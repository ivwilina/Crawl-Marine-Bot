// ============================================================================
//  INTERFACE (CLI) · Tra cứu 1 tàu — MỤC TIÊU 1
//  Chạy:  npm run get 9811983    (IMO hoặc MMSI đều được)
// ============================================================================

import { buildContainer } from "../../container";

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) {
    console.log("👉 Cách dùng: npm run get <IMO hoặc MMSI>");
    console.log("   Ví dụ:     npm run get 9811983");
    return;
  }

  const { getVesselDetails } = await buildContainer();
  console.log(`🔎 Tra cứu (IMO/MMSI) = ${id} ...`);

  try {
    const { vessel, position, fromCache } = await getVesselDetails.execute(id);
    console.log(fromCache ? "⚡ (lấy từ cache)" : "🌐 (gọi VesselFinder)");
    console.log("────────────────────────────────────────");
    console.log(`🚢 Tên tàu    : ${vessel.name}`);
    console.log(`🆔 IMO/MMSI   : ${vessel.imo} / ${vessel.mmsi}`);
    console.log(`📦 Loại       : ${vessel.type}`);
    console.log(`🏳️  Quốc gia   : ${vessel.country}`);
    console.log(`📐 Dài×Rộng   : ${vessel.lengthM}m × ${vessel.widthM}m`);
    console.log(`⚓ Trạng thái : ${position.navStatusText}`);
    console.log(`💨 Tốc độ     : ${position.speedKn} knots`);
    console.log(`🧭 Hướng      : ${position.courseDeg}°`);
    const approx = position.latLonApproximate ? "  ⚠️ (làm tròn ~111km)" : "";
    console.log(`📍 Lat/Lon    : ${position.lat ?? "—"} / ${position.lon ?? "—"}${approx}`);
    console.log(`🕒 Vị trí lúc : ${position.positionTime}`);
    console.log("────────────────────────────────────────");
    console.log("💾 Đã lưu vào /data");
  } catch (err) {
    const e = err as { code?: string; message: string };
    console.error(`❌ [${e.code ?? "?"}] ${e.message}`);
  }
}

// Thoát hẳn sau khi xong (đóng kết nối Mongo nếu có) để tiến trình không treo.
void main().then(() => process.exit(0));
