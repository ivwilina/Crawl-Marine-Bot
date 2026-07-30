// ============================================================================
//  INTERFACE (CLI) · Crawl watchlist 1 lần — MỤC TIÊU 2 kiểu A (thủ công)
//  Chạy:  npm run crawl
// ============================================================================

import { buildContainer } from "../../container";

async function main(): Promise<void> {
  const { crawlFleetPositions, config, repository } = await buildContainer();

  await crawlFleetPositions.execute(config.watchlist);

  const latest = await repository.getAllLatestPositions();
  console.log(`\n📊 DB hiện có ${latest.length} tàu (vị trí mới nhất):`);
  for (const p of latest) {
    const coords =
      p.lat !== null ? `${p.lat},${p.lon}${p.latLonApproximate ? "≈" : ""}` : "—";
    console.log(
      `   • MMSI ${p.mmsi}${p.imo ? ` / IMO ${p.imo}` : ""}  ${p.navStatusText}  ${p.speedKn}kn  ${p.courseDeg}°  @${coords}`
    );
  }
}

void main().then(() => process.exit(0));
