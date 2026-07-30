// ============================================================================
//  APPLICATION · PORT: IWatchlistRepository
// ----------------------------------------------------------------------------
//  Nơi lưu DANH SÁCH tàu đang tracking (watchlist). Lưu ở DB thay vì .env để
//  thêm/xóa được lúc đang chạy (không cần restart).
// ============================================================================

export interface IWatchlistRepository {
  /** Lấy toàn bộ ID (IMO/MMSI) đang theo dõi */
  getAll(): Promise<string[]>;
  /** Thêm 1 ID (bỏ qua nếu đã có) */
  add(id: string): Promise<void>;
  /** Xóa 1 ID */
  remove(id: string): Promise<void>;
  /** Kiểm tra đã có chưa */
  has(id: string): Promise<boolean>;
}
