// ============================================================================
//  DOMAIN · Lỗi nghiệp vụ (Error Codes) — theo bảng Error Codes trong spec
// ============================================================================

export class AppError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "AppError";
  }
}

export const Errors = {
  SHIP_NOT_FOUND: (id: string | number) =>
    new AppError("E-1001", `Không tìm thấy tàu id=${id}`),
  INVALID_ID: (id: string | number) =>
    new AppError("E-1003", `ID không hợp lệ (cần IMO 7 số hoặc MMSI 9 số): ${id}`),
  SCRAPE_BLOCKED: () => new AppError("E-2001", "Bị VesselFinder chặn (HTTP 403)"),
  SCRAPE_PARSE_FAIL: (msg: string) =>
    new AppError("E-2002", `Không bóc được dữ liệu: ${msg}`),
  SCRAPE_TIMEOUT: () =>
    new AppError("E-2003", "VesselFinder không phản hồi kịp (timeout)"),
  SOURCE_ERROR: (msg: string) => new AppError("E-2002", `Lỗi nguồn dữ liệu: ${msg}`),
};
