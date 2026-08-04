// ============================================================================
//  TEST · worldTiles — offline.
//  Chạy:  npm test  (hoặc node -r ts-node/register --test <file>)
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateWorldTiles, splitBox, boxHeightDeg, tilesForBox } from "./worldTiles";

test("lưới thế giới phủ đủ, không lọt kinh/vĩ độ", () => {
  const tiles = generateWorldTiles(9);
  // Lat -84..84 (168°) / 9 -> 19 hàng; Lon -180..180 (360°) / 9 = 40 cột.
  // 19 × 40 = 760 ô: đây là lưới mặc định của scanner, đừng đổi vô tình.
  assert.equal(tiles.length, 760);
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

test("vùng cấu hình được cắt thành lưới phủ kín vùng đó", () => {
  // Bờ Đông Mỹ trong .env.example: 23° × 16°.
  const box = { minLat: 24, minLon: -82, maxLat: 47, maxLon: -66 };
  const tiles = tilesForBox(box, 9);

  // Lưới bám mốc tuyệt đối: lat 18,27,36,45 và lon -90,-81,-72 -> 4 × 3.
  assert.equal(tiles.length, 12);
  // Phủ kín cả vùng (lưới có thể tràn ra ngoài, nhưng không được hụt).
  assert.ok(Math.min(...tiles.map((t) => t.minLat)) <= box.minLat);
  assert.ok(Math.max(...tiles.map((t) => t.maxLat)) >= box.maxLat);
  assert.ok(Math.min(...tiles.map((t) => t.minLon)) <= box.minLon);
  assert.ok(Math.max(...tiles.map((t) => t.maxLon)) >= box.maxLon);
  // Mọi ô cao đúng tileDeg -> subdivision chỉ còn 4 tầng, không phải 5.
  for (const tile of tiles) assert.equal(boxHeightDeg(tile), 9);
});

test("vùng nhỏ hơn 1 ô vẫn ra đúng 1 ô", () => {
  const tiles = tilesForBox({ minLat: 1, minLon: 103, maxLat: 1.6, maxLon: 104.5 }, 9);
  assert.equal(tiles.length, 1);
});

test("lưới vùng không vượt giới hạn ±84° của lưới thế giới", () => {
  for (const tile of tilesForBox({ minLat: 70, minLon: -10, maxLat: 89, maxLon: 10 }, 9)) {
    assert.ok(tile.maxLat <= 84);
    assert.ok(tile.minLat >= -84);
  }
});
