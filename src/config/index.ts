// ============================================================================
//  CONFIG · Cấu hình tập trung, đọc từ file .env
// ----------------------------------------------------------------------------
//  "dotenv/config" phải nạp TRƯỚC khi đọc process.env -> đặt ở dòng đầu tiên.
// ============================================================================

import "dotenv/config";
import * as path from "path";
import { BoundingBox } from "../application/ports/Geo";

export interface AppConfig {
  dataDir: string;
  mongoUri: string;
  redisUrl: string;
  httpPort: number;
  cacheTtlMs: number;
  crawlEveryMs: number;
  crawlDelayMs: number;
  scanMinMs: number;
  scanMaxMs: number;
  scanZoom: number;
  scanTileDelayMinMs: number; // nghỉ giữa 2 ô (chống ban)
  scanTileDelayMaxMs: number;
  scanSubdivideThreshold: number; // ô >= ngần này tàu -> chia 4
  scanMinTileDeg: number; // ngừng chia khi ô nhỏ hơn
  scanBlockCooldownMs: number; // bị chặn -> nghỉ dài
  enrichBatchSize: number;
  enrichDelayMs: number;
  enrichIntervalMs: number;
  watchlist: string[];
  scanBoundingBoxes: BoundingBox[];
}

// --- tiện ích đọc biến môi trường có kiểu ---
function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v !== undefined && v !== "" ? Number(v) : fallback;
}
function str(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}
// Đọc "WATCHLIST=9811983,305803000" -> ["9811983","305803000"]
function parseWatchlist(): string[] {
  return str("WATCHLIST")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Đọc "SCAN_BBOX=1.0,103.0,1.6,104.5" -> 1 bounding box, hoặc nhiều vùng cách
// nhau bằng ";". ScanArea sẽ quét tuần tự từng vùng.
function parseBBox(): BoundingBox[] {
  return str("SCAN_BBOX")
    .split(";")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => chunk.split(",").map((s) => Number(s.trim())))
    .filter((parts) => parts.length === 4 && parts.every((n) => !Number.isNaN(n)))
    .map(([minLat, minLon, maxLat, maxLon]) => ({ minLat, minLon, maxLat, maxLon }));
}

export const config: AppConfig = {
  dataDir: path.join(__dirname, "..", "..", "data"),
  mongoUri: str("MONGODB_URI"),
  redisUrl: str("REDIS_URL"),
  httpPort: num("PORT", 3000),
  cacheTtlMs: num("CACHE_TTL_MS", 60000),
  crawlEveryMs: num("CRAWL_EVERY_MS", 2 * 60 * 60 * 1000),
  crawlDelayMs: num("CRAWL_DELAY_MS", 1500),
  // Scanner refreshes at a fixed, low operational frequency. It is not an
  // access-control bypass and must remain disabled if the source forbids use.
  scanMinMs: num("SCAN_INTERVAL_MS", 6 * 60 * 60 * 1000),
  scanMaxMs: num("SCAN_INTERVAL_MS", 6 * 60 * 60 * 1000),
  scanZoom: num("SCAN_ZOOM", 9),
  scanTileDelayMinMs: num("SCAN_TILE_DELAY_MS", 15000),
  scanTileDelayMaxMs: num("SCAN_TILE_DELAY_MS", 15000),
  scanSubdivideThreshold: num("SCAN_SUBDIVIDE_THRESHOLD", 400),
  scanMinTileDeg: num("SCAN_MIN_TILE_DEG", 1),
  scanBlockCooldownMs: num("SCAN_BLOCK_COOLDOWN_MS", 15 * 60 * 1000),
  // Bổ sung type/flag cho tàu quét từ mp2 (chỉ có mmsi) — tra chậm, batch nhỏ.
  enrichBatchSize: num("ENRICH_BATCH_SIZE", 15),
  enrichDelayMs: num("ENRICH_DELAY_MS", 2000),
  enrichIntervalMs: num("ENRICH_INTERVAL_MS", 5 * 60 * 1000),
  // Xoá tàu quét từ vùng (không phải watchlist) không thấy lại sau ngần này ms.
  watchlist: parseWatchlist(),
  scanBoundingBoxes: parseBBox(),
};
