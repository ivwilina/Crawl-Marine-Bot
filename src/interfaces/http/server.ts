// ============================================================================
//  INTERFACE (HTTP) · Bootstrap: dựng app (createApp) + listen + scheduler
// ----------------------------------------------------------------------------
//  Chạy:  npm start
//  API (chỉ dữ liệu JSON — không có giao diện, không phục vụ file tĩnh):
//    GET /health         -> kiểm tra server sống (không cần khoá)
//    GET /positions      -> vị trí mới nhất, CÒN TƯƠI (không cần khoá)
//    GET /nearby         -> tàu lân cận từ dữ liệu đã crawl (không cần khoá)
//    GET /vessels?name=  -> tìm tàu theo tên (không cần khoá)
//    GET /vessel/:id     -> chi tiết 1 tàu (IMO/MMSI, có cache) — cần X-API-Key
//    /watchlist*         -> xem/thêm/xoá tàu tracking       — cần X-API-Key
//  Bind mặc định 127.0.0.1: muốn public thì đặt reverse proxy có xác thực ở
//  phía trước, KHÔNG mở thẳng cổng này ra internet.
//  Scheduler ở đây: crawl watchlist + dọn vị trí hết hạn. Enrich KHÔNG tự chạy
//  (worker riêng: `npm run enrich`) để tải upstream luôn đoán được.
// ============================================================================

import { buildContainer } from "../../container";
import { IntervalScheduler } from "../../infrastructure/scheduler/IntervalScheduler";
import { createApp } from "./createApp";

async function start(): Promise<void> {
  const {
    config,
    getVesselDetails,
    crawlFleetPositions,
    repository,
    manageWatchlist,
    cleanupStalePositions,
  } = await buildContainer();

  // Không có khoá -> KHÔNG mở server. Thà không chạy còn hơn chạy không rào.
  if (config.apiKey.trim().length === 0) {
    throw new Error(
      "Thiếu API_KEY: đặt API_KEY trong .env (hoặc EnvironmentFile của systemd) " +
        "trước khi mở HTTP server."
    );
  }

  const app = createApp({
    getVesselDetails,
    manageWatchlist,
    repository,
    apiKey: config.apiKey,
    positionStaleAfterMs: config.positionStaleAfterMs,
  });

  app.listen(config.httpPort, config.httpHost, () => {
    console.log(`✅ Express server: http://${config.httpHost}:${config.httpPort}`);
    console.log(`   • /health`);
    console.log(`   • /positions`);
    console.log(`   • /nearby?mmsi=257123000&radius=3`);
    console.log(`   • /vessels?name=maersk`);
    console.log(`   • /vessel/9811983      (cần header X-API-Key)`);
    console.log(`   • /watchlist           (cần header X-API-Key)`);
  });

  // --- Scheduler crawl watchlist định kỳ ---
  // ĐỌC watchlist MỚI NHẤT từ DB mỗi lần chạy -> thêm/xóa qua API có hiệu lực
  // ngay ở chu kỳ kế tiếp, KHÔNG cần restart.
  const crawlScheduler = new IntervalScheduler({
    label: "crawl watchlist",
    everyMs: config.crawlEveryMs,
    runOnStart: true,
    task: async () => {
      const ids = await manageWatchlist.list();
      if (ids.length === 0) {
        console.log("⏭️  Watchlist trống, bỏ qua chu kỳ crawl.");
        return;
      }
      await crawlFleetPositions.execute(ids);
    },
  });
  crawlScheduler.start();

  // --- Dọn vị trí map hết hạn: chạy ngay lúc khởi động, rồi theo chu kỳ ---
  // Chỉ xoá latest_positions; lý lịch tàu và lịch sử lộ trình giữ nguyên.
  const cleanupScheduler = new IntervalScheduler({
    label: "cleanup stale positions",
    everyMs: config.positionCleanupEveryMs,
    runOnStart: true,
    task: async () => {
      const removed = await cleanupStalePositions.execute();
      if (removed > 0) console.log(`🧽 Đã dọn ${removed} vị trí hết hạn.`);
    },
  });
  cleanupScheduler.start();
}

start().catch((err: Error) => {
  console.error(`❌ Không khởi động được HTTP server: ${err.message}`);
  process.exitCode = 1;
});
