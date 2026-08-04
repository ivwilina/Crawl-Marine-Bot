// ============================================================================
//  APPLICATION · worldTiles: chia bản đồ THẾ GIỚI thành lưới bounding box
// ----------------------------------------------------------------------------
//  Dùng cho ScanArea quét toàn cầu: thay vì 1 vùng nhỏ trong .env, phủ hết
//  mặt biển bằng nhiều ô. Vùng dày tàu (cảng, eo biển) sẽ được ScanArea CHIA
//  NHỎ động khi 1 ô trả về quá nhiều tàu (mp2 giới hạn số tàu/ô).
//
//  Lat giới hạn ±84°: bản đồ Web Mercator không phủ quá vĩ độ này, và vùng
//  cực gần như không có tàu -> bỏ để đỡ tốn request.
// ============================================================================

import { BoundingBox } from "../ports/Geo";

const LAT_LIMIT = 84;
const LON_LIMIT = 180;

/** Sinh lưới ô phủ toàn cầu, mỗi ô ~tileDeg×tileDeg độ. */
export function generateWorldTiles(tileDeg: number): BoundingBox[] {
  const step = Math.max(1, tileDeg);
  const tiles: BoundingBox[] = [];
  for (let lat = -LAT_LIMIT; lat < LAT_LIMIT; lat += step) {
    for (let lon = -LON_LIMIT; lon < LON_LIMIT; lon += step) {
      tiles.push({
        minLat: lat,
        minLon: lon,
        maxLat: Math.min(lat + step, LAT_LIMIT),
        maxLon: Math.min(lon + step, LON_LIMIT),
      });
    }
  }
  return tiles;
}

/**
 * Cắt 1 vùng cấu hình thành lưới ô ~tileDeg×tileDeg.
 *
 * Nạp bbox thô vào scanner là tự bắn vào chân: vùng bờ Đông Mỹ rộng 23° sẽ phải
 * chia nhỏ tới 5 tầng (23→11.5→5.75→2.9→1.4), worst case 1365 request cho MỘT
 * vùng. Cắt sẵn về 9° thì tầng chia tối đa còn 4 và số request đoán được.
 *
 * Lưới bám mốc tuyệt đối (…-9, 0, 9…) chứ không bám cạnh vùng, nên 2 vùng chồng
 * nhau sinh ra đúng cùng một ô — quét lại cùng toạ độ, buffer dedupe theo mmsi
 * lo phần trùng.
 */
export function tilesForBox(box: BoundingBox, tileDeg: number): BoundingBox[] {
  const step = Math.max(1, tileDeg);
  const snap = (value: number) => Math.floor(value / step) * step;

  const minLat = Math.max(snap(box.minLat), -LAT_LIMIT);
  const minLon = Math.max(snap(box.minLon), -LON_LIMIT);
  const tiles: BoundingBox[] = [];

  for (let lat = minLat; lat < box.maxLat && lat < LAT_LIMIT; lat += step) {
    for (let lon = minLon; lon < box.maxLon && lon < LON_LIMIT; lon += step) {
      tiles.push({
        minLat: lat,
        minLon: lon,
        maxLat: Math.min(lat + step, LAT_LIMIT),
        maxLon: Math.min(lon + step, LON_LIMIT),
      });
    }
  }

  return tiles;
}

/** Chia 1 ô thành 4 ô con (khi ô trả về quá nhiều tàu = có thể bị cắt bớt). */
export function splitBox(box: BoundingBox): BoundingBox[] {
  const midLat = (box.minLat + box.maxLat) / 2;
  const midLon = (box.minLon + box.maxLon) / 2;
  return [
    { minLat: box.minLat, minLon: box.minLon, maxLat: midLat, maxLon: midLon },
    { minLat: box.minLat, minLon: midLon, maxLat: midLat, maxLon: box.maxLon },
    { minLat: midLat, minLon: box.minLon, maxLat: box.maxLat, maxLon: midLon },
    { minLat: midLat, minLon: midLon, maxLat: box.maxLat, maxLon: box.maxLon },
  ];
}

/** Chiều cao (độ) của ô — dùng để biết còn chia nhỏ được nữa không. */
export function boxHeightDeg(box: BoundingBox): number {
  return box.maxLat - box.minLat;
}
