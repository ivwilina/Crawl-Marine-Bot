// ============================================================================
//  INTERFACE (CLI) · AIS ingest — nguồn PHỤ, làm tươi vị trí + nối imo/mmsi
// ----------------------------------------------------------------------------
//  Chạy:  npm run ais        (Ctrl+C để dừng)
//
//  WORKER RIÊNG, giống `npm run enrich`: `npm start` KHÔNG tự bật nó. Cố ý như
//  vậy vì đây là một socket giữ mở liên tục và ghi DB đều đặn — muốn chạy thì
//  phải chạy lệnh này, để tải lên DB luôn đoán được.
//
//  Vùng theo dõi lấy từ SCAN_BBOX (cùng vùng đang crawl). SCAN_BBOX trống ->
//  toàn cầu, vì AIS không tốn request theo vùng như mp2.
// ============================================================================

import { buildContainer } from "../../container";

async function main(): Promise<void> {
  const { ingestAisStream, config } = await buildContainer();

  if (!ingestAisStream) {
    console.error("❌ Thiếu AIS_API_KEY: đặt khoá aisstream.io trong .env rồi chạy lại.");
    process.exit(1);
  }

  const boxes = config.scanBoundingBoxes;
  console.log(
    boxes.length > 0
      ? `📡 Theo dõi ${boxes.length} vùng trong SCAN_BBOX.`
      : "📡 SCAN_BBOX trống -> theo dõi toàn cầu."
  );

  // Log định kỳ: đây là tiến trình chạy vô hạn, không có gì khác cho biết nó
  // còn sống và có đang ghi được hay không.
  const reporter = setInterval(() => {
    const stats = ingestAisStream.snapshot();
    console.log(
      `📡 nhận ${stats.positionsReceived} vị trí / ${stats.staticsReceived} định danh ` +
        `-> ghi ${stats.positionsWritten} vị trí / ${stats.vesselsWritten} lý lịch ` +
        `qua ${stats.flushes} lần ghi DB.`
    );
  }, 60 * 1000);

  process.on("SIGINT", () => {
    console.log("\n🛑 Đang dừng, ghi nốt buffer...");
    clearInterval(reporter);
    void ingestAisStream.stop().then(() => process.exit(0));
  });

  await ingestAisStream.start(boxes);
}

void main();
