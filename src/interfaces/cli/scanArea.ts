// ============================================================================
//  INTERFACE (CLI) · Quét lưới ô vào kho dữ liệu cục bộ. Chạy: npm run scan
// ----------------------------------------------------------------------------
//  Vùng quét:
//    • SCAN_BBOX có giá trị -> chỉ quét đúng các vùng đó (dùng khi thử nghiệm,
//      hoặc khi chỉ một số vùng được phép quét).
//    • SCAN_BBOX để trống  -> phủ TOÀN CẦU bằng lưới SCAN_TILE_DEG độ
//      (9° = 760 ô).
//  Scanner không có API admin: đổi vùng thì sửa .env rồi restart worker qua
//  service manager của VPS.
// ============================================================================

import { buildContainer } from "../../container";
import { generateWorldTiles, tilesForBox } from "../../application/use-cases/worldTiles";

async function main(): Promise<void> {
  const { scanArea, config } = await buildContainer();

  const configured = config.scanBoundingBoxes;

  // Vùng cấu hình cũng được cắt về lưới SCAN_TILE_DEG, không nạp bbox thô: một
  // vùng 23° làm subdivision chạy tới 5 tầng (~1365 request/vùng).
  const boxes =
    configured.length > 0
      ? configured.flatMap((box) => tilesForBox(box, config.scanTileDeg))
      : generateWorldTiles(config.scanTileDeg);

  if (configured.length > 0) {
    console.log(
      `Quét ${configured.length} vùng trong SCAN_BBOX -> ${boxes.length} ô ${config.scanTileDeg}°:`
    );
    for (const box of configured) {
      console.log(`  [${box.minLat},${box.minLon}] -> [${box.maxLat},${box.maxLon}]`);
    }
  } else {
    console.log(`SCAN_BBOX trống -> phủ toàn cầu: ${boxes.length} ô ${config.scanTileDeg}°.`);
  }

  process.on("SIGINT", () => {
    console.log("Stopping scanner...");
    scanArea.stop();
    process.exit(0);
  });

  await scanArea.start(boxes);
}

void main();
