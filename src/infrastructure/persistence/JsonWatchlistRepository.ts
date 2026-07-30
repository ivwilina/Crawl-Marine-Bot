// ============================================================================
//  INFRASTRUCTURE · Repository: JsonWatchlistRepository (lưu watchlist vào file)
// ============================================================================

import * as fs from "fs";
import * as path from "path";
import { IWatchlistRepository } from "../../application/ports/IWatchlistRepository";

export class JsonWatchlistRepository implements IWatchlistRepository {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "watchlist.json");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(this.file)) this.write([]);
  }

  async getAll(): Promise<string[]> {
    return this.read();
  }

  async add(id: string): Promise<void> {
    const list = this.read();
    if (!list.includes(id)) {
      list.push(id);
      this.write(list);
    }
  }

  async remove(id: string): Promise<void> {
    this.write(this.read().filter((x) => x !== id));
  }

  async has(id: string): Promise<boolean> {
    return this.read().includes(id);
  }

  private read(): string[] {
    return JSON.parse(fs.readFileSync(this.file, "utf-8")) as string[];
  }
  private write(list: string[]): void {
    fs.writeFileSync(this.file, JSON.stringify(list, null, 2), "utf-8");
  }
}
