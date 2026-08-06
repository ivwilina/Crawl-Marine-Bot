// ============================================================================
//  DOMAIN · Chuẩn hoá loại tàu và trạng thái di chuyển
// ----------------------------------------------------------------------------
//  Nguồn: sheet "AIS Ship Types" của dự án (bảng tra chính thức).
//
//  Vì sao phải có ở backend: client cần MỘT nhóm ổn định để chọn icon/màu,
//  nhưng dữ liệu vào có hai dạng khác nhau:
//    • crawler (trang chi tiết VesselFinder) -> CHỮ: "Crude Oil Tanker"
//    • AIS (ShipStaticData.Type)             -> SỐ : 80
//  Nếu để client tự đoán thì mỗi nguồn sẽ ra một cách hiển thị khác nhau.
//
//  File này thuần domain: không import gì từ lớp ngoài, không I/O.
// ============================================================================

/** Nhóm hiển thị, đúng cột "Type" của sheet. */
export type VesselTypeGroup =
  | "Tanker"
  | "Cargo"
  | "Passenger"
  | "High speed craft"
  | "Tug"
  | "Fishing"
  | "Pleasure Craft"
  | "Other Type"
  | "Other"
  | "Unspecified Ships";

/** Tàu đang chạy hay đang đứng — cột "Satus" của sheet. */
export type MovementState = "Moving" | "Stationary" | "Unknown";

/**
 * Mã AIS -> nhóm, theo dải mã trong sheet.
 *
 * Dải liên tục nên tra bằng khoảng, không phải bảng 100 dòng: 70-79 đều là
 * Cargo, 80-89 đều là Tanker. Mã ngoài mọi dải (vd 1-19, chưa dùng) là
 * "Unspecified Ships" giống mã 0.
 */
const AIS_CODE_RANGES: Array<{ from: number; to: number; group: VesselTypeGroup }> = [
  { from: 20, to: 29, group: "Other" }, // Wing in ground
  { from: 30, to: 30, group: "Fishing" },
  { from: 31, to: 36, group: "Other" }, // towing, dredging, diving, military, sailing
  { from: 37, to: 37, group: "Pleasure Craft" },
  { from: 38, to: 39, group: "Other" }, // reserved
  { from: 40, to: 49, group: "High speed craft" },
  { from: 50, to: 51, group: "Other" }, // pilot, SAR
  { from: 52, to: 52, group: "Tug" },
  { from: 53, to: 59, group: "Other" }, // port tender, law enforcement, medical...
  { from: 60, to: 69, group: "Passenger" },
  { from: 70, to: 79, group: "Cargo" },
  { from: 80, to: 89, group: "Tanker" },
  { from: 90, to: 99, group: "Other Type" },
];

/**
 * Chữ -> nhóm. THỨ TỰ QUAN TRỌNG: luật khớp trước thắng.
 *
 * Trang chi tiết trả loại cụ thể ("Passenger/Ro-Ro Cargo Ship", "Fish Carrier"),
 * nên vài chuỗi khớp nhiều luật. Xếp theo đúng cách sheet phân nhóm:
 *   • "Passenger/Ro-Ro Cargo" là Passenger (AIS 60-69), không phải Cargo
 *     -> passenger đứng trước cargo.
 *   • "Fish Carrier" là Fishing, mà "carrier" lại là dấu hiệu Cargo
 *     -> fishing đứng trước cargo.
 */
const TEXT_RULES: Array<{ match: RegExp; group: VesselTypeGroup }> = [
  { match: /tanker|lng|lpg|bunkering|oil products/i, group: "Tanker" },
  { match: /passenger|cruise|ferry/i, group: "Passenger" },
  { match: /fishing|trawler|fish carrier/i, group: "Fishing" },
  { match: /pleasure|yacht/i, group: "Pleasure Craft" },
  { match: /high speed|hsc/i, group: "High speed craft" },
  { match: /tug|pusher/i, group: "Tug" },
  { match: /cargo|container|bulk|carrier|reefer|ro-ro|roro|livestock|cement|wood chip|heavy load/i, group: "Cargo" },
  // Các loại sheet gom vào "Other": hoa tiêu, cứu hộ, nạo vét, quân sự, dịch vụ...
  {
    match:
      /pilot|search and rescue|dredg|diving|military|law enforcement|patrol|tender|anti-pollution|medical|sailing|supply|offshore|crew|buoy|research|salvage|cable|work|utility|training|icebreak|barge|dive|wing in ground/i,
    group: "Other",
  },
  { match: /other/i, group: "Other Type" },
];

/** Trạng thái nav -> Moving/Stationary, theo cột "Satus" của sheet. */
const MOVING_NAV_CODES = new Set([0, 3, 4, 7, 8]);

/** Tốc độ từ ngần này trở lên coi như đang chạy, khi không có trạng thái nav. */
const MOVING_SPEED_KN = 0.5;

/**
 * Nhóm hiển thị từ mã AIS.
 * @param code - `ShipStaticData.Type`; null/không hợp lệ -> "Unspecified Ships"
 */
export function typeGroupFromAisCode(code: number | null | undefined): VesselTypeGroup {
  if (code == null || !Number.isFinite(code)) return "Unspecified Ships";

  const found = AIS_CODE_RANGES.find((range) => code >= range.from && code <= range.to);
  return found?.group ?? "Unspecified Ships";
}

/**
 * Nhóm hiển thị từ chữ.
 *
 * Nhận cả loại cụ thể của trang chi tiết ("Crude Oil Tanker") và tên nhóm sẵn
 * của cột AIS Type ("Tanker").
 *
 * @param text - Chuỗi loại tàu; rỗng -> "Unspecified Ships"
 * @returns Nhóm khớp, hoặc "Other" khi có chữ nhưng không nhận ra được — KHÁC
 *   với "Unspecified Ships" (không có dữ liệu gì cả)
 */
export function typeGroupFromText(text: string | null | undefined): VesselTypeGroup {
  const value = text?.trim();
  if (!value || value === "-") return "Unspecified Ships";

  // Chuỗi toàn số là mã AIS đi lạc vào field chữ (vd mapper cũ đọc "AIS Type"
  // dạng số) -> tra theo mã cho đúng.
  if (/^\d+$/.test(value)) return typeGroupFromAisCode(Number(value));

  return TEXT_RULES.find((rule) => rule.match.test(value))?.group ?? "Other";
}

/**
 * Nhóm hiển thị của 1 tàu, dùng nguồn tốt nhất đang có.
 *
 * Chữ đi trước mã số: trang chi tiết cho loại cụ thể ("Crude Oil Tanker") trong
 * khi mã AIS chỉ cho dải chung (80-89 = Tanker). Tàu chỉ có AIS thì mã số là thứ
 * duy nhất có, và nó vẫn tốt hơn "Unspecified Ships".
 */
export function typeGroupOf(vessel: {
    type?: string | null;
    aisType?: number | null;
}): VesselTypeGroup {
    const fromText = typeGroupFromText(vessel.type);
    if (fromText !== "Unspecified Ships") return fromText;

    return typeGroupFromAisCode(vessel.aisType);
}

/**
 * Đang chạy hay đang đứng.
 *
 * Ưu tiên mã nav (chính xác nhất, từ AIS), rồi đến chữ nav (từ crawler), cuối
 * cùng mới suy từ tốc độ — bản ghi chỉ có mp2 thì không có trạng thái nav nào,
 * và "đang chạy" vẫn suy được từ speed.
 */
export function movementState(input: {
  navStatusCode?: number | null;
  navStatusText?: string | null;
  speedKn?: number | null;
}): MovementState {
  const { navStatusCode, navStatusText, speedKn } = input;

  if (navStatusCode != null && Number.isFinite(navStatusCode)) {
    return MOVING_NAV_CODES.has(navStatusCode) ? "Moving" : "Stationary";
  }

  const text = navStatusText?.trim().toLowerCase();
  if (text && text !== "unknown") {
    // "Under way using engine", "Under way sailing", "Engaged in fishing",
    // "Restricted manoeuvrability", "Constrained by draught" -> Moving.
    if (/under way|underway|fishing|restricted|constrained/.test(text)) return "Moving";
    if (/anchor|moor|aground|not under command|undefined|not defined|reserved/.test(text)) {
      return "Stationary";
    }
  }

  if (speedKn != null && Number.isFinite(speedKn)) {
    return speedKn >= MOVING_SPEED_KN ? "Moving" : "Stationary";
  }

  return "Unknown";
}
