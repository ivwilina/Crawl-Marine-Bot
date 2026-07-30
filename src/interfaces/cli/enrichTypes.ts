// ============================================================================
//  INTERFACE (CLI) · Enrich: bổ sung type/flag cho tàu quét từ mp2 (chỉ mmsi)
// ----------------------------------------------------------------------------
//  Chạy:  npm run enrich        (Ctrl+C để dừng)
//  Tự động chạy nền khi `npm start` rồi -> chỉ cần dùng CLI này nếu muốn chạy
//  RIÊNG (không kèm Express server), ví dụ để enrich nhanh 1 lần rồi tắt.
// ============================================================================

import { buildContainer } from "../../container";

async function main(): Promise<void> {
  const { enrichVesselTypes } = await buildContainer();

  process.on("SIGINT", () => {
    console.log("\n🛑 Đang dừng...");
    enrichVesselTypes.stop();
    process.exit(0);
  });

  await enrichVesselTypes.start();
}

void main();
