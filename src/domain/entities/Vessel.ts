// ============================================================================
//  DOMAIN · Entity: Vessel (lý lịch tàu — dữ liệu ÍT thay đổi)
// ----------------------------------------------------------------------------
//  Lõi ứng dụng. KHÔNG import gì từ lớp ngoài (không axios/express/db).
//  Trong TypeScript, ta khai báo rõ kiểu của từng thuộc tính.
// ============================================================================

/** Dữ liệu đầu vào để tạo một Vessel */
export interface VesselProps {
  mmsi: string | number | null; // KHÓA CHÍNH (AIS) — nguồn scan luôn có
  imo?: string | number | null; // thuộc tính, có thể thiếu (tàu nội địa)
  name?: string | null;
  /** Loại cụ thể dạng CHỮ từ trang chi tiết, vd "Crude Oil Tanker". */
  type?: string | null;
  /**
   * Mã loại AIS dạng SỐ (0-99), chỉ AIS mới có.
   *
   * Giữ riêng khỏi `type` chứ không quy đổi: `type` là chữ do người đọc, còn mã số
   * là thứ contract v3 (`basics.vType`) yêu cầu. Quy đổi một chiều rồi bỏ mã gốc là
   * mất dữ liệu không lấy lại được.
   */
  aisType?: number | null;
  callsign?: string | null;
  flagCode?: string | null;
  country?: string | null;
  yearBuilt?: number | null;
  lengthM?: number | null;
  widthM?: number | null;
  grossTonnage?: number | null;
  deadweight?: number | null;
  draughtM?: number | null;
  photoUrl?: string | null;
}

export class Vessel {
  readonly mmsi: string; // KHÓA CHÍNH — định danh bền vững của tàu
  readonly imo: string | null;
  readonly name: string | null;
  readonly type: string | null;
  readonly aisType: number | null;
  readonly callsign: string | null;
  readonly flagCode: string | null;
  readonly country: string | null;
  readonly yearBuilt: number | null;
  readonly lengthM: number | null;
  readonly widthM: number | null;
  readonly grossTonnage: number | null;
  readonly deadweight: number | null;
  readonly draughtM: number | null;
  readonly photoUrl: string | null;

  constructor(props: VesselProps) {
    // Business Rule BR-01: định danh bền vững = MMSI (AIS luôn có ở nguồn scan).
    // IMO là thuộc tính, nhiều tàu nội địa không có. Tàu hiếm CHỈ có IMO
    // (không MMSI) -> dùng IMO làm khóa dự phòng để không mất tàu.
    const key = props.mmsi ?? props.imo;
    if (!key) {
      throw new Error("Vessel phải có MMSI (hoặc IMO dự phòng)");
    }
    this.mmsi = String(key);
    this.imo = props.imo != null ? String(props.imo) : null;
    this.name = props.name ?? null;
    this.type = props.type ?? null;
    this.aisType = props.aisType ?? null;
    this.callsign = props.callsign ?? null;
    this.flagCode = props.flagCode ?? null;
    this.country = props.country ?? null;
    this.yearBuilt = props.yearBuilt ?? null;
    this.lengthM = props.lengthM ?? null;
    this.widthM = props.widthM ?? null;
    this.grossTonnage = props.grossTonnage ?? null;
    this.deadweight = props.deadweight ?? null;
    this.draughtM = props.draughtM ?? null;
    this.photoUrl = props.photoUrl ?? null;
  }
}
