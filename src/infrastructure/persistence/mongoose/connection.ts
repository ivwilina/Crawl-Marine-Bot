// ============================================================================
//  INFRASTRUCTURE · Kết nối MongoDB (Mongoose)
// ============================================================================

import mongoose from "mongoose";
import { Errors } from "../../../domain/errors/AppError";

export async function connectMongo(uri: string): Promise<void> {
  try {
    await mongoose.connect(uri);
    console.log("✅ MongoDB: đã kết nối");
  } catch (err) {
    throw Errors.SOURCE_ERROR(`Không kết nối được MongoDB: ${(err as Error).message}`);
  }
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}
