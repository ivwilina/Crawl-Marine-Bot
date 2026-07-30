// ============================================================================
//  APPLICATION · USE CASE: ManageWatchlist (thêm/xóa/xem tàu tracking)
// ----------------------------------------------------------------------------
//  Dùng cho các API /watchlist. Có validate ID trước khi thêm.
// ============================================================================

import { IWatchlistRepository } from "../ports/IWatchlistRepository";
import { Errors } from "../../domain/errors/AppError";

export class ManageWatchlist {
  constructor(private readonly repo: IWatchlistRepository) {}

  list(): Promise<string[]> {
    return this.repo.getAll();
  }

  async add(id: string): Promise<string[]> {
    if (!/^\d{7,9}$/.test(String(id))) {
      throw Errors.INVALID_ID(id);
    }
    await this.repo.add(String(id));
    return this.repo.getAll();
  }

  async remove(id: string): Promise<string[]> {
    await this.repo.remove(String(id));
    return this.repo.getAll();
  }
}
