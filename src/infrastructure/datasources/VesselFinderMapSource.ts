// ============================================================================
//  INFRASTRUCTURE · DataSource: VesselFinderMapSource
//  → QUÉT CẢ VÙNG từ VesselFinder qua endpoint ẩn /api/pub/mp2 (binary).
// ----------------------------------------------------------------------------
//  Đây là endpoint mà bản đồ VesselFinder dùng để vẽ tàu. Nó trả về BINARY
//  chứa MỌI tàu trong bounding box: mmsi + tên + lat/lon CHÍNH XÁC.
//  1 request = hàng trăm tàu → rất nhẹ, ít rủi ro ban.
//
//  ⚠️ Đây là API nội bộ (undocumented). Format có thể đổi bất kỳ lúc nào →
//  nếu decode lỗi, cần xem lại logic trong bundle map của VesselFinder.
// ============================================================================

import { HttpClient } from "../http/HttpClient";
import { BoundingBox } from "../../application/ports/Geo";
import { IAreaScanner, ScannedShip } from "../../application/ports/IAreaScanner";

const COORD_DIV = 600000; // toạ độ trong binary = độ × 600000

export class VesselFinderMapSource implements IAreaScanner {
  private readonly BASE = "https://www.vesselfinder.com/api/pub/mp2";

  constructor(private readonly http: HttpClient) {}

  /**
   * Lấy mọi tàu trong 1 vùng.
   * @param box   bounding box
   * @param zoom  mức zoom (7–10 hợp lý; nhỏ quá gộp tàu, lớn quá thêm field)
   */
  async fetchArea(box: BoundingBox, zoom = 9): Promise<ScannedShip[]> {
    // bbox trong request: minLon,minLat,maxLon,maxLat — mỗi số × 600000
    const bbox = [box.minLon, box.minLat, box.maxLon, box.maxLat]
      .map((v) => Math.floor(v * COORD_DIV))
      .join(",");
    const url = `${this.BASE}?bbox=${bbox}&zoom=${zoom}&mcbe=1`;

    const buf = await this.http.getArrayBuffer(url);
    return VesselFinderMapSource.decode(buf, zoom, box);
  }

  /**
   * Giải mã binary theo đúng logic drawShipsOnMapBinary của VesselFinder.
   *
   * ⚠️ Format không có tài liệu -> mọi sai lệch trong 1 record (ví dụ cờ
   * isSelected sai, nameLen đọc lệch) làm CÁC RECORD PHÍA SAU trong cùng
   * buffer bị đọc lệch offset theo (desync dây chuyền), sinh toạ độ rác
   * (VD: lat=36, lon=-5 dù đang quét vùng Việt Nam). Ta chặn bằng 2 lớp:
   *   1) `lt !== 0` khi so khớp isSelected — mmsi thật không bao giờ = 0,
   *      nên không để 1 mmsi đọc lệch thành 0 lại kích hoạt nhầm nhánh +6 byte.
   *   2) Sau khi decode, loại bỏ + log mọi tàu nằm NGOÀI bbox đã request —
   *      đó chính là dấu hiệu desync, không phải dữ liệu thật.
   */
  private static decode(buf: ArrayBuffer, zoom: number, box: BoundingBox): ScannedShip[] {
    const t = new DataView(buf);
    const P = buf.byteLength;
    if (P < 12) return []; // rỗng

    const Y = t.getUint16(1); // độ dài phần header cờ
    let I = 4 + Y; // vị trí bắt đầu các record
    const lt = t.getInt32(I - 4); // mmsi đang được chọn (0 = không tàu nào được chọn)

    const ships: ScannedShip[] = [];
    const decoder = new TextDecoder("utf-8");
    let desyncAt: number | null = null;

    try {
      while (I < P) {
        // Cần tối thiểu 2+4+4+4+1+1 = 16 byte cho phần cố định của 1 record.
        if (I + 16 > P) break;

        I += 2; // int16 cờ (bỏ qua)
        const mmsi = t.getInt32(I); I += 4;
        const lat = t.getInt32(I) / COORD_DIV; I += 4; // f = latitude
        const lon = t.getInt32(I) / COORD_DIV; I += 4; // d = longitude
        // BR: mmsi thật luôn khác 0 -> nếu lt=0 (không tàu chọn), KHÔNG được
        // coi mmsi=0 (đọc lệch) là "tàu đang chọn", tránh skip nhầm +6 byte.
        const isSelected = lt !== 0 && mmsi === lt;
        if (isSelected) {
          if (I + 6 > P) break;
          I += 6; // tàu chọn: thêm cog+sog+extra
        }

        if (I + 2 > P) break;
        I += 1; // int8 status (bỏ qua)
        const nameLen = t.getUint8(I); I += 1;
        if (I + nameLen > P) break;
        let name = decoder.decode(new Uint8Array(buf, I, nameLen)).trim();
        I += nameLen;
        if (isSelected) {
          if (I + 4 > P) break;
          I += 4; // int32 extra cho tàu chọn
        }
        if (name === "") name = String(mmsi);

        // Toạ độ phải hợp lệ VÀ nằm trong bbox đã request — nằm ngoài bbox
        // nghĩa là record này (và có thể cả phần buffer còn lại) đã desync.
        const inBbox =
          lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon;
        if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 && inBbox) {
          ships.push({ mmsi: String(mmsi), name, lat, lon });
        } else if (desyncAt === null) {
          desyncAt = I;
        }
      }
    } catch {
      // Nếu format đổi giữa chừng -> trả những gì đã đọc được.
    }

    if (desyncAt !== null) {
      console.warn(
        `⚠️  VesselFinderMapSource: phát hiện toạ độ ngoài bbox (nghi decode desync) ` +
          `gần byte offset ${desyncAt}/${P}. Giữ lại ${ships.length} tàu hợp lệ trong bbox.`
      );
    }

    return ships;
  }
}
