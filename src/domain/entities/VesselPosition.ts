// ============================================================================
//  DOMAIN · Entity: VesselPosition (vị trí tàu — dữ liệu ĐỔI liên tục)
// ----------------------------------------------------------------------------
//  Tách riêng khỏi Vessel: đây là dữ liệu time-series, ghi rất nhiều.
// ============================================================================

export type PositionSource = "vesselfinder" | "unknown";

export interface VesselPositionProps {
  imo?: string | number | null;
  mmsi?: string | number | null;
  lat?: number | null;
  lon?: number | null;
  speedKn?: number | null; // SOG
  courseDeg?: number | null; // COG
  headingDeg?: number | null;
  navStatusCode?: number | null;
  navStatusText?: string | null;
  destination?: string | null;
  eta?: string | null;
  positionTime?: string | null;
  source?: PositionSource;
  /** true nếu lat/lon bị làm tròn (VesselFinder miễn phí) */
  latLonApproximate?: boolean;
  /** thời điểm backend nhận; để trống khi tạo mới, có giá trị khi đọc lại từ DB */
  receivedAt?: string;
}

export class VesselPosition {
  readonly imo: string | null;
  readonly mmsi: string | null;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly speedKn: number | null;
  readonly courseDeg: number | null;
  readonly headingDeg: number | null;
  readonly navStatusCode: number | null;
  readonly navStatusText: string;
  readonly destination: string | null;
  readonly eta: string | null;
  readonly positionTime: string | null;
  readonly source: PositionSource;
  readonly latLonApproximate: boolean;
  readonly receivedAt: string;

  constructor(props: VesselPositionProps) {
    this.imo = props.imo != null ? String(props.imo) : null;
    // KHÓA = MMSI (dự phòng IMO nếu tàu hiếm không có MMSI) — khớp Vessel.
    const key = props.mmsi ?? props.imo;
    this.mmsi = key != null ? String(key) : null;

    // Business Rule BR-03: loại toạ độ vô lý (ngoài phạm vi trái đất).
    this.lat = VesselPosition.isValidLat(props.lat) ? (props.lat as number) : null;
    this.lon = VesselPosition.isValidLon(props.lon) ? (props.lon as number) : null;

    this.speedKn = props.speedKn ?? null;
    this.courseDeg = props.courseDeg ?? null;
    this.headingDeg = props.headingDeg ?? null;
    this.navStatusCode = props.navStatusCode ?? null;
    this.navStatusText = props.navStatusText ?? "Unknown";
    this.destination = props.destination ?? null;
    this.eta = props.eta ?? null;
    this.positionTime = props.positionTime ?? null;
    this.source = props.source ?? "unknown";
    this.latLonApproximate = props.latLonApproximate ?? false;
    // Giữ receivedAt nếu đọc lại từ DB; nếu tạo mới thì lấy thời điểm hiện tại.
    this.receivedAt = props.receivedAt ?? new Date().toISOString();
  }

  hasCoordinates(): boolean {
    return this.lat !== null && this.lon !== null;
  }

  private static isValidLat(v: unknown): v is number {
    return typeof v === "number" && v >= -90 && v <= 90;
  }
  private static isValidLon(v: unknown): v is number {
    return typeof v === "number" && v >= -180 && v <= 180;
  }
}
