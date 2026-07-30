// ============================================================================
//  INTERFACE (CLI) · Reset index MongoDB theo schema hiện tại
// ----------------------------------------------------------------------------
//  Chạy:  npm run reset-indexes
//  Dùng SAU KHI đổi khóa/schema (vd IMO -> MMSI): xoá index cũ còn sót +
//  tạo lại đúng index (mmsi unique...). ⚠️ Có cờ --drop để XOÁ SẠCH dữ liệu
//  vessels/positions trước khi dựng lại — chỉ dùng khi chấp nhận mất data.
// ============================================================================

import mongoose from "mongoose";
import * as dotenv from "dotenv";
import { VesselModel, PositionModel, LatestPositionModel } from "../../infrastructure/persistence/mongoose/models";

dotenv.config();

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("❌ Thiếu MONGODB_URI (đang dùng JSON file? Không cần reset index).");
    process.exit(1);
  }
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;

  if (process.argv.includes("--drop")) {
    for (const coll of ["vessels", "vesselpositions", "latestpositions"]) {
      try {
        await db.collection(coll).drop();
        console.log(`🗑️  Đã xoá collection ${coll}`);
      } catch (e) {
        console.log(`   (bỏ qua ${coll}: ${(e as Error).message})`);
      }
    }
  }

  // syncIndexes: xoá index thừa không còn trong schema + tạo index mới.
  await VesselModel.syncIndexes();
  await PositionModel.syncIndexes();
  await LatestPositionModel.syncIndexes();

  const show = async (coll: string) =>
    (await db.collection(coll).indexes()).map((i) => ({ name: i.name, unique: i.unique, sparse: i.sparse }));
  console.log("✅ vessels index:", JSON.stringify(await show("vessels")));
  console.log("✅ positions index:", JSON.stringify(await show("vesselpositions")));
  console.log("✅ latestpositions index:", JSON.stringify(await show("latestpositions")));

  await mongoose.disconnect();
}

void main();
