// ============================================================================
//  TEST · JsonFileVesselRepository — dọn vị trí mới nhất đã hết hạn.
//  Ghi vào thư mục tạm của HỆ ĐIỀU HÀNH, không đụng data/ của project.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { JsonFileVesselRepository } from "./JsonFileVesselRepository";
import { Vessel } from "../../domain/entities/Vessel";
import { VesselPosition } from "../../domain/entities/VesselPosition";

function tempRepo(): { repo: JsonFileVesselRepository; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crawlbot-json-repo-"));
  return { repo: new JsonFileVesselRepository(dir), dir };
}

test("deleteLatestPositionsOlderThan removes stale records but keeps vessels", async () => {
  const { repo, dir } = tempRepo();
  try {
    await repo.saveVessel(new Vessel({ mmsi: "111111111", name: "Old Boat" }));
    await repo.saveVessel(new Vessel({ mmsi: "222222222", name: "Fresh Boat" }));
    await repo.savePositionLatest(
      new VesselPosition({ mmsi: "111111111", lat: 1, lon: 2, receivedAt: "2026-07-29T00:00:00.000Z" })
    );
    await repo.savePositionLatest(
      new VesselPosition({ mmsi: "222222222", lat: 3, lon: 4, receivedAt: "2026-07-30T11:30:00.000Z" })
    );

    const removed = await repo.deleteLatestPositionsOlderThan(new Date("2026-07-30T11:00:00.000Z"));

    assert.equal(removed, 1);
    assert.deepEqual(
      (await repo.getAllLatestPositions()).map((p) => p.mmsi),
      ["222222222"]
    );
    assert.equal((await repo.findVesselByMmsi("111111111"))?.name, "Old Boat");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup removes only latest map state and preserves position history", async () => {
  const { repo, dir } = tempRepo();
  try {
    const historical = new VesselPosition({
      mmsi: "111111111",
      lat: 1,
      lon: 2,
      receivedAt: "2026-07-29T00:00:00.000Z",
    });
    const current = new VesselPosition({
      mmsi: "111111111",
      lat: 3,
      lon: 4,
      receivedAt: "2026-07-30T11:30:00.000Z",
    });

    await repo.savePosition(historical);
    await repo.savePositionLatest(current);
    await repo.deleteLatestPositionsOlderThan(new Date("2026-07-30T12:00:00.000Z"));

    const history = JSON.parse(fs.readFileSync(path.join(dir, "positions.json"), "utf-8")) as VesselPosition[];
    assert.equal(history.length, 1);
    assert.equal(history[0].receivedAt, historical.receivedAt);
    assert.deepEqual(await repo.getAllLatestPositions(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("migrates legacy positions into separate latest map state without deleting history", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crawlbot-json-repo-"));
  try {
    const legacy = [
      new VesselPosition({ mmsi: "111111111", lat: 1, lon: 2, receivedAt: "2026-07-29T00:00:00.000Z" }),
      new VesselPosition({ mmsi: "111111111", lat: 3, lon: 4, receivedAt: "2026-07-30T11:30:00.000Z" }),
    ];
    fs.writeFileSync(path.join(dir, "positions.json"), JSON.stringify(legacy), "utf-8");

    const repo = new JsonFileVesselRepository(dir);

    assert.deepEqual((await repo.getAllLatestPositions()).map((p) => p.receivedAt), [legacy[1].receivedAt]);
    assert.equal(
      (JSON.parse(fs.readFileSync(path.join(dir, "positions.json"), "utf-8")) as VesselPosition[]).length,
      2
    );
    assert.equal(fs.existsSync(path.join(dir, "latest_positions.json")), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteLatestPositionsOlderThan returns 0 and leaves the file untouched when nothing is stale", async () => {
  const { repo, dir } = tempRepo();
  try {
    await repo.savePositionLatest(
      new VesselPosition({ mmsi: "222222222", lat: 3, lon: 4, receivedAt: "2026-07-30T11:30:00.000Z" })
    );
    const before = fs.readFileSync(path.join(dir, "positions.json"), "utf-8");

    const removed = await repo.deleteLatestPositionsOlderThan(new Date("2026-07-30T11:00:00.000Z"));

    assert.equal(removed, 0);
    assert.equal(fs.readFileSync(path.join(dir, "positions.json"), "utf-8"), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("read methods exclude latest positions older than freshSince", async () => {
  const { repo, dir } = tempRepo();
  try {
    await repo.savePositionLatest(
      new VesselPosition({ mmsi: "111111111", lat: 1, lon: 2, receivedAt: "2026-07-29T00:00:00.000Z" })
    );
    await repo.savePositionLatest(
      new VesselPosition({ mmsi: "222222222", lat: 3, lon: 4, receivedAt: "2026-07-30T11:30:00.000Z" })
    );
    const freshSince = new Date("2026-07-30T11:00:00.000Z");

    assert.deepEqual(
      (await repo.getAllLatestPositions(freshSince)).map((p) => p.mmsi),
      ["222222222"]
    );
    assert.deepEqual(
      (
        await repo.getLatestPositionsInBbox(
          { minLat: -90, minLon: -180, maxLat: 90, maxLon: 180 },
          100,
          freshSince
        )
      ).map((p) => p.mmsi),
      ["222222222"]
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
