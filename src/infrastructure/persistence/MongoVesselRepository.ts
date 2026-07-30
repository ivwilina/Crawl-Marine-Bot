// ============================================================================
//  INFRASTRUCTURE · Repository: MongoVesselRepository (implements IVesselRepository)
// ----------------------------------------------------------------------------
//  Hiện thực đúng CÙNG interface với JsonFileVesselRepository. Use case không
//  biết mình đang dùng Mongo hay file JSON -> đổi qua lại chỉ sửa container.ts.
// ============================================================================

import { IVesselRepository } from "../../application/ports/IVesselRepository";
import { BoundingBox } from "../../application/ports/Geo";
import { Vessel } from "../../domain/entities/Vessel";
import { VesselPosition } from "../../domain/entities/VesselPosition";
import {
  VesselModel,
  PositionModel,
  LatestPositionModel,
  PositionDoc,
  LatestPositionDoc,
  VesselDoc,
} from "./mongoose/models";

export class MongoVesselRepository implements IVesselRepository {
  async saveVessel(vessel: Vessel): Promise<void> {
    // Upsert theo MMSI (khóa chính): có rồi thì cập nhật, chưa có thì tạo mới.
    await VesselModel.updateOne(
      { mmsi: vessel.mmsi },
      { $set: { ...vessel } },
      { upsert: true }
    );
  }

  async savePosition(position: VesselPosition): Promise<void> {
    // Append một bản ghi vị trí mới (time-series).
    await PositionModel.create({ ...position });
  }

  async savePositionLatest(position: VesselPosition): Promise<void> {
    // Ghi vào collection RIÊNG "latest_positions": mỗi mmsi 1 doc, có loc
    // [lon,lat] để bản đồ query theo khung nhìn cực nhanh (không aggregation).
    const hasCoord = position.lat != null && position.lon != null;
    await LatestPositionModel.replaceOne(
      { mmsi: position.mmsi },
      { ...position, loc: hasCoord ? [position.lon, position.lat] : undefined },
      { upsert: true }
    );
  }

  async getLatestPosition(mmsi: string): Promise<VesselPosition | null> {
    const doc = await LatestPositionModel.findOne({ mmsi: String(mmsi) })
      .lean<LatestPositionDoc>()
      .exec();
    return doc ? MongoVesselRepository.toEntity(doc) : null;
  }

  async getAllLatestPositions(): Promise<VesselPosition[]> {
    // 1 doc/tàu sẵn -> chỉ cần find(), KHÔNG aggregation nặng như trước.
    const docs = await LatestPositionModel.find().lean<LatestPositionDoc[]>().exec();
    return docs.map((d) => MongoVesselRepository.toEntity(d));
  }

  async getLatestPositionsInBbox(box: BoundingBox, limit: number): Promise<VesselPosition[]> {
    // $geoWithin $box trên index 2d -> chỉ lấy tàu trong khung nhìn, giới hạn
    // số lượng để trình duyệt không nghẽn. [lon,lat] theo thứ tự của index 2d.
    const docs = await LatestPositionModel.find({
      loc: {
        $geoWithin: {
          $box: [
            [box.minLon, box.minLat],
            [box.maxLon, box.maxLat],
          ],
        },
      },
    })
      .limit(limit)
      .lean<LatestPositionDoc[]>()
      .exec();
    return docs.map((d) => MongoVesselRepository.toEntity(d));
  }

  async getAllVessels(): Promise<Vessel[]> {
    const docs = await VesselModel.find().lean().exec();
    return (docs as unknown as VesselDoc[]).map(MongoVesselRepository.docToVessel);
  }

  async getVesselsByMmsi(mmsis: string[]): Promise<Vessel[]> {
    if (mmsis.length === 0) return [];
    const docs = await VesselModel.find({ mmsi: { $in: mmsis } }).lean().exec();
    return (docs as unknown as VesselDoc[]).map(MongoVesselRepository.docToVessel);
  }

  async getVesselsMissingType(limit: number): Promise<Vessel[]> {
    const docs = await VesselModel.find({
      $or: [{ type: null }, { type: { $exists: false } }, { type: "" }],
    })
      .limit(limit)
      .lean()
      .exec();
    return (docs as unknown as VesselDoc[]).map(MongoVesselRepository.docToVessel);
  }

  async findVesselByMmsi(mmsi: string): Promise<Vessel | null> {
    const doc = await VesselModel.findOne({ mmsi }).lean().exec();
    if (!doc) return null;
    return MongoVesselRepository.docToVessel(doc as unknown as VesselDoc);
  }

  async deleteVesselAndPositions(mmsi: string): Promise<void> {
    await Promise.all([
      VesselModel.deleteOne({ mmsi }),
      PositionModel.deleteMany({ mmsi }),
      LatestPositionModel.deleteOne({ mmsi }),
    ]);
  }

  private static docToVessel(d: VesselDoc): Vessel {
    return new Vessel({
      imo: d.imo,
      mmsi: d.mmsi,
      name: d.name,
      type: d.type,
      callsign: d.callsign,
      flagCode: d.flagCode,
      country: d.country,
      yearBuilt: d.yearBuilt,
      lengthM: d.lengthM,
      widthM: d.widthM,
      grossTonnage: d.grossTonnage,
      deadweight: d.deadweight,
      draughtM: d.draughtM,
      photoUrl: d.photoUrl,
    });
  }

  /** Chuyển document Mongo -> Entity Domain (giữ nguyên receivedAt đã lưu) */
  private static toEntity(doc: PositionDoc | LatestPositionDoc): VesselPosition {
    return new VesselPosition({
      imo: doc.imo,
      mmsi: doc.mmsi,
      lat: doc.lat,
      lon: doc.lon,
      speedKn: doc.speedKn,
      courseDeg: doc.courseDeg,
      headingDeg: doc.headingDeg,
      navStatusCode: doc.navStatusCode,
      navStatusText: doc.navStatusText,
      destination: doc.destination,
      eta: doc.eta,
      positionTime: doc.positionTime,
      source: doc.source as VesselPosition["source"],
      latLonApproximate: doc.latLonApproximate ?? false,
      receivedAt: doc.receivedAt ?? undefined,
    });
  }
}
