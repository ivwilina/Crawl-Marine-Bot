// ============================================================================
//  INFRASTRUCTURE · Mongoose Models (schema của MongoDB)
// ----------------------------------------------------------------------------
//  Đây là "hình dạng" dữ liệu trong MongoDB. Tách tĩnh (Vessel) khỏi động
//  (VesselPosition) đúng như Domain Spec.
// ============================================================================

import { Schema, model, InferSchemaType } from "mongoose";

// ---- Vessel: lý lịch tàu (mỗi MMSI 1 bản, cập nhật đè) ----
//  KHÓA CHÍNH = mmsi (unique) -> DB tự chống trùng tàu, không thể có 2 bản/tàu.
//  imo là thuộc tính thường (nhiều tàu không có), sparse để cho phép null.
const vesselSchema = new Schema(
  {
    mmsi: { type: String, required: true, unique: true, index: true },
    imo: { type: String, index: true, sparse: true },
    // Có index để sắp theo tên và tra tên chính xác. Lưu ý: tìm prefix KHÔNG
    // phân biệt hoa thường (findVesselsByName) vẫn phải scan — MongoDB không
    // dùng index cho regex `i`.
    name: { type: String, index: true },
    // Loại dạng chữ (trang chi tiết) và mã loại AIS dạng số (AIS) tồn tại song
    // song: cái đầu để hiển thị, cái sau là `vType` mà contract v3 yêu cầu.
    type: String,
    aisType: Number,
    callsign: String,
    flagCode: String,
    country: String,
    yearBuilt: Number,
    lengthM: Number,
    widthM: Number,
    grossTonnage: Number,
    deadweight: Number,
    draughtM: Number,
    photoUrl: String,
  },
  { timestamps: true } // tự thêm createdAt / updatedAt
);

// ---- VesselPosition: vị trí (time-series, ghi nhiều) ----
const positionSchema = new Schema({
  mmsi: { type: String, index: true }, // KHÓA tàu (khớp Vessel.mmsi)
  imo: { type: String, index: true, sparse: true },
  lat: Number,
  lon: Number,
  speedKn: Number,
  courseDeg: Number,
  headingDeg: Number,
  navStatusCode: Number,
  navStatusText: String,
  destination: String,
  eta: String,
  // Cảng rời gần nhất + giờ rời (ATD), giữ nguyên chữ của trang chi tiết.
  lastPort: String,
  lastPortDepartureUtc: String,
  positionTime: String,
  source: String,
  latLonApproximate: Boolean,
  receivedAt: { type: String, index: true },
});
// Index kép để truy vấn "vị trí mới nhất của 1 tàu" cho nhanh (BR / spec §06)
positionSchema.index({ mmsi: 1, receivedAt: -1 });

// ---- LatestPosition: CHỈ vị trí MỚI NHẤT (mỗi mmsi 1 bản) ----
//  Tách khỏi lịch sử (positionSchema) để bản đồ query CỰC NHANH theo khung
//  nhìn (bbox) mà KHÔNG phải gom aggregation cả triệu bản ghi lịch sử.
//    • mmsi unique  -> 1 tàu = 1 doc.
//    • loc [lon,lat] + index 2d -> truy vấn $geoWithin $box theo viewport.
const latestPositionSchema = new Schema({
  mmsi: { type: String, required: true, unique: true, index: true },
  imo: { type: String, index: true, sparse: true },
  loc: { type: [Number], index: "2d" }, // [lon, lat] cho $geoWithin $box
  lat: Number,
  lon: Number,
  speedKn: Number,
  courseDeg: Number,
  headingDeg: Number,
  navStatusCode: Number,
  navStatusText: String,
  destination: String,
  eta: String,
  // Cảng rời gần nhất + giờ rời (ATD), giữ nguyên chữ của trang chi tiết.
  lastPort: String,
  lastPortDepartureUtc: String,
  positionTime: String,
  source: String,
  latLonApproximate: Boolean,
  receivedAt: { type: String, index: true },
});

// ---- Watchlist: danh sách tàu đang tracking ----
const watchlistSchema = new Schema({
  vesselId: { type: String, required: true, unique: true, index: true }, // IMO/MMSI
});

export const VesselModel = model("Vessel", vesselSchema);
export const PositionModel = model("VesselPosition", positionSchema);
export const LatestPositionModel = model("LatestPosition", latestPositionSchema);
export const WatchlistModel = model("WatchlistItem", watchlistSchema);

export type VesselDoc = InferSchemaType<typeof vesselSchema>;
export type PositionDoc = InferSchemaType<typeof positionSchema>;
export type LatestPositionDoc = InferSchemaType<typeof latestPositionSchema>;
