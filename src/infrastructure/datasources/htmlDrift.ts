// ============================================================================
//  INFRASTRUCTURE · htmlDrift: logic thuần kiểm tra 1 trang HTML VesselFinder
//  còn khớp selector mà VesselFinderHtmlMapper phụ thuộc hay không.
//  KHÔNG fetch mạng -> test offline được. CLI detectHtmlDrift.ts gọi hàm này.
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
    name: "table td.n3 + td.v3  (lý lịch tàu)",
    critical: true,
    test: (h) =>
      /<td class="n3">[\s\S]*?<\/td>\s*<td[^>]*class="v3[^"]*"[^>]*>/i.test(h),
  },
  {
    name: "h1.title  (tên tàu)",
    critical: false,
    test: (h) => /<h1 class="title">/i.test(h),
  },
];

// Label bên trong bảng mà mapper tra cứu theo key. Đã kiểm chứng trên trang
// thật (IMO 9384198). Mapper có nhãn dự phòng cho vài field, nên nhãn thiếu
// không phải lúc nào cũng là hỏng — báo ra để người xem quyết.
export const LABELS = [
  // Bảng Voyage Data
  "IMO / MMSI",
  "Length / Beam",
  "Current draught",
  "AIS Type",
  "Callsign",
  "AIS Flag",
  "Navigation Status",
  "Destination",
  "ETA",
  "Position received",
  // Bảng Vessel Particulars
  "Ship Type",
  "Flag",
  "Year of Build",
  "Gross Tonnage",
  "Deadweight (t)",
  "Length Overall (m)",
  "Beam (m)",
];

export interface DriftResult {
  ok: boolean; // false nếu bất kỳ check critical fail
  failedChecks: string[];
  missingLabels: string[];
  djsonHasLatLon?: boolean; // undefined nếu không có #djson
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

  for (const label of LABELS) {
    const re = new RegExp(
      `<td class="n3">\\s*${label.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\s*<`,
      "i"
    );
    if (!re.test(html)) res.missingLabels.push(label);
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
