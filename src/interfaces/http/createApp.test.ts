// ============================================================================
//  TEST · createApp — tích hợp HTTP thật (http.createServer + fetch), KHÔNG cần
//  MongoDB: repository/watchlist/cache đều chạy trong RAM.
//  Khoá API dùng trong test là giá trị bịa, không phải khoá thật.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp } from "./createApp";
import { GetVesselDetails } from "../../application/use-cases/GetVesselDetails";
import { ManageWatchlist } from "../../application/use-cases/ManageWatchlist";
import { IVesselDetailsSource, VesselDetails } from "../../application/ports/IVesselDetailsSource";
import { InMemoryVesselRepository } from "../../infrastructure/persistence/InMemoryVesselRepository";
import { InMemoryWatchlistRepository } from "../../infrastructure/persistence/InMemoryWatchlistRepository";
import { InMemoryCache } from "../../infrastructure/cache/InMemoryCache";
import { Vessel } from "../../domain/entities/Vessel";
import { VesselPosition } from "../../domain/entities/VesselPosition";
import { Errors } from "../../domain/errors/AppError";

const API_KEY = "test-key";
const KEY_HEADER = { "X-API-Key": API_KEY };
const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date("2026-07-30T12:00:00.000Z");

const KNOWN_ID = "222222222"; // có ở nguồn
const MISSING_ID = "9811983"; // nguồn trả "không tìm thấy"
const BROKEN_ID = "333333333"; // nguồn lỗi hạ tầng -> 502

/** Nguồn dữ liệu giả: không gọi mạng, phản hồi theo id. */
class StubDetailsSource implements IVesselDetailsSource {
  async getDetails(id: string): Promise<VesselDetails> {
    if (id === MISSING_ID) throw Errors.SHIP_NOT_FOUND(id);
    if (id === BROKEN_ID) throw new Error("upstream unavailable");
    return {
      vessel: new Vessel({ mmsi: id, name: "Stub Boat", type: "Cargo" }),
      position: new VesselPosition({ mmsi: id, lat: 10, lon: 20, receivedAt: NOW.toISOString() }),
    };
  }
}

interface Harness {
  app: Express;
  watchlistRepository: InMemoryWatchlistRepository;
}

async function buildHarness(): Promise<Harness> {
  const repository = new InMemoryVesselRepository();
  await repository.saveVessel(new Vessel({ mmsi: "111111111", name: "Old Boat" }));
  await repository.saveVessel(new Vessel({ mmsi: KNOWN_ID, name: "Fresh Boat" }));
  // 1 vị trí hết hạn (hơn 1 giờ) + 1 vị trí còn tươi.
  await repository.savePositionLatest(
    new VesselPosition({ mmsi: "111111111", lat: 1, lon: 2, receivedAt: "2026-07-29T00:00:00.000Z" })
  );
  await repository.savePositionLatest(
    new VesselPosition({ mmsi: KNOWN_ID, lat: 3, lon: 4, receivedAt: "2026-07-30T11:30:00.000Z" })
  );

  const watchlistRepository = new InMemoryWatchlistRepository();
  const app = createApp({
    getVesselDetails: new GetVesselDetails({
      detailsSource: new StubDetailsSource(),
      repository,
      cache: new InMemoryCache(),
      cacheTtlMs: 60_000,
    }),
    manageWatchlist: new ManageWatchlist(watchlistRepository),
    repository,
    apiKey: API_KEY,
    positionStaleAfterMs: HOUR_MS,
    now: () => NOW,
  });
  return { app, watchlistRepository };
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

/** Bật server thật trên cổng tự do, gọi fetch, LUÔN đóng server ở finally. */
async function request(app: Express, pathname: string, options: RequestOptions = {}): Promise<HttpResult> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const { port } = server.address() as AddressInfo;
    const headers: Record<string, string> = { ...options.headers };
    let payload: string | undefined;
    if (options.body !== undefined) {
      payload = JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
    }
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: options.method ?? "GET",
      headers,
      body: payload,
    });
    const text = await response.text();
    const body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
    return { status: response.status, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("health check stays open without an API key", async () => {
  const { app } = await buildHarness();
  const response = await request(app, "/health");
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "ok");
});

test("rejects watchlist changes without the configured API key", async () => {
  const { app, watchlistRepository } = await buildHarness();
  const response = await request(app, "/watchlist", { method: "POST", body: { id: "9811983" } });
  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { code: "E-1004", error: "Unauthorized" });
  assert.deepEqual(await watchlistRepository.getAll(), []);
});

test("rejects an incorrect API key", async () => {
  const { app } = await buildHarness();
  const response = await request(app, "/watchlist", { headers: { "X-API-Key": "wrong-key" } });
  assert.equal(response.status, 401);
});

test("protects reading the watchlist and deleting from it", async () => {
  const { app } = await buildHarness();
  assert.equal((await request(app, "/watchlist")).status, 401);
  assert.equal((await request(app, "/watchlist/9811983", { method: "DELETE" })).status, 401);
});

test("accepts a keyed watchlist change", async () => {
  const { app, watchlistRepository } = await buildHarness();
  const response = await request(app, "/watchlist", {
    method: "POST",
    headers: KEY_HEADER,
    body: { id: "9811983" },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await watchlistRepository.getAll(), ["9811983"]);
});

test("requires the API key for vessel detail lookups", async () => {
  const { app } = await buildHarness();
  assert.equal((await request(app, `/vessel/${KNOWN_ID}`)).status, 401);
});

test("does not return a stale position", async () => {
  const { app } = await buildHarness();
  const response = await request(app, "/positions");
  assert.equal(response.status, 200);
  assert.equal(response.body.count, 1);
  const positions = response.body.positions as Array<{ mmsi: string; name: string | null }>;
  assert.equal(positions[0].mmsi, KNOWN_ID);
  assert.equal(positions[0].name, "Fresh Boat");
});

test("uses the default position limit when a caller supplies a negative limit", async () => {
  const { app } = await buildHarness();
  const response = await request(app, "/positions?limit=-1");
  assert.equal(response.status, 200);
  assert.equal(response.body.count, 1);
});

test("does not return a stale position inside a bounding box query", async () => {
  const { app } = await buildHarness();
  const response = await request(app, "/positions?bbox=-180,-90,180,90&limit=100");
  assert.equal(response.body.count, 1);
});

test("maps invalid IDs to 400 and missing vessels to 404", async () => {
  const { app } = await buildHarness();
  assert.equal((await request(app, "/vessel/not-an-id", { headers: KEY_HEADER })).status, 400);
  assert.equal((await request(app, `/vessel/${MISSING_ID}`, { headers: KEY_HEADER })).status, 404);
});

test("maps upstream failures to 502", async () => {
  const { app } = await buildHarness();
  const response = await request(app, `/vessel/${BROKEN_ID}`, { headers: KEY_HEADER });
  assert.equal(response.status, 502);
});

test("returns vessel details for a keyed request", async () => {
  const { app } = await buildHarness();
  const response = await request(app, `/vessel/${KNOWN_ID}`, { headers: KEY_HEADER });
  assert.equal(response.status, 200);
  assert.equal((response.body.vessel as { name: string }).name, "Stub Boat");
  assert.equal(response.body.fromCache, false);
});

test("unknown routes answer 404", async () => {
  const { app } = await buildHarness();
  assert.equal((await request(app, "/nope")).status, 404);
});
