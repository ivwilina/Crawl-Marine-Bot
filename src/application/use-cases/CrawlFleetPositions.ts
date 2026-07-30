// ============================================================================
//  APPLICATION · USE CASE: CrawlFleetPositions
//  → MỤC TIÊU 2 (kiểu A): crawl danh sách ID đã biết → DB, định kỳ.
// ----------------------------------------------------------------------------
//  Nhận danh sách ID (watchlist), lần lượt kéo từng tàu và lưu DB, có nghỉ
//  giữa các tàu để không bị chặn.
// ============================================================================

import { IVesselDetailsSource } from "../ports/IVesselDetailsSource";
import { IVesselRepository } from "../ports/IVesselRepository";

export interface CrawlFleetDeps {
  detailsSource: IVesselDetailsSource;
  repository: IVesselRepository;
  delayMs?: number;
}

export interface CrawlResult {
  ok: number;
  failed: number;
  errors: Array<{ id: string; code: string; message: string }>;
}

export class CrawlFleetPositions {
  private readonly detailsSource: IVesselDetailsSource;
  private readonly repository: IVesselRepository;
  private readonly delayMs: number;

  constructor(deps: CrawlFleetDeps) {
    this.detailsSource = deps.detailsSource;
    this.repository = deps.repository;
    this.delayMs = deps.delayMs ?? 1500;
  }

  async execute(idList: string[]): Promise<CrawlResult> {
    let ok = 0;
    let failed = 0;
    const errors: CrawlResult["errors"] = [];

    console.log(`🛰️  Bắt đầu crawl ${idList.length} tàu...`);

    for (const id of idList) {
      try {
        const { vessel, position } = await this.detailsSource.getDetails(id);
        await this.repository.saveVessel(vessel);
        await this.repository.savePosition(position);
        ok++;
        console.log(`   ✅ ${id}  ${vessel.name ?? ""} (${position.navStatusText})`);
      } catch (err) {
        failed++;
        const e = err as { code?: string; message: string };
        errors.push({ id, code: e.code ?? "?", message: e.message });
        console.log(`   ❌ ${id}  ${e.message}`);
      }
      await CrawlFleetPositions.sleep(this.delayMs);
    }

    console.log(`🏁 Xong: ${ok} thành công, ${failed} lỗi.`);
    return { ok, failed, errors };
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
