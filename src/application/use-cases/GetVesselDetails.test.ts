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

function build(cacheTtlMs?: number): {
  useCase: GetVesselDetails;
  cache: RecordingCache;
  detailsSource: CountingDetailsSource;
} {
  const cache = new RecordingCache();
  const detailsSource = new CountingDetailsSource();
  const useCase = new GetVesselDetails({
    detailsSource,
    repository: new InMemoryVesselRepository(),
    cache,
    cacheTtlMs,
  });
  return { useCase, cache, detailsSource };
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
