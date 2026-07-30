// ============================================================================
//  INFRASTRUCTURE · Repository: InMemoryVesselRepository (RAM)
// ----------------------------------------------------------------------------
//  Cùng interface với Mongo/JSON repository nhưng giữ mọi thứ trong RAM. Dùng
//  cho test tích hợp (khởi động app thật mà không cần MongoDB) và cho chạy thử
//  nhanh. Tách latest (1 bản/tàu) khỏi history (append) đúng như Mongo.
// ============================================================================

import { IVesselRepository } from "../../application/ports/IVesselRepository";
import { BoundingBox } from "../../application/ports/Geo";
import { Vessel } from "../../domain/entities/Vessel";
import { VesselPosition } from "../../domain/entities/VesselPosition";

export class InMemoryVesselRepository implements IVesselRepository {
  private readonly vessels = new Map<string, Vessel>();
  private readonly latest = new Map<string, VesselPosition>();
  private readonly history: VesselPosition[] = [];

  async saveVessel(vessel: Vessel): Promise<void> {
    this.vessels.set(vessel.mmsi, vessel);
  }

  async savePosition(position: VesselPosition): Promise<void> {
    this.history.push(position);
  }

  async savePositionLatest(position: VesselPosition): Promise<void> {
    if (position.mmsi === null) return;
    this.latest.set(position.mmsi, position);
  }

  async getLatestPosition(mmsi: string): Promise<VesselPosition | null> {
    return this.latest.get(String(mmsi)) ?? null;
  }

  async getAllLatestPositions(freshSince?: Date): Promise<VesselPosition[]> {
    return [...this.latest.values()].filter((p) => InMemoryVesselRepository.isFresh(p, freshSince));
  }

  async getLatestPositionsInBbox(
    box: BoundingBox,
    limit: number,
    freshSince?: Date
  ): Promise<VesselPosition[]> {
    return (await this.getAllLatestPositions(freshSince))
      .filter(
        (p) =>
          p.lat != null &&
          p.lon != null &&
          p.lat >= box.minLat &&
          p.lat <= box.maxLat &&
          p.lon >= box.minLon &&
          p.lon <= box.maxLon
      )
      .slice(0, limit);
  }

  async deleteLatestPositionsOlderThan(cutoff: Date): Promise<number> {
    const iso = cutoff.toISOString();
    let removed = 0;
    for (const [mmsi, position] of this.latest) {
      if (position.receivedAt < iso) {
        this.latest.delete(mmsi);
        removed += 1;
      }
    }
    return removed;
  }

  async getAllVessels(): Promise<Vessel[]> {
    return [...this.vessels.values()];
  }

  async getVesselsByMmsi(mmsis: string[]): Promise<Vessel[]> {
    const set = new Set(mmsis);
    return [...this.vessels.values()].filter((v) => set.has(v.mmsi));
  }

  async getVesselsMissingType(limit: number): Promise<Vessel[]> {
    return [...this.vessels.values()].filter((v) => !v.type).slice(0, limit);
  }

  async findVesselByMmsi(mmsi: string): Promise<Vessel | null> {
    return this.vessels.get(String(mmsi)) ?? null;
  }

  async deleteVesselAndPositions(mmsi: string): Promise<void> {
    this.vessels.delete(mmsi);
    this.latest.delete(mmsi);
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      if (this.history[i].mmsi === mmsi) this.history.splice(i, 1);
    }
  }

  /** Lịch sử lộ trình đã lưu — dùng để kiểm tra cleanup không xoá history. */
  positionHistory(): VesselPosition[] {
    return [...this.history];
  }

  private static isFresh(position: VesselPosition, freshSince?: Date): boolean {
    if (!freshSince) return true;
    return position.receivedAt >= freshSince.toISOString();
  }
}
