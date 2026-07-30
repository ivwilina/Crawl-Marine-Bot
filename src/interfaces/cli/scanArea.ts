// ============================================================================
//  INTERFACE (CLI) · Scan configured VesselFinder regions into the local store.
//  Run: npm run scan
//  The scanner has no public admin API. Update SCAN_BBOX and restart the
//  private worker through the VPS service manager when regions change.
// ============================================================================

import { buildContainer } from "../../container";

async function main(): Promise<void> {
  const { scanArea, config } = await buildContainer();
  const boxes = config.scanBoundingBoxes;

  if (boxes.length === 0) {
    console.error("SCAN_BBOX is required. Configure only the regions approved for scanning.");
    process.exit(1);
  }

  console.log("Starting configured VesselFinder regions:");
  for (const box of boxes) {
    console.log(`  [${box.minLat},${box.minLon}] -> [${box.maxLat},${box.maxLon}]`);
  }

  process.on("SIGINT", () => {
    console.log("Stopping scanner...");
    scanArea.stop();
    process.exit(0);
  });

  await scanArea.start(boxes);
}

void main();
