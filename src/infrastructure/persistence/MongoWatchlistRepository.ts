// ============================================================================
//  INFRASTRUCTURE · Repository: MongoWatchlistRepository (watchlist trong Mongo)
// ============================================================================

import { IWatchlistRepository } from "../../application/ports/IWatchlistRepository";
import { WatchlistModel } from "./mongoose/models";

export class MongoWatchlistRepository implements IWatchlistRepository {
  async getAll(): Promise<string[]> {
    const docs = await WatchlistModel.find().lean().exec();
    return docs.map((d) => d.vesselId);
  }

  async add(id: string): Promise<void> {
    // upsert: đã có thì không nhân đôi
    await WatchlistModel.updateOne(
      { vesselId: id },
      { $set: { vesselId: id } },
      { upsert: true }
    );
  }

  async remove(id: string): Promise<void> {
    await WatchlistModel.deleteOne({ vesselId: id });
  }

  async has(id: string): Promise<boolean> {
    return (await WatchlistModel.exists({ vesselId: id })) !== null;
  }
}
