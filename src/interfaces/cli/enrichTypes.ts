// ============================================================================
//  INTERFACE (CLI) · Enrich: bổ sung type/flag cho tàu quét từ mp2 (chỉ mmsi)
// ----------------------------------------------------------------------------
//  Chạy:  npm run enrich        (Ctrl+C để dừng)
//  Đây là WORKER RIÊNG: `npm start` KHÔNG tự chạy enrich. Cố ý như vậy để số
//  request gửi lên upstream luôn đoán được — muốn enrich thì phải chạy lệnh này.
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
