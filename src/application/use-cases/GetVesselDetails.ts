// ============================================================================
//  APPLICATION · USE CASE: GetVesselDetails — MỤC TIÊU 1: lấy details 1 tàu
// ----------------------------------------------------------------------------
//  Điều phối các bước, "sai" các port làm việc bẩn. Port được tiêm qua
//  constructor (Dependency Injection).
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
}

export type GetVesselResult = VesselDetails & { fromCache: boolean };

const DEFAULT_CACHE_TTL_MS = 60 * 1000; // BR-07: cache 60s

export class GetVesselDetails {
  private readonly cacheTtlMs: number;

  constructor(private readonly deps: GetVesselDetailsDeps) {
    this.cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
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
      return { ...cached, fromCache: true };
    }

    // Bước 2: gọi nguồn
    const details = await this.deps.detailsSource.getDetails(id);

    // Bước 3: lưu DB
    await this.deps.repository.saveVessel(details.vessel);
    await this.deps.repository.savePosition(details.position);

    // Bước 4: cache + trả về
    await this.deps.cache.set(cacheKey, details, this.cacheTtlMs);
    return { ...details, fromCache: false };
  }
}
