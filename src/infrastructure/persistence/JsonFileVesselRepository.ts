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

  constructor(dataDir: string) {
    this.vesselsFile = path.join(dataDir, "vessels.json");
    this.positionsFile = path.join(dataDir, "positions.json");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.ensure(this.vesselsFile, {});
    this.ensure(this.positionsFile, []);
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
  }

  async savePositionLatest(position: VesselPosition): Promise<void> {
    const key = position.mmsi; // KHÓA = MMSI
    const positions = this.read<VesselPosition[]>(this.positionsFile);
    // Bỏ bản cũ của tàu này (nếu có) rồi thêm bản mới -> luôn 1 record/tàu.
    const kept = positions.filter((p) => p.mmsi !== key);
    kept.push(position);
    this.write(this.positionsFile, kept);
  }

  async getLatestPosition(mmsi: string): Promise<VesselPosition | null> {
    const positions = this.read<VesselPosition[]>(this.positionsFile);
    const mine = positions.filter((p) => p.mmsi === String(mmsi));
    if (mine.length === 0) return null;
    return mine.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1))[0];
  }

  async getAllLatestPositions(): Promise<VesselPosition[]> {
    const positions = this.read<VesselPosition[]>(this.positionsFile);
    const latest: Record<string, VesselPosition> = {};
    for (const p of positions) {
      const key = p.mmsi ?? "?";
      if (!latest[key] || latest[key].receivedAt < p.receivedAt) {
        latest[key] = p;
      }
    }
    return Object.values(latest);
  }

  async getLatestPositionsInBbox(
    box: import("../../application/ports/Geo").BoundingBox,
    limit: number
  ): Promise<VesselPosition[]> {
    const all = await this.getAllLatestPositions();
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

  async deleteVesselAndPositions(mmsi: string): Promise<void> {
    const vessels = this.read<Record<string, unknown>>(this.vesselsFile);
    delete vessels[mmsi];
    this.write(this.vesselsFile, vessels);

    const positions = this.read<VesselPosition[]>(this.positionsFile);
    this.write(
      this.positionsFile,
      positions.filter((p) => p.mmsi !== mmsi)
    );
  }

  // ---- tiện ích file (private) ----
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
