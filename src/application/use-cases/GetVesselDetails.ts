// ============================================================================
//  APPLICATION · USE CASE: GetVesselDetails — chi tiết 1 tàu theo IMO/MMSI
// ----------------------------------------------------------------------------
//  Thứ tự nguồn, rẻ trước đắt sau:
//    1) CACHE   (RAM/Redis, TTL ngắn)     — 0 request
//    2) KHO     (dữ liệu đã crawl)        — 0 request, nếu bản ghi còn ĐỦ và TƯƠI
//    3) UPSTREAM (trang chi tiết VF)      — 1 request
//
//  Bước 2 là phần thêm cho api_v3: crawler là nguồn chính, nên tàu đã quét/đã
//  enrich thì không có lý gì gọi lại VesselFinder. Nhưng chỉ trả từ kho khi bản
//  ghi thực sự phục vụ được màn detail:
//    • có `type`      -> đã qua enrich, không phải bản trống từ mp2
//    • có `courseDeg` -> vị trí đến từ trang chi tiết, không phải mp2 (mp2 không
//                        mang course/speed)
//    • receivedAt còn trong `storeMaxAgeMs`
//  Thiếu bất kỳ điều kiện nào -> gọi upstream, vì màn detail của sheet cần
//  course/speed/destination/eta mà mp2 không có.
// ============================================================================

import { IVesselDetailsSource, VesselDetails } from "../ports/IVesselDetailsSource";
import { IVesselRepository } from "../ports/IVesselRepository";
import { ICache } from "../ports/ICache";
import { Errors } from "../../domain/errors/AppError";

export interface GetVesselDetailsDeps {
  detailsSource: IVesselDetailsSource;
  repository: IVesselRepository;
  cache: ICache;
  /** TTL cache (ms) — lấy từ CACHE_TTL_MS. Bỏ trống -> 60s theo BR-07. */
  cacheTtlMs?: number;
  /** Bản ghi trong kho cũ hơn ngần này thì coi như hết hạn cho màn detail. */
  storeMaxAgeMs?: number;
  /** Tiêm được để test không phụ thuộc đồng hồ thật. */
  now?: () => Date;
}

/** Dữ liệu thực sự đến từ đâu — hữu ích để đo tỉ lệ tiết kiệm request. */
export type DetailsSourceKind = "cache" | "store" | "upstream";

export type GetVesselResult = VesselDetails & {
  /** Giữ lại cho client cũ; `source` là thông tin đầy đủ hơn. */
  fromCache: boolean;
  source: DetailsSourceKind;
};

const DEFAULT_CACHE_TTL_MS = 60 * 1000; // BR-07: cache 60s
const DEFAULT_STORE_MAX_AGE_MS = 30 * 60 * 1000;

export class GetVesselDetails {
  private readonly cacheTtlMs: number;
  private readonly storeMaxAgeMs: number;
  private readonly now: () => Date;

  constructor(private readonly deps: GetVesselDetailsDeps) {
    this.cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.storeMaxAgeMs = deps.storeMaxAgeMs ?? DEFAULT_STORE_MAX_AGE_MS;
    this.now = deps.now ?? (() => new Date());
  }

  async execute(id: string): Promise<GetVesselResult> {
    // Bước 0: validate (7–9 chữ số = IMO hoặc MMSI)
    if (!/^\d{7,9}$/.test(String(id))) {
      throw Errors.INVALID_ID(id);
    }

    // Bước 1: thử cache
    const cacheKey = `vessel:${id}`;
    const cached = await this.deps.cache.get<VesselDetails>(cacheKey);
    if (cached) {
      return { ...cached, fromCache: true, source: "cache" };
    }

    // Bước 2: thử kho dữ liệu đã crawl
    const stored = await this.readFromStore(id);
    if (stored) {
      await this.deps.cache.set(cacheKey, stored, this.cacheTtlMs);
      return { ...stored, fromCache: false, source: "store" };
    }

    // Bước 3: gọi nguồn
    const details = await this.deps.detailsSource.getDetails(id);

    await this.deps.repository.saveVessel(details.vessel);
    await this.deps.repository.savePosition(details.position);

    await this.deps.cache.set(cacheKey, details, this.cacheTtlMs);
    return { ...details, fromCache: false, source: "upstream" };
  }

  /**
   * Bản ghi trong kho, chỉ khi nó đủ dùng cho màn detail.
   * @returns null nếu chưa có, chưa enrich, hoặc đã cũ -> caller gọi upstream
   */
  private async readFromStore(id: string): Promise<VesselDetails | null> {
    const vessel = await this.deps.repository.findVesselByImoOrMmsi(id);
    if (!vessel?.type) return null;

    const position = await this.deps.repository.getLatestPosition(vessel.mmsi);
    if (!position || position.courseDeg === null) return null;

    const age = this.now().getTime() - new Date(position.receivedAt).getTime();
    if (!Number.isFinite(age) || age > this.storeMaxAgeMs) return null;

    return { vessel, position };
  }
}
