// ============================================================================
//  INFRASTRUCTURE · Cache: InMemoryCache (RAM). Đổi sang Redis: viết RedisCache
//  implements ICache rồi đổi 1 dòng trong container.
// ============================================================================

import { ICache } from "../../application/ports/ICache";

interface Entry {
  value: unknown;
  expireAt: number;
}

export class InMemoryCache implements ICache {
  private store = new Map<string, Entry>();

  async get<T>(key: string): Promise<T | null> {
    const item = this.store.get(key);
    if (!item) return null;
    if (item.expireAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return item.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.store.set(key, { value, expireAt: Date.now() + ttlMs });
  }
}
