// ============================================================================
//  APPLICATION · PORT: IVesselRepository (nơi lưu trữ)
//  Use case chỉ biết interface này; không quan tâm là JSON file hay MongoDB.
// ============================================================================

import { Vessel } from "../../domain/entities/Vessel";
import { VesselPosition } from "../../domain/entities/VesselPosition";
import { BoundingBox } from "./Geo";

export interface IVesselRepository {
  saveVessel(vessel: Vessel): Promise<void>;
  /** Ghi THÊM 1 bản ghi vị trí (append) — giữ lịch sử lộ trình */
  savePosition(position: VesselPosition): Promise<void>;
  /**
   * GHI ĐÈ vị trí mới nhất của 1 tàu (upsert theo MMSI) — mỗi tàu chỉ 1
   * bản ghi, KHÔNG phình DB. Dùng cho stream realtime khi chỉ cần vị trí hiện tại.
   */
  savePositionLatest(position: VesselPosition): Promise<void>;
  getLatestPosition(mmsi: string): Promise<VesselPosition | null>;
  /**
   * @param freshSince  chỉ trả bản ghi có receivedAt >= mốc này (bỏ vị trí đã
   *                    hết hạn). Không truyền -> trả tất cả.
   */
  getAllLatestPositions(freshSince?: Date): Promise<VesselPosition[]>;
  /**
   * Vị trí mới nhất của các tàu TRONG khung nhìn (bbox) — dùng cho bản đồ,
   * chỉ trả tối đa `limit` tàu để trình duyệt không nghẽn ở quy mô 1M.
   * `freshSince` lọc vị trí hết hạn giống getAllLatestPositions.
   */
  getLatestPositionsInBbox(
    box: BoundingBox,
    limit: number,
    freshSince?: Date
  ): Promise<VesselPosition[]>;
  /**
   * Xoá các bản ghi VỊ TRÍ MỚI NHẤT (map-state) có receivedAt < cutoff và trả
   * về số bản ghi đã xoá. KHÔNG xoá lý lịch tàu, KHÔNG xoá lịch sử lộ trình.
   */
  deleteLatestPositionsOlderThan(cutoff: Date): Promise<number>;
  /** Lý lịch (type, flagCode...) của mọi tàu đã biết — dùng để hiển thị icon theo loại tàu. */
  getAllVessels(): Promise<Vessel[]>;
  /** Lý lịch của 1 tập mmsi cụ thể — join nhanh cho các tàu trong viewport. */
  getVesselsByMmsi(mmsis: string[]): Promise<Vessel[]>;
  /**
   * Tối đa `limit` tàu CHƯA có type (cần enrich lý lịch). Query thẳng ở DB,
   * KHÔNG nạp cả triệu vessel vào RAM mỗi vòng enrich.
   */
  getVesselsMissingType(limit: number): Promise<Vessel[]>;
  /**
   * Tìm vessel theo MMSI (không phải IMO). Dùng để kiểm tra 1 mmsi đã được
   * "nâng cấp" lên IMO thật chưa (qua EnrichVesselTypes) trước khi ScanArea
   * lưu tạm bằng MMSI-là-IMO -> tránh tạo lại tàu trùng mỗi vòng quét.
   */
  findVesselByMmsi(mmsi: string): Promise<Vessel | null>;
  /** Xoá vessel + mọi position theo khóa MMSI (vd tàu im lặng quá lâu). */
  deleteVesselAndPositions(mmsi: string): Promise<void>;
}
