// ============================================================================
//  TEST · VesselFinderHtmlMapper — offline, không mạng.
//  Fixture mô phỏng trang chi tiết thật: 2 bảng n3/v3 (Voyage Data + Vessel
//  Particulars) với nhãn đã kiểm chứng trên IMO 9384198.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselFinderHtmlMapper } from "./VesselFinderHtmlMapper";

const HTML = `
<html><body>
  <h1 class="title">MANIFA</h1>
  <div id="djson" data-json='{"mmsi":403560000,"imo":9384198,"ship_lat":1,"ship_lon":103,"ship_cog":214,"ship_sog":0,"lrpd":"1 min ago"}'></div>
  <table>
    <tr><td class="n3">Destination</td><td class="v3">FOR ORDERS</td></tr>
    <tr><td class="n3">ETA</td><td class="v3">Aug 10, 02:00 (in 5 days)</td></tr>
    <tr><td class="n3">Predicted ETA</td><td class="v3">-</td></tr>
    <tr><td class="n3">Current draught</td><td class="v3">11.0 m</td></tr>
    <tr><td class="n3">Navigation Status</td><td class="v3">Under way</td></tr>
    <tr><td class="n3">IMO / MMSI</td><td class="v3">9384198 / 403560000</td></tr>
    <tr><td class="n3">Callsign</td><td class="v3">HZGW</td></tr>
    <tr><td class="n3">AIS Type</td><td class="v3">Tanker</td></tr>
    <tr><td class="n3">AIS Flag</td><td class="v3">Saudi Arabia</td></tr>
    <tr><td class="n3">Length / Beam</td><td class="v3">333 / 60 m</td></tr>
  </table>
  <table>
    <tr><td class="n3">Ship Type</td><td class="v3">Crude Oil Tanker</td></tr>
    <tr><td class="n3">Flag</td><td class="v3">Saudi Arabia</td></tr>
    <tr><td class="n3">Year of Build</td><td class="v3">2008</td></tr>
    <tr><td class="n3">Length Overall (m)</td><td class="v3">333.00</td></tr>
    <tr><td class="n3">Beam (m)</td><td class="v3">60.00</td></tr>
    <tr><td class="n3">Gross Tonnage</td><td class="v3">162,252</td></tr>
    <tr><td class="n3">Deadweight (t)</td><td class="v3">319,427</td></tr>
  </table>
</body></html>`;

test("extracts the full free-tier extended profile from both tables", () => {
  const { vessel } = VesselFinderHtmlMapper.toDomain(HTML);

  assert.equal(vessel.imo, "9384198");
  assert.equal(vessel.mmsi, "403560000");
  assert.equal(vessel.name, "MANIFA");
  assert.equal(vessel.callsign, "HZGW");
  // Các field api_v3 đòi cho "extended" mà mapper trước đây bỏ trống.
  assert.equal(vessel.grossTonnage, 162252, "dấu phẩy nghìn phải được bỏ");
  assert.equal(vessel.deadweight, 319427);
  assert.equal(vessel.yearBuilt, 2008);
  assert.equal(vessel.country, "Saudi Arabia");
});

test("prefers the more precise of two labels for the same field", () => {
  const { vessel } = VesselFinderHtmlMapper.toDomain(HTML);

  // "Ship Type" cụ thể hơn "AIS Type" ("Tanker").
  assert.equal(vessel.type, "Crude Oil Tanker");
  // "Length Overall (m)"/"Beam (m)" thập phân, không phải 333/60 làm tròn.
  assert.equal(vessel.lengthM, 333.0);
  assert.equal(vessel.widthM, 60.0);
  assert.equal(vessel.draughtM, 11.0);
});

test("keeps voyage text verbatim and flags the rounded coordinates", () => {
  const { position } = VesselFinderHtmlMapper.toDomain(HTML);

  assert.equal(position.destination, "FOR ORDERS");
  assert.equal(position.eta, "Aug 10, 02:00 (in 5 days)");
  assert.equal(position.navStatusText, "Under way");
  assert.equal(position.positionTime, "1 min ago");
  // #djson cho course/speed CHÍNH XÁC...
  assert.equal(position.courseDeg, 214);
  assert.equal(position.speedKn, 0, "speed 0 là giá trị thật, không phải thiếu");
  // ...nhưng lat/lon bị làm tròn -> phải đánh dấu để không dùng cho bản đồ.
  assert.equal(position.latLonApproximate, true);
});

test('reads "-" as missing rather than as a value', () => {
  const { vessel } = VesselFinderHtmlMapper.toDomain(
    HTML.replace("Crude Oil Tanker", "-").replace("2008", "-")
  );

  // "Ship Type" là "-" -> tụt về "AIS Type".
  assert.equal(vessel.type, "Tanker");
  assert.equal(vessel.yearBuilt, null, "không có số -> null, không phải 0");
});

test("throws when the page carries neither IMO nor MMSI", () => {
  const html = HTML.replace(/<div id="djson"[\s\S]*?<\/div>/, "").replace(
    /<td class="n3">IMO \/ MMSI<\/td><td class="v3">[^<]*<\/td>/,
    ""
  );

  assert.throws(() => VesselFinderHtmlMapper.toDomain(html), /IMO\/MMSI/);
});
