// ============================================================================
//  APPLICATION · PORT: ICache — hôm nay RAM, mai Redis, không đổi use case.
//  Dùng generic <T> để cache giữ đúng kiểu dữ liệu.
// ============================================================================

export interface ICache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
}
