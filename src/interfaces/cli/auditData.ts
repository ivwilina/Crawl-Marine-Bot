// ============================================================================
//  INTERFACE (CLI) · Audit: kiểm tra tính đúng đắn dữ liệu trong DB
// ----------------------------------------------------------------------------
//  Chạy:  npm run audit
//  Kiểm tra các lỗi ĐÃ TỪNG gặp trong project (trùng mmsi/2 imo, toạ độ ngoài
//  bbox đang quét, vessel mồ côi không có position) — chạy bất cứ lúc nào
//  nghi ngờ data sai, không cần sửa code / viết script tạm nữa.
// ============================================================================

import { buildContainer } from "../../container";
import { BoundingBox } from "../../application/ports/Geo";

function inAnyBox(lat: number, lon: number, boxes: BoundingBox[]): boolean {
  if (boxes.length === 0) return true; // không có bbox cấu hình -> không check
  return boxes.some((b) => lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon);
}

async function main(): Promise<void> {
  const { repository, config } = await buildContainer();
  const vessels = await repository.getAllVessels();
  const positions = await repository.getAllLatestPositions();

  console.log(`📦 Tổng: ${vessels.length} vessel, ${positions.length} position\n`);

  // 1) Trùng mmsi (2 imo khác nhau cùng 1 mmsi) — bug đã gặp: ScanArea tạo lại
  // bản tạm dù đã có IMO thật.
  const byMmsi = new Map<string, number>();
  for (const v of vessels) {
    if (!v.mmsi) continue;
    byMmsi.set(v.mmsi, (byMmsi.get(v.mmsi) ?? 0) + 1);
  }
  const dupMmsi = [...byMmsi.entries()].filter(([, n]) => n > 1);
  console.log(`🔁 MMSI bị trùng (>1 bản ghi): ${dupMmsi.length}`);
  for (const [mmsi, n] of dupMmsi.slice(0, 10)) {
    console.log(`   mmsi=${mmsi} -> ${n} bản`);
  }

  // 2) Toạ độ nằm ngoài mọi bbox đang cấu hình quét — dấu hiệu decode lỗi
  // (mp2 desync) hoặc data cũ để lại từ vùng quét trước.
  const outside = positions.filter(
    (p) => p.lat != null && p.lon != null && !inAnyBox(p.lat, p.lon, config.scanBoundingBoxes)
  );
  console.log(`\n🗺️  Toạ độ NGOÀI mọi bbox đang cấu hình: ${outside.length}`);
  for (const p of outside.slice(0, 10)) {
    console.log(`   mmsi=${p.mmsi} lat=${p.lat} lon=${p.lon} (source=${p.source})`);
  }

  // 3) Vessel không có position tương ứng (mồ côi — crawl lỗi giữa đường).
  const posKeys = new Set(positions.map((p) => p.mmsi));
  const orphans = vessels.filter((v) => !posKeys.has(v.mmsi));
  console.log(`\n👻 Vessel không có position: ${orphans.length}`);
  for (const v of orphans.slice(0, 10)) {
    console.log(`   mmsi=${v.mmsi} imo=${v.imo} name=${v.name}`);
  }

  // 4) Position không có vessel tương ứng (ngược lại #3).
  const vesselKeys = new Set(vessels.map((v) => v.mmsi));
  const posOrphans = positions.filter((p) => p.mmsi && !vesselKeys.has(p.mmsi));
  console.log(`\n👻 Position không có vessel: ${posOrphans.length}`);
  for (const p of posOrphans.slice(0, 10)) {
    console.log(`   mmsi=${p.mmsi} imo=${p.imo}`);
  }

  const clean = dupMmsi.length === 0 && outside.length === 0 && orphans.length === 0 && posOrphans.length === 0;
  console.log(clean ? "\n✅ Data sạch, không phát hiện lỗi." : "\n⚠️  Phát hiện vấn đề — xem chi tiết trên.");
  process.exit(clean ? 0 : 1);
}

void main();
