import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capSize, coverCrop, fitInside, gridRows, sizeForLongSide } from '../src/core/geometry.js';

test('grid rows account for tall cells', () => {
  // 0.5-wide cells: a square image needs half as many rows as columns.
  assert.equal(gridRows(100, 1, 0.5), 50);
  assert.equal(gridRows(160, 16 / 9, 0.6), 54);
  assert.equal(gridRows(1, 100, 0.5), 1);
});

test('cover crop trims the long side and stays centered', () => {
  assert.deepEqual(coverCrop(200, 100, 1), { x: 50, y: 0, w: 100, h: 100 });
  assert.deepEqual(coverCrop(100, 200, 1), { x: 0, y: 50, w: 100, h: 100 });
  assert.deepEqual(coverCrop(160, 90, 16 / 9), { x: 0, y: 0, w: 160, h: 90 });
});

test('fit inside keeps the aspect ratio', () => {
  assert.deepEqual(fitInside(400, 400, 2), { width: 400, height: 200 });
  assert.deepEqual(fitInside(400, 100, 2), { width: 200, height: 100 });
});

test('long side sizing works for both orientations', () => {
  assert.deepEqual(sizeForLongSide(16 / 9, 3840), { width: 3840, height: 2160 });
  assert.deepEqual(sizeForLongSide(9 / 16, 3840), { width: 2160, height: 3840 });
});

test('cap size only ever scales down', () => {
  assert.deepEqual(capSize({ width: 3840, height: 2160 }, 1280), { width: 1280, height: 720 });
  assert.deepEqual(capSize({ width: 800, height: 600 }, 1280), { width: 800, height: 600 });
});
