// ============================================================================
//  APPLICATION · PORT: IAisStream — nguồn AIS realtime (aisstream.io)
// ----------------------------------------------------------------------------
//  AIS là nguồn PHỤ: crawl mp2 vẫn là nguồn chính của bản đồ. Vai của AIS:
//    1) làm tươi vị trí giữa hai vòng quét (vòng quét vùng tính bằng giờ),
//    2) mang course/speed/navStatus mà mp2 KHÔNG có,
//    3) nối `imo` với `mmsi` — thứ mp2 không bao giờ có và tra trang chi tiết
//       chỉ làm được ~4.300 tàu/ngày.
//
//  Port này chỉ mô tả 2 loại message ta dùng. Mọi thứ về WebSocket, reconnect,
//  và định dạng thời gian của nhà cung cấp nằm ở infrastructure.
// ============================================================================

import { BoundingBox } from "./Geo";

/** PositionReport: tàu đang ở đâu, đi hướng nào. */
export interface AisPositionMessage {
  mmsi: string;
  lat: number;
  lon: number;
  speedKn: number | null;
  courseDeg: number | null;
  headingDeg: number | null;
  navStatusCode: number | null;
  /** Đã chuẩn hoá sang chữ ở tầng infrastructure, để use case không phải tra bảng. */
  navStatusText: string;
  /** ISO 8601. Nhà cung cấp gửi định dạng Go, đã được đổi ở infrastructure. */
  receivedAt: string;
}

/** ShipStaticData: tàu này là ai — mang CẢ imo và mmsi. */
export interface AisStaticMessage {
  mmsi: string;
  imo: string | null;
  name: string | null;
  /** Mã loại AIS 0-99. */
  aisType: number | null;
}

export interface IAisStream {
  /** Đăng ký nhận vị trí. Gọi trước `connect()`. */
  onPosition(handler: (message: AisPositionMessage) => void): void;
  /** Đăng ký nhận định danh. Gọi trước `connect()`. */
  onStatic(handler: (message: AisStaticMessage) => void): void;
  /**
   * Mở kết nối và đăng ký các vùng cần theo dõi.
   * @param boxes - Vùng quan tâm; rỗng nghĩa là toàn cầu
   */
  connect(boxes: BoundingBox[]): Promise<void>;
  /** Đóng kết nối và huỷ mọi hẹn reconnect. */
  stop(): void;
}
