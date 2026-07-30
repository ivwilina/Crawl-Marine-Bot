// ============================================================================
//  INFRASTRUCTURE · Repository: lưu vào file JSON (chạy ngay, không cần Mongo).
//  Đổi sang MongoDB: viết MongoVesselRepository implements IVesselRepository,
//  đổi 1 dòng trong container. Use case KHÔNG phải sửa.
// ============================================================================

import * as fs from "fs";
import * as path from "path";
import { IVesselRepository } from "../../application/ports/IVesselRepository";
import { Vessel } from "../../domain/entities/Vessel";
import { VesselPosition } from "../../domain/entities/VesselPosition";

export class JsonFileVesselRepository implements IVesselRepository {
  private readonly vesselsFile: string;
  private readonly positionsFile: string;
  private readonly latestPositionsFile: string;

  constructor(dataDir: string) {
    this.vesselsFile = path.join(dataDir, "vessels.json");
    this.positionsFile = path.join(dataDir, "positions.json");
    this.latestPositionsFile = path.join(dataDir, "latest_positions.json");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.ensure(this.vesselsFile, {});
    this.ensure(this.positionsFile, []);
    this.migrateLegacyLatestPositions();
  }

  async saveVessel(vessel: Vessel): Promise<void> {
    const vessels = this.read<Record<string, unknown>>(this.vesselsFile);
    vessels[vessel.mmsi] = { ...vessel, updatedAt: new Date().toISOString() };
    this.write(this.vesselsFile, vessels);
  }

  async savePosition(position: VesselPosition): Promise<void> {
    const positions = this.read<VesselPosition[]>(this.positionsFile);
    positions.push(position);
    this.write(this.positionsFile, positions);
    this.upsertLatest(position);
  }

  async savePositionLatest(position: VesselPosition): Promise<void> {
    this.upsertLatest(position);
  }

  async getLatestPosition(mmsi: string): Promise<VesselPosition | null> {
    return this.read<VesselPosition[]>(this.latestPositionsFile).find((p) => p.mmsi === String(mmsi)) ?? null;
  }

  async getAllLatestPositions(freshSince?: Date): Promise<VesselPosition[]> {
    const all = this.read<VesselPosition[]>(this.latestPositionsFile);
    if (!freshSince) return all;
    const cutoff = freshSince.toISOString();
    return all.filter((p) => p.receivedAt >= cutoff);
  }

  async getLatestPositionsInBbox(
    box: import("../../application/ports/Geo").BoundingBox,
    limit: number,
    freshSince?: Date
  ): Promise<VesselPosition[]> {
    const all = await this.getAllLatestPositions(freshSince);
    return all
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

  async getAllVessels(): Promise<Vessel[]> {
    const vessels = this.read<Record<string, Record<string, unknown>>>(this.vesselsFile);
    return Object.values(vessels).map(
      (v) => new Vessel(v as unknown as ConstructorParameters<typeof Vessel>[0])
    );
  }

  async getVesselsByMmsi(mmsis: string[]): Promise<Vessel[]> {
    const set = new Set(mmsis);
    return (await this.getAllVessels()).filter((v) => set.has(v.mmsi));
  }

  async getVesselsMissingType(limit: number): Promise<Vessel[]> {
    return (await this.getAllVessels()).filter((v) => !v.type).slice(0, limit);
  }

  async findVesselByMmsi(mmsi: string): Promise<Vessel | null> {
    const vessels = await this.getAllVessels();
    return vessels.find((v) => v.mmsi === mmsi) ?? null;
  }

  /** Xoá map state đã hết hạn khỏi latest_positions.json, giữ nguyên history. */
  async deleteLatestPositionsOlderThan(cutoff: Date): Promise<number> {
    const iso = cutoff.toISOString();
    const positions = this.read<VesselPosition[]>(this.latestPositionsFile);
    const kept = positions.filter((p) => p.receivedAt >= iso);
    const removed = positions.length - kept.length;
    // Chỉ ghi map state khi thực sự có bản ghi bị xoá; history luôn giữ nguyên.
    if (removed > 0) this.write(this.latestPositionsFile, kept);
    return removed;
  }

  async deleteVesselAndPositions(mmsi: string): Promise<void> {
    const vessels = this.read<Record<string, unknown>>(this.vesselsFile);
    delete vessels[mmsi];
    this.write(this.vesselsFile, vessels);

    const positions = this.read<VesselPosition[]>(this.positionsFile);
    this.write(
      this.positionsFile,
      positions.filter((p) => p.mmsi !== mmsi)
    );
    this.write(
      this.latestPositionsFile,
      this.read<VesselPosition[]>(this.latestPositionsFile).filter((p) => p.mmsi !== mmsi)
    );
  }

  // ---- tiện ích file (private) ----
  /** Migrate legacy history thành snapshot latest mà không sửa positions.json. */
  private migrateLegacyLatestPositions(): void {
    if (fs.existsSync(this.latestPositionsFile)) return;
    const latest = new Map<string, VesselPosition>();
    for (const position of this.read<VesselPosition[]>(this.positionsFile)) {
      const key = position.mmsi ?? "?";
      const current = latest.get(key);
      if (!current || current.receivedAt < position.receivedAt) latest.set(key, position);
    }
    this.write(this.latestPositionsFile, [...latest.values()]);
  }

  private upsertLatest(position: VesselPosition): void {
    const positions = this.read<VesselPosition[]>(this.latestPositionsFile);
    const kept = positions.filter((p) => p.mmsi !== position.mmsi);
    kept.push(position);
    this.write(this.latestPositionsFile, kept);
  }

  private ensure(file: string, initial: unknown): void {
    if (!fs.existsSync(file)) this.write(file, initial);
  }
  private read<T>(file: string): T {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  }
  private write(file: string, data: unknown): void {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
  }
}
