// ============================================================================
//  APPLICATION · PORT: IAreaScanner
//  Quét 1 vùng -> trả danh sách tàu (mmsi + tên + toạ độ). VesselFinderMapSource
//  (qua mp2) implement port này; mai đổi nguồn khác chỉ viết class mới.
// ============================================================================

import { BoundingBox } from "./Geo";

export interface ScannedShip {
  mmsi: string;
  name: string;
  lat: number;
  lon: number;
}

export interface IAreaScanner {
  fetchArea(box: BoundingBox, zoom?: number): Promise<ScannedShip[]>;
}
