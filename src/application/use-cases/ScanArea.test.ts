// ============================================================================
//  TEST · ScanArea — offline, KHÔNG gọi mạng, KHÔNG cần MongoDB.
//  Nguồn quét là stub; kho lưu trữ là InMemoryVesselRepository (cùng interface
//  với Mongo). Mọi khoảng nghỉ đặt 0 nên test chạy tức thì.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { ScanArea } from "./ScanArea";
import { IAreaScanner, ScannedShip } from "../ports/IAreaScanner";
import { BoundingBox } from "../ports/Geo";
import { InMemoryVesselRepository } from "../../infrastructure/persistence/InMemoryVesselRepository";
import { IVesselRepository } from "../ports/IVesselRepository";
import { Vessel } from "../../domain/entities/Vessel";
import { VesselPosition } from "../../domain/entities/VesselPosition";
import { Errors } from "../../domain/errors/AppError";

/** Nguồn quét giả: trả tàu theo hàm `reply`, đo mức song song thực tế. */
class StubScanner implements IAreaScanner {
  readonly seen: BoundingBox[] = [];
  peakInFlight = 0;
  private inFlight = 0;

  constructor(private readonly reply: (box: BoundingBox, call: number) => ScannedShip[]) {}

  async fetchArea(box: BoundingBox): Promise<ScannedShip[]> {
    const call = this.seen.length;
    this.seen.push(box);
    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    // Nhường event loop để các fetch trong cùng lượt thực sự chồng nhau.
    await new Promise((resolve) => setImmediate(resolve));
    this.inFlight -= 1;
    return this.reply(box, call);
  }
}

/** Repo đếm số LẦN ghi (không phải số bản ghi) — đó là thứ làm DB quá tải. */
class CountingRepository extends InMemoryVesselRepository {
  vesselWrites = 0;
  positionWrites = 0;

  async upsertVesselsFromScan(vessels: Vessel[]): Promise<number> {
    this.vesselWrites += 1;
    return super.upsertVesselsFromScan(vessels);
  }

  async savePositionsFromScan(positions: VesselPosition[]): Promise<number> {
    this.positionWrites += 1;
    return super.savePositionsFromScan(positions);
  }
}

function tiles(count: number): BoundingBox[] {
  return Array.from({ length: count }, (_, i) => ({
    minLat: 0,
    minLon: i,
    maxLat: 9,
    maxLon: i + 1,
  }));
}

function ship(mmsi: string, name = `Boat ${mmsi}`): ScannedShip {
  return { mmsi, name, lat: 1, lon: 2 };
}

function build(scanner: IAreaScanner, repository: IVesselRepository, overrides = {}) {
  return new ScanArea({
    mapSource: scanner,
    repository,
    concurrency: 4,
    chunkDelayMs: 0,
    flushEveryTiles: 20,
    cycleDelayMs: 0,
    blockCooldownMs: 0,
    subdivideThreshold: 400,
    minTileDeg: 1,
    ...overrides,
  });
}

test("fetches tiles 4 at a time and covers every tile exactly once", async () => {
  const scanner = new StubScanner((_box, call) => [ship(`1000000${call}`)]);
  const repository = new CountingRepository();
  const boxes = tiles(10);

  const stats = await build(scanner, repository).scanOnce(boxes);

  assert.equal(stats.tiles, 10);
  assert.equal(scanner.seen.length, 10);
  assert.equal(scanner.peakInFlight, 4, "không được vượt concurrency");
  assert.deepEqual(
    scanner.seen.map((b) => b.minLon).sort((a, b) => a - b),
    boxes.map((b) => b.minLon)
  );
});

test("writes to the store once per flush window, not once per vessel", async () => {
  const scanner = new StubScanner((_box, call) => [ship(`2000000${call}`), ship(`3000000${call}`)]);
  const repository = new CountingRepository();

  // 20 ô, flush mỗi 5 ô -> đúng 4 lần ghi cho 40 tàu.
  const stats = await build(scanner, repository, { flushEveryTiles: 5 }).scanOnce(tiles(20));

  assert.equal(stats.tiles, 20);
  assert.equal(repository.vesselWrites, 4);
  assert.equal(repository.positionWrites, 4);
  assert.equal((await repository.getAllLatestPositions()).length, 40);
});

test("flushes the remainder when a cycle ends between windows", async () => {
  const scanner = new StubScanner((_box, call) => [ship(`4000000${call}`)]);
  const repository = new CountingRepository();

  // 7 ô, flush mỗi 5 -> 1 lần đủ cửa sổ + 1 lần cho phần dư.
  await build(scanner, repository, { flushEveryTiles: 5 }).scanOnce(tiles(7));

  assert.equal(repository.vesselWrites, 2);
  assert.equal((await repository.getAllLatestPositions()).length, 7);
});

test("splits a truncated tile into 4 children and drops the parent payload", async () => {
  // Ô đầu trả 400 tàu (mp2 cắt bớt); các ô con trả 1 tàu.
  const dense = Array.from({ length: 400 }, (_, i) => ship(`50000${String(i).padStart(4, "0")}`));
  const scanner = new StubScanner((box, call) => (call === 0 ? dense : [ship(`6000000${call}`)]));
  const repository = new CountingRepository();

  const stats = await build(scanner, repository, { flushEveryTiles: 100 }).scanOnce(tiles(1));

  assert.equal(stats.subdivided, 1);
  assert.equal(stats.tiles, 5, "1 ô cha + 4 ô con");
  assert.equal(scanner.seen.length, 5);
  // 400 tàu của ô cha bị bỏ; chỉ 4 tàu của ô con được lưu.
  assert.equal(stats.ships, 4);
  assert.equal((await repository.getAllLatestPositions()).length, 4);
  // Ô con cao đúng nửa ô cha.
  for (const child of scanner.seen.slice(1)) {
    assert.equal(child.maxLat - child.minLat, 4.5);
  }
});

test("stops splitting at the minimum tile size", async () => {
  const dense = Array.from({ length: 400 }, (_, i) => ship(`70000${String(i).padStart(4, "0")}`));
  const scanner = new StubScanner(() => dense);
  const repository = new CountingRepository();

  // Ô cao 1° = minTileDeg -> không chia nữa, dữ liệu được nhận dù bị cắt bớt.
  const stats = await build(scanner, repository, { minTileDeg: 1 }).scanOnce([
    { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 },
  ]);

  assert.equal(stats.subdivided, 0);
  assert.equal(stats.tiles, 1);
  assert.equal(stats.ships, 400);
});

test("deduplicates a vessel seen in more than one tile within the same batch", async () => {
  const scanner = new StubScanner(() => [ship("888888888", "Same Boat")]);
  const repository = new CountingRepository();

  const stats = await build(scanner, repository, { flushEveryTiles: 100 }).scanOnce(tiles(6));

  assert.equal(stats.tiles, 6);
  assert.equal(stats.ships, 1, "6 ô cùng 1 tàu -> 1 op ghi, không đụng unique index");
  assert.equal((await repository.getAllLatestPositions()).length, 1);
});

test("retries a blocked tile once instead of losing coverage", async () => {
  const attempts = new Map<number, number>();
  const scanner = new StubScanner((box) => {
    const seen = (attempts.get(box.minLon) ?? 0) + 1;
    attempts.set(box.minLon, seen);
    // Ô số 0 bị chặn ở lần đầu, lần thử lại thành công.
    if (box.minLon === 0 && seen === 1) throw Errors.SCRAPE_BLOCKED();
    return [ship(`9000000${box.minLon}`)];
  });
  const repository = new CountingRepository();

  const stats = await build(scanner, repository, { flushEveryTiles: 100 }).scanOnce(tiles(3));

  assert.equal(stats.blocked, 1);
  assert.equal(stats.failed, 0);
  assert.equal(attempts.get(0), 2, "ô bị chặn được thử lại");
  assert.equal(stats.ships, 3, "không mất ô nào");
});

test("gives up on a tile that keeps failing and keeps scanning the rest", async () => {
  const scanner = new StubScanner((box) => {
    if (box.minLon === 1) throw Errors.SOURCE_ERROR("boom");
    return [ship(`9100000${box.minLon}`)];
  });
  const repository = new CountingRepository();

  const stats = await build(scanner, repository, { flushEveryTiles: 100 }).scanOnce(tiles(3));

  assert.equal(stats.failed, 1);
  assert.equal(stats.blocked, 0);
  assert.equal(stats.ships, 2, "2 ô còn lại vẫn được lưu");
});

test("stop() ends the cycle and still flushes what was already scanned", async () => {
  const repository = new CountingRepository();
  let scanArea: ScanArea;
  const scanner = new StubScanner((_box, call) => {
    if (call === 3) scanArea.stop(); // dừng ngay trong lượt đầu
    return [ship(`9200000${call}`)];
  });
  scanArea = build(scanner, repository);

  const stats = await scanArea.scanOnce(tiles(40));

  assert.equal(stats.tiles, 4, "dừng sau lượt đang chạy, không bỏ dở dữ liệu");
  assert.equal(stats.ships, 4);
  assert.equal((await repository.getAllLatestPositions()).length, 4);
});

test("a scan pass does not overwrite metadata that enrichment filled in", async () => {
  const repository = new InMemoryVesselRepository();
  // Tàu đã được enrich: có type + course/speed từ trang chi tiết.
  await repository.saveVessel(new Vessel({ mmsi: "555555555", name: "Real Name", type: "Cargo" }));
  await repository.savePositionLatest(
    new VesselPosition({ mmsi: "555555555", lat: 1, lon: 2, speedKn: 12, courseDeg: 90, navStatusText: "Under way" })
  );

  // Vòng quét sau chỉ có mmsi + toạ độ mới, và tên rỗng -> mp2 trả về mmsi.
  const scanner = new StubScanner(() => [{ mmsi: "555555555", name: "555555555", lat: 5, lon: 6 }]);
  await build(scanner, repository).scanOnce(tiles(1));

  const vessel = await repository.findVesselByMmsi("555555555");
  assert.equal(vessel?.type, "Cargo", "type do enrich điền phải còn");
  assert.equal(vessel?.name, "Real Name", "tên thật không bị mmsi ghi đè");

  const position = await repository.getLatestPosition("555555555");
  assert.equal(position?.lat, 5, "toạ độ mới được cập nhật");
  assert.equal(position?.speedKn, 12, "speed do enrich điền phải còn");
  assert.equal(position?.courseDeg, 90, "course do enrich điền phải còn");
});
