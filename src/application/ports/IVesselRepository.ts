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
  /**
   * Ghi 1 MẺ lý lịch tàu do ScanArea quét được, trong ít lệnh nhất có thể.
   *
   * Nguồn quét vùng (mp2) CHỈ có mmsi + tên: mọi field lý lịch khác là null.
   * Nên field lý lịch chỉ được ghi KHI TẠO MỚI — nếu ghi đè, mỗi vòng quét sẽ
   * xoá sạch type/flag/kích thước mà EnrichVesselTypes đã tra về. Riêng `name`
   * được cập nhật, trừ khi nó chỉ là mmsi (mp2 trả tên rỗng -> dùng mmsi thay).
   *
   * @returns số bản ghi đã tạo mới hoặc cập nhật
   */
  upsertVesselsFromScan(vessels: Vessel[]): Promise<number>;
  /**
   * Ghi 1 MẺ vị trí mới nhất do ScanArea quét được.
   *
   * Chỉ đặt các field nguồn quét thực sự có (toạ độ, nguồn, thời điểm nhận);
   * course/speed/navStatus do EnrichVesselTypes điền được GIỮ NGUYÊN.
   *
   * @returns số bản ghi đã tạo mới hoặc cập nhật
   */
  savePositionsFromScan(positions: VesselPosition[]): Promise<number>;
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
   * Vị trí mới nhất của các tàu trong bán kính `radiusNm` hải lý quanh 1 điểm,
   * gần nhất trước. Đây là "Vessel Nearby" của api_v3, chạy hoàn toàn trên dữ
   * liệu đã crawl nên không tốn credit upstream nào.
   *
   * Bán kính là khoảng cách great-circle, không phải hình vuông bbox: ở vĩ độ
   * cao 1° kinh tuyến ngắn hơn nhiều so với 1° vĩ tuyến, nên lọc theo bbox sẽ
   * trả về tàu xa hơn bán kính đã hỏi.
   */
  getLatestPositionsNearby(
    center: { lat: number; lon: number },
    radiusNm: number,
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
  /**
   * Tra 1 tàu bằng IMO HOẶC MMSI — mọi luồng free tier của api_v3 đều nhận cả
   * hai và không nói trước là cái nào.
   */
  findVesselByImoOrMmsi(id: string): Promise<Vessel | null>;
  /**
   * Tàu có tên BẮT ĐẦU bằng `prefix` (không phân biệt hoa thường), sắp theo tên.
   *
   * Prefix chứ không phải chứa-ở-giữa: người dùng gõ dần từ đầu tên, và tìm
   * giữa chuỗi thì không index nào đỡ được ở quy mô hàng trăm nghìn tàu.
   *
   * @param prefix - Ít nhất 3 ký tự; ngắn hơn thì trả rỗng
   * @param limit - Chặn trên số kết quả
   */
  findVesselsByName(prefix: string, limit: number): Promise<Vessel[]>;
  /** Xoá vessel + mọi position theo khóa MMSI (vd tàu im lặng quá lâu). */
  deleteVesselAndPositions(mmsi: string): Promise<void>;
}
