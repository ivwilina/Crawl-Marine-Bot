// ============================================================================
//  CONFIG · Cấu hình tập trung, đọc từ file .env
// ----------------------------------------------------------------------------
//  "dotenv/config" phải nạp TRƯỚC khi đọc process.env -> đặt ở dòng đầu tiên.
//  `loadConfig(env)` nhận env tường minh để test được, không đụng process.env.
//  Số sai (không phải số hữu hạn / ngoài phạm vi) -> THROW ngay lúc khởi động,
//  thay vì lặng lẽ chạy với NaN.
// ============================================================================

import "dotenv/config";
import * as path from "path";
import { BoundingBox } from "../application/ports/Geo";

export interface AppConfig {
  dataDir: string;
  mongoUri: string;
  redisUrl: string;
  /** Địa chỉ bind của HTTP server. Mặc định loopback -> không lộ ra internet. */
  httpHost: string;
  httpPort: number;
  /** Khoá bắt buộc cho các route ghi/gọi upstream (header X-API-Key). */
  apiKey: string;
  cacheTtlMs: number;
  /** Vị trí mới nhất cũ hơn ngần này ms bị coi là hết hạn (không trả về nữa). */
  positionStaleAfterMs: number;
  /** Chu kỳ dọn vị trí mới nhất đã hết hạn. */
  positionCleanupEveryMs: number;
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

type Env = NodeJS.ProcessEnv;

export interface NumConstraints {
  min?: number;
  max?: number;
}

// --- tiện ích đọc biến môi trường có kiểu ---
function str(env: Env, name: string, fallback = ""): string {
  const v = env[name];
  return v !== undefined && v.trim() !== "" ? v : fallback;
}

/** Số hữu hạn trong phạm vi cho phép; sai -> throw kèm tên biến. */
function num(env: Env, name: string, fallback: number, constraints: NumConstraints = {}): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Config ${name} phải là số hữu hạn, nhận "${raw}".`);
  }
  const { min, max } = constraints;
  if (min !== undefined && value < min) {
    throw new Error(`Config ${name} phải >= ${min}, nhận ${value}.`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`Config ${name} phải <= ${max}, nhận ${value}.`);
  }
  return value;
}

/** Bắt buộc > 0 (khoảng thời gian, TTL, chu kỳ...). */
function positiveNum(env: Env, name: string, fallback: number): number {
  return num(env, name, fallback, { min: 1 });
}

/** Cho phép 0 (delay/batch có thể tắt bằng 0). */
function nonNegativeNum(env: Env, name: string, fallback: number): number {
  return num(env, name, fallback, { min: 0 });
}

// Đọc "WATCHLIST=9811983,305803000" -> ["9811983","305803000"]
function parseWatchlist(env: Env): string[] {
  return str(env, "WATCHLIST")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Đọc "SCAN_BBOX=1.0,103.0,1.6,104.5" -> 1 bounding box, hoặc nhiều vùng cách
// nhau bằng ";". ScanArea sẽ quét tuần tự từng vùng.
function parseBBox(env: Env): BoundingBox[] {
  return str(env, "SCAN_BBOX")
    .split(";")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => chunk.split(",").map((s) => Number(s.trim())))
    .filter((parts) => parts.length === 4 && parts.every((n) => !Number.isNaN(n)))
    .map(([minLat, minLon, maxLat, maxLon]) => ({ minLat, minLon, maxLat, maxLon }));
}

export function loadConfig(env: Env = process.env): AppConfig {
  return {
    dataDir: path.join(__dirname, "..", "..", "data"),
    mongoUri: str(env, "MONGODB_URI"),
    redisUrl: str(env, "REDIS_URL"),
    // Mặc định chỉ nghe loopback: muốn public thì đặt reverse proxy phía trước.
    httpHost: str(env, "HTTP_HOST", "127.0.0.1"),
    httpPort: num(env, "PORT", 3000, { min: 1, max: 65535 }),
    // Không có mặc định: server HTTP tự từ chối khởi động nếu để trống.
    apiKey: str(env, "API_KEY"),
    cacheTtlMs: positiveNum(env, "CACHE_TTL_MS", 60_000),
    // Vị trí map cũ hơn ngần này -> ẩn khỏi API và bị dọn khỏi latest_positions.
    positionStaleAfterMs: positiveNum(env, "POSITION_STALE_AFTER_MS", 24 * 60 * 60 * 1000),
    positionCleanupEveryMs: positiveNum(env, "POSITION_CLEANUP_EVERY_MS", 60 * 60 * 1000),
    crawlEveryMs: positiveNum(env, "CRAWL_EVERY_MS", 2 * 60 * 60 * 1000),
    crawlDelayMs: nonNegativeNum(env, "CRAWL_DELAY_MS", 1500),
    // Scanner refreshes at a fixed, low operational frequency. It is not an
    // access-control bypass and must remain disabled if the source forbids use.
    scanMinMs: positiveNum(env, "SCAN_INTERVAL_MS", 6 * 60 * 60 * 1000),
    scanMaxMs: positiveNum(env, "SCAN_INTERVAL_MS", 6 * 60 * 60 * 1000),
    scanZoom: num(env, "SCAN_ZOOM", 9, { min: 0, max: 22 }),
    scanTileDelayMinMs: nonNegativeNum(env, "SCAN_TILE_DELAY_MS", 15_000),
    scanTileDelayMaxMs: nonNegativeNum(env, "SCAN_TILE_DELAY_MS", 15_000),
    scanSubdivideThreshold: positiveNum(env, "SCAN_SUBDIVIDE_THRESHOLD", 400),
    scanMinTileDeg: num(env, "SCAN_MIN_TILE_DEG", 1, { min: 0.01, max: 180 }),
    scanBlockCooldownMs: positiveNum(env, "SCAN_BLOCK_COOLDOWN_MS", 15 * 60 * 1000),
    // Bổ sung type/flag cho tàu quét từ mp2 (chỉ có mmsi) — tra chậm, batch nhỏ.
    // 0 = tắt enrich.
    enrichBatchSize: nonNegativeNum(env, "ENRICH_BATCH_SIZE", 15),
    enrichDelayMs: nonNegativeNum(env, "ENRICH_DELAY_MS", 2000),
    enrichIntervalMs: positiveNum(env, "ENRICH_INTERVAL_MS", 5 * 60 * 1000),
    watchlist: parseWatchlist(env),
    scanBoundingBoxes: parseBBox(env),
  };
}

export const config: AppConfig = loadConfig();
