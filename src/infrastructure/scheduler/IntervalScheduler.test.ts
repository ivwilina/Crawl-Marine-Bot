// ============================================================================
//  TEST · IntervalScheduler — không chạy chồng, vẫn sống sau khi task lỗi.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { IntervalScheduler } from "./IntervalScheduler";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("does not overlap scheduled executions", async () => {
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const scheduler = new IntervalScheduler({
    everyMs: 1,
    task: async () => {
      calls += 1;
      await gate;
    },
  });
  scheduler.start();
  await wait(30); // nhiều tick trôi qua nhưng task đầu chưa xong

  assert.equal(calls, 1);
  release();
  scheduler.stop();
  await wait(5);
});

test("runs again on the next tick once the previous task finished", async () => {
  let calls = 0;
  const scheduler = new IntervalScheduler({ everyMs: 5, task: async () => void (calls += 1) });
  scheduler.start();
  await wait(40);
  scheduler.stop();
  assert.ok(calls >= 2, `mong đợi >= 2 lần chạy, nhận ${calls}`);
});

test("skips the immediate run when runOnStart is false", async () => {
  let calls = 0;
  const scheduler = new IntervalScheduler({
    everyMs: 60_000,
    runOnStart: false,
    task: async () => void (calls += 1),
  });
  scheduler.start();
  await wait(10);
  scheduler.stop();
  assert.equal(calls, 0);
});

test("keeps scheduling after a task throws", async () => {
  let calls = 0;
  const scheduler = new IntervalScheduler({
    everyMs: 5,
    task: async () => {
      calls += 1;
      throw new Error("task failed");
    },
  });
  scheduler.start();
  await wait(40);
  scheduler.stop();
  assert.ok(calls >= 2, `mong đợi >= 2 lần chạy, nhận ${calls}`);
});
