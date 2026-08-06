// ============================================================================
//  TEST · VesselFinderHtmlMapper — chạy trên HTML THẬT, offline.
// ----------------------------------------------------------------------------
//  Fixture trong ./fixtures là trang tải nguyên từ vesselfinder.com, KHÔNG phải
//  HTML tự viết. Đây là điểm quan trọng: bản test trước đây dùng fixture tự bịa
//  theo cách hiểu sai về cấu trúc (tưởng bảng "Vessel Particulars" cũng dùng
//  class n3/v3), nên nó xanh trong khi mapper đọc trang thật ra toàn null.
//
//  Hai trang được chọn có tính chất khác nhau:
//    • 9384198 (MANIFA)      — dữ liệu đầy đủ, có cả tonnage và voyage
//    • 9811983 (BBC UKRAINE) — vị trí cũ nhiều ngày, Navigation Status là "-",
//                              Course / Speed rỗng trong HTML (JS mới điền)
//  Khi VesselFinder đổi form, cách phát hiện là tải lại fixture rồi chạy test
//  này — `npm run check-drift` là bản kiểm nhanh trên mạng cho cùng mục đích.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { VesselFinderHtmlMapper } from "./VesselFinderHtmlMapper";

function fixture(imo: string): string {
  return fs.readFileSync(path.join(__dirname, "fixtures", `vesselfinder-${imo}.html`), "utf-8");
}

const MANIFA = fixture("9384198");
const BBC_UKRAINE = fixture("9811983");

/* ---- Bảng "Vessel Particulars" (td.tpc1/td.tpc2) -------------------------- */

test("reads the particulars table, which is tpc1/tpc2 and not n3/v3", () => {
  const { vessel } = VesselFinderHtmlMapper.toDomain(MANIFA);

  // Bốn field này chỉ tồn tại trong bảng particulars. Mapper đọc sai class thì
  // chúng null hết — đó chính là bug bản trước.
  assert.equal(vessel.grossTonnage, 162252, "dấu phẩy nghìn phải được bỏ");
  assert.equal(vessel.deadweight, 319427);
  assert.equal(vessel.yearBuilt, 2008);
  assert.equal(vessel.type, "Crude Oil Tanker", '"Ship Type" cụ thể hơn "AIS Type"');
});

test("prefers the decimal dimensions from the particulars table", () => {
  const { vessel } = VesselFinderHtmlMapper.toDomain(MANIFA);

  // "Length Overall (m)" = 333.00 thay vì "Length / Beam" = 333 / 60.
  assert.equal(vessel.lengthM, 333);
  assert.equal(vessel.widthM, 60);
});

/* ---- Khối voyage (div.vilabel, không phải bảng) --------------------------- */

test("reads Destination and ETA, which live in divs rather than a table", () => {
  const { position } = VesselFinderHtmlMapper.toDomain(MANIFA);

  assert.equal(position.destination, "FOR ORDERS");
  assert.equal(position.eta, "Aug 10, 02:00");
});

test("reads Last Port and its ATD from the same kind of block", () => {
  const { position } = VesselFinderHtmlMapper.toDomain(MANIFA);

  assert.equal(position.lastPort, "Singapore Anch. 4, Singapore");
  assert.equal(position.lastPortDepartureUtc, "Aug 3, 22:23 UTC");
});

test("reads a destination that is a port link rather than free text", () => {
  // MANIFA có "FOR ORDERS" là chữ tự do; BBC UKRAINE có <a> trỏ tới trang cảng.
  const { position } = VesselFinderHtmlMapper.toDomain(BBC_UKRAINE);

  assert.equal(position.destination, "Luanda, Angola");
  assert.equal(position.eta, "Aug 7, 10:00");
  assert.equal(position.lastPort, "Las Palmas, Spain");
  assert.equal(position.lastPortDepartureUtc, "Jul 24, 04:13 UTC");
});

test("drops the relative time that sits next to the timestamp", () => {
  const { position } = VesselFinderHtmlMapper.toDomain(MANIFA);

  // Trang hiển thị "ETA: Aug 10, 02:00 (in 4 days)". Phần trong ngoặc đổi mỗi
  // ngày, giữ nó lại thì mỗi request thấy dữ liệu "khác" dù không có gì đổi.
  assert.ok(!position.eta?.includes("day"), position.eta ?? "");
  assert.ok(!position.lastPortDepartureUtc?.includes("ago"), position.lastPortDepartureUtc ?? "");
});

test("does not swallow text from the section after the voyage block", () => {
  // Khối "Last Port" không có nhãn vilabel nào phía sau, nên nếu không chặn ở
  // </section> thì nó ngoạm cả tiêu đề "Ship positions" của section kế.
  for (const html of [MANIFA, BBC_UKRAINE]) {
    const { position } = VesselFinderHtmlMapper.toDomain(html);
    assert.ok(!position.lastPort?.includes("Ship"), position.lastPort ?? "");
    assert.ok(!position.lastPortDepartureUtc?.includes("Ship"), position.lastPortDepartureUtc ?? "");
  }
});

/* ---- Bảng AIS/voyage (td.n3/td.v3) --------------------------------------- */

test("reads identity, callsign and flag from the AIS table", () => {
  const { vessel } = VesselFinderHtmlMapper.toDomain(MANIFA);

  assert.equal(vessel.imo, "9384198");
  assert.equal(vessel.mmsi, "403560000");
  assert.equal(vessel.name, "MANIFA");
  assert.equal(vessel.callsign, "HZGW");
  assert.equal(vessel.country, "Saudi Arabia");
  assert.equal(vessel.draughtM, 11);
});

test("takes course and speed from #djson, not from the empty table cell", () => {
  // Ô "Course / Speed" trong HTML là &nbsp; — JS mới điền. #djson thì có sẵn.
  const { position } = VesselFinderHtmlMapper.toDomain(BBC_UKRAINE);

  assert.equal(typeof position.courseDeg, "number");
  assert.equal(typeof position.speedKn, "number");
});

test("flags the rounded coordinates that the free page serves", () => {
  const { position } = VesselFinderHtmlMapper.toDomain(MANIFA);

  // Toạ độ bị làm tròn về số nguyên (~111km) -> không được dùng cho bản đồ.
  assert.equal(position.latLonApproximate, true);
  assert.equal(position.lat, Math.trunc(position.lat as number));
  assert.equal(position.lon, Math.trunc(position.lon as number));
});

test('reports a "-" navigation status as unknown rather than as data', () => {
  // BBC UKRAINE: vị trí nhiều ngày trước, ô Navigation Status là "-".
  const { position } = VesselFinderHtmlMapper.toDomain(BBC_UKRAINE);
  assert.equal(position.navStatusText, "Unknown");

  const { position: fresh } = VesselFinderHtmlMapper.toDomain(MANIFA);
  assert.equal(fresh.navStatusText, "Under way");
});

/* ---- Trang không phải tàu ------------------------------------------------- */

test("throws when the page carries neither IMO nor MMSI", () => {
  assert.throws(
    () => VesselFinderHtmlMapper.toDomain("<html><body>Not a vessel page</body></html>"),
    /IMO\/MMSI/
  );
});
