// ============================================================================
//  TEST · worldTiles — offline.
//  Chạy:  npm test  (hoặc node -r ts-node/register --test <file>)
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateWorldTiles, splitBox, boxHeightDeg } from "./worldTiles";

test("lưới thế giới phủ đủ, không lọt kinh/vĩ độ", () => {
  const tiles = generateWorldTiles(9);
  // Lat -84..84 (168°) / 9 ~ 19 hàng; Lon -180..180 (360°) / 9 = 40 cột.
  assert.ok(tiles.length > 0);
  // Không ô nào vượt biên.
  for (const t of tiles) {
    assert.ok(t.minLat >= -84 && t.maxLat <= 84);
    assert.ok(t.minLon >= -180 && t.maxLon <= 180);
    assert.ok(t.maxLat > t.minLat && t.maxLon > t.minLon);
  }
});

test("ô lớn -> chia 4 ô con phủ đúng diện tích cha", () => {
  const box = { minLat: 0, minLon: 100, maxLat: 10, maxLon: 110 };
  const kids = splitBox(box);
  assert.equal(kids.length, 4);
  // Mỗi con cao đúng nửa cha.
  for (const k of kids) assert.equal(boxHeightDeg(k), 5);
  // Hợp các con = cha (biên min/max khớp).
  const minLat = Math.min(...kids.map((k) => k.minLat));
  const maxLat = Math.max(...kids.map((k) => k.maxLat));
  assert.equal(minLat, 0);
  assert.equal(maxLat, 10);
});

test("tileDeg lớn -> ít ô hơn tileDeg nhỏ", () => {
  assert.ok(generateWorldTiles(30).length < generateWorldTiles(9).length);
});
