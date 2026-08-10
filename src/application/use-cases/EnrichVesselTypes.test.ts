// ============================================================================
//  TEST · EnrichVesselTypes — phản ứng khi upstream từ chối phục vụ.
// ----------------------------------------------------------------------------
//  Hai hành vi được kiểm ở đây đều sinh ra từ một sự cố thật: enrich chạy trên
//  VPS gặp timeout liên tiếp, và bản cũ chỉ hạ nhiệt khi bị 403 nên nó vẫn nện
//  đều tay đúng lúc site đang siết.
//
//  `sleep` được tiêm nên test không chờ thật; nó cũng chính là thứ được assert —
//  "đã nghỉ bao lâu" là hành vi, không phải chi tiết cài đặt.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { EnrichVesselTypes } from "./EnrichVesselTypes";
import { InMemoryVesselRepository } from "../../infrastructure/persistence/InMemoryVesselRepository";
import { IVesselDetailsSource, VesselDetails } from "../ports/IVesselDetailsSource";
import { Vessel } from "../../domain/entities/Vessel";
import { VesselPosition } from "../../domain/entities/VesselPosition";
import { AppError, Errors } from "../../domain/errors/AppError";

/* -------------------------------------------------------------------------- */

/** Nguồn giả: trả lỗi theo kịch bản, và đếm số lần thực sự bị gọi. */
class StubDetailsSource implements IVesselDetailsSource {
  calls: string[] = [];

  /** `outcomes[i]` áp cho lần gọi thứ i; hết kịch bản thì thành công. */
  constructor(private outcomes: Array<AppError | null> = []) {}

  async getDetails(id: string): Promise<VesselDetails> {
    const outcome = this.outcomes[this.calls.length] ?? null;
    this.calls.push(id);

    if (outcome) throw outcome;

    return {
      vessel: new Vessel({ mmsi: id, name: "OK BOAT", type: "General Cargo Ship" }),
      position: new VesselPosition({ mmsi: id, lat: 1, lon: 103, courseDeg: 90 }),
    };
  }
}

/** Ghi lại mọi lần nghỉ thay vì nghỉ thật. */
function recordingSleep(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

async function seed(repo: InMemoryVesselRepository, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await repo.saveVessel(new Vessel({ mmsi: `33800000${i}`, name: `BOAT ${i}` }));
  }
}

/* -------------------------------------------------------------------------- */

test("timeout cũng được hạ nhiệt, không chỉ 403", async () => {
  const repo = new InMemoryVesselRepository();
  await seed(repo, 5);
  const source = new StubDetailsSource([Errors.SCRAPE_TIMEOUT()]);
  const { waits, sleep } = recordingSleep();

  await new EnrichVesselTypes({
    detailsSource: source, repository: repo, batchSize: 5, delayMs: 1000, sleep,
  }).runOnce();

  // Bản cũ chỉ nghỉ `delayMs` cho một timeout; giờ phải có một lượt nghỉ dài.
  assert.ok(waits.some((w) => w >= 60_000), `không thấy lượt hạ nhiệt nào: ${waits}`);
});

test("hỏng liên tiếp thì nghỉ gấp đôi dần rồi bỏ nốt vòng", async () => {
  const repo = new InMemoryVesselRepository();
  await seed(repo, 10);
  const source = new StubDetailsSource(Array(10).fill(Errors.SCRAPE_TIMEOUT()));
  const { waits, sleep } = recordingSleep();

  await new EnrichVesselTypes({
    detailsSource: source, repository: repo, batchSize: 10, delayMs: 1000, sleep,
  }).runOnce();

  const cooldowns = waits.filter((w) => w >= 60_000);
  assert.deepEqual(cooldowns, [60_000, 120_000, 240_000]);
  // Bỏ vòng ở lần hỏng thứ 3 -> không đụng tới 7 tàu còn lại.
  assert.equal(source.calls.length, 3, "phải dừng sớm thay vì chạy hết batch");
});

test("một lượt thành công xoá chuỗi hỏng, hạ nhiệt quay về mức đầu", async () => {
  const repo = new InMemoryVesselRepository();
  await seed(repo, 6);
  const source = new StubDetailsSource([
    Errors.SCRAPE_TIMEOUT(), // hỏng 1 -> 60s
    null,                    // thành công -> reset
    Errors.SCRAPE_TIMEOUT(), // hỏng 1 lần nữa -> lại 60s, KHÔNG phải 120s
  ]);
  const { waits, sleep } = recordingSleep();

  await new EnrichVesselTypes({
    detailsSource: source, repository: repo, batchSize: 6, delayMs: 1000, sleep,
  }).runOnce();

  assert.deepEqual(waits.filter((w) => w >= 60_000), [60_000, 60_000]);
});

test("lỗi của riêng một tàu không làm dừng vòng và không hạ nhiệt", async () => {
  const repo = new InMemoryVesselRepository();
  await seed(repo, 4);
  // 404 nói về con tàu đó, không nói gì về sức khoẻ của upstream.
  const source = new StubDetailsSource([
    Errors.SHIP_NOT_FOUND("1"), Errors.SHIP_NOT_FOUND("2"), Errors.SHIP_NOT_FOUND("3"),
  ]);
  const { waits, sleep } = recordingSleep();

  await new EnrichVesselTypes({
    detailsSource: source, repository: repo, batchSize: 4, delayMs: 1000, sleep,
  }).runOnce();

  assert.equal(source.calls.length, 4, "404 không được làm dừng vòng");
  assert.equal(waits.filter((w) => w >= 60_000).length, 0, "404 không được hạ nhiệt");
});

test("vòng sau đi tiếp tàu chưa thử, không bốc lại tàu vừa hỏng", async () => {
  // ĐÂY là vòng lặp đói: hàng đợi 5 tàu, mỗi vòng chỉ xử được 2. Nếu lượt hỏng
  // không để lại dấu vết thì vòng nào cũng bốc đúng 2 tàu đầu và 3 tàu còn lại
  // không bao giờ tới lượt.
  const repo = new InMemoryVesselRepository();
  await seed(repo, 5);
  const source = new StubDetailsSource([
    Errors.SHIP_NOT_FOUND("a"), Errors.SHIP_NOT_FOUND("b"),
  ]);
  const { sleep } = recordingSleep();

  const enrich = new EnrichVesselTypes({
    detailsSource: source, repository: repo, batchSize: 2, delayMs: 1000, sleep,
  });
  await enrich.runOnce();

  assert.deepEqual(source.calls, ["338000000", "338000001"]);

  const next = await repo.getVesselsMissingType(2);
  assert.deepEqual(
    next.map((v) => v.mmsi),
    ["338000002", "338000003"],
    "hàng đợi phải tiến lên, không quay lại 2 tàu vừa hỏng"
  );
});

test("hết một lượt quét hàng đợi thì quay lại tàu cũ chứ không bỏ luôn", async () => {
  // Đẩy xuống cuối, KHÔNG loại vĩnh viễn: một tàu hỏng vì sự cố tạm thời vẫn
  // phải được thử lại sau khi những tàu khác đã tới lượt.
  const repo = new InMemoryVesselRepository();
  await seed(repo, 2);
  const source = new StubDetailsSource([
    Errors.SHIP_NOT_FOUND("a"), Errors.SHIP_NOT_FOUND("b"),
  ]);
  const { sleep } = recordingSleep();
  const enrich = new EnrichVesselTypes({
    detailsSource: source, repository: repo, batchSize: 2, delayMs: 1000, sleep,
  });

  await enrich.runOnce();
  const next = await repo.getVesselsMissingType(2);

  assert.equal(next.length, 2, "cả hai tàu vẫn còn trong hàng đợi");
});
