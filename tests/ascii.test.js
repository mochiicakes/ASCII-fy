import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert, ditherInPlace, gridToText, luminance, toneLut } from '../src/core/ascii.js';

function solid(width, height, value) {
  const px = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = px[i + 1] = px[i + 2] = value;
    px[i + 3] = 255;
  }
  return px;
}

function setPixel(px, width, x, y, value) {
  const p = (y * width + x) * 4;
  px[p] = px[p + 1] = px[p + 2] = value;
}

const glyph = (grid, i) => grid.glyphs[grid.index[i]];

test('luminance spans 0 to 255', () => {
  assert.equal(luminance(0, 0, 0), 0);
  assert.equal(luminance(255, 255, 255), 255);
  assert.ok(luminance(0, 255, 0) > luminance(255, 0, 0));
});

test('tone curve clamps and inverts', () => {
  const bright = toneLut({ brightness: 1 });
  assert.equal(bright[0], 1);
  const inverted = toneLut({ invert: true });
  assert.equal(inverted[0], 1);
  assert.equal(inverted[255], 0);
  const flat = toneLut({ contrast: 0 });
  assert.equal(flat[0], 0.5);
  assert.equal(flat[255], 0.5);
});

test('black and white land on the ends of the ramp', () => {
  const dark = convert(solid(3, 2, 0), 3, 2, { pattern: 'classic' });
  const light = convert(solid(3, 2, 255), 3, 2, { pattern: 'classic' });
  assert.equal(dark.cols, 3);
  assert.equal(dark.rows, 2);
  assert.equal(glyph(dark, 0), ' ');
  assert.equal(glyph(light, 5), '@');
});

test('invert swaps the ramp ends', () => {
  const grid = convert(solid(1, 1, 0), 1, 1, { pattern: 'classic', invert: true });
  assert.equal(glyph(grid, 0), '@');
});

test('a one-character custom ramp gets a blank for dark areas', () => {
  const dark = convert(solid(1, 1, 0), 1, 1, { pattern: 'custom', ramp: '$' });
  const light = convert(solid(1, 1, 255), 1, 1, { pattern: 'custom', ramp: '$' });
  assert.equal(glyph(dark, 0), ' ');
  assert.equal(glyph(light, 0), '$');
});

test('braille packs 2x4 pixels into one cell', () => {
  const full = convert(solid(2, 4, 255), 2, 4, { pattern: 'braille' });
  assert.equal(full.cols, 1);
  assert.equal(full.rows, 1);
  assert.equal(glyph(full, 0), '⣿');

  const topLeft = solid(2, 4, 0);
  setPixel(topLeft, 2, 0, 0, 255);
  assert.equal(glyph(convert(topLeft, 2, 4, { pattern: 'braille' }), 0), '⠁');

  const bottomRight = solid(2, 4, 0);
  setPixel(bottomRight, 2, 1, 3, 255);
  assert.equal(glyph(convert(bottomRight, 2, 4, { pattern: 'braille' }), 0), '⢀');

  assert.equal(glyph(convert(solid(2, 4, 0), 2, 4, { pattern: 'braille' }), 0), ' ');
});

test('braille shades mid-tones with a mix of dots', () => {
  const grid = convert(solid(8, 8, 128), 8, 8, { pattern: 'braille' });
  const dots = [...grid.index].reduce((n, bits) => n + bits.toString(2).split('1').length - 1, 0);
  assert.ok(dots > 16 && dots < 48, `expected roughly half the 64 dots, got ${dots}`);
});

test('text pattern repeats the text and blanks dark cells', () => {
  const light = convert(solid(5, 1, 255), 5, 1, { pattern: 'text', text: 'ab' });
  assert.equal(gridToText(light), 'ababa');
  assert.ok(light.alpha);
  const dark = convert(solid(5, 1, 0), 5, 1, { pattern: 'text', text: 'ab' });
  assert.equal(gridToText(dark), '');
});

test('dithering leaves only quantized levels', () => {
  const values = new Float32Array(64).map((_, i) => i / 63);
  ditherInPlace(values, 8, 8, 4);
  for (const v of values) assert.ok([0, 1 / 3, 2 / 3, 1].some((q) => Math.abs(v - q) < 1e-6), `unexpected ${v}`);
});

test('a dithered mid-gray mixes both ends of a two-step ramp', () => {
  const grid = convert(solid(10, 10, 128), 10, 10, { pattern: 'custom', ramp: ' #', dither: true });
  const text = gridToText(grid);
  assert.ok(text.includes('#'));
  assert.ok(text.includes(' '));
});

test('cell colors follow the source pixels', () => {
  const px = solid(2, 1, 0);
  px[4] = 200;
  px[5] = 10;
  px[6] = 30;
  const grid = convert(px, 2, 1, { pattern: 'classic' });
  assert.deepEqual([...grid.colors], [0, 0, 0, 200, 10, 30]);
});

test('gridToText joins rows and trims trailing blanks', () => {
  const px = solid(3, 2, 0);
  setPixel(px, 3, 0, 1, 255);
  assert.equal(gridToText(convert(px, 3, 2, { pattern: 'classic' })), '\n@');
});
