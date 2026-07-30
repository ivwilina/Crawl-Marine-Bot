// ============================================================================
//  TEST · public/render.js — chống XSS khi dựng HTML cho bản đồ.
//  Nạp trực tiếp file browser (một nguồn sự thật) qua require -> test và UI
//  KHÔNG THỂ lệch nhau.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";

interface Rendering {
  escapeHtml(value: unknown): string;
  safeCourse(value: unknown): number | null;
  safeNumber(value: unknown): number | null;
  fmt(value: unknown, unit?: string): string;
  renderVesselRow(p: Record<string, unknown>): string;
  popupHtml(p: Record<string, unknown>): string;
  shipIconSvg(p: Record<string, unknown>): { html: string; size: number[]; anchor: number[] };
  legendHtml(): string;
  classifyType(type: unknown): { color: string; label: string };
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const rendering: Rendering = require(path.join(__dirname, "..", "..", "..", "public", "render.js"));

const { escapeHtml, safeCourse, safeNumber, fmt, renderVesselRow, popupHtml, shipIconSvg } =
  rendering;

const XSS = `<img src=x onerror=alert(1)>`;

test("escapes vessel text before rendering a list row and popup", () => {
  const row = renderVesselRow({ name: XSS });
  assert.match(row, /&lt;img/);
  assert.doesNotMatch(row, /<img/);

  const popup = popupHtml({ name: XSS, destination: XSS, type: XSS, callsign: XSS });
  assert.match(popup, /&lt;img/);
  assert.doesNotMatch(popup, /<img/);
});

test("escapes every dangerous character", () => {
  assert.equal(escapeHtml(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

test("rejects non-numeric course values from SVG styles", () => {
  assert.equal(safeCourse("0);background:url(javascript:alert(1))"), null);
  assert.equal(safeCourse("90"), null);
  assert.equal(safeCourse(NaN), null);
  assert.equal(safeCourse(Infinity), null);
  assert.equal(safeCourse(-1), null);
  assert.equal(safeCourse(361), null);
  assert.equal(safeCourse(0), 0);
  assert.equal(safeCourse(360), 360);
  assert.equal(safeCourse(123.4), 123.4);
});

test("never puts a hostile course into the rotate() style", () => {
  const icon = shipIconSvg({ courseDeg: "0);background:url(javascript:alert(1))" });
  assert.doesNotMatch(icon.html, /javascript:/);
  assert.doesNotMatch(icon.html, /rotate\(/);

  const rotated = shipIconSvg({ courseDeg: 45 });
  assert.match(rotated.html, /transform:rotate\(45deg\)/);
});

test("falls back to heading when course is unusable", () => {
  const icon = shipIconSvg({ courseDeg: null, headingDeg: 270 });
  assert.match(icon.html, /transform:rotate\(270deg\)/);
});

test("fmt escapes values and shows a dash for empty ones", () => {
  assert.equal(fmt(null), "—");
  assert.equal(fmt(""), "—");
  assert.equal(fmt(undefined), "—");
  assert.equal(fmt(12, "kn"), "12 kn");
  assert.equal(fmt(XSS), "&lt;img src=x onerror=alert(1)&gt;");
});

test("safeNumber only accepts finite numbers", () => {
  assert.equal(safeNumber("12"), null);
  assert.equal(safeNumber(12), 12);
  assert.equal(safeNumber(NaN), null);
});

test("classifies an unknown type into the Other category instead of trusting it", () => {
  assert.equal(rendering.classifyType(XSS).label, "Other / chưa xác định");
  assert.equal(rendering.classifyType("Crude Oil Tanker").label, "Tanker");
  assert.equal(rendering.classifyType(null).label, "Other / chưa xác định");
});

test("legend contains only developer-owned static colours", () => {
  const legend = rendering.legendHtml();
  assert.doesNotMatch(legend, /<img|javascript:/);
  assert.match(legend, /Tanker/);
});
