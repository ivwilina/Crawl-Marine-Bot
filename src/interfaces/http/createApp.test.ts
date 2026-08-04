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

/**
 * Harness riêng cho nearby / tìm theo tên: 3 tàu quanh Singapore, cách tâm
 * (1.0, 103.8) lần lượt ~0.6 / ~6 / ~60 hải lý. Để riêng để không đụng các
 * assertion đếm của /positions ở harness chính.
 */
async function buildGeoHarness(): Promise<Express> {
  const repository = new InMemoryVesselRepository();
  const fleet = [
    { mmsi: "563000001", name: "MAERSK ALPHA", imo: "9000001", lat: 1.01, lon: 103.8 },
    { mmsi: "563000002", name: "MAERSK BETA", imo: null, lat: 1.1, lon: 103.8 },
    { mmsi: "563000003", name: "EVER FAR", imo: null, lat: 2.0, lon: 103.8 },
  ];

  for (const ship of fleet) {
    await repository.saveVessel(
      new Vessel({ mmsi: ship.mmsi, imo: ship.imo, name: ship.name, type: "Container Ship" })
    );
    await repository.savePositionLatest(
      new VesselPosition({
        mmsi: ship.mmsi,
        lat: ship.lat,
        lon: ship.lon,
        receivedAt: "2026-07-30T11:59:00.000Z",
      })
    );
  }

  return createApp({
    getVesselDetails: new GetVesselDetails({
      detailsSource: new StubDetailsSource(),
      repository,
      cache: new InMemoryCache(),
    }),
    manageWatchlist: new ManageWatchlist(new InMemoryWatchlistRepository()),
    repository,
    apiKey: API_KEY,
    positionStaleAfterMs: HOUR_MS,
    now: () => NOW,
  });
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
  const response = await request(app, "/positions", { headers: KEY_HEADER });
  assert.equal(response.status, 200);
  assert.equal(response.body.count, 1);
  const positions = response.body.positions as Array<{ mmsi: string; name: string | null }>;
  assert.equal(positions[0].mmsi, KNOWN_ID);
  assert.equal(positions[0].name, "Fresh Boat");
});

test("uses the default position limit when a caller supplies a negative limit", async () => {
  const { app } = await buildHarness();
  const response = await request(app, "/positions?limit=-1", { headers: KEY_HEADER });
  assert.equal(response.status, 200);
  assert.equal(response.body.count, 1);
});

test("does not return a stale position inside a bounding box query", async () => {
  const { app } = await buildHarness();
  const response = await request(app, "/positions?bbox=-180,-90,180,90&limit=100", {
    headers: KEY_HEADER,
  });
  assert.equal(response.body.count, 1);
});

// ---- Tàu trong 1 khu vực map (nguồn cho mobile qua soosky api) ----

interface MapBody {
  count: number;
  truncated: boolean;
  limit: number;
  positions: Array<Record<string, unknown>>;
}

test("requires the API key for the map-area query", async () => {
  const app = await buildGeoHarness();
  assert.equal((await request(app, "/positions?bbox=103,0,105,2")).status, 401);
});

test("returns only the vessels inside the requested map area", async () => {
  const app = await buildGeoHarness();
  // Khung nhìn quanh Singapore: lấy 2 tàu ở lat 1.01 và 1.1, bỏ tàu ở lat 2.0.
  const body = (
    await request(app, "/positions?bbox=103,0.5,105,1.5", { headers: KEY_HEADER })
  ).body as unknown as MapBody;

  assert.equal(body.count, 2);
  assert.deepEqual(
    body.positions.map((p) => p.mmsi),
    ["563000001", "563000002"]
  );
});

test("sends a compact marker payload by default and the full record on request", async () => {
  const app = await buildGeoHarness();

  const compact = (
    await request(app, "/positions?bbox=103,0.5,105,1.5", { headers: KEY_HEADER })
  ).body as unknown as MapBody;
  assert.deepEqual(Object.keys(compact.positions[0]).sort(), [
    "courseDeg",
    "imo",
    "lat",
    "lon",
    "mmsi",
    "name",
    "navStatusText",
    "receivedAt",
    "speedKn",
    "type",
  ]);
  assert.equal(compact.positions[0].name, "MAERSK ALPHA");
  assert.equal(compact.positions[0].imo, "9000001");

  const full = (
    await request(app, "/positions?bbox=103,0.5,105,1.5&fields=full", { headers: KEY_HEADER })
  ).body as unknown as MapBody;
  assert.ok("lengthM" in full.positions[0], "fields=full mới trả thêm lý lịch");
  assert.ok("source" in full.positions[0]);
});

test("reports truncation instead of pretending the area is that empty", async () => {
  const app = await buildGeoHarness();
  const body = (
    await request(app, "/positions?bbox=103,0,105,3&limit=1", { headers: KEY_HEADER })
  ).body as unknown as MapBody;

  assert.equal(body.count, 1);
  assert.equal(body.limit, 1);
  assert.equal(body.truncated, true);
  // Cắt sau khi sắp theo mmsi -> cùng khung nhìn luôn ra cùng tàu, không nháy.
  assert.equal(body.positions[0].mmsi, "563000001");
});

test("splits a viewport that crosses the antimeridian", async () => {
  const app = await buildGeoHarness();
  // minLon 170 > maxLon -170: khung nhìn vắt qua 180°. Không tàu nào ở đó, cái
  // cần khẳng định là nó KHÔNG lỗi và KHÔNG trả cả kho.
  const response = await request(app, "/positions?bbox=170,-10,-170,10", { headers: KEY_HEADER });
  assert.equal(response.status, 200);
  assert.equal((response.body as unknown as MapBody).count, 0);
});

test("rejects a malformed bbox instead of silently returning the world", async () => {
  const app = await buildGeoHarness();
  for (const bbox of ["103,0.5,105", "a,b,c,d", "103,1.5,105,0.5", "200,0,205,2", "103,-95,105,2"]) {
    const response = await request(app, `/positions?bbox=${bbox}`, { headers: KEY_HEADER });
    assert.equal(response.status, 400, `bbox=${bbox} phải là 400`);
  }
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

// ---- Vessel Nearby: chạy trên dữ liệu đã crawl, 0 credit upstream ----

interface NearbyBody {
  count: number;
  radiusNm: number;
  center: { lat: number; lon: number; mmsi: string | null };
  vessels: Array<{ mmsi: string; name: string | null; type: string | null; distanceNm: number }>;
}

test("returns vessels within the radius, nearest first, from lat/lon", async () => {
  const app = await buildGeoHarness();
  const response = await request(app, "/nearby?lat=1.0&lon=103.8&radius=10");
  const body = response.body as unknown as NearbyBody;

  assert.equal(response.status, 200);
  // ~0.6 nm và ~6 nm nằm trong bán kính; ~60 nm thì không.
  assert.equal(body.count, 2);
  assert.deepEqual(
    body.vessels.map((v) => v.name),
    ["MAERSK ALPHA", "MAERSK BETA"]
  );
  assert.ok(body.vessels[0].distanceNm < body.vessels[1].distanceNm);
  assert.equal(body.vessels[0].type, "Container Ship", "lý lịch được join vào");
});

test("uses the crawled position of a given mmsi as the centre and excludes it", async () => {
  const app = await buildGeoHarness();
  const body = (await request(app, "/nearby?mmsi=563000001&radius=10")).body as unknown as NearbyBody;

  assert.equal(body.center.mmsi, "563000001");
  assert.equal(body.center.lat, 1.01);
  assert.equal(body.count, 1, "tàu làm tâm không tự xuất hiện trong kết quả");
  assert.equal(body.vessels[0].mmsi, "563000002");
});

test("defaults the nearby radius to 3 nautical miles", async () => {
  const app = await buildGeoHarness();
  const body = (await request(app, "/nearby?lat=1.0&lon=103.8")).body as unknown as NearbyBody;

  assert.equal(body.radiusNm, 3);
  assert.equal(body.count, 1, "chỉ tàu ~0.6 nm nằm trong 3 nm");
});

test("caps an oversized nearby radius instead of scanning the whole sea", async () => {
  const app = await buildGeoHarness();
  const body = (await request(app, "/nearby?lat=1.0&lon=103.8&radius=9999")).body as unknown as NearbyBody;

  assert.equal(body.radiusNm, 50);
});

test("rejects a nearby query with neither mmsi nor coordinates", async () => {
  const app = await buildGeoHarness();
  assert.equal((await request(app, "/nearby")).status, 400);
  assert.equal((await request(app, "/nearby?lat=91&lon=0")).status, 400);
});

test("answers 404 for a nearby centre that has never been crawled", async () => {
  const app = await buildGeoHarness();
  const response = await request(app, "/nearby?mmsi=999999999");
  assert.equal(response.status, 404);
});

// ---- Search by Name ----

interface SearchBody {
  count: number;
  vessels: Array<{ mmsi: string; imo: string | null; name: string | null }>;
}

test("finds vessels by name prefix, case-insensitively", async () => {
  const app = await buildGeoHarness();
  const body = (await request(app, "/vessels?name=maersk")).body as unknown as SearchBody;

  assert.equal(body.count, 2);
  assert.deepEqual(
    body.vessels.map((v) => v.name),
    ["MAERSK ALPHA", "MAERSK BETA"]
  );
  assert.equal(body.vessels[0].imo, "9000001");
});

test("rejects a name query shorter than 3 characters", async () => {
  const app = await buildGeoHarness();
  assert.equal((await request(app, "/vessels?name=ma")).status, 400);
  assert.equal((await request(app, "/vessels")).status, 400);
});

test("returns an empty list when no name matches", async () => {
  const app = await buildGeoHarness();
  const body = (await request(app, "/vessels?name=zzz")).body as unknown as SearchBody;
  assert.equal(body.count, 0);
});
