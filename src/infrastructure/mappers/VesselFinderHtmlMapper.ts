// ============================================================================
//  INFRASTRUCTURE · Mapper: HTML trang chi tiết VesselFinder -> Entity Domain
// ----------------------------------------------------------------------------
//  Nguồn dữ liệu trong HTML:
//    1) <div id="djson" data-json='{...}'>  -> ship_lat/lon/cog/sog (JSON)
//    2) Bảng <td class="n3">nhãn</td><td class="v3">giá trị</td> -> lý lịch
//    3) <h1 class="title">Tên tàu</h1>
//
//  Trang có HAI bảng n3/v3 và cùng một dữ liệu xuất hiện ở cả hai với nhãn
//  KHÁC NHAU (đã kiểm chứng trên trang thật, IMO 9384198):
//    • "Voyage Data"        : Destination, ETA, Course / Speed, Current draught,
//                             Navigation Status, Position received, IMO / MMSI,
//                             Callsign, AIS Type, AIS Flag, Length / Beam, Last Port
//    • "Vessel Particulars" : IMO number, Vessel Name, Ship Type, Flag,
//                             Year of Build, Length Overall (m), Beam (m),
//                             Gross Tonnage, Deadweight (t)
//  parseTable() gộp cả hai vào 1 map, nên chỗ nào có 2 nguồn thì ưu tiên bản
//  CHÍNH XÁC HƠN: "Ship Type" ("Crude Oil Tanker") hơn "AIS Type" ("Tanker"),
//  "Length Overall (m)" (333.00) hơn "Length / Beam" (333).
//
//  ⚠️ lat/lon trong #djson bị LÀM TRÒN về số nguyên (sai số ~111km) khi chưa
//  đăng nhập. cog/sog thì chính xác. Ta đánh dấu latLonApproximate=true.
//  => KHÔNG dùng toạ độ từ đây cho bản đồ; toạ độ chính xác lấy từ mp2 (scan).
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

/** Giá trị đầu tiên có thật trong bảng, theo thứ tự nhãn ưu tiên. */
function pick(tbl: Record<string, string>, ...labels: string[]): string | null {
  for (const label of labels) {
    const value = tbl[label]?.trim();
    // Trang dùng "-" cho ô không có dữ liệu.
    if (value && value !== "-") return value;
  }
  return null;
}

/**
 * Số đầu tiên trong giá trị, bỏ đơn vị và dấu phân cách nghìn ("162,252 t" ->
 * 162252). Không có số -> null, KHÔNG phải 0.
 */
function pickNumber(tbl: Record<string, string>, ...labels: string[]): number | null {
  const raw = pick(tbl, ...labels);
  if (!raw) return null;

  const match = raw.replace(/,/g, "").match(/-?\d*\.?\d+/);
  if (!match) return null;

  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

export class VesselFinderHtmlMapper {
  static toDomain(html: string): VesselDetails {
    const dj = parseDjson(html);
    const tbl = parseTable(html);

    const nameMatch = html.match(/<h1 class="title">([\s\S]*?)<\/h1>/i);
    const name = nameMatch ? stripTags(nameMatch[1]) : null;

    const imoMmsi = (tbl["IMO / MMSI"] ?? "").split("/").map((x) => x.trim());
    const imo = imoMmsi[0] || pick(tbl, "IMO number") || (dj.imo != null ? String(dj.imo) : null);
    const mmsi = imoMmsi[1] || (dj.mmsi != null ? String(dj.mmsi) : null);

    // "Length / Beam" là số nguyên; bảng particulars có số thập phân nên đi trước.
    const dims = (tbl["Length / Beam"] ?? "").match(/([\d.]+)\s*\/\s*([\d.]+)/);
    const lengthM = pickNumber(tbl, "Length Overall (m)") ?? (dims ? Number(dims[1]) : null);
    const widthM = pickNumber(tbl, "Beam (m)") ?? (dims ? Number(dims[2]) : null);

    const draughtM = pickNumber(tbl, "Current draught");

    if (!imo && !mmsi) {
      // Không có cả IMO và MMSI -> trang lỗi / tàu không tồn tại
      throw new Error("Không tìm thấy IMO/MMSI trong trang (tàu không tồn tại?)");
    }
    // BR-01: khóa chính = MMSI (mp2/AIS luôn có). IMO chỉ là thuộc tính; tàu
    // hiếm chỉ có IMO -> Vessel entity tự dùng IMO làm khóa dự phòng.
    const vessel = new Vessel({
      mmsi,
      imo,
      // Trang particulars có tên đầy đủ hơn h1 trong vài trường hợp redirect.
      name: name || pick(tbl, "Vessel Name"),
      // "Ship Type" là loại cụ thể ("Crude Oil Tanker"); "AIS Type" chỉ là nhóm.
      type: pick(tbl, "Ship Type", "AIS Type"),
      callsign: pick(tbl, "Callsign"),
      country: pick(tbl, "Flag", "AIS Flag"),
      // flagCode: trang chỉ có TÊN nước, không có mã ISO. Suy từ MID (3 số đầu
      // của MMSI) là việc riêng, chưa làm -> để null thay vì đoán.
      yearBuilt: pickNumber(tbl, "Year of Build"),
      grossTonnage: pickNumber(tbl, "Gross Tonnage"),
      deadweight: pickNumber(tbl, "Deadweight (t)", "Deadweight"),
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
      navStatusText: pick(tbl, "Navigation Status") ?? "Unknown",
      destination: pick(tbl, "Destination"),
      // Giữ nguyên chữ của trang ("Aug 10, 02:00 (in 5 days)"): định dạng không
      // được tài liệu hoá, tự đoán rồi convert là làm hỏng dữ liệu trong im lặng.
      eta: pick(tbl, "ETA"),
      positionTime: dj.lrpd?.trim() || pick(tbl, "Position received"),
      source: "vesselfinder",
      latLonApproximate: hasLatLon, // toạ độ VF miễn phí bị làm tròn!
    });

    return { vessel, position };
  }
}
