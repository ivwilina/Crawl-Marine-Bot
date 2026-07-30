// ============================================================================
//  TEST · config/loadConfig — offline, không phụ thuộc file .env thật.
//  Chạy:  npm test
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./index";

test("reads configured cache and freshness values", () => {
  const config = loadConfig({
    CACHE_TTL_MS: "120000",
    POSITION_STALE_AFTER_MS: "3600000",
    POSITION_CLEANUP_EVERY_MS: "600000",
  });
  assert.equal(config.cacheTtlMs, 120000);
  assert.equal(config.positionStaleAfterMs, 3600000);
  assert.equal(config.positionCleanupEveryMs, 600000);
});

test("defaults the HTTP host to loopback and leaves the API key empty", () => {
  const config = loadConfig({});
  assert.equal(config.httpHost, "127.0.0.1");
  assert.equal(config.apiKey, "");
  assert.equal(config.positionStaleAfterMs, 24 * 60 * 60 * 1000);
  assert.equal(config.positionCleanupEveryMs, 60 * 60 * 1000);
});

test("reads HTTP host and API key from the environment", () => {
  const config = loadConfig({ HTTP_HOST: "0.0.0.0", API_KEY: "unit-test-key" });
  assert.equal(config.httpHost, "0.0.0.0");
  assert.equal(config.apiKey, "unit-test-key");
});

test("rejects a non-positive cleanup interval", () => {
  assert.throws(() => loadConfig({ POSITION_CLEANUP_EVERY_MS: "0" }), /POSITION_CLEANUP_EVERY_MS/);
});

test("rejects a non-numeric stale window", () => {
  assert.throws(
    () => loadConfig({ POSITION_STALE_AFTER_MS: "soon" }),
    /POSITION_STALE_AFTER_MS/
  );
});

test("rejects an out-of-range HTTP port", () => {
  assert.throws(() => loadConfig({ PORT: "70000" }), /PORT/);
});

test("treats an empty value as absent and uses the fallback", () => {
  const config = loadConfig({ CACHE_TTL_MS: "" });
  assert.equal(config.cacheTtlMs, 60_000);
});
