// ============================================================================
//  INTERFACE (HTTP) · createApp — dựng Express app THUẦN (không listen, không
//  đọc process.env). Nhờ vậy test tích hợp dựng được app thật với dependency
//  trong RAM; server.ts chỉ còn việc bootstrap và listen.
// ----------------------------------------------------------------------------
//  Ranh giới bảo mật:
//    • GET /health, GET /positions  -> đọc, KHÔNG cần khoá (bản đồ tĩnh cần).
//    • GET /vessel/:id, /watchlist* -> BẮT BUỘC header X-API-Key vì chúng gọi
//      upstream hoặc thay đổi trạng thái ứng dụng.
// ============================================================================

import { timingSafeEqual } from "node:crypto";
import express, { NextFunction, Request, RequestHandler, Response } from "express";
import { GetVesselDetails } from "../../application/use-cases/GetVesselDetails";
import { ManageWatchlist } from "../../application/use-cases/ManageWatchlist";
import { IVesselRepository } from "../../application/ports/IVesselRepository";
import { Errors, errorStatus } from "../../domain/errors/AppError";

export interface HttpAppDeps {
  getVesselDetails: GetVesselDetails;
  manageWatchlist: ManageWatchlist;
  repository: IVesselRepository;
  /** Khoá bắt buộc cho route ghi/gọi upstream. Rỗng -> mọi route đó trả 401. */
  apiKey: string;
  /** Vị trí mới nhất cũ hơn ngần này ms không được trả về. */
  positionStaleAfterMs: number;
  /** Thư mục chứa giao diện bản đồ. Bỏ trống -> không phục vụ file tĩnh. */
  staticDir?: string;
  /** Tiêm được để test không phụ thuộc đồng hồ thật. */
  now?: () => Date;
}

const MAX_POSITIONS = 5000;
const DEFAULT_POSITIONS = 3000;

function positionLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_POSITIONS;
  return Math.min(Math.floor(parsed), MAX_POSITIONS);
}

/** So sánh khoá theo thời gian hằng số -> không rò rỉ độ giống nhau qua timing. */
function safeEqual(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Middleware chặn request thiếu/sai X-API-Key. Khoá rỗng -> chặn tất cả. */
export function requireApiKey(apiKey: string): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const provided = req.header("x-api-key") ?? "";
    if (apiKey.length === 0 || !safeEqual(provided, apiKey)) {
      next(Errors.UNAUTHORIZED());
      return;
    }
    next();
  };
}

export function createApp(deps: HttpAppDeps): express.Express {
  const now = deps.now ?? (() => new Date());
  const guard = requireApiKey(deps.apiKey);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

  // Giao diện web xem bản đồ tàu (clone tối giản kiểu VesselFinder)
  if (deps.staticDir) app.use(express.static(deps.staticDir));

  // --- Routes ---
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", time: now().toISOString() });
  });

  // Chi tiết 1 tàu theo IMO/MMSI (dùng cache). Có khoá: route này gọi upstream.
  app.get("/vessel/:id", guard, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await deps.getVesselDetails.execute(String(req.params.id));
      res.json(result);
    } catch (err) {
      next(err); // đẩy sang error handler bên dưới
    }
  });

  // Vị trí mới nhất trong KHUNG NHÌN (bbox). Không có bbox -> giới hạn số lượng.
  //   /positions?bbox=minLon,minLat,maxLon,maxLat&limit=3000
  // Chỉ trả vị trí CÒN TƯƠI: cleanup lỗi cũng không làm dữ liệu cũ hiện lại.
  app.get("/positions", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = positionLimit(req.query.limit);
      const bboxRaw = String(req.query.bbox ?? "");
      const parts = bboxRaw.split(",").map(Number);
      const hasBbox = parts.length === 4 && parts.every((n) => !Number.isNaN(n));
      const freshSince = new Date(now().getTime() - deps.positionStaleAfterMs);

      let positions;
      if (hasBbox) {
        const [minLon, minLat, maxLon, maxLat] = parts;
        positions = await deps.repository.getLatestPositionsInBbox(
          { minLat, minLon, maxLat, maxLon },
          limit,
          freshSince
        );
      } else {
        // Không truyền bbox -> lấy tất cả nhưng CẮT còn `limit` (tránh nghẽn 1M).
        positions = (await deps.repository.getAllLatestPositions(freshSince)).slice(0, limit);
      }

      // Chỉ join lý lịch cho các tàu ĐANG trả về (không nạp cả triệu vessel).
      const mmsis = positions.map((p) => p.mmsi).filter((m): m is string => !!m);
      const vessels = await deps.repository.getVesselsByMmsi(mmsis);
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
  //      Mọi route dưới đây đổi trạng thái hoặc tiết lộ cấu hình -> cần khoá.

  // Xem danh sách tàu đang tracking
  app.get("/watchlist", guard, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ watchlist: await deps.manageWatchlist.list() });
    } catch (err) {
      next(err);
    }
  });

  // Thêm tàu:  POST /watchlist   body: { "id": "9839430" }
  app.post("/watchlist", guard, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String((req.body as { id?: unknown } | undefined)?.id ?? "");
      const watchlist = await deps.manageWatchlist.add(id);
      res.status(201).json({ added: id, watchlist });
    } catch (err) {
      next(err);
    }
  });

  // Xóa tàu:  DELETE /watchlist/9839430
  app.delete("/watchlist/:id", guard, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const watchlist = await deps.manageWatchlist.remove(String(req.params.id));
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
    res.status(errorStatus(err)).json({ code: err.code ?? "?", error: err.message });
  });

  return app;
}
