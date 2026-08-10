// ============================================================================
//  INFRASTRUCTURE · Repository: lưu vào file JSON (chạy ngay, không cần Mongo).
//  Đổi sang MongoDB: viết MongoVesselRepository implements IVesselRepository,
//  đổi 1 dòng trong container. Use case KHÔNG phải sửa.
// ============================================================================

import * as fs from "fs";
import * as path from "path";
import { IVesselRepository } from "../../application/ports/IVesselRepository";
import { distanceNm } from "../../application/ports/Geo";
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
    const vessels = this.read<Record<string, Record<string, unknown>>>(this.vesselsFile);
    // Trải bản ghi cũ ra trước: `Vessel` không mang `enrichAttempts`, nên ghi đè
    // thẳng sẽ xoá bộ đếm hàng đợi enrich. Bản Mongo dùng `$set` nên giữ nguyên
    // các field lạ — chỗ này phải làm tay cho khớp ngữ nghĩa đó.
    vessels[vessel.mmsi] = {
      ...vessels[vessel.mmsi],
      ...vessel,
      updatedAt: new Date().toISOString(),
    };
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

  /**
   * Cả mẻ trong 1 lần đọc + 1 lần ghi file (thay vì đọc/ghi mỗi tàu). Ngữ nghĩa
   * giống Mongo: lý lịch chỉ điền khi tạo mới, chỉ `name` được cập nhật.
   */
  async upsertVesselsFromScan(vessels: Vessel[]): Promise<number> {
    const stored = this.read<Record<string, Record<string, unknown>>>(this.vesselsFile);
    const now = new Date().toISOString();
    let written = 0;

    for (const vessel of vessels) {
      const existing = stored[vessel.mmsi];
      if (!existing) {
        stored[vessel.mmsi] = { ...vessel, updatedAt: now };
        written += 1;
        continue;
      }
      // Tên "rỗng" từ mp2 chính là mmsi -> không đè lên tên thật.
      const isRealName = Boolean(vessel.name) && vessel.name !== vessel.mmsi;
      if (isRealName && vessel.name !== existing.name) {
        stored[vessel.mmsi] = { ...existing, name: vessel.name, updatedAt: now };
        written += 1;
      }
    }

    if (written > 0) this.write(this.vesselsFile, stored);
    return written;
  }

  /** Cả mẻ trong 1 lần đọc + 1 lần ghi; giữ nguyên course/speed đã enrich. */
  async savePositionsFromScan(positions: VesselPosition[]): Promise<number> {
    return this._writeGuardedPositions(positions, (position, existing) => ({
      ...existing,
      imo: position.imo ?? existing.imo,
      lat: position.lat,
      lon: position.lon,
      source: position.source,
      latLonApproximate: position.latLonApproximate,
      receivedAt: position.receivedAt,
    }));
  }

  /** AIS mang thêm course/speed/heading/navStatus; destination/eta giữ nguyên. */
  async savePositionsFromAis(positions: VesselPosition[]): Promise<number> {
    return this._writeGuardedPositions(positions, (position, existing) => ({
      ...existing,
      imo: position.imo ?? existing.imo,
      lat: position.lat,
      lon: position.lon,
      speedKn: position.speedKn,
      courseDeg: position.courseDeg,
      headingDeg: position.headingDeg,
      navStatusCode: position.navStatusCode,
      navStatusText: position.navStatusText,
      source: position.source,
      latLonApproximate: position.latLonApproximate,
      receivedAt: position.receivedAt,
    }));
  }

  /** Chỉ điền chỗ trống — giá trị đang có luôn thắng. */
  async upsertVesselsFromAis(vessels: Vessel[]): Promise<number> {
    const stored = this.read<Record<string, Record<string, unknown>>>(this.vesselsFile);
    const now = new Date().toISOString();
    let written = 0;

    for (const vessel of vessels) {
      const existing = stored[vessel.mmsi];
      if (!existing) {
        stored[vessel.mmsi] = { ...vessel, updatedAt: now };
        written += 1;
        continue;
      }

      const filled = {
        ...existing,
        imo: existing.imo ?? vessel.imo,
        aisType: existing.aisType ?? vessel.aisType,
        name: existing.name ?? vessel.name,
      };

      if (
        filled.imo !== existing.imo ||
        filled.aisType !== existing.aisType ||
        filled.name !== existing.name
      ) {
        stored[vessel.mmsi] = { ...filled, updatedAt: now };
        written += 1;
      }
    }

    if (written > 0) this.write(this.vesselsFile, stored);
    return written;
  }

  /** Bỏ qua bản ghi CŨ HƠN cái đang có: mp2 và AIS cùng ghi vào file này. */
  private async _writeGuardedPositions(
    positions: VesselPosition[],
    merge: (position: VesselPosition, existing: VesselPosition) => ConstructorParameters<typeof VesselPosition>[0]
  ): Promise<number> {
    const stored = this.read<VesselPosition[]>(this.latestPositionsFile);
    const byMmsi = new Map(stored.map((p) => [p.mmsi, p]));
    let written = 0;

    for (const position of positions) {
      if (position.mmsi === null) continue;

      const existing = byMmsi.get(position.mmsi);
      if (existing && existing.receivedAt > position.receivedAt) continue;

      byMmsi.set(
        position.mmsi,
        existing ? new VesselPosition(merge(position, existing)) : position
      );
      written += 1;
    }

    if (written > 0) this.write(this.latestPositionsFile, [...byMmsi.values()]);
    return written;
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

  /** Lọc bằng haversine — file JSON không có index địa lý. */
  async getLatestPositionsNearby(
    center: { lat: number; lon: number },
    radiusNm: number,
    limit: number,
    freshSince?: Date
  ): Promise<VesselPosition[]> {
    return (await this.getAllLatestPositions(freshSince))
      .filter((p) => {
        if (p.lat === null || p.lon === null) return false;
        return distanceNm(center, { lat: p.lat, lon: p.lon }) <= radiusNm;
      })
      .slice(0, limit);
  }

  async findVesselsByName(prefix: string, limit: number): Promise<Vessel[]> {
    const query = prefix.trim().toUpperCase();
    if (query.length < 3) return [];

    return (await this.getAllVessels())
      .filter((v) => (v.name ?? "").toUpperCase().startsWith(query))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
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

  /**
   * Tàu cần enrich: có IMO trước, trong mỗi nhóm thì ít lượt thử nhất trước.
   * Cùng thứ tự ưu tiên với bản Mongo.
   */
  async getVesselsMissingType(limit: number): Promise<Vessel[]> {
    const stored = this.read<Record<string, Record<string, unknown>>>(this.vesselsFile);
    const missing = (await this.getAllVessels()).filter((v) => !v.type);
    const attempts = (v: Vessel): number => Number(stored[v.mmsi]?.enrichAttempts ?? 0);
    // Sắp ổn định: các phần tử bằng điểm giữ nguyên thứ tự chèn.
    const byAttempts = (group: Vessel[]): Vessel[] =>
      [...group].sort((a, b) => attempts(a) - attempts(b));

    return [
      ...byAttempts(missing.filter((v) => v.imo)),
      ...byAttempts(missing.filter((v) => !v.imo)),
    ].slice(0, limit);
  }

  async recordEnrichAttempt(mmsi: string): Promise<void> {
    const stored = this.read<Record<string, Record<string, unknown>>>(this.vesselsFile);
    const existing = stored[mmsi];
    if (!existing) return;

    stored[mmsi] = { ...existing, enrichAttempts: Number(existing.enrichAttempts ?? 0) + 1 };
    this.write(this.vesselsFile, stored);
  }

  async findVesselByMmsi(mmsi: string): Promise<Vessel | null> {
    const vessels = await this.getAllVessels();
    return vessels.find((v) => v.mmsi === mmsi) ?? null;
  }

  async findVesselByImoOrMmsi(id: string): Promise<Vessel | null> {
    const key = String(id).trim();
    const vessels = await this.getAllVessels();
    return vessels.find((v) => v.mmsi === key || v.imo === key) ?? null;
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
