// ============================================================================
//  INFRASTRUCTURE · Mapper: HTML trang chi tiết VesselFinder -> Entity Domain
// ----------------------------------------------------------------------------
//  Nguồn dữ liệu trong HTML:
//    1) <div id="djson" data-json='{...}'>  -> ship_lat/lon/cog/sog (JSON)
//    2) Bảng <td class="n3">nhãn</td><td class="v3">giá trị</td> -> lý lịch
//    3) <h1 class="title">Tên tàu</h1>
//
//  ⚠️ lat/lon trong #djson bị LÀM TRÒN về số nguyên (sai số ~111km) khi chưa
//  đăng nhập. cog/sog thì chính xác. Ta đánh dấu latLonApproximate=true.
// ============================================================================

import { Vessel } from "../../domain/entities/Vessel";
import { VesselPosition } from "../../domain/entities/VesselPosition";
import { VesselDetails } from "../../application/ports/IVesselDetailsSource";

/** Hình dạng JSON trong #djson (chỉ khai báo field ta dùng) */
interface DJson {
  mmsi?: number;
  imo?: number;
  ship_lat?: number;
  ship_lon?: number;
  ship_cog?: number;
  ship_sog?: number;
  ship_type?: number;
  lrpd?: string; // "0 min ago"
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDjson(html: string): DJson {
  const m = html.match(/id=["']djson["'][^>]*data-json=(['"])([\s\S]*?)\1/i);
  if (!m) return {};
  try {
    return JSON.parse(m[2]) as DJson;
  } catch {
    return {};
  }
}

function parseTable(html: string): Record<string, string> {
  const rows: Record<string, string> = {};
  const re =
    /<td class="n3">([\s\S]*?)<\/td>\s*<td[^>]*class="v3[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    rows[stripTags(m[1])] = stripTags(m[2]);
  }
  return rows;
}

export class VesselFinderHtmlMapper {
  static toDomain(html: string): VesselDetails {
    const dj = parseDjson(html);
    const tbl = parseTable(html);

    const nameMatch = html.match(/<h1 class="title">([\s\S]*?)<\/h1>/i);
    const name = nameMatch ? stripTags(nameMatch[1]) : null;

    const imoMmsi = (tbl["IMO / MMSI"] ?? "").split("/").map((x) => x.trim());
    const imo = imoMmsi[0] || (dj.imo != null ? String(dj.imo) : null);
    const mmsi = imoMmsi[1] || (dj.mmsi != null ? String(dj.mmsi) : null);

    const dims = (tbl["Length / Beam"] ?? "").match(/([\d.]+)\s*\/\s*([\d.]+)/);
    const lengthM = dims ? Number(dims[1]) : null;
    const widthM = dims ? Number(dims[2]) : null;

    const draughtMatch = (tbl["Current draught"] ?? "").match(/([\d.]+)/);
    const draughtM = draughtMatch ? Number(draughtMatch[1]) : null;

    if (!imo && !mmsi) {
      // Không có cả IMO và MMSI -> trang lỗi / tàu không tồn tại
      throw new Error("Không tìm thấy IMO/MMSI trong trang (tàu không tồn tại?)");
    }
    // BR-01: khóa chính = MMSI (mp2/AIS luôn có). IMO chỉ là thuộc tính; tàu
    // hiếm chỉ có IMO -> Vessel entity tự dùng IMO làm khóa dự phòng.
    const vessel = new Vessel({
      mmsi,
      imo,
      name,
      type: tbl["AIS Type"] ?? null,
      callsign: tbl["Callsign"] ?? null,
      country: tbl["AIS Flag"] ?? null,
      lengthM,
      widthM,
      draughtM,
    });

    const hasLatLon =
      typeof dj.ship_lat === "number" && typeof dj.ship_lon === "number";

    const position = new VesselPosition({
      mmsi,
      imo,
      lat: hasLatLon ? dj.ship_lat : null,
      lon: hasLatLon ? dj.ship_lon : null,
      speedKn: typeof dj.ship_sog === "number" ? dj.ship_sog : null,
      courseDeg: typeof dj.ship_cog === "number" ? dj.ship_cog : null,
      navStatusText: tbl["Navigation Status"] ?? "Unknown",
      positionTime: dj.lrpd ? dj.lrpd.trim() : null,
      source: "vesselfinder",
      latLonApproximate: hasLatLon, // toạ độ VF miễn phí bị làm tròn!
    });

    return { vessel, position };
  }
}
