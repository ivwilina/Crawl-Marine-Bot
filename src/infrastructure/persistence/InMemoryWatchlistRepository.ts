// ============================================================================
//  INFRASTRUCTURE · Repository: InMemoryWatchlistRepository (RAM)
//  Cùng interface với bản Mongo/JSON. Dùng cho test tích hợp HTTP.
// ============================================================================

import { IWatchlistRepository } from "../../application/ports/IWatchlistRepository";

export class InMemoryWatchlistRepository implements IWatchlistRepository {
  private readonly ids = new Set<string>();

  constructor(initial: string[] = []) {
    for (const id of initial) this.ids.add(String(id));
  }

  async getAll(): Promise<string[]> {
    return [...this.ids];
  }

  async add(id: string): Promise<void> {
    this.ids.add(String(id));
  }

  async remove(id: string): Promise<void> {
    this.ids.delete(String(id));
  }

  async has(id: string): Promise<boolean> {
    return this.ids.has(String(id));
  }
}
