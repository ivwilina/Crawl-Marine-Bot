// ============================================================================
//  TEST · AisStreamSource.toIsoTimestamp — offline, không mở WebSocket.
// ----------------------------------------------------------------------------
//  Định dạng thời gian của aisstream là thứ dễ phá dữ liệu nhất trong cả luồng
//  AIS: nó KHÔNG phải ISO 8601, mà `receivedAt` thì đang được so sánh như chuỗi
//  ISO ở hai chỗ quan trọng — guard "không ghi đè bản ghi mới hơn" trong
//  repository, và bộ lọc `freshSince` của mọi truy vấn map.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { toIsoTimestamp } from "./AisStreamSource";

const FALLBACK = new Date("2026-08-06T12:00:00.000Z");
const now = () => FALLBACK;

test("converts the provider's Go timestamp to ISO 8601", () => {
  // Đúng định dạng aisstream gửi: nanosecond + offset + hậu tố " UTC".
  assert.equal(
    toIsoTimestamp("2026-08-06 03:38:08.419123456 +0000 UTC", now),
    "2026-08-06T03:38:08.419Z"
  );
});

test("truncates nanoseconds to milliseconds instead of failing", () => {
  assert.equal(toIsoTimestamp("2026-08-06 03:38:08.4 +0000 UTC", now), "2026-08-06T03:38:08.400Z");
  assert.equal(toIsoTimestamp("2026-08-06 03:38:08.41 +0000 UTC", now), "2026-08-06T03:38:08.410Z");
  assert.equal(toIsoTimestamp("2026-08-06 03:38:08 +0000 UTC", now), "2026-08-06T03:38:08.000Z");
});

test("accepts an already-ISO value unchanged in meaning", () => {
  assert.equal(toIsoTimestamp("2026-08-06T03:38:08.419Z", now), "2026-08-06T03:38:08.419Z");
});

test("falls back to now when the value cannot be read", () => {
  // Thà lệch vài giây còn hơn ghi một chuỗi mà guard so sánh sẽ hiểu sai.
  assert.equal(toIsoTimestamp("hôm qua", now), FALLBACK.toISOString());
  assert.equal(toIsoTimestamp(undefined, now), FALLBACK.toISOString());
  assert.equal(toIsoTimestamp(null, now), FALLBACK.toISOString());
  assert.equal(toIsoTimestamp(1234567890, now), FALLBACK.toISOString());
});

test("produces values that sort chronologically as plain strings", () => {
  // Đây chính là tính chất mà guard receivedAt và freshSince dựa vào.
  const earlier = toIsoTimestamp("2026-08-06 03:38:08.100000000 +0000 UTC", now);
  const later = toIsoTimestamp("2026-08-06 03:38:08.200000000 +0000 UTC", now);
  const nextDay = toIsoTimestamp("2026-08-07 00:00:00.000000000 +0000 UTC", now);

  assert.ok(earlier < later);
  assert.ok(later < nextDay);
});
