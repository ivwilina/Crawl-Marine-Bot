// ============================================================================
//  INFRASTRUCTURE · Repository: MongoVesselRepository (implements IVesselRepository)
// ----------------------------------------------------------------------------
//  Hiện thực đúng CÙNG interface với JsonFileVesselRepository. Use case không
//  biết mình đang dùng Mongo hay file JSON -> đổi qua lại chỉ sửa container.ts.
// ============================================================================

import { IVesselRepository } from "../../application/ports/IVesselRepository";
import { BoundingBox, EARTH_RADIUS_KM, KM_PER_NM } from "../../application/ports/Geo";
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

/**
 * Số operation mỗi lệnh bulkWrite. MongoDB cho phép nhiều hơn hẳn, nhưng mẻ nhỏ
 * giữ mỗi lệnh dưới giới hạn 16MB và không giữ server bận quá lâu trong 1 lượt.
 */
const BULK_CHUNK = 1000;

/**
 * Query ngắn hơn ngần này khớp gần hết collection và không đáng một lượt scan.
 * Đây là hàng rào của tầng lưu trữ; trả 400 cho client là việc của route.
 */
const NAME_SEARCH_MIN_LENGTH = 3;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Chặn ký tự đặc biệt trước khi ghép tên người dùng nhập vào RegExp. */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

  /**
   * Lý lịch của cả mẻ quét trong vài lệnh bulkWrite.
   *
   * `$setOnInsert` cho toàn bộ lý lịch: mp2 chỉ có mmsi + tên, nên ghi đè sẽ
   * xoá type/flag/kích thước mà enrich đã tra. Chỉ `name` được `$set`.
   * `ordered: false` để 1 op lỗi không chặn phần còn lại của mẻ.
   */
  async upsertVesselsFromScan(vessels: Vessel[]): Promise<number> {
    let written = 0;

    for (const batch of chunked(vessels, BULK_CHUNK)) {
      const ops = batch.map((vessel) => {
        const { name, ...profile } = { ...vessel };
        const setOnInsert: Record<string, unknown> = { ...profile };
        const update: Record<string, unknown> = {};

        // mp2 trả tên rỗng thì lấy chính mmsi làm tên -> đó không phải tên thật,
        // không được đè lên tên đã có.
        if (name && name !== vessel.mmsi) update.$set = { name };
        else setOnInsert.name = name ?? null;

        update.$setOnInsert = setOnInsert;
        return { updateOne: { filter: { mmsi: vessel.mmsi }, update, upsert: true } };
      });

      const result = await VesselModel.bulkWrite(ops, { ordered: false });
      written += (result.upsertedCount ?? 0) + (result.modifiedCount ?? 0);
    }

    return written;
  }

  /**
   * Vị trí mới nhất của cả mẻ quét trong vài lệnh bulkWrite.
   *
   * mp2 chỉ có toạ độ, nên chỉ toạ độ + nguồn + thời điểm nhận được ghi. Các
   * field chỉ trang chi tiết/AIS mới có (course/speed/navStatus/destination) đi
   * vào phần "chỉ khi tạo mới" để tàu mới vẫn có document đầy đủ, còn tàu đã
   * enrich thì giữ nguyên giá trị thật.
   */
  async savePositionsFromScan(positions: VesselPosition[]): Promise<number> {
    return this._writeGuardedPositions(positions, (position) => {
      const set: Record<string, unknown> = {
        lat: position.lat,
        lon: position.lon,
        source: position.source,
        latLonApproximate: position.latLonApproximate,
        receivedAt: position.receivedAt,
      };

      // Toạ độ hợp lệ mới ghi `loc`; thiếu thì để nguyên cái cũ cho index 2d.
      if (position.hasCoordinates()) set.loc = [position.lon, position.lat];
      // IMO của nguồn quét luôn null -> không xoá IMO mà enrich/AIS đã điền.
      if (position.imo !== null) set.imo = position.imo;

      return {
        set,
        insertOnly: {
          imo: position.imo,
          speedKn: null,
          courseDeg: null,
          headingDeg: null,
          navStatusCode: null,
          navStatusText: position.navStatusText,
          destination: null,
          eta: null,
          lastPort: null,
          lastPortDepartureUtc: null,
          positionTime: null,
        },
      };
    });
  }

  /**
   * Vị trí từ AIS. Ghi nhiều field hơn scan vì PositionReport mang cả
   * course/speed/heading/navStatus, nhưng không đụng destination/eta — những
   * thứ đó chỉ trang chi tiết có.
   */
  async savePositionsFromAis(positions: VesselPosition[]): Promise<number> {
    return this._writeGuardedPositions(positions, (position) => {
      const set: Record<string, unknown> = {
        lat: position.lat,
        lon: position.lon,
        speedKn: position.speedKn,
        courseDeg: position.courseDeg,
        headingDeg: position.headingDeg,
        navStatusCode: position.navStatusCode,
        navStatusText: position.navStatusText,
        source: position.source,
        latLonApproximate: position.latLonApproximate,
        receivedAt: position.receivedAt,
      };

      if (position.hasCoordinates()) set.loc = [position.lon, position.lat];
      if (position.imo !== null) set.imo = position.imo;

      return {
        set,
        insertOnly: {
          imo: position.imo,
          destination: null,
          eta: null,
          lastPort: null,
          lastPortDepartureUtc: null,
          positionTime: null,
        },
      };
    });
  }

  /**
   * Định danh từ AIS ShipStaticData: CHỈ điền chỗ trống.
   *
   * `$ifNull` là cả ý nghĩa của hàm này — giá trị đang có luôn thắng, nên một
   * bản ghi đã qua enrich (type dạng chữ, tên sạch) không bị AIS ghi đè, còn
   * tàu mới quét thì được nối `imo` và `aisType` mà mp2 không bao giờ có.
   */
  async upsertVesselsFromAis(vessels: Vessel[]): Promise<number> {
    let written = 0;

    for (const batch of chunked(vessels, BULK_CHUNK)) {
      const ops = batch.map((vessel) => ({
        updateOne: {
          filter: { mmsi: vessel.mmsi },
          update: [
            {
              $set: {
                imo    : { $ifNull: ["$imo", vessel.imo] },
                aisType: { $ifNull: ["$aisType", vessel.aisType] },
                name   : { $ifNull: ["$name", vessel.name] },
              },
            },
          ],
          upsert: true,
        },
      }));

      if (ops.length === 0) continue;

      const result = await VesselModel.bulkWrite(ops, { ordered: false });
      written += (result.upsertedCount ?? 0) + (result.modifiedCount ?? 0);
    }

    return written;
  }

  /**
   * Ghi vị trí theo mẻ, không bao giờ ghi đè bản ghi MỚI HƠN.
   *
   * Dùng aggregation-pipeline update thay vì `$set`/`$setOnInsert` vì hai lý do
   * không thể tránh: điều kiện "chỉ ghi khi mới hơn" phải nằm TRONG lệnh ghi để
   * còn nguyên tính nguyên tử (đọc rồi so rồi ghi là một race), mà nếu đưa điều
   * kiện đó vào `filter` thì upsert sẽ INSERT một document thứ hai khi bản ghi
   * hiện có mới hơn — và đụng unique index `mmsi`.
   *
   * Thứ tự trong `$mergeObjects` chính là thứ tự ưu tiên: default lúc tạo mới
   * (thấp nhất) -> document hiện có -> dữ liệu mới (chỉ khi mới hơn).
   */
  private async _writeGuardedPositions(
    positions: VesselPosition[],
    build: (position: VesselPosition) => { set: Record<string, unknown>; insertOnly: Record<string, unknown> }
  ): Promise<number> {
    let written = 0;

    for (const batch of chunked(positions, BULK_CHUNK)) {
      const ops = batch
        .filter((position) => position.mmsi !== null)
        .map((position) => {
          const { set, insertOnly } = build(position);

          // Chưa có `receivedAt` = document vừa do upsert tạo ra.
          const isNew = { $eq: [{ $type: "$receivedAt" }, "missing"] };
          const isFresher = {
            $or: [isNew, { $lte: ["$receivedAt", position.receivedAt] }],
          };

          return {
            updateOne: {
              filter: { mmsi: position.mmsi },
              update: [
                {
                  $replaceWith: {
                    $mergeObjects: [
                      { $cond: [isNew, insertOnly, {}] },
                      "$$ROOT",
                      { $cond: [isFresher, set, {}] },
                    ],
                  },
                },
              ],
              upsert: true,
            },
          };
        });

      if (ops.length === 0) continue;

      const result = await LatestPositionModel.bulkWrite(ops, { ordered: false });
      written += (result.upsertedCount ?? 0) + (result.modifiedCount ?? 0);
    }

    return written;
  }

  async getLatestPosition(mmsi: string): Promise<VesselPosition | null> {
    const doc = await LatestPositionModel.findOne({ mmsi: String(mmsi) })
      .lean<LatestPositionDoc>()
      .exec();
    return doc ? MongoVesselRepository.toEntity(doc) : null;
  }

  async getAllLatestPositions(freshSince?: Date): Promise<VesselPosition[]> {
    // 1 doc/tàu sẵn -> chỉ cần find(), KHÔNG aggregation nặng như trước.
    const docs = await LatestPositionModel.find(MongoVesselRepository.freshFilter(freshSince))
      .lean<LatestPositionDoc[]>()
      .exec();
    return docs.map((d) => MongoVesselRepository.toEntity(d));
  }

  async getLatestPositionsInBbox(
    box: BoundingBox,
    limit: number,
    freshSince?: Date
  ): Promise<VesselPosition[]> {
    // $geoWithin $box trên index 2d -> chỉ lấy tàu trong khung nhìn, giới hạn
    // số lượng để trình duyệt không nghẽn. [lon,lat] theo thứ tự của index 2d.
    const docs = await LatestPositionModel.find({
      ...MongoVesselRepository.freshFilter(freshSince),
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

  /**
   * Nearby bằng `$geoWithin $centerSphere` trên index 2d: MongoDB tự lọc theo
   * khoảng cách cầu, không phải hình vuông. Bán kính đưa vào radian = km / R.
   *
   * `$centerSphere` không sắp theo khoảng cách (chỉ `$near` mới sắp, mà `$near`
   * không kết hợp được với filter `receivedAt` trên cùng index 2d một cách hiệu
   * quả), nên sắp lại ở tầng use-case/route.
   */
  async getLatestPositionsNearby(
    center: { lat: number; lon: number },
    radiusNm: number,
    limit: number,
    freshSince?: Date
  ): Promise<VesselPosition[]> {
    const radiusRadians = (radiusNm * KM_PER_NM) / EARTH_RADIUS_KM;

    const docs = await LatestPositionModel.find({
      ...MongoVesselRepository.freshFilter(freshSince),
      loc: {
        $geoWithin: {
          $centerSphere: [[center.lon, center.lat], radiusRadians],
        },
      },
    })
      .limit(limit)
      .lean<LatestPositionDoc[]>()
      .exec();

    return docs.map((d) => MongoVesselRepository.toEntity(d));
  }

  /**
   * Xoá map-state hết hạn. CHỈ collection latest_positions: lý lịch tàu
   * (vessels) và lịch sử lộ trình (positions) giữ nguyên.
   */
  async deleteLatestPositionsOlderThan(cutoff: Date): Promise<number> {
    const result = await LatestPositionModel.deleteMany({
      receivedAt: { $lt: cutoff.toISOString() },
    });
    return result.deletedCount ?? 0;
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

  /**
   * Tìm theo prefix tên, không phân biệt hoa thường.
   *
   * ⚠️ Regex `i` KHÔNG dùng được index `name` (MongoDB chỉ dùng index cho regex
   * prefix phân biệt hoa thường). Ở đây `limit` chặn payload, không chặn scan —
   * chấp nhận được vì scan dừng sớm khi đã đủ `limit` bản khớp. Nếu collection
   * lên hàng triệu thì thêm field `nameUpper` + index và tra bằng prefix in hoa.
   */
  async findVesselsByName(prefix: string, limit: number): Promise<Vessel[]> {
    const query = prefix.trim();
    if (query.length < NAME_SEARCH_MIN_LENGTH) return [];

    const docs = await VesselModel.find({
      name: new RegExp(`^${escapeRegExp(query)}`, "i"),
    })
      .sort({ name: 1 })
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

  /** Cả 2 field đều có index, nên $or dùng index union chứ không scan. */
  async findVesselByImoOrMmsi(id: string): Promise<Vessel | null> {
    const key = String(id).trim();
    const doc = await VesselModel.findOne({ $or: [{ mmsi: key }, { imo: key }] })
      .lean()
      .exec();
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

  /**
   * receivedAt lưu dạng ISO string -> so sánh chuỗi ISO là so sánh thời gian
   * (cùng độ dài, cùng UTC "Z"). Không truyền freshSince -> không lọc.
   */
  private static freshFilter(freshSince?: Date): Record<string, unknown> {
    return freshSince ? { receivedAt: { $gte: freshSince.toISOString() } } : {};
  }

  private static docToVessel(d: VesselDoc): Vessel {
    return new Vessel({
      imo: d.imo,
      mmsi: d.mmsi,
      name: d.name,
      type: d.type,
      aisType: d.aisType,
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
      lastPort: doc.lastPort,
      lastPortDepartureUtc: doc.lastPortDepartureUtc,
      positionTime: doc.positionTime,
      source: doc.source as VesselPosition["source"],
      latLonApproximate: doc.latLonApproximate ?? false,
      receivedAt: doc.receivedAt ?? undefined,
    });
  }
}
