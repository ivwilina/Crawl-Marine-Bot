// ============================================================================
//  INFRASTRUCTURE · Cache: RedisCache (implements ICache) — dùng ioredis
// ----------------------------------------------------------------------------
//  Cùng interface với InMemoryCache -> use case không biết mình đang dùng
//  Redis hay RAM. Đổi qua lại chỉ nhờ có/không có REDIS_URL trong .env.
//
//  Tương thích:
//    - Redis local:  redis://localhost:6379
//    - Upstash (TCP): rediss://default:xxxx@yyyy.upstash.io:6379
//  ioredis tự bật TLS khi URL bắt đầu bằng "rediss://".
// ============================================================================

import Redis from "ioredis";
import { ICache } from "../../application/ports/ICache";

export class RedisCache implements ICache {
  private readonly client: Redis;

  constructor(url: string) {
    // Upstash BẮT BUỘC TLS. Nếu URL để "redis://" mà host là upstash.io thì
    // tự nâng thành "rediss://" (2 chữ s) để ioredis bật TLS -> khỏi bị lỗi.
    let finalUrl = url;
    if (/upstash\.io/i.test(url) && url.startsWith("redis://")) {
      finalUrl = url.replace(/^redis:\/\//, "rediss://");
    }

    this.client = new Redis(finalUrl, {
      // Không "chết" nếu Redis tạm gián đoạn; thử lại vài lần rồi báo lỗi.
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
    this.client.on("error", (err) => {
      console.error(`⚠️  Redis lỗi: ${err.message}`);
    });
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch {
      // Redis trục trặc -> coi như cache miss, KHÔNG làm hỏng request.
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    try {
      // "PX" = đặt thời gian sống theo mili giây (tự hết hạn).
      await this.client.set(key, JSON.stringify(value), "PX", ttlMs);
    } catch {
      // Ghi cache thất bại thì bỏ qua, lần sau lấy lại từ nguồn.
    }
  }
}
