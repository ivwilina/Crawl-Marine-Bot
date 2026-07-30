// ============================================================================
//  APPLICATION · USE CASE: CleanupStalePositions
// ----------------------------------------------------------------------------
//  Xoá VỊ TRÍ MỚI NHẤT (map-state) đã quá cũ để bản đồ không hiển thị tàu ở
//  chỗ nó không còn ở đó nữa. Chỉ đụng latest_positions:
//    • lý lịch tàu (vessels)      -> GIỮ
//    • lịch sử lộ trình (positions) -> GIỮ (dữ liệu audit)
// ============================================================================

import { IVesselRepository } from "../ports/IVesselRepository";

export interface CleanupStalePositionsDeps {
  repo: IVesselRepository;
  /** Vị trí cũ hơn ngần này ms bị coi là hết hạn. */
  staleAfterMs: number;
}

export class CleanupStalePositions {
  constructor(private readonly deps: CleanupStalePositionsDeps) {}

  /** Mốc "còn tươi": bản ghi có receivedAt >= mốc này vẫn được trả về. */
  freshSince(now: Date = new Date()): Date {
    return new Date(now.getTime() - this.deps.staleAfterMs);
  }

  /** @returns số bản ghi vị trí mới nhất đã xoá */
  async execute(now: Date = new Date()): Promise<number> {
    return this.deps.repo.deleteLatestPositionsOlderThan(this.freshSince(now));
  }
}
