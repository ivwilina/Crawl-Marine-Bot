// ============================================================================
//  TEST · htmlDrift.analyzeHtml — chạy trên HTML THẬT, offline.
// ----------------------------------------------------------------------------
//  Dùng chung fixture với VesselFinderHtmlMapper.test.ts: một trang tải nguyên
//  từ site phải cho "không thiếu nhãn nào". Bản trước dùng fixture tự viết theo
//  cách hiểu sai cấu trúc, nên nó xanh trong khi trang thật báo thiếu 10 nhãn.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { analyzeHtml } from "./htmlDrift";

function fixture(imo: string): string {
  return fs.readFileSync(
    path.join(__dirname, "..", "mappers", "fixtures", `vesselfinder-${imo}.html`),
    "utf-8"
  );
}

const REAL_PAGE = fixture("9384198");

test("một trang thật không được báo thiếu nhãn nào", () => {
  const result = analyzeHtml(REAL_PAGE);

  assert.equal(result.ok, true);
  assert.deepEqual(result.failedChecks, []);
  assert.deepEqual(result.missingLabels, [], "nhãn thiếu = parser đang tìm sai chỗ");
  assert.equal(result.djsonHasLatLon, true);
});

test("trang thật thứ hai cũng vậy", () => {
  const result = analyzeHtml(fixture("9811983"));

  assert.equal(result.ok, true);
  assert.deepEqual(result.missingLabels, []);
});

test("mất #djson -> CRITICAL, ok=false", () => {
  const html = REAL_PAGE.replace(/<div id="djson"[\s\S]*?<\/div>/, "");
  const result = analyzeHtml(html);

  assert.equal(result.ok, false);
  assert.ok(result.failedChecks.some((f) => f.includes("[CRITICAL]") && f.includes("djson")));
});

test("đổi class n3 -> n4 (VF đổi form bảng AIS) -> CRITICAL", () => {
  const result = analyzeHtml(REAL_PAGE.replace(/class="n3"/g, 'class="n4"'));

  assert.equal(result.ok, false);
  assert.ok(result.failedChecks.some((f) => f.includes("[CRITICAL]") && f.includes("n3")));
});

test("mất bảng particulars -> warn, không critical", () => {
  // Mapper vẫn chạy được nhờ nhãn dự phòng trong bảng AIS, chỉ mất tonnage.
  const result = analyzeHtml(REAL_PAGE.replace(/class="tpc1"/g, 'class="tpcX"'));

  assert.equal(result.ok, true);
  assert.ok(result.failedChecks.some((f) => f.includes("[warn]") && f.includes("tpc1")));
  assert.ok(result.missingLabels.some((l) => l.startsWith("tpc1: ")));
});

test("mất khối vilabel -> warn kèm nhãn voyage bị thiếu", () => {
  const result = analyzeHtml(REAL_PAGE.replace(/class="vilabel"/g, 'class="vilabelX"'));

  assert.equal(result.ok, true);
  assert.ok(result.failedChecks.some((f) => f.includes("vilabel")));
  assert.deepEqual(
    result.missingLabels.filter((l) => l.startsWith("vilabel: ")),
    ["vilabel: Destination", "vilabel: Last Port"]
  );
});

test("đổi tên nhãn (Callsign -> Call Sign) -> missingLabels bắt được, kèm cấu trúc", () => {
  const result = analyzeHtml(REAL_PAGE.replace(">Callsign<", ">Call Sign<"));

  assert.equal(result.ok, true, "selector còn nguyên nên mapper chưa hỏng hẳn");
  assert.ok(result.missingLabels.includes("n3: Callsign"));
});

test("djson JSON hỏng -> CRITICAL parse fail", () => {
  const html = REAL_PAGE.replace(/data-json='[^']*'/, `data-json='{broken json,,,'`);
  const result = analyzeHtml(html);

  assert.equal(result.ok, false);
  assert.ok(result.failedChecks.some((f) => f.includes("parse")));
});

test("djson thiếu ship_lat/lon -> djsonHasLatLon=false, vẫn ok", () => {
  const html = REAL_PAGE.replace(
    /data-json='[^']*'/,
    `data-json='{"mmsi":403560000,"ship_cog":180,"ship_sog":12.5}'`
  );
  const result = analyzeHtml(html);

  assert.equal(result.ok, true);
  assert.equal(result.djsonHasLatLon, false);
});

test("mất h1.title -> warn, ok vẫn true", () => {
  const result = analyzeHtml(REAL_PAGE.replace(/<h1 class="title">/, "<h1>"));

  assert.equal(result.ok, true);
  assert.ok(result.failedChecks.some((f) => f.includes("[warn]") && f.includes("h1.title")));
});
