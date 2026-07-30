// ============================================================================
//  APPLICATION · PORT: Geo
//  --------------------------------------------------------------------------
//  Shared geographic primitives for VesselFinder area scanning and map queries.
// ============================================================================

/** A latitude/longitude rectangle. */
export interface BoundingBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}
