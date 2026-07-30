// ============================================================================
//  INFRASTRUCTURE · HttpClient
//  --------------------------------------------------------------------------
//  Single, transparent HTTP client for approved upstream integrations.
// ============================================================================

import { Errors } from "../../domain/errors/AppError";

export interface HttpClientOptions {
  timeoutMs?: number;
}

export class HttpClient {
  private readonly timeoutMs: number;

  constructor(opts: HttpClientOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 10000;
  }

  async getJson<T>(url: string, extraHeaders: Record<string, string> = {}): Promise<T> {
    const res = await this.doFetch(url, extraHeaders);
    return (await res.json()) as T;
  }

  async getText(url: string, extraHeaders: Record<string, string> = {}): Promise<string> {
    const res = await this.doFetch(url, extraHeaders);
    return res.text();
  }

  async getArrayBuffer(url: string, extraHeaders: Record<string, string> = {}): Promise<ArrayBuffer> {
    const res = await this.doFetch(url, extraHeaders);
    return res.arrayBuffer();
  }

  private async doFetch(url: string, extraHeaders: Record<string, string>): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "user-agent": "SooskyCrawlBot/1.0",
          accept: "application/octet-stream,text/html;q=0.9,*/*;q=0.8",
          ...extraHeaders,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = err as { name?: string; message: string };
      if (e.name === "TimeoutError") throw Errors.SCRAPE_TIMEOUT();
      throw Errors.SOURCE_ERROR(e.message);
    }

    if (res.status === 403 || res.status === 429) throw Errors.SCRAPE_BLOCKED();
    if (res.status === 404) throw Errors.SHIP_NOT_FOUND(url);
    if (!res.ok) throw Errors.SOURCE_ERROR(`HTTP ${res.status}`);
    return res;
  }
}
