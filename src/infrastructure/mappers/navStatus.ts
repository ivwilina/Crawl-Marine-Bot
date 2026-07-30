// ============================================================================
//  INFRASTRUCTURE · Bảng tra Navigation Status (mã AIS -> chữ)
//  Used to normalize VesselFinder navigation-status values.
// ============================================================================

export const NAV_STATUS: Record<number, string> = {
  0: "Under way using engine",
  1: "At anchor",
  2: "Not under command",
  3: "Restricted manoeuvrability",
  4: "Constrained by draught",
  5: "Moored",
  6: "Aground",
  7: "Fishing",
  8: "Under way sailing",
  14: "AIS-SART (cứu nạn)",
  15: "Undefined",
};

export function navStatusText(code: number | null | undefined): string {
  if (code == null) return "Unknown";
  return NAV_STATUS[code] ?? "Unknown";
}
