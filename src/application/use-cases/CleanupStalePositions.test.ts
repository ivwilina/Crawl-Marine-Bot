// ============================================================================
//  TEST · CleanupStalePositions — offline, dùng repository trong RAM.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { CleanupStalePositions } from "./CleanupStalePositions";
import { InMemoryVesselRepository } from "../../infrastructure/persistence/InMemoryVesselRepository";
import { Vessel } from "../../domain/entities/Vessel";
import { VesselPosition } from "../../domain/entities/VesselPosition";

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date("2026-07-30T12:00:00.000Z");

function position(mmsi: string, receivedAt: string): VesselPosition {
  return new VesselPosition({ mmsi, lat: 10, lon: 20, receivedAt });
}

async function repoWithOldAndFresh(): Promise<InMemoryVesselRepository> {
  const repo = new InMemoryVesselRepository();
  await repo.saveVessel(new Vessel({ mmsi: "111111111", name: "Old Boat" }));
  await repo.saveVessel(new Vessel({ mmsi: "222222222", name: "Fresh Boat" }));
  await repo.savePosition(position("111111111", "2026-07-29T00:00:00.000Z"));
  await repo.savePositionLatest(position("111111111", "2026-07-29T00:00:00.000Z"));
  await repo.savePositionLatest(position("222222222", "2026-07-30T11:30:00.000Z"));
  return repo;
}

test("removes only latest positions older than the configured cutoff", async () => {
  const repo = await repoWithOldAndFresh();
  const useCase = new CleanupStalePositions({ repo, staleAfterMs: HOUR_MS });

  assert.equal(await useCase.execute(NOW), 1);
  const remaining = await repo.getAllLatestPositions();
  assert.deepEqual(
    remaining.map((p) => p.mmsi),
    ["222222222"]
  );
});

test("keeps vessel metadata and position history", async () => {
  const repo = await repoWithOldAndFresh();
  const useCase = new CleanupStalePositions({ repo, staleAfterMs: HOUR_MS });

  await useCase.execute(NOW);

  assert.equal((await repo.findVesselByMmsi("111111111"))?.name, "Old Boat");
  assert.deepEqual(
    repo.positionHistory().map((p) => p.mmsi),
    ["111111111"]
  );
});

test("removes nothing when every latest position is fresh", async () => {
  const repo = await repoWithOldAndFresh();
  const useCase = new CleanupStalePositions({ repo, staleAfterMs: 48 * HOUR_MS });

  assert.equal(await useCase.execute(NOW), 0);
  assert.equal((await repo.getAllLatestPositions()).length, 2);
});

test("hides stale latest positions from reads even before cleanup runs", async () => {
  const repo = await repoWithOldAndFresh();
  const freshSince = new Date(NOW.getTime() - HOUR_MS);

  const all = await repo.getAllLatestPositions(freshSince);
  assert.deepEqual(
    all.map((p) => p.mmsi),
    ["222222222"]
  );

  const inBox = await repo.getLatestPositionsInBbox(
    { minLat: -90, minLon: -180, maxLat: 90, maxLon: 180 },
    100,
    freshSince
  );
  assert.deepEqual(
    inBox.map((p) => p.mmsi),
    ["222222222"]
  );
});
