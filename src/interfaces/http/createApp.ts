// ============================================================================
//  INTERFACE (HTTP) · createApp — dựng Express app THUẦN (không listen, không
//  đọc process.env). Nhờ vậy test tích hợp dựng được app thật với dependency
//  trong RAM; server.ts chỉ còn việc bootstrap và listen.
// ----------------------------------------------------------------------------
//  Đây là API THUẦN DỮ LIỆU: không phục vụ file tĩnh, không giao diện. Bên tiêu
//  thụ (soosky-marine-api) gọi REST ở đây và nhận đẩy qua WebSocket.
//
//  Ranh giới bảo mật:
//    • GET /health                   -> mở, để health check.
//    • GET /nearby, GET /vessels     -> mở: đọc dữ liệu 1 tàu / 1 vùng nhỏ.
//    • GET /positions                -> BẮT BUỘC X-API-Key. Nó xuất được cả kho
//      vị trí, và người gọi duy nhất là soosky-marine-api (server-to-server).
//      Lý do trước đây để mở là phục vụ trang map tĩnh — trang đó đã bỏ.
//    • GET /vessel/:id, /watchlist*  -> BẮT BUỘC X-API-Key vì chúng gọi upstream
//      hoặc thay đổi trạng thái ứng dụng.
// ============================================================================

import { timingSafeEqual } from "node:crypto";
import express, { NextFunction, Request, RequestHandler, Response } from "express";
import { GetVesselDetails } from "../../application/use-cases/GetVesselDetails";
import { ManageWatchlist } from "../../application/use-cases/ManageWatchlist";
import { IVesselRepository } from "../../application/ports/IVesselRepository";
import { BoundingBox, distanceNm } from "../../application/ports/Geo";
import { Errors, errorStatus } from "../../domain/errors/AppError";
import { movementState, typeGroupOf } from "../../domain/vesselType";

export interface HttpAppDeps {
  getVesselDetails: GetVesselDetails;
  manageWatchlist: ManageWatchlist;
  repository: IVesselRepository;
  /** Khoá bắt buộc cho route ghi/gọi upstream. Rỗng -> mọi route đó trả 401. */
  apiKey: string;
  /** Vị trí mới nhất cũ hơn ngần này ms không được trả về. */
  positionStaleAfterMs: number;
  /** Tiêm được để test không phụ thuộc đồng hồ thật. */
  now?: () => Date;
}

const MAX_POSITIONS = 5000;
const DEFAULT_POSITIONS = 3000;

/** Nearby của api_v3: bán kính 3 (hải lý). Chặn trên để 1 request không quét cả biển. */
const DEFAULT_NEARBY_RADIUS_NM = 3;
const MAX_NEARBY_RADIUS_NM = 50;
const MAX_NEARBY_RESULTS = 500;

/** Tìm theo tên: dưới 3 ký tự là 400, không phải danh sách rỗng. */
const NAME_MIN_LENGTH = 3;
const MAX_NAME_RESULTS = 50;

function positionLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_POSITIONS;
  return Math.min(Math.floor(parsed), MAX_POSITIONS);
}

function boundedNumber(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
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

/** Tâm của truy vấn nearby: toạ độ truyền thẳng, hoặc vị trí của 1 mmsi. */
type NearbyCenter = { lat: number; lon: number; mmsi?: string };

function isLat(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

function isLon(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

/**
 * Đọc `bbox=minLon,minLat,maxLon,maxLat` thành các ô để truy vấn.
 *
 * Trả về NHIỀU ô khi vùng vắt qua kinh tuyến 180°: `minLon > maxLon` là cách
 * client map diễn tả khung nhìn qua Thái Bình Dương, và nó phải được tách thành
 * [minLon..180] + [-180..maxLon]. `minLat > maxLat` thì không có cách đọc nào
 * hợp lý -> lỗi.
 */
function parseBbox(raw: string): { boxes: BoundingBox[] } | { error: string } {
  const parts = raw.split(",").map((value) => Number(value.trim()));

  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return { error: "bbox phải là 4 số: minLon,minLat,maxLon,maxLat" };
  }

  const [minLon, minLat, maxLon, maxLat] = parts;

  if (!isLon(minLon) || !isLon(maxLon)) {
    return { error: "Kinh độ trong bbox phải thuộc [-180, 180]" };
  }
  if (!isLat(minLat) || !isLat(maxLat)) {
    return { error: "Vĩ độ trong bbox phải thuộc [-90, 90]" };
  }
  if (minLat > maxLat) {
    return { error: "minLat không được lớn hơn maxLat (thứ tự là minLon,minLat,maxLon,maxLat)" };
  }

  if (minLon <= maxLon) {
    return { boxes: [{ minLat, minLon, maxLat, maxLon }] };
  }

  return {
    boxes: [
      { minLat, minLon, maxLat, maxLon: 180 },
      { minLat, minLon: -180, maxLat, maxLon },
    ],
  };
}

export function createApp(deps: HttpAppDeps): express.Express {
  const now = deps.now ?? (() => new Date());
  const guard = requireApiKey(deps.apiKey);

  /**
   * `vessel` (IMO hoặc MMSI) -> lấy vị trí mới nhất của tàu đó làm tâm; hoặc
   * `lat`+`lon` trực tiếp. Tàu chưa từng được quét thì không có tâm -> 404, chứ
   * không lặng lẽ trả rỗng.
   *
   * Nhận IMO chứ không chỉ MMSI: mọi luồng v3 đều cho phép cả hai, và tâm phải
   * tra được bằng đúng cái id mà client đang có. `mmsi=` giữ lại như bí danh.
   */
  const resolveCenter = async (
    req: Request
  ): Promise<NearbyCenter | { error: string; status: number }> => {
    const id = String(req.query.vessel ?? req.query.mmsi ?? "").trim();

    if (id.length > 0) {
      const vessel = await deps.repository.findVesselByImoOrMmsi(id);
      const mmsi = vessel?.mmsi ?? id;
      const position = await deps.repository.getLatestPosition(mmsi);
      if (!position || position.lat === null || position.lon === null) {
        return { error: `Chưa có vị trí đã crawl cho ${id}.`, status: 404 };
      }
      return { lat: position.lat, lon: position.lon, mmsi };
    }

    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!isLat(lat) || !isLon(lon)) {
      return { error: "Cần mmsi, hoặc cả lat và lon hợp lệ.", status: 400 };
    }

    return { lat, lon };
  };

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

  // --- Routes ---
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", time: now().toISOString() });
  });

  // Chi tiết 1 tàu theo IMO/MMSI (dùng cache). Có khoá: route này gọi upstream.
  app.get("/vessel/:id", guard, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await deps.getVesselDetails.execute(String(req.params.id));
      // Trả kèm 2 field dẫn xuất như các endpoint map: bảng tra AIS chỉ nằm ở
      // repo này, nên bên tiêu thụ không phải nhân bản nó để tự phân nhóm.
      res.json({
        ...result,
        typeGroup: typeGroupOf(result.vessel),
        movementState: movementState(result.position),
      });
    } catch (err) {
      next(err); // đẩy sang error handler bên dưới
    }
  });

  // ---- Tàu trong 1 KHU VỰC MAP: nguồn để mobile vẽ tàu (qua soosky api) ----
  //   /positions?bbox=minLon,minLat,maxLon,maxLat&limit=3000
  //   /positions?bbox=...&fields=full     -> trả nguyên bản ghi vị trí
  //   /positions                          -> không bbox: full sync, cắt còn limit
  //
  // Thứ tự bbox là minLon,minLat,maxLon,maxLat (kiểu GeoJSON: KINH ĐỘ TRƯỚC).
  // bbox sai định dạng -> 400, KHÔNG lặng lẽ trả tàu toàn cầu: với client map,
  // một bbox gõ sai mà vẫn 200 là bug rất khó thấy.
  //
  // Vùng vắt qua kinh tuyến 180° (minLon > maxLon) là hợp lệ và được tách thành
  // 2 truy vấn — máy khách pan qua Thái Bình Dương gửi đúng dạng này, còn
  // $box của MongoDB thì trả rỗng.
  //
  // Chỉ trả vị trí CÒN TƯƠI: cleanup lỗi cũng không làm dữ liệu cũ hiện lại.
  app.get("/positions", guard, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = positionLimit(req.query.limit);
      const freshSince = new Date(now().getTime() - deps.positionStaleAfterMs);
      const full = String(req.query.fields ?? "") === "full";
      const bboxRaw = String(req.query.bbox ?? "").trim();

      let positions;
      if (bboxRaw.length > 0) {
        const parsed = parseBbox(bboxRaw);
        if ("error" in parsed) {
          res.status(400).json({ error: parsed.error });
          return;
        }
        // Xin `limit + 1` mỗi mảnh: dư 1 bản ghi là bằng chứng vùng còn tàu
        // chưa trả, tức là `truncated`. Xin đúng `limit` thì không thể phân biệt
        // "vừa đủ" với "còn nữa". Cắt tổng sau khi gộp, không cắt từng mảnh.
        const perBox = await Promise.all(
          parsed.boxes.map((box) =>
            deps.repository.getLatestPositionsInBbox(box, limit + 1, freshSince)
          )
        );
        positions = perBox.flat();
      } else {
        positions = await deps.repository.getAllLatestPositions(freshSince);
      }

      // Sắp theo mmsi rồi mới cắt: kho không có thứ tự ổn định, nên nếu cắt bừa
      // thì cùng một khung nhìn có thể trả tập tàu khác nhau giữa 2 lần gọi và
      // tàu sẽ nháy trên map. Cắt xong thì báo `truncated` để client biết cần
      // zoom vào (hoặc tăng limit) chứ không nghĩ là vùng đó chỉ có ngần ấy tàu.
      positions.sort((a, b) => (a.mmsi ?? "").localeCompare(b.mmsi ?? ""));
      const truncated = positions.length > limit;
      const visible = truncated ? positions.slice(0, limit) : positions;

      // Chỉ join lý lịch cho các tàu ĐANG trả về (không nạp cả triệu vessel).
      const mmsis = visible.map((p) => p.mmsi).filter((m): m is string => !!m);
      const vessels = await deps.repository.getVesselsByMmsi(mmsis);
      const vesselByKey = new Map(vessels.map((v) => [v.mmsi, v]));

      const enriched = visible.map((p) => {
        const v = p.mmsi ? vesselByKey.get(p.mmsi) : undefined;

        // Mặc định là payload GỌN đủ để vẽ 1 marker: toạ độ, hướng (quay icon),
        // tốc độ (đang chạy hay đứng), loại (màu icon), tên/imo (nhãn + tra chi
        // tiết), receivedAt (độ cũ). 3000 marker × 18 field là băng thông vô ích
        // trên mạng di động; cần đủ bộ thì gọi fields=full.
        const marker = {
          mmsi: p.mmsi,
          imo: p.imo ?? v?.imo ?? null,
          name: v?.name ?? null,
          type: v?.type ?? null,
          // Mã loại AIS dạng số — chỉ AIS mới có, và là thứ contract v3 gọi là
          // `vType`. Giữ song song với `type` dạng chữ, không quy đổi một chiều.
          aisType: v?.aisType ?? null,
          // Nhóm đã chuẩn hoá: client chọn icon/màu theo field này, không phải
          // tự đoán từ `type` (chữ của crawler và số của AIS khác nhau).
          typeGroup: typeGroupOf(v ?? {}),
          lat: p.lat,
          lon: p.lon,
          courseDeg: p.courseDeg,
          speedKn: p.speedKn,
          navStatusText: p.navStatusText,
          movementState: movementState(p),
          receivedAt: p.receivedAt,
        };

        return full
          ? {
              ...p,
              ...marker,
              country: v?.country ?? null,
              callsign: v?.callsign ?? null,
              lengthM: v?.lengthM ?? null,
              widthM: v?.widthM ?? null,
              draughtM: v?.draughtM ?? null,
            }
          : marker;
      });

      res.json({ count: enriched.length, truncated, limit, positions: enriched });
    } catch (err) {
      next(err);
    }
  });

  // Tàu lân cận — "Vessel Nearby" của api_v3, chạy trên dữ liệu đã crawl nên
  // KHÔNG tốn credit upstream nào (bản v2 tính 1 credit mỗi tàu trả về).
  //   /nearby?mmsi=257123000&radius=3&limit=500
  //   /nearby?lat=1.2&lon=103.8&radius=10
  // Tâm là toạ độ truyền vào, hoặc vị trí mới nhất của `mmsi`.
  app.get("/nearby", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const radiusNm = boundedNumber(req.query.radius, DEFAULT_NEARBY_RADIUS_NM, MAX_NEARBY_RADIUS_NM);
      const limit = boundedNumber(req.query.limit, MAX_NEARBY_RESULTS, MAX_NEARBY_RESULTS);
      const freshSince = new Date(now().getTime() - deps.positionStaleAfterMs);

      const center = await resolveCenter(req);
      if ("error" in center) {
        res.status(center.status).json({ error: center.error });
        return;
      }

      const found = await deps.repository.getLatestPositionsNearby(
        center,
        radiusNm,
        // Xin thêm rồi cắt sau: tâm nằm trong bán kính của chính nó, và kho
        // không sắp theo khoảng cách nên cắt trước sẽ cắt mất tàu gần hơn.
        Math.min(limit + 1, MAX_NEARBY_RESULTS + 1),
        freshSince
      );

      const nearby = found
        .filter((p) => p.mmsi !== center.mmsi)
        .map((p) => ({
          ...p,
          distanceNm: Number(distanceNm(center, { lat: p.lat as number, lon: p.lon as number }).toFixed(2)),
        }))
        .sort((a, b) => a.distanceNm - b.distanceNm)
        .slice(0, limit);

      const vessels = await deps.repository.getVesselsByMmsi(
        nearby.map((p) => p.mmsi).filter((m): m is string => !!m)
      );
      const byMmsi = new Map(vessels.map((v) => [v.mmsi, v]));

      res.json({
        center: { lat: center.lat, lon: center.lon, mmsi: center.mmsi ?? null },
        radiusNm,
        count: nearby.length,
        vessels: nearby.map((p) => {
          const v = byMmsi.get(p.mmsi ?? "");
          return {
            ...p,
            name: v?.name ?? null,
            imo: p.imo ?? v?.imo ?? null,
            type: v?.type ?? null,
            aisType: v?.aisType ?? null,
            typeGroup: typeGroupOf(v ?? {}),
            movementState: movementState(p),
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  // Tìm tàu theo tên — "Search by Name" của api_v3. Trả lý lịch, không vị trí:
  // client chọn 1 tàu rồi gọi /vessel/:id.
  //   /vessels?name=maersk&limit=50
  app.get("/vessels", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const name = String(req.query.name ?? "").trim();
      if (name.length < NAME_MIN_LENGTH) {
        res.status(400).json({ error: `Tham số name cần ít nhất ${NAME_MIN_LENGTH} ký tự.` });
        return;
      }

      const limit = boundedNumber(req.query.limit, MAX_NAME_RESULTS, MAX_NAME_RESULTS);
      const vessels = await deps.repository.findVesselsByName(name, limit);

      res.json({
        count: vessels.length,
        vessels: vessels.map((v) => ({
          mmsi: v.mmsi,
          imo: v.imo,
          name: v.name,
          type: v.type,
          aisType: v.aisType,
          typeGroup: typeGroupOf(v),
          flag: v.country,
          callsign: v.callsign,
        })),
      });
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
