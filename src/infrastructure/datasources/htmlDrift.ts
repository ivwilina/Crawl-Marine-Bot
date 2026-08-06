// ============================================================================
//  INFRASTRUCTURE · htmlDrift: logic thuần kiểm tra 1 trang HTML VesselFinder
//  còn khớp cấu trúc mà VesselFinderHtmlMapper phụ thuộc hay không.
//  KHÔNG fetch mạng -> test offline được. CLI detectHtmlDrift.ts gọi hàm này.
// ----------------------------------------------------------------------------
//  Nhãn được chia theo ĐÚNG cấu trúc chứa nó, không gộp một danh sách. Gộp lại
//  là báo động giả trên mọi trang: "Gross Tonnage" có thật nhưng nằm trong bảng
//  tpc1/tpc2, còn "Destination" thì không nằm trong bảng nào cả.
// ============================================================================

/** 1 check cấu trúc. critical = mất là mapper hỏng. */
export interface Check {
  name: string;
  critical: boolean;
  test: (html: string) => boolean;
}

// Các selector/pattern mapper thực sự dùng (xem VesselFinderHtmlMapper.ts).
export const CHECKS: Check[] = [
  {
    name: "#djson[data-json]  (toạ độ/sog/cog)",
    critical: true,
    test: (h) => /id=["']djson["'][^>]*data-json=/i.test(h),
  },
  {
    name: "td.n3 + td.v3  (bảng AIS/voyage)",
    critical: true,
    test: (h) =>
      /<td class="n3">[\s\S]*?<\/td>\s*<td[^>]*class="v3[^"]*"[^>]*>/i.test(h),
  },
  {
    name: "td.tpc1 + td.tpc2  (bảng Vessel Particulars)",
    critical: false,
    test: (h) =>
      /<td class="tpc1">[\s\S]*?<\/td>\s*<td[^>]*class="tpc2[^"]*"[^>]*>/i.test(h),
  },
  {
    name: "div.vilabel  (khối Destination / Last Port)",
    critical: false,
    test: (h) => /class="vilabel"[^>]*>/i.test(h),
  },
  {
    name: "h1.title  (tên tàu)",
    critical: false,
    test: (h) => /<h1 class="title">/i.test(h),
  },
];

/** Nhãn trong bảng AIS/voyage — `<td class="n3">`. */
export const TABLE_LABELS = [
  "IMO / MMSI",
  "Length / Beam",
  "Current draught",
  "AIS Type",
  "Callsign",
  "AIS Flag",
  "Navigation Status",
  "Position received",
];

/** Nhãn trong bảng Vessel Particulars — `<td class="tpc1">`. */
export const PARTICULARS_LABELS = [
  "Ship Type",
  "Flag",
  "Year of Build",
  "Gross Tonnage",
  "Deadweight",
  "Length Overall",
  "Beam",
];

/** Nhãn của khối voyage — `<div class="vilabel">`, không phải bảng. */
export const VOYAGE_LABELS = ["Destination", "Last Port"];

export interface DriftResult {
  ok: boolean; // false nếu bất kỳ check critical fail
  failedChecks: string[];
  /** Nhãn không tìm thấy, kèm tiền tố cấu trúc để biết phải sửa parser nào. */
  missingLabels: string[];
  djsonHasLatLon?: boolean; // undefined nếu không có #djson
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Tìm nhãn trong ô đầu của một bảng.
 *
 * Nhãn có thể mang tag con (`Deadweight <small>(t)</small>`) nên chỉ so khớp
 * phần MỞ ĐẦU của ô, không đòi khớp hết tới `</td>`.
 */
function hasTableLabel(html: string, labelClass: string, label: string): boolean {
  return new RegExp(`<td class="${labelClass}">\\s*${escapeRegExp(label)}`, "i").test(html);
}

function hasVoyageLabel(html: string, label: string): boolean {
  return new RegExp(`class="vilabel"[^>]*>\\s*${escapeRegExp(label)}\\s*</div>`, "i").test(html);
}

/** Phân tích 1 trang HTML. Thuần, không side-effect, không mạng. */
export function analyzeHtml(html: string): DriftResult {
  const res: DriftResult = { ok: true, failedChecks: [], missingLabels: [] };

  for (const c of CHECKS) {
    if (!c.test(html)) {
      res.failedChecks.push((c.critical ? "[CRITICAL] " : "[warn] ") + c.name);
      if (c.critical) res.ok = false;
    }
  }

  for (const label of TABLE_LABELS) {
    if (!hasTableLabel(html, "n3", label)) res.missingLabels.push(`n3: ${label}`);
  }

  for (const label of PARTICULARS_LABELS) {
    if (!hasTableLabel(html, "tpc1", label)) res.missingLabels.push(`tpc1: ${label}`);
  }

  for (const label of VOYAGE_LABELS) {
    if (!hasVoyageLabel(html, label)) res.missingLabels.push(`vilabel: ${label}`);
  }

  const m = html.match(/id=["']djson["'][^>]*data-json=(['"])([\s\S]*?)\1/i);
  if (m) {
    try {
      const dj = JSON.parse(m[2]) as Record<string, unknown>;
      res.djsonHasLatLon =
        typeof dj.ship_lat === "number" && typeof dj.ship_lon === "number";
    } catch {
      res.failedChecks.push("[CRITICAL] #djson data-json không parse được JSON");
      res.ok = false;
    }
  }

  return res;
}
