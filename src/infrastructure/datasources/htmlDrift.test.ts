// ============================================================================
//  TEST · htmlDrift.analyzeHtml — chạy offline, không mạng.
//  Chạy:  npx ts-node --test src/infrastructure/datasources/htmlDrift.test.ts
//  (Node 18+ có sẵn node:test, không cần cài framework.)
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeHtml } from "./htmlDrift";

// ── Fixture: trang HTML "tốt" — có đủ selector mapper cần ──────────────────
//  Hai bảng n3/v3 giống trang thật (kiểm chứng trên IMO 9384198): Voyage Data
//  rồi Vessel Particulars, cùng dữ liệu nhưng nhãn khác nhau.
const GOOD_HTML = `
<html><body>
  <h1 class="title">EVER GIVEN</h1>
  <div id="djson" data-json='{"mmsi":353136000,"imo":9811000,"ship_lat":31.2,"ship_lon":32.3,"ship_cog":180,"ship_sog":12.5}'></div>
  <table>
    <tr><td class="n3">Destination</td><td class="v3">EGSUZ</td></tr>
    <tr><td class="n3">ETA</td><td class="v3">Aug 10, 02:00 (in 5 days)</td></tr>
    <tr><td class="n3">Course / Speed</td><td class="v3">180 / 12.5 kn</td></tr>
    <tr><td class="n3">Current draught</td><td class="v3">14.5 m</td></tr>
    <tr><td class="n3">Navigation Status</td><td class="v3">Under way</td></tr>
    <tr><td class="n3">Position received</td><td class="v3">1 min ago</td></tr>
    <tr><td class="n3">IMO / MMSI</td><td class="v3">9811000 / 353136000</td></tr>
    <tr><td class="n3">Callsign</td><td class="v3">H3RC</td></tr>
    <tr><td class="n3">AIS Type</td><td class="v3">Cargo</td></tr>
    <tr><td class="n3">AIS Flag</td><td class="v3">Panama</td></tr>
    <tr><td class="n3">Length / Beam</td><td class="v3">399 / 59 m</td></tr>
  </table>
  <table>
    <tr><td class="n3">IMO number</td><td class="v3">9811000</td></tr>
    <tr><td class="n3">Vessel Name</td><td class="v3">EVER GIVEN</td></tr>
    <tr><td class="n3">Ship Type</td><td class="v3">Container Ship</td></tr>
    <tr><td class="n3">Flag</td><td class="v3">Panama</td></tr>
    <tr><td class="n3">Year of Build</td><td class="v3">2018</td></tr>
    <tr><td class="n3">Length Overall (m)</td><td class="v3">399.00</td></tr>
    <tr><td class="n3">Beam (m)</td><td class="v3">58.80</td></tr>
    <tr><td class="n3">Gross Tonnage</td><td class="v3">220,940</td></tr>
    <tr><td class="n3">Deadweight (t)</td><td class="v3">199,489</td></tr>
  </table>
</body></html>`;

test("HTML tốt -> ok, không fail check nào", () => {
  const r = analyzeHtml(GOOD_HTML);
  assert.equal(r.ok, true);
  assert.deepEqual(r.failedChecks, []);
  assert.deepEqual(r.missingLabels, []);
  assert.equal(r.djsonHasLatLon, true);
});

test("mất #djson -> CRITICAL, ok=false", () => {
  const html = GOOD_HTML.replace(/<div id="djson"[\s\S]*?<\/div>/, "");
  const r = analyzeHtml(html);
  assert.equal(r.ok, false);
  assert.ok(r.failedChecks.some((f) => f.includes("[CRITICAL]") && f.includes("djson")));
});

test("đổi class n3 -> n4 (VF đổi form bảng) -> CRITICAL, ok=false", () => {
  const html = GOOD_HTML.replace(/class="n3"/g, 'class="n4"');
  const r = analyzeHtml(html);
  assert.equal(r.ok, false);
  assert.ok(r.failedChecks.some((f) => f.includes("[CRITICAL]") && f.includes("n3")));
});

test("djson JSON hỏng -> CRITICAL parse fail", () => {
  const html = GOOD_HTML.replace(
    /data-json='[^']*'/,
    `data-json='{broken json,,,'`
  );
  const r = analyzeHtml(html);
  assert.equal(r.ok, false);
  assert.ok(r.failedChecks.some((f) => f.includes("parse")));
});

test("djson thiếu ship_lat/lon -> djsonHasLatLon=false, vẫn ok (không critical)", () => {
  const html = GOOD_HTML.replace(
    /data-json='[^']*'/,
    `data-json='{"mmsi":353136000,"ship_cog":180,"ship_sog":12.5}'`
  );
  const r = analyzeHtml(html);
  assert.equal(r.ok, true); // selector còn -> mapper vẫn chạy
  assert.equal(r.djsonHasLatLon, false);
});

test("mất h1.title -> warn (không critical), ok vẫn true", () => {
  const html = GOOD_HTML.replace(/<h1 class="title">[\s\S]*?<\/h1>/, "<h1>EVER GIVEN</h1>");
  const r = analyzeHtml(html);
  assert.equal(r.ok, true);
  assert.ok(r.failedChecks.some((f) => f.includes("[warn]") && f.includes("h1.title")));
});

test("VF đổi tên label (Callsign -> Call Sign) -> missingLabels bắt được", () => {
  const html = GOOD_HTML.replace("Callsign", "Call Sign");
  const r = analyzeHtml(html);
  assert.equal(r.ok, true); // selector còn nguyên
  assert.ok(r.missingLabels.includes("Callsign"));
});
