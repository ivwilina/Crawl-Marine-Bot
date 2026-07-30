// ============================================================================
//  APPLICATION · USE CASE: ScanArea
//  → Quét vùng (tới cả THẾ GIỚI) từ VesselFinder (mp2) định kỳ, upsert DB.
// ----------------------------------------------------------------------------
//  Mỗi ô: 1 request lấy hàng trăm tàu (mmsi + tên + toạ độ chính xác). Vì chỉ
//  1 request/ô nên nhẹ. Để quy mô 700k–1M tàu + HẠ RỦI RO BAN xuống thấp nhất:
//    • Tuần tự (đồng thời = 1) — không bao giờ bắn song song vào VF.
//    • Nghỉ jitter ngẫu nhiên GIỮA MỖI Ô (không nhịp đều như máy).
//    • Xáo trộn thứ tự ô mỗi vòng — không quét kiểu raster đoán được.
//    • Ô nào trả về quá nhiều tàu (mp2 cắt bớt) -> CHIA 4 quét sâu, phủ đủ.
//    • Bị chặn (403/429) -> hạ nhiệt DÀI rồi tiếp, không mất cả vòng.
// ============================================================================

import { IAreaScanner } from "../ports/IAreaScanner";
import { IVesselRepository } from "../ports/IVesselRepository";
import { BoundingBox } from "../ports/Geo";
import { Vessel } from "../../domain/entities/Vessel";
import { VesselPosition } from "../../domain/entities/VesselPosition";
import { splitBox, boxHeightDeg } from "./worldTiles";

export interface ScanAreaDeps {
  mapSource: IAreaScanner;
  repository: IVesselRepository;
  minMs?: number; // nghỉ tối thiểu giữa 2 VÒNG quét
  maxMs?: number; // nghỉ tối đa giữa 2 vòng
  zoom?: number;
  tileDelayMinMs?: number; // nghỉ tối thiểu giữa 2 Ô (chống ban)
  tileDelayMaxMs?: number; // nghỉ tối đa giữa 2 ô
  subdivideThreshold?: number; // ô trả >= ngần này tàu -> nghi bị cắt -> chia 4
  minTileDeg?: number; // ngừng chia khi ô nhỏ hơn (độ)
  blockCooldownMs?: number; // bị chặn -> nghỉ dài ngần này rồi tiếp
}

export class ScanArea {
  private readonly mapSource: IAreaScanner;
  private readonly repository: IVesselRepository;
  private readonly minMs: number;
  private readonly maxMs: number;
  private readonly zoom: number;
  private readonly tileDelayMinMs: number;
  private readonly tileDelayMaxMs: number;
  private readonly subdivideThreshold: number;
  private readonly minTileDeg: number;
  private readonly blockCooldownMs: number;
  private boxes: BoundingBox[] = [];
  private running = false;

  constructor(deps: ScanAreaDeps) {
    this.mapSource = deps.mapSource;
    this.repository = deps.repository;
    this.minMs = deps.minMs ?? 2 * 60 * 1000;
    this.maxMs = deps.maxMs ?? 15 * 60 * 1000;
    this.zoom = deps.zoom ?? 9;
    this.tileDelayMinMs = deps.tileDelayMinMs ?? 3000;
    this.tileDelayMaxMs = deps.tileDelayMaxMs ?? 8000;
    this.subdivideThreshold = deps.subdivideThreshold ?? 400;
    this.minTileDeg = deps.minTileDeg ?? 1;
    this.blockCooldownMs = deps.blockCooldownMs ?? 15 * 60 * 1000;
  }

  /** Random khoảng nghỉ trong [min,max] — nhịp không đều như người. */
  /** Xáo trộn mảng (Fisher–Yates) — thứ tự quét không đoán được. */
  private static sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Lưu 1 mẻ tàu (upsert theo mmsi). */
  private async saveShips(ships: { mmsi: string; name: string; lat: number; lon: number }[]): Promise<void> {
    for (const s of ships) {
      const known = await this.repository.findVesselByMmsi(s.mmsi);
      if (!known) {
        await this.repository.saveVessel(new Vessel({ mmsi: s.mmsi, name: s.name }));
      }
      await this.repository.savePositionLatest(
        new VesselPosition({
          mmsi: s.mmsi,
          lat: s.lat,
          lon: s.lon,
          source: "vesselfinder",
          latLonApproximate: false, // mp2 cho toạ độ CHÍNH XÁC
        })
      );
    }
  }

  /**
   * Quét 1 ô. Nếu trả về quá nhiều tàu (nghi mp2 cắt bớt) và ô còn đủ lớn ->
   * chia 4 quét sâu. Trả tổng số tàu đã lưu. Ném lỗi block lên trên để backoff.
   */
  private async scanTile(box: BoundingBox): Promise<number> {
    const ships = await this.mapSource.fetchArea(box, this.zoom);

    if (ships.length >= this.subdivideThreshold && boxHeightDeg(box) > this.minTileDeg) {
      // Ô dày -> chia 4, quét từng ô con (có nghỉ jitter giữa các ô con).
      let sub = 0;
      for (const child of splitBox(box)) {
        if (!this.running) break;
        sub += await this.scanTile(child);
        await ScanArea.sleep(this.tileDelayMinMs);
      }
      return sub;
    }

    await this.saveShips(ships);
    return ships.length;
  }

  /** Quét 1 lần TẤT CẢ các ô (xáo trộn, nghỉ jitter giữa ô, backoff khi bị chặn). */
  async scanOnce(boxes: BoundingBox[]): Promise<number> {
    let total = 0;
    const order = boxes;
    for (let i = 0; i < boxes.length; i++) {
      if (!this.running) break;
      try {
        total += await this.scanTile(boxes[i]);
      } catch (err) {
        const e = err as { code?: string; message: string };
        if (e.code === "E-2001") {
          // Bị chặn -> hạ nhiệt dài, KHÔNG bỏ cả vòng.
          console.log(`   🧊 Bị chặn (403/429) — hạ nhiệt ${this.blockCooldownMs / 60000} phút...`);
          await ScanArea.sleep(this.blockCooldownMs);
          break;
        } else {
          console.log(`   ⚠️  Ô ${i + 1} lỗi: ${e.message}`);
        }
      }
      // Nghỉ jitter giữa các ô — lá chắn ban chính.
      if (i < boxes.length - 1) {
        await ScanArea.sleep(this.tileDelayMinMs);
      }
      // Log tiến độ mỗi 25 ô (vòng quét thế giới có rất nhiều ô).
      if ((i + 1) % 25 === 0) {
        console.log(`   … ${i + 1}/${order.length} ô, ${total} tàu (upsert).`);
      }
    }
    return total;
  }

  /** Chạy lặp: quét toàn bộ ô, nghỉ giữa các vòng (Ctrl+C / stop để dừng). */
  async start(boxes: BoundingBox[]): Promise<void> {
    this.boxes = boxes;
    this.running = true;
    console.log(
      `🗺️  Quét ${boxes.length} ô, nghỉ ${this.tileDelayMinMs / 1000}–${this.tileDelayMaxMs / 1000}s/ô, ` +
        `${this.minMs / 60000}–${this.maxMs / 60000} phút/vòng (Ctrl+C để dừng)\n`
    );
    while (this.running) {
      try {
        const n = await this.scanOnce(this.boxes);
        const wait = this.minMs;
        console.log(
          `   📍 ${new Date().toISOString()} — xong 1 vòng: ${n} tàu. Vòng sau sau ${(wait / 60000).toFixed(1)} phút.`
        );
        await ScanArea.sleep(wait);
      } catch (err) {
        console.log(`   ❌ ${(err as Error).message}`);
        await ScanArea.sleep(this.maxMs);
      }
    }
  }

  updateArea(boxes: BoundingBox[]): void {
    this.boxes = boxes;
    console.log("📐 Đã đổi vùng quét.");
  }
  getArea(): BoundingBox[] {
    return this.boxes;
  }
  stop(): void {
    this.running = false;
  }
}
