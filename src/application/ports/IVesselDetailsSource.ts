// ============================================================================
//  APPLICATION · PORT: IVesselDetailsSource
// ----------------------------------------------------------------------------
//  Trong TypeScript, port là INTERFACE thật (không cần class giả như bên JS).
//  Any vessel-detail source can provide a normalized vessel profile.
//  1 tàu thì phải implement interface này.
// ============================================================================

import { Vessel } from "../../domain/entities/Vessel";
import { VesselPosition } from "../../domain/entities/VesselPosition";

export interface VesselDetails {
  vessel: Vessel;
  position: VesselPosition;
}

export interface IVesselDetailsSource {
  /**
   * @param id  IMO (7 số) hoặc MMSI (9 số) — trang VF tự redirect
   */
  getDetails(id: string): Promise<VesselDetails>;
}
