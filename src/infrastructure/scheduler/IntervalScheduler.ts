// ============================================================================
//  INFRASTRUCTURE · Scheduler: chạy 1 việc định kỳ (vd mỗi 2 giờ) bằng setInterval
// ----------------------------------------------------------------------------
//  KHÔNG chạy chồng: tick nào tới trong khi lần chạy trước chưa xong thì bỏ
//  qua. Việc dài hơn chu kỳ (crawl/scan/cleanup) vì thế không nhân bản tải lên
//  upstream hay DB.
// ============================================================================

export interface IntervalSchedulerDeps {
  everyMs: number;
  task: () => Promise<void>;
  runOnStart?: boolean;
  /** Tên việc để log rõ đang hẹn giờ cho cái gì. */
  label?: string;
}

export class IntervalScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: IntervalSchedulerDeps) {}

  start(): void {
    const label = this.deps.label ?? "công việc";
    const minutes = (this.deps.everyMs / 60000).toFixed(1);
    console.log(`⏰ Scheduler: chạy "${label}" mỗi ${minutes} phút.`);
    if (this.deps.runOnStart ?? true) void this.safeRun();
    this.timer = setInterval(() => void this.safeRun(), this.deps.everyMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async safeRun(): Promise<void> {
    // Lần chạy trước còn đang dở -> bỏ tick này (không xếp hàng, không chồng).
    if (this.running) return;
    this.running = true;
    try {
      await this.deps.task();
    } catch (err) {
      console.error(`⚠️  Scheduler lỗi: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
