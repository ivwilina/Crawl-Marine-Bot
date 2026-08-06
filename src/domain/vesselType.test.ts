// ============================================================================
//  TEST · vesselType — đối chiếu với bảng tra trong sheet "AIS Ship Types".
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { typeGroupFromAisCode, typeGroupFromText, typeGroupOf, movementState } from "./vesselType";

test("maps AIS type codes to the groups the sheet defines", () => {
  // Biên của từng dải, đúng như sheet.
  assert.equal(typeGroupFromAisCode(30), "Fishing");
  assert.equal(typeGroupFromAisCode(37), "Pleasure Craft");
  assert.equal(typeGroupFromAisCode(40), "High speed craft");
  assert.equal(typeGroupFromAisCode(49), "High speed craft");
  assert.equal(typeGroupFromAisCode(52), "Tug");
  assert.equal(typeGroupFromAisCode(60), "Passenger");
  assert.equal(typeGroupFromAisCode(69), "Passenger");
  assert.equal(typeGroupFromAisCode(70), "Cargo");
  assert.equal(typeGroupFromAisCode(79), "Cargo");
  assert.equal(typeGroupFromAisCode(80), "Tanker");
  assert.equal(typeGroupFromAisCode(89), "Tanker");
  assert.equal(typeGroupFromAisCode(90), "Other Type");
  assert.equal(typeGroupFromAisCode(99), "Other Type");
  // Hoa tiêu / SAR / port tender... sheet gom vào "Other".
  assert.equal(typeGroupFromAisCode(50), "Other");
  assert.equal(typeGroupFromAisCode(55), "Other");
  assert.equal(typeGroupFromAisCode(20), "Other");
});

test("treats code 0 and unused codes as unspecified", () => {
  assert.equal(typeGroupFromAisCode(0), "Unspecified Ships");
  assert.equal(typeGroupFromAisCode(5), "Unspecified Ships");
  assert.equal(typeGroupFromAisCode(null), "Unspecified Ships");
  assert.equal(typeGroupFromAisCode(undefined), "Unspecified Ships");
});

test("maps the crawler's specific ship-type text to the same groups", () => {
  assert.equal(typeGroupFromText("Crude Oil Tanker"), "Tanker");
  assert.equal(typeGroupFromText("Chemical/Oil Products Tanker"), "Tanker");
  assert.equal(typeGroupFromText("LNG Tanker"), "Tanker");
  assert.equal(typeGroupFromText("Container Ship"), "Cargo");
  assert.equal(typeGroupFromText("Bulk Carrier"), "Cargo");
  assert.equal(typeGroupFromText("Vehicles Carrier"), "Cargo");
  assert.equal(typeGroupFromText("Tug"), "Tug");
  assert.equal(typeGroupFromText("Pleasure Craft"), "Pleasure Craft");
  assert.equal(typeGroupFromText("Pilot Vessel"), "Other");
  assert.equal(typeGroupFromText("Dredger"), "Other");
});

test("resolves text that matches more than one rule the way the sheet groups it", () => {
  // AIS 60-69 là Passenger, nên Ro-Ro chở khách KHÔNG phải Cargo.
  assert.equal(typeGroupFromText("Passenger/Ro-Ro Cargo Ship"), "Passenger");
  // "Fish Carrier" là Fishing, dù "carrier" là dấu hiệu Cargo.
  assert.equal(typeGroupFromText("Fish Carrier"), "Fishing");
});

test("tells missing type apart from unrecognised type", () => {
  assert.equal(typeGroupFromText(null), "Unspecified Ships");
  assert.equal(typeGroupFromText(""), "Unspecified Ships");
  assert.equal(typeGroupFromText("-"), "Unspecified Ships", 'trang dùng "-" cho ô trống');
  assert.equal(typeGroupFromText("Zzz Unknown Hull"), "Other", "có chữ nhưng không nhận ra");
});

test("reads a numeric string in the text field as an AIS code", () => {
  // Mapper cũ đọc "AIS Type" ra số; bản ghi cũ trong DB vẫn còn dạng đó.
  assert.equal(typeGroupFromText("80"), "Tanker");
  assert.equal(typeGroupFromText("70"), "Cargo");
});

test("prefers the specific text type over the numeric AIS code", () => {
  // Chữ cho loại cụ thể, mã số chỉ cho dải chung -> chữ thắng khi có cả hai.
  assert.equal(typeGroupOf({ type: "Crude Oil Tanker", aisType: 80 }), "Tanker");
  assert.equal(typeGroupOf({ type: "Container Ship", aisType: 70 }), "Cargo");
});

test("falls back to the AIS code for a vessel only AIS has seen", () => {
  // Tàu chỉ có AIS: không có chữ, nhưng mã số vẫn phân nhóm được.
  assert.equal(typeGroupOf({ type: null, aisType: 80 }), "Tanker");
  assert.equal(typeGroupOf({ aisType: 30 }), "Fishing");
  assert.equal(typeGroupOf({ type: "-", aisType: 52 }), "Tug");
});

test("returns unspecified only when neither source says anything", () => {
  assert.equal(typeGroupOf({}), "Unspecified Ships");
  assert.equal(typeGroupOf({ type: null, aisType: null }), "Unspecified Ships");
  // Mã 0 nghĩa là "không có" -> vẫn là chưa xác định.
  assert.equal(typeGroupOf({ aisType: 0 }), "Unspecified Ships");
});

test("uses the AIS code when the text is present but unrecognised", () => {
  // Chữ lạ cho ra "Other", nhưng mã số 80 là thông tin thật hơn -> không dùng
  // được vì "Other" đã là một kết luận. Chốt hành vi để khỏi đổi ngầm.
  assert.equal(typeGroupOf({ type: "Zzz Unknown Hull", aisType: 80 }), "Other");
});

test("derives movement state from the AIS nav status code first", () => {
  assert.equal(movementState({ navStatusCode: 0 }), "Moving");
  assert.equal(movementState({ navStatusCode: 7 }), "Moving");
  assert.equal(movementState({ navStatusCode: 1 }), "Stationary");
  assert.equal(movementState({ navStatusCode: 5 }), "Stationary");
  assert.equal(movementState({ navStatusCode: 15 }), "Stationary");
  // Mã thắng cả speed: đứng yên mà mã báo under way thì vẫn là Moving.
  assert.equal(movementState({ navStatusCode: 0, speedKn: 0 }), "Moving");
});

test("falls back to the crawler's nav status text", () => {
  assert.equal(movementState({ navStatusText: "Under way using engine" }), "Moving");
  assert.equal(movementState({ navStatusText: "Under way" }), "Moving");
  assert.equal(movementState({ navStatusText: "At anchor" }), "Stationary");
  assert.equal(movementState({ navStatusText: "Moored" }), "Stationary");
});

test("falls back to speed for a scan-only record with no nav status", () => {
  // mp2 không mang trạng thái nav -> entity để "Unknown".
  assert.equal(movementState({ navStatusText: "Unknown", speedKn: 11.3 }), "Moving");
  assert.equal(movementState({ navStatusText: "Unknown", speedKn: 0 }), "Stationary");
  assert.equal(movementState({ speedKn: 0.2 }), "Stationary");
  assert.equal(movementState({}), "Unknown", "không có gì để suy -> Unknown, không đoán");
});
