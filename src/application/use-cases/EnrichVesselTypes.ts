// ============================================================================
//  APPLICATION · USE CASE: EnrichVesselTypes
//  → Tàu quét được từ mp2 (ScanArea) chỉ có mmsi + tên + toạ độ, KHÔNG có
//  type/flag/kích thước/HƯỚNG ĐI. Use case này chạy nền, lần lượt tra chi
//  tiết từng tàu còn thiếu `type` (qua trang chi tiết VesselFinder theo
//  mmsi/imo) rồi lưu lại lý lịch đầy đủ — để UI vẽ icon đúng màu + đúng
//  hướng theo loại tàu.
// ----------------------------------------------------------------------------
//  ⚠️ mp2 (quét vùng) KHÔNG mang course/speed cho tàu thường (đã kiểm chứng
//  thực nghiệm: 2 byte "flag" không khớp công thức nào với hướng thật) —
//  chỉ trang chi tiết mới có course/speed CHÍNH XÁC (JSON #djson). Vì đã
//  tải trang chi tiết để lấy type, ta lấy LUÔN course/speed từ đó — không
//  tốn thêm request nào. Toạ độ lat/lon vẫn GIỮ NGUYÊN từ mp2 (chính xác
//  hơn toạ độ làm tròn của trang chi tiết miễn phí).
// ----------------------------------------------------------------------------
//  Đây là tra cứu theo từng tàu -> tạo thêm request upstream ngoài area scan.
//  vùng, nên PHẢI giới hạn tốc độ: batch nhỏ mỗi vòng + nghỉ dài giữa các
//  vòng + jitter ngẫu nhiên + hạ nhiệt khi bị chặn (403).
// ============================================================================

import { IVesselDetailsSource } from "../ports/IVesselDetailsSource";
import { IVesselRepository } from "../ports/IVesselRepository";
import { Vessel } from "../../domain/entities/Vessel";
import { VesselPosition } from "../../domain/entities/VesselPosition";

export interface EnrichVesselTypesDeps {
  detailsSource: IVesselDetailsSource;
  repository: IVesselRepository;
  batchSize?: number; // số tàu tra mỗi vòng (mặc định 15)
  delayMs?: number; // nghỉ giữa 2 tàu trong 1 vòng (mặc định 2s)
  intervalMs?: number; // nghỉ giữa 2 vòng (mặc định 5 phút)
}

export class EnrichVesselTypes {
  private readonly detailsSource: IVesselDetailsSource;
  private readonly repository: IVesselRepository;
  private readonly batchSize: number;
  private readonly delayMs: number;
  private readonly intervalMs: number;
  private running = false;

  constructor(deps: EnrichVesselTypesDeps) {
    this.detailsSource = deps.detailsSource;
    this.repository = deps.repository;
    this.batchSize = deps.batchSize ?? 15;
    this.delayMs = deps.delayMs ?? 2000;
    this.intervalMs = deps.intervalMs ?? 5 * 60 * 1000;
  }

  /** Chạy 1 vòng: tra tối đa batchSize tàu thiếu type. Trả số tàu đã bổ sung được. */
  async runOnce(): Promise<number> {
    if (this.batchSize <= 0) return 0;
    // Query thẳng tàu thiếu type ở DB (không nạp cả triệu vessel vào RAM).
    const missing = await this.repository.getVesselsMissingType(this.batchSize);
    let done = 0;

    for (const v of missing) {
      if (!this.running) break;
      // KHÓA = mmsi, KHÔNG bao giờ đổi. Enrich chỉ ĐIỀN thêm IMO/type/kích
      // thước vào cùng bản ghi -> không còn cảnh xóa-tạo-lại gây trùng tàu.
      const mmsi = v.mmsi;
      try {
        const details = await this.detailsSource.getDetails(mmsi);

        // Giữ toạ độ chính xác đã có (mp2); chỉ lấy course/speed/trạng thái
        // từ trang chi tiết — dữ liệu mp2 không có.
        const existing = await this.repository.getLatestPosition(mmsi);
        await this.repository.saveVessel(details.vessel);
        await this.repository.savePositionLatest(
          new VesselPosition({
            mmsi,
            imo: details.vessel.imo,
            lat: existing?.lat ?? details.position.lat,
            lon: existing?.lon ?? details.position.lon,
            speedKn: details.position.speedKn,
            courseDeg: details.position.courseDeg,
            navStatusText: details.position.navStatusText,
            destination: details.position.destination,
            eta: details.position.eta,
            positionTime: details.position.positionTime,
            source: "vesselfinder",
            latLonApproximate: existing ? existing.latLonApproximate : details.position.latLonApproximate,
          })
        );

        done++;
        console.log(
          `   🏷️  ${details.vessel.name ?? mmsi} -> ${details.vessel.type ?? "?"}  ${details.position.courseDeg ?? "?"}°`
        );
      } catch (err) {
        const e = err as { code?: string; message: string };
        console.log(`   ⚠️  ${mmsi}  ${e.message}`);
        if (e.code === "E-2001") {
          console.log("   🧊 Bị chặn — tạm nghỉ 5 phút cho hạ nhiệt...");
          await EnrichVesselTypes.sleep(5 * 60 * 1000);
        }
      }
      await EnrichVesselTypes.sleep(EnrichVesselTypes.jitter(this.delayMs));
    }
    return done;
  }

  /** Chạy lặp vô hạn (Ctrl+C / stop() để dừng). */
  async start(): Promise<void> {
    this.running = true;
    console.log(
      `🏷️  EnrichVesselTypes: mỗi vòng tra tối đa ${this.batchSize} tàu, nghỉ ${this.intervalMs / 60000} phút giữa các vòng.\n`
    );
    while (this.running) {
      try {
        const done = await this.runOnce();
        if (done === 0) {
          console.log("   ✅ Không còn tàu thiếu type (hoặc đang chờ hạ nhiệt).");
        }
      } catch (err) {
        console.log(`   ❌ ${(err as Error).message}`);
      }
      await EnrichVesselTypes.sleep(this.intervalMs);
    }
  }

  stop(): void {
    this.running = false;
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private static jitter(ms: number): number {
    return Math.round(ms * (0.6 + Math.random() * 0.8));
  }
}
