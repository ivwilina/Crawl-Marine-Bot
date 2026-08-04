// ============================================================================
//  APPLICATION · PORT: Geo
//  --------------------------------------------------------------------------
//  Shared geographic primitives for VesselFinder area scanning and map queries.
// ============================================================================

/** A latitude/longitude rectangle. */
export interface BoundingBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/** Bán kính Trái Đất theo hải lý — đơn vị bán kính mà "Vessel Nearby" dùng. */
export const EARTH_RADIUS_NM = 3440.065;

/** Bán kính Trái Đất theo km, cho $centerSphere của MongoDB. */
export const EARTH_RADIUS_KM = 6378.1;

export const KM_PER_NM = 1.852;

/**
 * Khoảng cách great-circle giữa 2 điểm, theo hải lý (haversine).
 *
 * Dùng cho các repo không có index địa lý (file JSON / RAM) và để tính field
 * `distanceNm` trả về cho client. Đủ chính xác ở mọi bán kính mà nearby cần.
 */
export function distanceNm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const latA = toRad(a.lat);
  const latB = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}
