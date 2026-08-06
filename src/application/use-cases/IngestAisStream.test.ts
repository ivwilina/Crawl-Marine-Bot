// ============================================================================
//  TEST · IngestAisStream — offline, không WebSocket, không MongoDB.
//  Stream là stub phát message theo lệnh; kho là InMemoryVesselRepository.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { IngestAisStream } from "./IngestAisStream";
import {
  AisPositionMessage,
  AisStaticMessage,
  IAisStream,
} from "../ports/IAisStream";
import { BoundingBox } from "../ports/Geo";
import { InMemoryVesselRepository } from "../../infrastructure/persistence/InMemoryVesselRepository";
import { Vessel } from "../../domain/entities/Vessel";
import { VesselPosition } from "../../domain/entities/VesselPosition";

/** Stream giả: test tự quyết định khi nào có message. */
class StubStream implements IAisStream {
  connected = 0;
  stopped = 0;
  boxes: BoundingBox[] = [];
  private position: ((m: AisPositionMessage) => void) | undefined;
  private staticData: ((m: AisStaticMessage) => void) | undefined;

  onPosition(handler: (m: AisPositionMessage) => void): void {
    this.position = handler;
  }
  onStatic(handler: (m: AisStaticMessage) => void): void {
    this.staticData = handler;
  }
  async connect(boxes: BoundingBox[]): Promise<void> {
    this.connected += 1;
    this.boxes = boxes;
  }
  stop(): void {
    this.stopped += 1;
  }

  emitPosition(m: Partial<AisPositionMessage> & { mmsi: string; receivedAt: string }): void {
    this.position?.({
      lat: 1,
      lon: 103,
      speedKn: 10,
      courseDeg: 90,
      headingDeg: 91,
      navStatusCode: 0,
      navStatusText: "Under way using engine",
      ...m,
    });
  }
  emitStatic(m: Partial<AisStaticMessage> & { mmsi: string }): void {
    this.staticData?.({ imo: null, name: null, aisType: null, ...m });
  }
}

/** Đếm số LẦN ghi DB — con số quyết định DB có bị dồn hay không. */
class CountingRepository extends InMemoryVesselRepository {
  positionWrites = 0;
  vesselWrites = 0;

  async savePositionsFromAis(positions: VesselPosition[]): Promise<number> {
    this.positionWrites += 1;
    return super.savePositionsFromAis(positions);
  }
  async upsertVesselsFromAis(vessels: Vessel[]): Promise<number> {
    this.vesselWrites += 1;
    return super.upsertVesselsFromAis(vessels);
  }
}

function build(flushMaxSize = 100) {
  const stream = new StubStream();
  const repository = new CountingRepository();
  const ingest = new IngestAisStream({
    stream,
    repository,
    // Chu kỳ rất dài: test tự kích flush bằng ngưỡng kích thước hoặc stop().
    flushEveryMs: 60 * 60 * 1000,
    flushMaxSize,
  });
  return { stream, repository, ingest };
}

const T1 = "2026-08-06T03:00:00.000Z";
const T2 = "2026-08-06T03:05:00.000Z";

test("subscribes to the configured regions on start", async () => {
  const { stream, ingest } = build();
  const boxes = [{ minLat: 1, minLon: 103, maxLat: 2, maxLon: 104 }];

  await ingest.start(boxes);

  assert.equal(stream.connected, 1);
  assert.deepEqual(stream.boxes, boxes);
  await ingest.stop();
});

test("batches many messages into a single database write", async () => {
  const { stream, repository, ingest } = build(3);
  await ingest.start([]);

  stream.emitPosition({ mmsi: "111111111", receivedAt: T1 });
  stream.emitPosition({ mmsi: "222222222", receivedAt: T1 });
  stream.emitPosition({ mmsi: "333333333", receivedAt: T1 });
  // Ngưỡng 3 -> đã ghi 1 lần ở đây.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(repository.positionWrites, 1, "3 message -> 1 lệnh ghi");
  assert.equal((await repository.getAllLatestPositions()).length, 3);

  await ingest.stop();
});

test("keeps only the newest report per vessel inside a batch", async () => {
  const { stream, repository, ingest } = build();
  await ingest.start([]);

  stream.emitPosition({ mmsi: "111111111", lat: 1, receivedAt: T1 });
  stream.emitPosition({ mmsi: "111111111", lat: 5, receivedAt: T2 });
  // Bản cũ tới SAU bản mới: AIS không đảm bảo thứ tự.
  stream.emitPosition({ mmsi: "111111111", lat: 9, receivedAt: T1 });
  await ingest.stop();

  const position = await repository.getLatestPosition("111111111");
  assert.equal(position?.lat, 5, "bản mới nhất thắng, không phải bản tới cuối");
  assert.equal(repository.positionWrites, 1, "3 message cùng tàu -> 1 op ghi");
});

test("flushes whatever is buffered when stopping", async () => {
  const { stream, repository, ingest } = build();
  await ingest.start([]);

  stream.emitPosition({ mmsi: "444444444", receivedAt: T1 });
  assert.equal(repository.positionWrites, 0, "chưa tới ngưỡng thì chưa ghi");

  await ingest.stop();

  assert.equal(repository.positionWrites, 1);
  assert.equal(stream.stopped, 1);
  assert.equal((await repository.getAllLatestPositions()).length, 1);
});

test("writes course, speed and nav status — the fields the map scan cannot give", async () => {
  const { stream, repository, ingest } = build();
  await ingest.start([]);

  stream.emitPosition({
    mmsi: "555555555",
    lat: 1.5,
    lon: 103.5,
    speedKn: 12.4,
    courseDeg: 214,
    headingDeg: 210,
    navStatusCode: 1,
    navStatusText: "At anchor",
    receivedAt: T1,
  });
  await ingest.stop();

  const position = await repository.getLatestPosition("555555555");
  assert.equal(position?.speedKn, 12.4);
  assert.equal(position?.courseDeg, 214);
  assert.equal(position?.headingDeg, 210);
  assert.equal(position?.navStatusCode, 1);
  assert.equal(position?.navStatusText, "At anchor");
  assert.equal(position?.source, "ais");
  assert.equal(position?.latLonApproximate, false, "AIS cho toạ độ chính xác");
});

test("links IMO to MMSI and records the numeric AIS type", async () => {
  const { stream, repository, ingest } = build();
  await ingest.start([]);

  stream.emitStatic({ mmsi: "666666666", imo: "9247431", name: "REGAL I", aisType: 80 });
  await ingest.stop();

  const vessel = await repository.findVesselByMmsi("666666666");
  assert.equal(vessel?.imo, "9247431", "đây là thứ mp2 không bao giờ có");
  assert.equal(vessel?.aisType, 80);
  assert.equal(vessel?.name, "REGAL I");
});

test("fills gaps from AIS without overwriting what enrichment already found", async () => {
  const { stream, repository, ingest } = build();
  // Bản ghi đã enrich: tên sạch + loại cụ thể dạng chữ.
  await repository.saveVessel(
    new Vessel({ mmsi: "777777777", name: "Ever Given", type: "Container Ship" })
  );
  await ingest.start([]);

  // AIS gửi tên viết hoa và mã số — chỉ được điền chỗ trống.
  stream.emitStatic({ mmsi: "777777777", imo: "9811000", name: "EVER GIVEN", aisType: 70 });
  await ingest.stop();

  const vessel = await repository.findVesselByMmsi("777777777");
  assert.equal(vessel?.name, "Ever Given", "tên đã có không bị AIS ghi đè");
  assert.equal(vessel?.type, "Container Ship", "loại dạng chữ vẫn còn");
  assert.equal(vessel?.imo, "9811000", "imo còn trống -> được điền");
  assert.equal(vessel?.aisType, 70, "aisType còn trống -> được điền");
});

test("does not let a late AIS report move a vessel back in time", async () => {
  const { stream, repository, ingest } = build();
  await ingest.start([]);

  stream.emitPosition({ mmsi: "888888888", lat: 5, receivedAt: T2 });
  await ingest.stop();

  // Mẻ sau mang bản ghi CŨ hơn — ví dụ một vòng scan tới muộn.
  await repository.savePositionsFromScan([
    new VesselPosition({ mmsi: "888888888", lat: 1, lon: 2, receivedAt: T1 }),
  ]);

  const position = await repository.getLatestPosition("888888888");
  assert.equal(position?.lat, 5, "bản mới hơn phải được giữ");
});

test("a newer scan still wins over an older AIS report", async () => {
  const { stream, repository, ingest } = build();
  await ingest.start([]);

  stream.emitPosition({ mmsi: "999999999", lat: 5, receivedAt: T1 });
  await ingest.stop();

  await repository.savePositionsFromScan([
    new VesselPosition({ mmsi: "999999999", lat: 1, lon: 2, receivedAt: T2 }),
  ]);

  const position = await repository.getLatestPosition("999999999");
  assert.equal(position?.lat, 1, "guard chỉ chặn bản CŨ, không chặn bản mới");
  assert.equal(position?.speedKn, 10, "field AIS không bị mẻ scan xoá");
});
