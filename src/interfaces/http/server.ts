// ============================================================================
//  INTERFACE (HTTP) · Express API server + Scheduler crawl tự động
// ----------------------------------------------------------------------------
//  Chạy:  npm start
//  API:
//    GET /health         -> kiểm tra server sống
//    GET /vessel/:id     -> chi tiết 1 tàu (IMO/MMSI, có cache)
//    GET /positions      -> vị trí mới nhất mọi tàu trong DB
//  Đồng thời tự crawl watchlist mỗi CRAWL_EVERY_MS.
// ============================================================================

import path from "path";
import express, { Request, Response, NextFunction } from "express";
import { buildContainer } from "../../container";
import { IntervalScheduler } from "../../infrastructure/scheduler/IntervalScheduler";

async function start(): Promise<void> {
  const {
    config,
    getVesselDetails,
    crawlFleetPositions,
    repository,
    manageWatchlist,
  } = await buildContainer();

  const app = express();
  app.use(express.json());

  // Giao diện web xem bản đồ tàu (clone tối giản kiểu VesselFinder)
  app.use(express.static(path.join(__dirname, "../../../public")));

  // --- Routes ---
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  // Chi tiết 1 tàu theo IMO/MMSI (dùng cache)
  app.get("/vessel/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await getVesselDetails.execute(String(req.params.id));
      res.json(result);
    } catch (err) {
      next(err); // đẩy sang error handler bên dưới
    }
  });

  // Vị trí mới nhất trong KHUNG NHÌN (bbox). Không có bbox -> giới hạn số lượng.
  //   /positions?bbox=minLon,minLat,maxLon,maxLat&limit=3000
  app.get("/positions", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 3000, 5000);
      const bboxRaw = String(req.query.bbox ?? "");
      const parts = bboxRaw.split(",").map(Number);
      const hasBbox = parts.length === 4 && parts.every((n) => !Number.isNaN(n));

      let positions;
      if (hasBbox) {
        const [minLon, minLat, maxLon, maxLat] = parts;
        positions = await repository.getLatestPositionsInBbox(
          { minLat, minLon, maxLat, maxLon },
          limit
        );
      } else {
        // Không truyền bbox -> lấy tất cả nhưng CẮT còn `limit` (tránh nghẽn 1M).
        positions = (await repository.getAllLatestPositions()).slice(0, limit);
      }

      // Chỉ join lý lịch cho các tàu ĐANG trả về (không nạp cả triệu vessel).
      const mmsis = positions.map((p) => p.mmsi).filter((m): m is string => !!m);
      const vessels = await repository.getVesselsByMmsi(mmsis);
      const vesselByKey = new Map(vessels.map((v) => [v.mmsi, v]));
      const enriched = positions.map((p) => {
        const v = p.mmsi ? vesselByKey.get(p.mmsi) : undefined;
        return {
          ...p,
          name: v?.name ?? null,
          type: v?.type ?? null,
          country: v?.country ?? null,
          callsign: v?.callsign ?? null,
          lengthM: v?.lengthM ?? null,
          widthM: v?.widthM ?? null,
          draughtM: v?.draughtM ?? null,
        };
      });
      res.json({ count: enriched.length, positions: enriched });
    } catch (err) {
      next(err);
    }
  });

  // ---- Quản lý watchlist (thêm/sửa/xóa tàu tracking KHÔNG cần restart) ----

  // Xem danh sách tàu đang tracking
  app.get("/watchlist", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ watchlist: await manageWatchlist.list() });
    } catch (err) {
      next(err);
    }
  });

  // Thêm tàu:  POST /watchlist   body: { "id": "9839430" }
  app.post("/watchlist", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.body?.id ?? "");
      const watchlist = await manageWatchlist.add(id);
      res.status(201).json({ added: id, watchlist });
    } catch (err) {
      next(err);
    }
  });

  // Xóa tàu:  DELETE /watchlist/9839430
  app.delete("/watchlist/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const watchlist = await manageWatchlist.remove(String(req.params.id));
      res.json({ removed: req.params.id, watchlist });
    } catch (err) {
      next(err);
    }
  });

  // 404 cho route không khớp
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Không tìm thấy route. Thử /vessel/<id> hoặc /positions" });
  });

  // Error handler tập trung (nhận lỗi từ next(err))
  app.use((err: Error & { code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(502).json({ code: err.code ?? "?", error: err.message });
  });

  app.listen(config.httpPort, () => {
    console.log(`✅ Express server: http://localhost:${config.httpPort}`);
    console.log(`   • / (giao diện bản đồ tàu)`);
    console.log(`   • /health`);
    console.log(`   • /vessel/9811983`);
    console.log(`   • /positions`);
  });

  // --- Scheduler crawl watchlist định kỳ ---
  // ĐỌC watchlist MỚI NHẤT từ DB mỗi lần chạy -> thêm/xóa qua API có hiệu lực
  // ngay ở chu kỳ kế tiếp, KHÔNG cần restart.
  const scheduler = new IntervalScheduler({
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
  scheduler.start();

  // --- Bổ sung type/flag cho tàu quét từ mp2 (chạy nền, không chặn request) ---

  // --- Dọn tàu im lặng quá lâu, chống DB phình vô hạn (chạy nền) ---
}

void start();
