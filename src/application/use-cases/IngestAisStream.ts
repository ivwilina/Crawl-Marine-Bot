// ============================================================================
//  APPLICATION · USE CASE: IngestAisStream
//  → Nhận AIS realtime và ghi vào kho theo MẺ.
// ----------------------------------------------------------------------------
//  AIS là nguồn PHỤ, nhưng nó lấp đúng 3 chỗ mà crawl mp2 không làm được:
//    • làm tươi vị trí giữa 2 vòng quét (vòng quét vùng tính bằng giờ),
//    • course/speed/navStatus — mp2 không mang,
//    • nối `imo` với `mmsi` + mã loại AIS dạng số, ở quy mô mà tra trang chi
//      tiết (≈4.300 tàu/ngày) không bao giờ với tới.
//
//  Vì sao phải gom mẻ: một vùng đông tàu đẩy về hàng nghìn message mỗi phút, và
//  cùng một tàu phát lại sau vài giây. Ghi từng message là 1 round-trip DB mỗi
//  message cho phần lớn là dữ liệu sẽ bị ghi đè ngay. Buffer dedupe theo mmsi
//  (bản mới nhất thắng) rồi ghi bulk, giống hệt cách ScanArea làm.
//
//  Ghi qua `savePositionsFromAis`/`upsertVesselsFromAis` chứ không phải
//  `savePositionLatest`: hai hàm đó có guard `receivedAt` và chỉ-điền-chỗ-trống,
//  là thứ bắt buộc khi mp2 và AIS cùng ghi vào một kho.
// ============================================================================

import { IAisStream, AisPositionMessage, AisStaticMessage } from "../ports/IAisStream";
import { IVesselRepository } from "../ports/IVesselRepository";
import { BoundingBox } from "../ports/Geo";
import { Vessel } from "../../domain/entities/Vessel";
import { VesselPosition } from "../../domain/entities/VesselPosition";

export interface IngestAisStreamDeps {
  stream: IAisStream;
  repository: IVesselRepository;
  /** Ghi DB mỗi ngần này ms. */
  flushEveryMs?: number;
  /** Ghi ngay khi buffer đạt ngần này bản ghi, không đợi hết chu kỳ. */
  flushMaxSize?: number;
}

export interface AisIngestStats {
  /** Số message nhận được (kể cả bản bị dedupe mất). */
  positionsReceived: number;
  staticsReceived: number;
  /** Số bản ghi thực sự vào DB. */
  positionsWritten: number;
  vesselsWritten: number;
  /** Số lần ghi DB — con số cần theo dõi để biết DB có bị dồn hay không. */
  flushes: number;
}

const DEFAULT_FLUSH_EVERY_MS = 10 * 1000;
const DEFAULT_FLUSH_MAX_SIZE = 2000;

export class IngestAisStream {
  private readonly stream: IAisStream;
  private readonly repository: IVesselRepository;
  private readonly flushEveryMs: number;
  private readonly flushMaxSize: number;

  /** Dedupe theo mmsi: bản mới nhất trong chu kỳ thắng. */
  private readonly positions = new Map<string, AisPositionMessage>();
  private readonly statics = new Map<string, AisStaticMessage>();

  private timer: NodeJS.Timeout | undefined;
  private flushing = false;
  private stopped = false;

  private readonly stats: AisIngestStats = {
    positionsReceived: 0,
    staticsReceived: 0,
    positionsWritten: 0,
    vesselsWritten: 0,
    flushes: 0,
  };

  constructor(deps: IngestAisStreamDeps) {
    this.stream = deps.stream;
    this.repository = deps.repository;
    this.flushEveryMs = deps.flushEveryMs ?? DEFAULT_FLUSH_EVERY_MS;
    this.flushMaxSize = Math.max(1, deps.flushMaxSize ?? DEFAULT_FLUSH_MAX_SIZE);
  }

  /** Đăng ký handler, mở stream, và bật chu kỳ ghi. */
  async start(boxes: BoundingBox[]): Promise<void> {
    this.stopped = false;

    this.stream.onPosition((message) => this.acceptPosition(message));
    this.stream.onStatic((message) => this.acceptStatic(message));

    this.timer = setInterval(() => void this.flush(), this.flushEveryMs);

    console.log(
      `📡 AIS ingest: ghi DB mỗi ${this.flushEveryMs / 1000}s hoặc mỗi ${this.flushMaxSize} bản ghi.`
    );

    await this.stream.connect(boxes);
  }

  /** Dừng stream, huỷ chu kỳ, và ghi nốt phần còn trong buffer. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.stream.stop();
    await this.flush();
  }

  snapshot(): AisIngestStats {
    return { ...this.stats };
  }

  /* ---------------------------------------------------------------------- */

  private acceptPosition(message: AisPositionMessage): void {
    if (this.stopped) return;
    this.stats.positionsReceived += 1;

    const existing = this.positions.get(message.mmsi);
    // Message tới không đảm bảo đúng thứ tự thời gian; giữ bản mới nhất.
    if (!existing || existing.receivedAt <= message.receivedAt) {
      this.positions.set(message.mmsi, message);
    }

    if (this.positions.size >= this.flushMaxSize) void this.flush();
  }

  private acceptStatic(message: AisStaticMessage): void {
    if (this.stopped) return;
    this.stats.staticsReceived += 1;
    this.statics.set(message.mmsi, message);

    if (this.statics.size >= this.flushMaxSize) void this.flush();
  }

  /**
   * Ghi buffer xuống DB.
   *
   * `flushing` chặn chồng lệnh: chu kỳ và ngưỡng kích thước có thể cùng gọi, và
   * hai lượt bulk song song trên cùng một mmsi thì lượt chậm hơn có thể ghi
   * dữ liệu cũ hơn — guard `receivedAt` ở repository chặn được, nhưng vẫn là
   * round-trip vô ích.
   *
   * Buffer được LẤY RA TRƯỚC khi await: message mới đến trong lúc đang ghi sẽ
   * vào chu kỳ sau chứ không bị mất.
   *
   * Ghi định danh TRƯỚC vị trí: nếu chết giữa hai lệnh thì thà có tàu chưa vị
   * trí (vòng sau bù) hơn là vị trí trỏ tới tàu chưa tồn tại.
   */
  private async flush(): Promise<void> {
    if (this.flushing) return;
    if (this.positions.size === 0 && this.statics.size === 0) return;

    this.flushing = true;

    const positions = [...this.positions.values()];
    const statics = [...this.statics.values()];
    this.positions.clear();
    this.statics.clear();

    try {
      if (statics.length > 0) {
        this.stats.vesselsWritten += await this.repository.upsertVesselsFromAis(
          statics.map(
            (message) =>
              new Vessel({
                mmsi: message.mmsi,
                imo: message.imo,
                name: message.name,
                aisType: message.aisType,
              })
          )
        );
      }

      if (positions.length > 0) {
        this.stats.positionsWritten += await this.repository.savePositionsFromAis(
          positions.map(
            (message) =>
              new VesselPosition({
                mmsi: message.mmsi,
                lat: message.lat,
                lon: message.lon,
                speedKn: message.speedKn,
                courseDeg: message.courseDeg,
                headingDeg: message.headingDeg,
                navStatusCode: message.navStatusCode,
                navStatusText: message.navStatusText,
                // AIS cho toạ độ chính xác, không phải toạ độ làm tròn như
                // trang chi tiết miễn phí.
                source: "ais",
                latLonApproximate: false,
                receivedAt: message.receivedAt,
              })
          )
        );
      }

      this.stats.flushes += 1;
    } catch (err) {
      // Buffer đã bị lấy ra, nên mẻ này mất. Chấp nhận được: AIS phát lại liên
      // tục, và giữ buffer khi DB đang chết chỉ làm RAM phình vô hạn.
      console.log(`📡 AIS: ghi DB thất bại, bỏ mẻ ${positions.length} vị trí: ${(err as Error).message}`);
    } finally {
      this.flushing = false;
    }
  }
}
