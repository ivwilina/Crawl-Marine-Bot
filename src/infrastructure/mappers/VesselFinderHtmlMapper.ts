// ============================================================================
//  INFRASTRUCTURE · Mapper: HTML trang chi tiết VesselFinder -> Entity Domain
// ----------------------------------------------------------------------------
//  Trang dùng BỐN cấu trúc khác nhau, không phải một. Đã đối chiếu HTML thật của
//  IMO 9384198 và 9811983 (fixture trong ./fixtures):
//
//    1) <div id="djson" data-json='{...}'>          -> lat/lon/cog/sog (JSON)
//    2) <td class="n3">nhãn</td><td class="v3">…</td>
//       bảng AIS/voyage: IMO / MMSI, Callsign, AIS Type, AIS Flag,
//       Length / Beam, Current draught, Navigation Status, Position received,
//       Course / Speed, Predicted ETA, Distance / Time
//    3) <table class="tpt1"><td class="tpc1">nhãn</td><td class="tpc2">…</td>
//       bảng "Vessel Particulars" (9 bảng nhỏ): IMO number, Vessel Name,
//       Ship Type, Flag, Year of Build, Length Overall (m), Beam (m),
//       Gross Tonnage, Net Tonnage, Deadweight (t), TEU…
//    4) <div class="vilabel">Destination|Last Port</div> + phần tử kế
//       KHÔNG phải bảng: giá trị nằm trong <a> hoặc <div>, còn ETA/ATD nằm
//       trong khối "_value" sau đó.
//
//  (2) và (3) không trùng nhãn nên được gộp vào một map; chỗ nào có hai nguồn
//  thì `pick()` xếp bản CHÍNH XÁC HƠN lên trước: "Ship Type" ("Crude Oil
//  Tanker") hơn "AIS Type" ("Tanker"), "Length Overall (m)" (333.00) hơn
//  "Length / Beam" (333).
//
//  ⚠️ (4) neo vào CHỮ của nhãn, không vào class: `_3-Yih`, `_npNa`, `_value`,
//  `_mcol12ext` là class sinh tự động khi build lại site, còn chữ "Destination"
//  và "Last Port" thì không.
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

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Đọc một bảng nhãn/giá trị theo class của 2 ô.
 *
 * Nhận tên class thay vì hard-code "n3"/"v3" vì trang có HAI bảng cấu trúc khác
 * nhau: AIS/voyage dùng n3/v3, còn Vessel Particulars dùng tpc1/tpc2. Trước đây
 * mapper chỉ đọc n3/v3 nên toàn bộ tonnage/năm đóng luôn rỗng.
 *
 * Nhãn có thể chứa tag (`Deadweight <small>(t)</small>`) nên nó cũng đi qua
 * stripTags -> "Deadweight (t)".
 */
function parseLabelledTable(html: string, labelClass: string, valueClass: string): Record<string, string> {
  const rows: Record<string, string> = {};
  const re = new RegExp(
    `<td class="${labelClass}">([\\s\\S]*?)</td>\\s*<td[^>]*class="${valueClass}[^"]*"[^>]*>([\\s\\S]*?)</td>`,
    "gi"
  );

  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    rows[stripTags(match[1])] = stripTags(match[2]);
  }
  return rows;
}

/** Một khối voyage: giá trị chính + mốc thời gian đi kèm (ETA hoặc ATD). */
interface VoyageBlock {
  value: string | null;
  time: string | null;
}

/**
 * Số ký tự đọc sau nhãn `vilabel` trước khi cắt. Phải đủ rộng để chứa cả giá trị
 * và khối `_value` chứa ETA/ATD (thực tế ~250 ký tự), nhưng vẫn có chặn trên để
 * một trang đổi form không khiến parser quét cả tài liệu.
 */
const VOYAGE_BLOCK_WINDOW = 600;

/**
 * Đọc khối `vilabel` — Destination và Last Port KHÔNG nằm trong bảng nào.
 *
 * Hình dạng thật, hai biến thể (giá trị là link cảng, hoặc chữ tự do):
 *   <div class="vilabel">Destination</div>
 *     <div class="_3-Yih">FOR ORDERS</div>
 *     <div class="_value"><span>ETA: Aug 10, 02:00</span><span>(in 4 days)</span></div>
 *   <div class="vilabel">Last Port</div>
 *     <a class="_npNa" href="/ports/SGSIN001">Singapore Anch. 4, Singapore</a>
 *     <div class="_value">ATD: Aug 3, 22:23 UTC <span>(2 days ago)</span></div>
 *
 * Cách bóc, chọn để không phụ thuộc class sinh tự động:
 * - Lấy một cửa sổ cố định sau nhãn rồi CẮT TRONG CODE ở nhãn `vilabel` kế tiếp
 *   hoặc `</section>`. Không dùng lookahead trong regex: mốc chặn khi đó thành
 *   bắt buộc, và khối "Destination" có nhãn kế cách xa hơn cửa sổ nên cả match
 *   thất bại — trả null thay vì cắt tạm. Đã gặp đúng lỗi này.
 * - Phải cắt, vì khối "Last Port" không có nhãn nào phía sau và sẽ ngoạm cả chữ
 *   của section kế ("Ship positions").
 * - Mốc thời gian lấy bằng `[^(<]+` sau "ETA:"/"ATD:" nên tự dừng trước tag và
 *   trước phần tương đối trong ngoặc — "(in 4 days)" đổi mỗi ngày, giữ nó lại
 *   thì mỗi request sẽ thấy dữ liệu "khác" dù chẳng có gì thay đổi.
 * - Giá trị là phần chữ TRƯỚC mốc thời gian, nên mọi thứ phía sau đều bị loại.
 */
function parseVoyageBlock(html: string, label: string): VoyageBlock {
  const anchor = html.match(
    new RegExp(`class="vilabel"[^>]*>\\s*${escapeRegExp(label)}\\s*</div>`, "i")
  );
  if (!anchor || anchor.index === undefined) return { value: null, time: null };

  const start = anchor.index + anchor[0].length;
  let block = html.slice(start, start + VOYAGE_BLOCK_WINDOW);

  for (const boundary of ['class="vilabel"', "</section"]) {
    const at = block.indexOf(boundary);
    if (at >= 0) block = block.slice(0, at);
  }

  const timeMatch = block.match(/\b(?:ETA|ATD):\s*([^(<]+)/i);
  const value = stripTags(timeMatch ? block.slice(0, timeMatch.index) : block);

  return {
    value: value && value !== "-" ? value : null,
    time: timeMatch?.[1].trim() || null,
  };
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
    // Hai bảng, hai bộ class, không trùng nhãn -> gộp làm một map để `pick()`
    // xếp thứ tự ưu tiên bằng danh sách nhãn của nó.
    const tbl = {
      ...parseLabelledTable(html, "n3", "v3"),
      ...parseLabelledTable(html, "tpc1", "tpc2"),
    };
    const destination = parseVoyageBlock(html, "Destination");
    const lastPort = parseVoyageBlock(html, "Last Port");

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
      destination: destination.value,
      // Giữ nguyên chữ của trang ("Aug 10, 02:00"): định dạng không được tài
      // liệu hoá, tự đoán rồi convert là làm hỏng dữ liệu trong im lặng.
      eta: destination.time,
      lastPort: lastPort.value,
      lastPortDepartureUtc: lastPort.time,
      positionTime: dj.lrpd?.trim() || pick(tbl, "Position received"),
      source: "vesselfinder",
      latLonApproximate: hasLatLon, // toạ độ VF miễn phí bị làm tròn!
    });

    return { vessel, position };
  }
}
