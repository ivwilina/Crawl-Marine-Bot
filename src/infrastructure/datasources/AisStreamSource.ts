// ============================================================================
//  INFRASTRUCTURE · DataSource: AisStreamSource (aisstream.io qua WebSocket)
// ----------------------------------------------------------------------------
//  Chuyển từ repo soosky-marine-api sang, giữ nguyên các bản sửa socket đã
//  kiểm chứng ở đó (commit fix/socket):
//    • guard `readyState` trước khi mở socket mới,
//    • dọn listener + terminate socket cũ trước khi tạo mới,
//    • reconnect single-flight trên timer 30s, hẹn từ CẢ `error` và `close`
//      (lỗi "socket hang up" có thể fire trước `open` và không kèm `close`),
//    • bọc parse frame để một frame rác không giết process.
//
//  ⚠️ time_utc của nhà cung cấp là định dạng Go, KHÔNG phải ISO 8601:
//     "2026-08-06 03:38:08.419123456 +0000 UTC"
//  Lưu nguyên chuỗi đó vào `receivedAt` sẽ phá 2 thứ đang so sánh chuỗi ISO:
//  guard "không ghi đè bản ghi mới hơn" trong repository, và bộ lọc `freshSince`
//  của mọi truy vấn map. Nên nó được đổi sang ISO ngay tại đây.
// ============================================================================

import WebSocket from "ws";
import {
  AisPositionMessage,
  AisStaticMessage,
  IAisStream,
} from "../../application/ports/IAisStream";
import { BoundingBox } from "../../application/ports/Geo";
import { navStatusText } from "../mappers/navStatus";

const AIS_STREAM_URL = "wss://stream.aisstream.io/v0/stream";

const PING_INTERVAL_MS = 60 * 1000;
const RECONNECT_INTERVAL_MS = 30 * 1000;

/** Toàn cầu — dùng khi không cấu hình vùng nào. */
const WORLD_BOX: BoundingBox = { minLat: -90, minLon: -180, maxLat: 90, maxLon: 180 };

const MESSAGE_POSITION = "PositionReport";
const MESSAGE_STATIC = "ShipStaticData";

/**
 * Đổi timestamp định dạng Go của nhà cung cấp sang ISO 8601.
 *
 * Phần thập phân của Go dài tới 9 chữ số (nanosecond) trong khi JS chỉ nhận 3,
 * và hậu tố " UTC" sau offset làm `Date` không parse được. Nên chuỗi được bóc
 * bằng regex thay vì đưa cho `Date` đoán.
 *
 * @param raw - Ví dụ "2026-08-06 03:38:08.419123456 +0000 UTC"
 * @param now - Mốc thay thế khi không đọc được, tiêm để test không phụ thuộc đồng hồ
 * @returns Chuỗi ISO 8601, hoặc thời điểm hiện tại nếu không đọc được
 */
export function toIsoTimestamp(raw: unknown, now: () => Date = () => new Date()): string {
  if (typeof raw === "string") {
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?/);
    if (match) {
      const [, date, time, fraction = ""] = match;
      const millis = `${fraction}000`.slice(0, 3);
      return `${date}T${time}.${millis}Z`;
    }
  }
  // Không đọc được thì lấy "vừa nhận" — sai vài giây còn hơn ghi một chuỗi mà
  // guard so sánh sẽ hiểu sai hoàn toàn.
  return now().toISOString();
}

/** Số hữu hạn, hoặc null. AIS gửi giá trị canh lề như 511 (heading không rõ). */
function numeric(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/**
 * IMO của AIS là số, và 0 nghĩa là "không có" — tàu nội địa không có IMO.
 * Trả chuỗi để khớp với `Vessel.imo`.
 */
function imoNumber(raw: unknown): string | null {
  const value = numeric(raw);
  return value !== null && value > 0 ? String(value) : null;
}

export class AisStreamSource implements IAisStream {
  private ws: WebSocket | undefined;
  private pingInterval: NodeJS.Timeout | undefined;
  private reconnectTimeout: NodeJS.Timeout | undefined;
  private boxes: BoundingBox[] = [];
  private stopped = false;

  private positionHandler: ((message: AisPositionMessage) => void) | undefined;
  private staticHandler: ((message: AisStaticMessage) => void) | undefined;

  constructor(
    private readonly apiKey: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  onPosition(handler: (message: AisPositionMessage) => void): void {
    this.positionHandler = handler;
  }

  onStatic(handler: (message: AisStaticMessage) => void): void {
    this.staticHandler = handler;
  }

  connect(boxes: BoundingBox[]): Promise<void> {
    this.boxes = boxes.length > 0 ? boxes : [WORLD_BOX];
    this.stopped = false;

    // Bỏ qua nếu socket hiện tại đang kết nối hoặc đã mở.
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return Promise.resolve();
    }

    this.teardownSocket();
    this.stopPing();

    // Gắn listener lên biến cục bộ, không lên `this.ws`: reconnect có thể thay
    // socket giữa đường, và listener phải thuộc đúng socket đã tạo ra chúng.
    const socket = new WebSocket(AIS_STREAM_URL);
    this.ws = socket;

    return new Promise((resolve) => {
      socket.on("open", () => {
        this.handleOpen();
        resolve();
      });
      socket.on("error", (err: Error) => this.handleError(err));
      socket.on("message", (data: WebSocket.RawData) => this.handleMessage(data));
      socket.on("close", () => this.handleClose());
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }
    this.stopPing();
    this.teardownSocket();
  }

  // ---- vòng đời socket ----

  private handleOpen(): void {
    console.log("📡 AIS: đã kết nối aisstream.io");

    this.ws?.send(
      JSON.stringify({
        Apikey: this.apiKey,
        // aisstream nhận [[[minLat,minLon],[maxLat,maxLon]], ...] — VĨ ĐỘ TRƯỚC,
        // ngược với thứ tự bbox của mp2 và của API map.
        BoundingBoxes: this.boxes.map((box) => [
          [box.minLat, box.minLon],
          [box.maxLat, box.maxLon],
        ]),
        FilterMessageTypes: [MESSAGE_POSITION, MESSAGE_STATIC],
      })
    );

    console.log(`📡 AIS: đăng ký ${this.boxes.length} vùng.`);
    this.startPing();
  }

  private handleError(err: Error): void {
    console.error(`📡 AIS: lỗi kết nối lúc ${this.now().toISOString()}:`, err.message);
    this.stopPing();
    this.scheduleReconnect();
  }

  private handleClose(): void {
    console.log(`📡 AIS: đóng kết nối lúc ${this.now().toISOString()}`);
    this.stopPing();
    this.scheduleReconnect();
  }

  /** Hẹn reconnect cố định 30s. Single-flight: chỉ 1 timer tại 1 thời điểm. */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimeout) return;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    console.log(`📡 AIS: sẽ kết nối lại sau ${RECONNECT_INTERVAL_MS / 1000}s.`);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = undefined;
      if (!this.stopped) void this.connect(this.boxes);
    }, RECONNECT_INTERVAL_MS);
  }

  private teardownSocket(): void {
    if (!this.ws) return;
    this.ws.removeAllListeners();
    try {
      this.ws.terminate();
    } catch {
      /* socket đã chết, không có gì để đóng */
    }
    this.ws = undefined;
  }

  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => this.ws?.ping(), PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }
  }

  // ---- message ----

  private handleMessage(raw: WebSocket.RawData): void {
    let frame: any;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      // Một frame rác không được giết process; stream vẫn chạy tiếp.
      return;
    }

    try {
      this.dispatch(frame);
    } catch (err) {
      console.error("📡 AIS: không xử lý được message, bỏ qua.", (err as Error).message);
    }
  }

  private dispatch(frame: any): void {
    const mmsi = numeric(frame?.MetaData?.MMSI);
    // mmsi là khoá chính ở mọi nơi trong repo này; không có nó thì message vô dụng.
    if (mmsi === null || mmsi <= 0) return;

    switch (frame?.MessageType) {
      case MESSAGE_POSITION: {
        const report = frame?.Message?.PositionReport;
        const lat = numeric(report?.Latitude);
        const lon = numeric(report?.Longitude);
        if (lat === null || lon === null) return;

        const navStatusCode = numeric(report?.NavigationalStatus);

        this.positionHandler?.({
          mmsi: String(mmsi),
          lat,
          lon,
          speedKn: numeric(report?.Sog),
          courseDeg: numeric(report?.Cog),
          headingDeg: numeric(report?.TrueHeading),
          navStatusCode,
          navStatusText: navStatusText(navStatusCode),
          receivedAt: toIsoTimestamp(frame?.MetaData?.time_utc, this.now),
        });
        return;
      }

      case MESSAGE_STATIC: {
        const staticData = frame?.Message?.ShipStaticData;

        this.staticHandler?.({
          mmsi: String(mmsi),
          imo: imoNumber(staticData?.ImoNumber),
          name: (frame?.MetaData?.ShipName ?? staticData?.Name)?.trim() || null,
          aisType: numeric(staticData?.Type),
        });
        return;
      }

      default:
        // aisstream có 20+ loại message; ta chỉ đăng ký 2, phần còn lại bỏ qua
        // trong im lặng chứ không log (sẽ thành hàng nghìn dòng mỗi phút).
        return;
    }
  }
}
