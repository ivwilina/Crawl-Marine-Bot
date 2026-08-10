// ============================================================================
//  TEST · Thứ tự ưu tiên của getVesselsMissingType — tàu CÓ IMO enrich trước.
// ----------------------------------------------------------------------------
//  Enrich tra từng tàu một, mất vài giây mỗi tàu, nên với kho vài chục nghìn
//  tàu thì THỨ TỰ quyết định app có dữ liệu dùng được sau vài giờ hay vài ngày.
//  Có IMO ≈ tàu thương mại; không IMO phần lớn là tàu giải trí/nội địa.
//
//  Chạy trên cả hai implementation không-Mongo để hợp đồng này không phụ thuộc
//  một kho cụ thể. Bản Mongo dùng 2 truy vấn với vị ngữ ngược nhau — cùng ý
//  nghĩa, nhưng cần một MongoDB thật nên không kiểm ở đây.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { InMemoryVesselRepository } from "../../infrastructure/persistence/InMemoryVesselRepository";
import { JsonFileVesselRepository } from "../../infrastructure/persistence/JsonFileVesselRepository";
import { IVesselRepository } from "../ports/IVesselRepository";
import { Vessel } from "../../domain/entities/Vessel";

/** Chạy cùng một kịch bản trên mọi kho không cần Mongo. */
async function forEachRepo(
  run: (repo: IVesselRepository) => Promise<void>
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crawlbot-enrich-order-"));
  try {
    for (const repo of [new InMemoryVesselRepository(), new JsonFileVesselRepository(dir)]) {
      await run(repo);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Kho trộn lẫn: tàu có IMO nằm CUỐI, để thứ tự chèn không tự cho ra đáp án đúng. */
async function seedMixed(repo: IVesselRepository): Promise<void> {
  await repo.saveVessel(new Vessel({ mmsi: "338202151", name: "SATORI" }));
  await repo.saveVessel(new Vessel({ mmsi: "338218387", name: "INN THE RED" }));
  await repo.saveVessel(new Vessel({ mmsi: "338307771", name: "P-520" }));
  await repo.saveVessel(new Vessel({ mmsi: "305803000", imo: "9811983", name: "BBC UKRAINE" }));
  await repo.saveVessel(new Vessel({ mmsi: "403560000", imo: "9384198", name: "MANIFA" }));
}

/* -------------------------------------------------------------------------- */

test("trả tàu có IMO trước, dù chúng được lưu sau", async () => {
  await forEachRepo(async (repo) => {
    await seedMixed(repo);

    const batch = await repo.getVesselsMissingType(5);

    assert.deepEqual(
      batch.map((v) => v.name),
      ["BBC UKRAINE", "MANIFA", "SATORI", "INN THE RED", "P-520"]
    );
  });
});

test("batch nhỏ hơn số tàu có IMO thì chưa đụng tới tàu không IMO", async () => {
  await forEachRepo(async (repo) => {
    await seedMixed(repo);

    const batch = await repo.getVesselsMissingType(2);

    assert.equal(batch.length, 2);
    assert.ok(batch.every((v) => v.imo), "một vòng enrich ngắn phải dành trọn cho tàu thương mại");
  });
});

test("hết tàu có IMO thì lấy tiếp nhóm còn lại cho đủ batch", async () => {
  await forEachRepo(async (repo) => {
    await seedMixed(repo);

    // 2 tàu có IMO + 1 tàu không -> vòng enrich không được chạy non tải.
    const batch = await repo.getVesselsMissingType(3);

    assert.equal(batch.length, 3);
    assert.equal(batch.filter((v) => v.imo).length, 2);
    assert.equal(batch.filter((v) => !v.imo).length, 1);
  });
});

test("kho chỉ có tàu không IMO vẫn được enrich, không bị bỏ đói", async () => {
  await forEachRepo(async (repo) => {
    await repo.saveVessel(new Vessel({ mmsi: "338202151", name: "SATORI" }));
    await repo.saveVessel(new Vessel({ mmsi: "338218387", name: "INN THE RED" }));

    const batch = await repo.getVesselsMissingType(10);

    assert.equal(batch.length, 2);
  });
});

test("tàu đã có type không bao giờ được trả lại", async () => {
  await forEachRepo(async (repo) => {
    await seedMixed(repo);
    // MANIFA đã enrich xong -> vòng sau phải bỏ qua nó.
    await repo.saveVessel(
      new Vessel({ mmsi: "403560000", imo: "9384198", name: "MANIFA", type: "Crude Oil Tanker" })
    );

    const batch = await repo.getVesselsMissingType(5);

    assert.ok(!batch.some((v) => v.mmsi === "403560000"));
    assert.equal(batch.length, 4);
    // Tàu có IMO còn lại vẫn phải đứng đầu.
    assert.equal(batch[0].name, "BBC UKRAINE");
  });
});
