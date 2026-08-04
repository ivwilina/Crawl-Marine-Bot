// ============================================================================
//  COMPOSITION ROOT · container.ts — nơi DUY NHẤT ráp mọi mảnh lại
// ----------------------------------------------------------------------------
//  Tạo các adapter cụ thể và tiêm vào use case (Dependency Injection).
//  Muốn đổi công nghệ (Redis / MongoDB / nguồn khác) -> chỉ sửa file này.
// ============================================================================

import { config, AppConfig } from "./config";

import { HttpClient } from "./infrastructure/http/HttpClient";
import { VesselFinderHtmlSource } from "./infrastructure/datasources/VesselFinderHtmlSource";
import { VesselFinderMapSource } from "./infrastructure/datasources/VesselFinderMapSource";
import { InMemoryCache } from "./infrastructure/cache/InMemoryCache";
import { RedisCache } from "./infrastructure/cache/RedisCache";
import { ICache } from "./application/ports/ICache";
import { JsonFileVesselRepository } from "./infrastructure/persistence/JsonFileVesselRepository";
import { MongoVesselRepository } from "./infrastructure/persistence/MongoVesselRepository";
import { JsonWatchlistRepository } from "./infrastructure/persistence/JsonWatchlistRepository";
import { MongoWatchlistRepository } from "./infrastructure/persistence/MongoWatchlistRepository";
import { connectMongo } from "./infrastructure/persistence/mongoose/connection";

import { GetVesselDetails } from "./application/use-cases/GetVesselDetails";
import { CrawlFleetPositions } from "./application/use-cases/CrawlFleetPositions";
import { ScanArea } from "./application/use-cases/ScanArea";
import { ManageWatchlist } from "./application/use-cases/ManageWatchlist";
import { EnrichVesselTypes } from "./application/use-cases/EnrichVesselTypes";
import { CleanupStalePositions } from "./application/use-cases/CleanupStalePositions";
import { IVesselRepository } from "./application/ports/IVesselRepository";
import { IWatchlistRepository } from "./application/ports/IWatchlistRepository";

export interface Container {
  config: AppConfig;
  repository: IVesselRepository;
  watchlistRepository: IWatchlistRepository;
  getVesselDetails: GetVesselDetails;
  crawlFleetPositions: CrawlFleetPositions;
  scanArea: ScanArea;
  manageWatchlist: ManageWatchlist;
  enrichVesselTypes: EnrichVesselTypes;
  cleanupStalePositions: CleanupStalePositions;
}

export async function buildContainer(): Promise<Container> {
  // 1) Adapter hạ tầng
  const httpClient = new HttpClient({ timeoutMs: 10000 });
  const detailsSource = new VesselFinderHtmlSource(httpClient); // có lat/lon (làm tròn)

  // Chọn cache: có REDIS_URL -> Redis, không thì RAM.
  let cache: ICache;
  if (config.redisUrl) {
    console.log("⚡ Cache: Redis");
    cache = new RedisCache(config.redisUrl);
  } else {
    console.log("⚡ Cache: RAM (đặt REDIS_URL để dùng Redis)");
    cache = new InMemoryCache();
  }

  // Chọn nơi lưu trữ: có MONGODB_URI -> MongoDB, không thì file JSON.
  // ĐÂY là điểm đổi công nghệ duy nhất — use case không hề biết.
  let repository: IVesselRepository;
  let watchlistRepository: IWatchlistRepository;
  if (config.mongoUri) {
    await connectMongo(config.mongoUri);
    repository = new MongoVesselRepository();
    watchlistRepository = new MongoWatchlistRepository();
  } else {
    console.log("💾 Dùng file JSON (đặt MONGODB_URI để chuyển sang MongoDB)");
    repository = new JsonFileVesselRepository(config.dataDir);
    watchlistRepository = new JsonWatchlistRepository(config.dataDir);
  }

  // Seed watchlist từ .env nếu DB còn trống (lần chạy đầu tiên).
  const current = await watchlistRepository.getAll();
  if (current.length === 0 && config.watchlist.length > 0) {
    for (const id of config.watchlist) await watchlistRepository.add(id);
    console.log(`🌱 Seed watchlist từ .env: ${config.watchlist.join(", ")}`);
  }

  // 2) Lắp vào use case
  const getVesselDetails = new GetVesselDetails({
    detailsSource,
    repository,
    cache,
    cacheTtlMs: config.cacheTtlMs,
    storeMaxAgeMs: config.detailsStoreMaxAgeMs,
  });
  const crawlFleetPositions = new CrawlFleetPositions({
    detailsSource,
    repository,
    delayMs: config.crawlDelayMs,
  });
  const mapSource = new VesselFinderMapSource(httpClient);
  const scanArea = new ScanArea({
    mapSource,
    repository,
    concurrency: config.scanConcurrency,
    chunkDelayMs: config.scanChunkDelayMs,
    flushEveryTiles: config.scanFlushEveryTiles,
    cycleDelayMs: config.scanCycleDelayMs,
    zoom: config.scanZoom,
    subdivideThreshold: config.scanSubdivideThreshold,
    minTileDeg: config.scanMinTileDeg,
    blockCooldownMs: config.scanBlockCooldownMs,
  });
  const manageWatchlist = new ManageWatchlist(watchlistRepository);
  const enrichVesselTypes = new EnrichVesselTypes({
    detailsSource,
    repository,
    batchSize: config.enrichBatchSize,
    delayMs: config.enrichDelayMs,
    intervalMs: config.enrichIntervalMs,
  });
  // Dọn vị trí map hết hạn: chỉ latest_positions, giữ lý lịch + lịch sử.
  const cleanupStalePositions = new CleanupStalePositions({
    repo: repository,
    staleAfterMs: config.positionStaleAfterMs,
  });

  return {
    config,
    repository,
    watchlistRepository,
    getVesselDetails,
    crawlFleetPositions,
    scanArea,
    manageWatchlist,
    enrichVesselTypes,
    cleanupStalePositions,
  };
}
