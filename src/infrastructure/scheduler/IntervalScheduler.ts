// ============================================================================
//  INFRASTRUCTURE · Scheduler: chạy 1 việc định kỳ (vd mỗi 2 giờ) bằng setInterval
// ============================================================================

export interface IntervalSchedulerDeps {
  everyMs: number;
  task: () => Promise<void>;
  runOnStart?: boolean;
}

export class IntervalScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: IntervalSchedulerDeps) {}

  start(): void {
    const hours = (this.deps.everyMs / 3600000).toFixed(2);
    console.log(`⏰ Scheduler: sẽ crawl mỗi ${hours} giờ.`);
    if (this.deps.runOnStart ?? true) void this.safeRun();
    this.timer = setInterval(() => void this.safeRun(), this.deps.everyMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async safeRun(): Promise<void> {
    try {
      await this.deps.task();
    } catch (err) {
      console.error(`⚠️  Scheduler lỗi: ${(err as Error).message}`);
    }
  }
}
