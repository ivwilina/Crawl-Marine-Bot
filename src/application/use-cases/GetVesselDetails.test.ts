// ============================================================================
//  TEST · GetVesselDetails — cache TTL tiêm từ ngoài, validate id, hit cache.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { GetVesselDetails } from "./GetVesselDetails";
import { ICache } from "../ports/ICache";
import { IVesselDetailsSource, VesselDetails } from "../ports/IVesselDetailsSource";
import { InMemoryVesselRepository } from "../../infrastructure/persistence/InMemoryVesselRepository";
import { Vessel } from "../../domain/entities/Vessel";
import { VesselPosition } from "../../domain/entities/VesselPosition";

const ID = "222222222";

class RecordingCache implements ICache {
  lastTtlMs: number | null = null;
  private readonly store = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T | undefined) ?? null;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.lastTtlMs = ttlMs;
    this.store.set(key, value);
  }
}

class CountingDetailsSource implements IVesselDetailsSource {
  calls = 0;

  async getDetails(id: string): Promise<VesselDetails> {
    this.calls += 1;
    return {
      vessel: new Vessel({ mmsi: id, name: "Stub Boat" }),
      position: new VesselPosition({ mmsi: id, lat: 1, lon: 2 }),
    };
  }
}

const NOW = new Date("2026-08-04T12:00:00.000Z");

function build(
  cacheTtlMs?: number,
  repository: InMemoryVesselRepository = new InMemoryVesselRepository()
): {
  useCase: GetVesselDetails;
  cache: RecordingCache;
  detailsSource: CountingDetailsSource;
  repository: InMemoryVesselRepository;
} {
  const cache = new RecordingCache();
  const detailsSource = new CountingDetailsSource();
  const useCase = new GetVesselDetails({
    detailsSource,
    repository,
    cache,
    cacheTtlMs,
    storeMaxAgeMs: 30 * 60 * 1000,
    now: () => NOW,
  });
  return { useCase, cache, detailsSource, repository };
}

/** Bản ghi "đã enrich": có type + course, tuổi `ageMs`. */
async function seedEnriched(ageMs: number): Promise<InMemoryVesselRepository> {
  const repository = new InMemoryVesselRepository();
  await repository.saveVessel(new Vessel({ mmsi: ID, imo: "9811983", name: "Stored Boat", type: "Cargo" }));
  await repository.savePositionLatest(
    new VesselPosition({
      mmsi: ID,
      lat: 10,
      lon: 20,
      courseDeg: 90,
      speedKn: 12,
      receivedAt: new Date(NOW.getTime() - ageMs).toISOString(),
    })
  );
  return repository;
}

test("uses the injected cache TTL", async () => {
  const { useCase, cache } = build(12_345);
  await useCase.execute(ID);
  assert.equal(cache.lastTtlMs, 12_345);
});

test("falls back to a 60s TTL when none is injected", async () => {
  const { useCase, cache } = build();
  await useCase.execute(ID);
  assert.equal(cache.lastTtlMs, 60_000);
});

test("serves the second call from cache without touching the source", async () => {
  const { useCase, detailsSource } = build(12_345);
  const first = await useCase.execute(ID);
  const second = await useCase.execute(ID);
  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, true);
  assert.equal(detailsSource.calls, 1);
});

test("rejects an invalid id before calling the source", async () => {
  const { useCase, detailsSource } = build(12_345);
  await assert.rejects(() => useCase.execute("not-an-id"), /E-1003|không hợp lệ/);
  assert.equal(detailsSource.calls, 0);
});

test("serves a fresh enriched record from the store without an upstream request", async () => {
  const { useCase, detailsSource } = build(60_000, await seedEnriched(5 * 60 * 1000));

  const result = await useCase.execute(ID);

  assert.equal(result.source, "store");
  assert.equal(result.vessel.name, "Stored Boat");
  assert.equal(result.position.courseDeg, 90);
  assert.equal(detailsSource.calls, 0, "crawler là nguồn chính -> không gọi lại VesselFinder");
});

test("finds the stored vessel by IMO as well as by MMSI", async () => {
  const { useCase, detailsSource } = build(60_000, await seedEnriched(5 * 60 * 1000));

  const result = await useCase.execute("9811983");

  assert.equal(result.source, "store");
  assert.equal(detailsSource.calls, 0);
});

test("goes upstream when the stored position is too old", async () => {
  const { useCase, detailsSource } = build(60_000, await seedEnriched(31 * 60 * 1000));

  const result = await useCase.execute(ID);

  assert.equal(result.source, "upstream");
  assert.equal(detailsSource.calls, 1);
});

test("goes upstream when the stored record never went through enrichment", async () => {
  // Bản ghi thuần từ mp2: có toạ độ, KHÔNG có type và course/speed.
  const repository = new InMemoryVesselRepository();
  await repository.saveVessel(new Vessel({ mmsi: ID, name: "Scan Only" }));
  await repository.savePositionLatest(
    new VesselPosition({ mmsi: ID, lat: 10, lon: 20, receivedAt: NOW.toISOString() })
  );
  const { useCase, detailsSource } = build(60_000, repository);

  const result = await useCase.execute(ID);

  assert.equal(result.source, "upstream", "màn detail cần course/speed mà mp2 không có");
  assert.equal(detailsSource.calls, 1);
});
