// ============================================================================
//  INFRASTRUCTURE · DataSource: VesselFinderHtmlSource (nguồn chính)
//  Tải trang chi tiết rồi nhờ mapper bóc dữ liệu. 1 request lấy hết + toạ độ.
//  id = IMO hoặc MMSI (VesselFinder tự redirect 301, fetch tự đi theo).
// ============================================================================

import { IVesselDetailsSource, VesselDetails } from "../../application/ports/IVesselDetailsSource";
import { HttpClient } from "../http/HttpClient";
import { VesselFinderHtmlMapper } from "../mappers/VesselFinderHtmlMapper";
import { Errors } from "../../domain/errors/AppError";

export class VesselFinderHtmlSource implements IVesselDetailsSource {
  private readonly BASE = "https://www.vesselfinder.com/vessels/details";

  constructor(private readonly http: HttpClient) {}

  async getDetails(id: string): Promise<VesselDetails> {
    const url = `${this.BASE}/${id}`;
    const html = await this.http.getText(url);
    try {
      return VesselFinderHtmlMapper.toDomain(html);
    } catch (err) {
      throw Errors.SCRAPE_PARSE_FAIL((err as Error).message);
    }
  }
}
