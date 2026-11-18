import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cubeIndexer, cubePalette, parseHex, rampIndexer, rampPalette } from '../src/core/palette.js';

test('parses hex colors', () => {
  assert.deepEqual(parseHex('#ff8000'), [255, 128, 0]);
  assert.deepEqual(parseHex('0a0b0c'), [10, 11, 12]);
});

test('ramp palette runs from background to foreground', () => {
  const p = rampPalette('#ffffff', '#000000');
  assert.deepEqual([...p.subarray(0, 3)], [0, 0, 0]);
  assert.deepEqual([...p.subarray(765, 768)], [255, 255, 255]);
});

test('ramp indexer maps blends back to their palette slot', () => {
  const fg = '#f0e0d0';
  const bg = '#102030';
  const palette = rampPalette(fg, bg);
  const toIndex = rampIndexer(fg, bg);
  const px = new Uint8ClampedArray([...palette.subarray(0, 3), 255, ...palette.subarray(100 * 3, 101 * 3), 255, ...palette.subarray(765, 768), 255]);
  assert.deepEqual([...toIndex(px)], [0, 100, 255]);
});

test('ramp indexer handles identical colors', () => {
  const toIndex = rampIndexer('#333333', '#333333');
  assert.deepEqual([...toIndex(new Uint8ClampedArray([51, 51, 51, 255]))], [0]);
});

test('color cube maps primaries to exact entries', () => {
  const palette = cubePalette();
  const toIndex = cubeIndexer();
  const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  const indices = toIndex(px);
  const colors = [...indices].map((i) => [...palette.subarray(i * 3, i * 3 + 3)]);
  assert.deepEqual(colors, [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]]);
  assert.ok(Math.max(...indices) < 252);
});
