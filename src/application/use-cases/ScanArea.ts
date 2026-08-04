// ============================================================================
//  APPLICATION · USE CASE: ScanArea
//  → Quét lưới ô phủ toàn cầu từ VesselFinder (mp2), lặp vô hạn, ghi DB theo MẺ.
// ----------------------------------------------------------------------------
//  Một vòng làm việc:
//    • Nạp lưới ô gốc (760 ô ở 9° — xem worldTiles) vào 1 QUEUE.
//    • Mỗi LƯỢT lấy `concurrency` ô (mặc định 4) fetch SONG SONG, rồi nghỉ
//      `chunkDelayMs` (mặc định 60s). Nhịp trung bình = 4 req/60s = 1 req/15s,
//      đúng bằng nhịp tuần tự cũ -> không tăng rủi ro bị chặn, chỉ gom thành
//      từng burst nhỏ.
//    • Ô nào trả về >= `subdivideThreshold` tàu là dấu hiệu mp2 đã CẮT BỚT ->
//      đẩy 4 ô con TRỞ LẠI QUEUE (dữ liệu ô cha bỏ, ô con sẽ phủ lại). Nhờ đi
//      qua queue nên số request đồng thời luôn đúng `concurrency`, chia sâu bao
//      nhiêu tầng cũng không bung ra 16-64 request song song.
//    • Tàu quét được nằm trong BUFFER trong RAM; cứ `flushEveryTiles` ô (mặc
//      định 20) mới ghi DB một lần bằng bulk -> DB nhận ~2 lệnh mỗi 20 ô thay
//      vì 2 lệnh mỗi TÀU. Buffer dedupe theo mmsi nên ô cha/ô con chồng nhau
//      không sinh ghi trùng (và không đụng unique index mmsi).
//    • Hết queue = xong 1 vòng -> nghỉ `cycleDelayMs` rồi quét lại từ đầu.
//
//  Chống ban: gặp 403/429 -> hạ nhiệt `blockCooldownMs` MỘT LẦN cho cả lượt,
//  rồi trả ô về queue để thử lại (tối đa `MAX_ATTEMPTS`) — không mất vùng phủ,
//  cũng không mất cả vòng như trước.
//
//  ⚠️ Thời gian 1 vòng (760 ô + subdivision, 60s/lượt) có thể 15-30h. Nó PHẢI
//  nhỏ hơn POSITION_STALE_AFTER_MS, nếu không CleanupStalePositions sẽ xoá tàu
//  trước khi vòng sau quét lại tới nó.
// ============================================================================

import { IAreaScanner, ScannedShip } from "../ports/IAreaScanner";
import { IVesselRepository } from "../ports/IVesselRepository";
import { BoundingBox } from "../ports/Geo";
import { Vessel } from "../../domain/entities/Vessel";
import { VesselPosition } from "../../domain/entities/VesselPosition";
import { splitBox, boxHeightDeg } from "./worldTiles";

/** Số lần thử 1 ô trước khi bỏ qua nó trong vòng này (1 lần thử lại). */
const MAX_ATTEMPTS = 2;

/** Biên độ jitter quanh khoảng nghỉ: nhịp không đều tăm tắp như máy. */
const JITTER_RATIO = 0.2;

export interface ScanAreaDeps {
  mapSource: IAreaScanner;
  repository: IVesselRepository;
  /** Số ô fetch song song mỗi lượt. */
  concurrency?: number;
  /** Nghỉ giữa 2 lượt — lá chắn ban chính. */
  chunkDelayMs?: number;
  /** Gom bao nhiêu ô thì ghi DB 1 lần. */
  flushEveryTiles?: number;
  /** Nghỉ giữa 2 vòng quét toàn lưới. */
  cycleDelayMs?: number;
  zoom?: number;
  /** Ô trả >= ngần này tàu -> nghi bị cắt bớt -> chia 4. */
  subdivideThreshold?: number;
  /** Ngừng chia khi ô cao hơn ngần này độ (chiều cao ô, đơn vị độ). */
  minTileDeg?: number;
  /** Bị chặn -> nghỉ dài ngần này rồi tiếp. */
  blockCooldownMs?: number;
}

/** Kết quả 1 vòng quét — đủ để biết vòng đó có lành hay không. */
export interface ScanCycleStats {
  /** Số ô đã fetch, tính cả ô con sinh ra do chia nhỏ. */
  tiles: number;
  /** Số ô bị chia nhỏ vì mp2 cắt bớt dữ liệu. */
  subdivided: number;
  /** Số tàu đã gom (đã dedupe trong từng mẻ). */
  ships: number;
  /** Số lý lịch tàu đã tạo mới/cập nhật. */
  vessels: number;
  /** Số vị trí mới nhất đã ghi. */
  positions: number;
  /** Số lần bị 403/429. */
  blocked: number;
  /** Số ô bỏ cuộc sau khi hết lượt thử. */
  failed: number;
}

/** 1 ô đang chờ trong queue, kèm số lần đã thử. */
interface QueuedTile {
  box: BoundingBox;
  attempts: number;
}

export class ScanArea {
  private readonly mapSource: IAreaScanner;
  private readonly repository: IVesselRepository;
  private readonly concurrency: number;
  private readonly chunkDelayMs: number;
  private readonly flushEveryTiles: number;
  private readonly cycleDelayMs: number;
  private readonly zoom: number;
  private readonly subdivideThreshold: number;
  private readonly minTileDeg: number;
  private readonly blockCooldownMs: number;
  private boxes: BoundingBox[] = [];
  /** Chỉ `stop()` bật cờ này. Mặc định false -> `scanOnce()` chạy được một mình. */
  private stopped = false;

  constructor(deps: ScanAreaDeps) {
    this.mapSource = deps.mapSource;
    this.repository = deps.repository;
    this.concurrency = Math.max(1, deps.concurrency ?? 4);
    this.chunkDelayMs = deps.chunkDelayMs ?? 60 * 1000;
    this.flushEveryTiles = Math.max(1, deps.flushEveryTiles ?? 20);
    this.cycleDelayMs = deps.cycleDelayMs ?? 6 * 60 * 60 * 1000;
    this.zoom = deps.zoom ?? 9;
    this.subdivideThreshold = deps.subdivideThreshold ?? 400;
    this.minTileDeg = deps.minTileDeg ?? 1;
    this.blockCooldownMs = deps.blockCooldownMs ?? 15 * 60 * 1000;
  }

  /**
   * Quét đúng 1 vòng hết mọi ô (kể cả ô con sinh ra khi chia nhỏ).
   *
   * Buffer nằm ở đây, không phải ở field của class: mỗi vòng là một mẻ dữ liệu
   * độc lập, và một vòng bị dừng giữa đường không được để tàu tồn lại sang vòng
   * sau với receivedAt cũ.
   */
  async scanOnce(boxes: BoundingBox[]): Promise<ScanCycleStats> {
    const queue: QueuedTile[] = boxes.map((box) => ({ box, attempts: 0 }));
    const buffer = new Map<string, ScannedShip>();
    const stats: ScanCycleStats = {
      tiles: 0,
      subdivided: 0,
      ships: 0,
      vessels: 0,
      positions: 0,
      blocked: 0,
      failed: 0,
    };
    let tilesSinceFlush = 0;

    while (queue.length > 0 && !this.stopped) {
      const chunk = queue.splice(0, this.concurrency);
      const results = await Promise.allSettled(
        chunk.map((tile) => this.mapSource.fetchArea(tile.box, this.zoom))
      );

      // Hạ nhiệt 1 lần cho cả lượt: bị chặn thì thường cả 4 ô cùng trượt, không
      // có lý gì nghỉ 4 lần liên tiếp.
      let cooledDown = false;

      for (let i = 0; i < chunk.length; i++) {
        const tile = chunk[i];
        const result = results[i];
        stats.tiles += 1;
        tilesSinceFlush += 1;

        if (result.status === "rejected") {
          cooledDown = await this.handleTileFailure(tile, result.reason, queue, stats, cooledDown);
        } else if (this.shouldSubdivide(tile.box, result.value.length)) {
          // Ô dày -> mp2 đã cắt bớt, dữ liệu ô này không đủ tin. Bỏ nó, đẩy 4 ô
          // con vào queue để lượt sau quét sâu hơn.
          stats.subdivided += 1;
          for (const child of splitBox(tile.box)) queue.push({ box: child, attempts: 0 });
        } else {
          // Dedupe theo mmsi: ô chồng nhau hoặc ô con quét lại cùng vùng thì bản
          // mới nhất thắng, và mẻ ghi xuống DB không có 2 op cùng 1 mmsi.
          for (const ship of result.value) buffer.set(ship.mmsi, ship);
        }

        // Đếm theo Ô, không theo lượt: `flushEveryTiles` giữ đúng nghĩa dù nó có
        // chia hết cho `concurrency` hay không.
        if (tilesSinceFlush >= this.flushEveryTiles) {
          await this.flush(buffer, stats);
          tilesSinceFlush = 0;
          console.log(
            `   … ${stats.tiles} ô xong, còn ${queue.length} ô trong queue, ${stats.positions} vị trí đã ghi.`
          );
        }
      }

      if (queue.length > 0 && !this.stopped) {
        await ScanArea.sleep(ScanArea.jitter(this.chunkDelayMs));
      }
    }

    // Phần dư chưa đủ `flushEveryTiles` ô — kể cả khi bị stop() giữa vòng.
    await this.flush(buffer, stats);
    return stats;
  }

  /** Chạy lặp: quét hết lưới, nghỉ, quét lại (Ctrl+C / stop() để dừng). */
  async start(boxes: BoundingBox[]): Promise<void> {
    this.boxes = boxes;
    this.stopped = false;
    console.log(
      `🗺️  Quét ${boxes.length} ô gốc | ${this.concurrency} ô/lượt, nghỉ ${this.chunkDelayMs / 1000}s/lượt ` +
        `(~${(this.chunkDelayMs / 1000 / this.concurrency).toFixed(1)}s/request) | ` +
        `ghi DB mỗi ${this.flushEveryTiles} ô | nghỉ ${(this.cycleDelayMs / 60000).toFixed(0)} phút giữa 2 vòng\n`
    );

    while (!this.stopped) {
      try {
        const stats = await this.scanOnce(this.boxes);
        console.log(
          `   📍 ${new Date().toISOString()} — xong 1 vòng: ${stats.tiles} ô ` +
            `(${stats.subdivided} ô chia nhỏ, ${stats.blocked} lần bị chặn, ${stats.failed} ô bỏ), ` +
            `${stats.ships} tàu -> ${stats.vessels} lý lịch / ${stats.positions} vị trí.`
        );
      } catch (err) {
        console.log(`   ❌ ${(err as Error).message}`);
      }
      if (!this.stopped) await ScanArea.sleep(this.cycleDelayMs);
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
    this.stopped = true;
  }

  /** Ô trả về quá nhiều tàu = mp2 đã cắt bớt, và ô còn đủ lớn để chia tiếp. */
  private shouldSubdivide(box: BoundingBox, shipCount: number): boolean {
    return shipCount >= this.subdivideThreshold && boxHeightDeg(box) > this.minTileDeg;
  }

  /**
   * Ô fetch trượt: trả về queue để thử lại, hoặc bỏ nếu đã hết lượt thử.
   *
   * @param alreadyCooledDown - Lượt này đã hạ nhiệt chưa. Bị chặn thì thường cả
   *   `concurrency` ô cùng trượt, không có lý gì nghỉ 4 lần liên tiếp.
   * @returns Trạng thái hạ nhiệt sau khi xử lý ô này
   */
  private async handleTileFailure(
    tile: QueuedTile,
    reason: unknown,
    queue: QueuedTile[],
    stats: ScanCycleStats,
    alreadyCooledDown: boolean
  ): Promise<boolean> {
    const err = reason as { code?: string; message: string };
    const blocked = err.code === "E-2001";
    if (blocked) stats.blocked += 1;

    if (tile.attempts + 1 < MAX_ATTEMPTS) {
      queue.push({ box: tile.box, attempts: tile.attempts + 1 });
    } else {
      stats.failed += 1;
      console.log(`   ⚠️  Bỏ ô [${ScanArea.label(tile.box)}] sau ${MAX_ATTEMPTS} lần thử: ${err.message}`);
    }

    if (blocked && !alreadyCooledDown) {
      console.log(`   🧊 Bị chặn (403/429) — hạ nhiệt ${this.blockCooldownMs / 60000} phút...`);
      await ScanArea.sleep(this.blockCooldownMs);
      return true;
    }

    return alreadyCooledDown;
  }

  /**
   * Ghi buffer xuống DB rồi xoá buffer.
   *
   * Ghi lý lịch TRƯỚC vị trí: nếu tiến trình chết giữa 2 lệnh thì thà có tàu
   * chưa có vị trí (vòng sau bù) hơn là có vị trí trỏ tới tàu chưa tồn tại.
   *
   * Lỗi ghi KHÔNG làm chết vòng quét: buffer bị bỏ và ghi log, vì vòng sau sẽ
   * quét lại chính những ô đó. Giữ lại buffer khi DB đang chết chỉ làm RAM phình
   * lên vô hạn.
   */
  private async flush(buffer: Map<string, ScannedShip>, stats: ScanCycleStats): Promise<void> {
    if (buffer.size === 0) return;

    const ships = [...buffer.values()];
    buffer.clear();
    stats.ships += ships.length;

    try {
      stats.vessels += await this.repository.upsertVesselsFromScan(
        ships.map((ship) => new Vessel({ mmsi: ship.mmsi, name: ship.name }))
      );
      stats.positions += await this.repository.savePositionsFromScan(
        ships.map(
          (ship) =>
            new VesselPosition({
              mmsi: ship.mmsi,
              lat: ship.lat,
              lon: ship.lon,
              source: "vesselfinder",
              latLonApproximate: false, // mp2 cho toạ độ CHÍNH XÁC
            })
        )
      );
    } catch (err) {
      console.log(`   ❌ Ghi DB thất bại, bỏ mẻ ${ships.length} tàu: ${(err as Error).message}`);
    }
  }

  private static label(box: BoundingBox): string {
    return `${box.minLat},${box.minLon} → ${box.maxLat},${box.maxLon}`;
  }

  private static jitter(ms: number): number {
    if (ms <= 0) return 0;
    const spread = ms * JITTER_RATIO;
    return Math.round(ms - spread + Math.random() * spread * 2);
  }

  private static sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
