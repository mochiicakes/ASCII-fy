import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GifWriter } from '../src/core/gif-encode.js';
import { decodeGif } from '../src/core/gif-decode.js';

function testPalette() {
  const p = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    p[i * 3] = i;
    p[i * 3 + 1] = 255 - i;
    p[i * 3 + 2] = (i * 7) & 255;
  }
  return p;
}

function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function assertFrameMatches(pixels, indices, palette) {
  for (let i = 0; i < indices.length; i++) {
    const p = i * 4;
    const c = indices[i] * 3;
    if (pixels[p] !== palette[c] || pixels[p + 1] !== palette[c + 1] || pixels[p + 2] !== palette[c + 2] || pixels[p + 3] !== 255) {
      assert.fail(`pixel ${i} differs: got ${pixels.slice(p, p + 4)} for index ${indices[i]}`);
    }
  }
}

const fromBase64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

test('noisy and smooth frames survive an encode/decode round trip', () => {
  const width = 211;
  const height = 157;
  const palette = testPalette();
  const rand = random(42);

  // Pure noise fills the code table quickly and forces many clear codes.
  const noise = new Uint8Array(width * height).map(() => Math.floor(rand() * 256));
  // Long runs exercise long dictionary chains.
  const runs = new Uint8Array(width * height).map((_, i) => Math.floor(i / 97) % 5);
  // Few distinct values grow codes slowly through every code size.
  const sparse = new Uint8Array(width * height).map(() => (rand() < 0.9 ? 0 : 1 + Math.floor(rand() * 3)));

  const writer = new GifWriter(width, height, palette);
  writer.addFrame(noise, 120);
  writer.addFrame(runs, 40);
  writer.addFrame(sparse, 5);
  const gif = decodeGif(writer.finish());

  assert.equal(gif.width, width);
  assert.equal(gif.height, height);
  assert.deepEqual(gif.frames.map((f) => f.delay), [12, 4, 2]);
  assertFrameMatches(gif.frames[0].pixels, noise, palette);
  assertFrameMatches(gif.frames[1].pixels, runs, palette);
  assertFrameMatches(gif.frames[2].pixels, sparse, palette);
});

test('a single-pixel frame round trips', () => {
  const palette = testPalette();
  const writer = new GifWriter(1, 1, palette);
  writer.addFrame(new Uint8Array([200]), 100);
  const gif = decodeGif(writer.finish());
  assertFrameMatches(gif.frames[0].pixels, [200], palette);
});

test('decodes a known opaque 1x1 GIF', () => {
  const gif = decodeGif(fromBase64('R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs='));
  assert.equal(gif.frames.length, 1);
  assert.deepEqual([...gif.frames[0].pixels], [255, 255, 255, 255]);
});

test('decodes a known transparent 1x1 GIF', () => {
  const gif = decodeGif(fromBase64('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'));
  assert.equal(gif.frames.length, 1);
  assert.equal(gif.frames[0].pixels[3], 0);
});

test('decodes interlaced rows into the right order', () => {
  const width = 3;
  const height = 11;
  const palette = testPalette();
  const rows = [0, 8, 4, 2, 6, 10, 1, 3, 5, 7, 9];
  const expected = new Uint8Array(width * height).map((_, i) => Math.floor(i / width) * 10);
  const stored = new Uint8Array(width * height);
  rows.forEach((row, n) => stored.set(expected.subarray(row * width, row * width + width), n * width));

  const writer = new GifWriter(width, height, palette);
  writer.addFrame(stored, 100);
  const out = writer.finish();
  // header 13 + palette 768 + loop extension 19 + graphic control 8
  const descriptor = 13 + 768 + 19 + 8;
  assert.equal(out[descriptor], 0x2c);
  out[descriptor + 9] |= 0x40;

  assertFrameMatches(decodeGif(out).frames[0].pixels, expected, palette);
});

// Two 2x1 frames; the second has a transparent first pixel so whatever the
// first frame left behind shows through.
function layeredGif(firstDisposal) {
  const palette = testPalette();
  const writer = new GifWriter(2, 1, palette);
  writer.addFrame(new Uint8Array([5, 6]), 100);
  writer.addFrame(new Uint8Array([7, 8]), 100);
  const out = writer.finish();

  const first = 13 + 768 + 19;
  assert.equal(out[first + 1], 0xf9);
  out[first + 3] = firstDisposal << 2;

  let second = -1;
  for (let i = first + 8; i < out.length - 2; i++) {
    if (out[i] === 0x21 && out[i + 1] === 0xf9 && out[i + 2] === 0x04) {
      second = i;
      break;
    }
  }
  assert.ok(second > 0);
  out[second + 3] |= 0x01;
  out[second + 6] = 7;
  return { gif: decodeGif(out), palette };
}

test('disposal to background clears the previous frame', () => {
  const { gif, palette } = layeredGif(2);
  assert.equal(gif.frames[1].pixels[3], 0);
  assert.deepEqual([...gif.frames[1].pixels.subarray(4, 7)], [...palette.subarray(24, 27)]);
});

test('keeping the previous frame lets it show through', () => {
  const { gif, palette } = layeredGif(1);
  assert.deepEqual([...gif.frames[1].pixels.subarray(0, 3)], [...palette.subarray(15, 18)]);
  assert.equal(gif.frames[1].pixels[3], 255);
});

test('stops at the frame budget and reports truncation', () => {
  const writer = new GifWriter(4, 4, testPalette());
  for (let i = 0; i < 5; i++) writer.addFrame(new Uint8Array(16).fill(i), 100);
  const gif = decodeGif(writer.finish(), { maxFrames: 3 });
  assert.equal(gif.frames.length, 3);
  assert.equal(gif.truncated, true);
});

test('rejects files that are not GIFs', () => {
  assert.throws(() => decodeGif(new Uint8Array(20)), /Not a GIF/);
});
