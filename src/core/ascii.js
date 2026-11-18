// Ramps run from empty (index 0) to full ink.
export const PATTERNS = [
  { id: 'classic', name: 'Classic', ramp: ' .:-=+*#%@' },
  { id: 'dense', name: 'Dense', ramp: " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$" },
  { id: 'blocks', name: 'Blocks', ramp: ' ░▒▓█' },
  { id: 'braille', name: 'Dots', braille: true, sample: '⠁⠃⠇⡇⣇⣧⣷⣿' },
  { id: 'round', name: 'Round', ramp: ' .·oO@' },
  { id: 'binary', name: 'Binary', ramp: ' 10' },
  { id: 'custom', name: 'Custom' },
  { id: 'text', name: 'Text' },
];

// Below this level a cell stays blank in the text pattern.
const TEXT_CUTOFF = 0.08;

// Braille dot bits for a 2x4 cell, row by row.
const BRAILLE_BITS = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80];
const BRAILLE_GLYPHS = Array.from({ length: 256 }, (_, i) => (i === 0 ? ' ' : String.fromCharCode(0x2800 + i)));

export function findPattern(id) {
  return PATTERNS.find((p) => p.id === id) ?? PATTERNS[0];
}

// Rec. 709 weights scaled to 256.
export function luminance(r, g, b) {
  return (r * 54 + g * 183 + b * 19) >> 8;
}

export function toneLut({ brightness = 0, contrast = 1, invert = false } = {}) {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = clamp01((i / 255 - 0.5) * contrast + 0.5 + brightness);
    lut[i] = invert ? 1 - v : v;
  }
  return lut;
}

// Floyd-Steinberg, quantizing values in 0..1 to `steps` evenly spaced levels.
export function ditherInPlace(values, width, height, steps) {
  const q = Math.max(1, steps - 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = values[i];
      const next = Math.round(clamp01(old) * q) / q;
      const err = old - next;
      values[i] = next;
      if (x + 1 < width) values[i + 1] += (err * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) values[i + width - 1] += (err * 3) / 16;
        values[i + width] += (err * 5) / 16;
        if (x + 1 < width) values[i + width + 1] += err / 16;
      }
    }
  }
}

/**
 * Converts RGBA pixels into a character grid.
 * For most patterns each pixel is one cell. Braille reads 2x4 pixels per cell,
 * so pass a buffer twice as wide and four times as tall as the grid.
 *
 * Returns { cols, rows, glyphs, index, colors, alpha } where index[i] points
 * into glyphs, colors holds RGB per cell and alpha is per-cell opacity or null.
 */
export function usesDither(patternId) {
  return patternId !== 'text' && patternId !== 'braille';
}

export function convert(rgba, width, height, options = {}) {
  const pattern = findPattern(options.pattern);
  const lut = toneLut(options);
  const count = width * height;
  const levels = new Float32Array(count);
  for (let i = 0, p = 0; i < count; i++, p += 4) {
    levels[i] = lut[luminance(rgba[p], rgba[p + 1], rgba[p + 2])];
  }

  if (pattern.braille) return brailleGrid(rgba, levels, width, height, options);

  const textMode = pattern.id === 'text';
  const glyphs = textMode ? [' ', ...textChars(options.text)] : rampChars(pattern, options.ramp);
  if (options.dither && usesDither(pattern.id)) ditherInPlace(levels, width, height, glyphs.length);

  const index = new Uint16Array(count);
  const top = glyphs.length - 1;
  for (let i = 0; i < count; i++) {
    if (textMode) index[i] = levels[i] < TEXT_CUTOFF ? 0 : 1 + (i % top);
    else index[i] = Math.min(top, Math.max(0, Math.round(levels[i] * top)));
  }

  return {
    cols: width,
    rows: height,
    glyphs,
    index,
    colors: cellColors(rgba, width, height, 1, 1, options),
    alpha: textMode ? levels : null,
  };
}

function brailleGrid(rgba, levels, width, height, options) {
  const cols = Math.floor(width / 2);
  const rows = Math.floor(height / 4);
  // Dots are either on or off, so without dithering every tone collapses to a silhouette.
  ditherInPlace(levels, width, height, 2);

  const index = new Uint16Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let bits = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          if (levels[(r * 4 + dy) * width + c * 2 + dx] >= 0.5) bits |= BRAILLE_BITS[dy * 2 + dx];
        }
      }
      index[r * cols + c] = bits;
    }
  }

  return {
    cols,
    rows,
    glyphs: BRAILLE_GLYPHS,
    index,
    colors: cellColors(rgba, width, height, 2, 4, options),
    alpha: null,
  };
}

// Average color of each cell, with brightness and contrast applied per channel.
function cellColors(rgba, width, height, cellW, cellH, { brightness = 0, contrast = 1 } = {}) {
  const cols = Math.floor(width / cellW);
  const rows = Math.floor(height / cellH);
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(clamp01((i / 255 - 0.5) * contrast + 0.5 + brightness) * 255);

  const colors = new Uint8ClampedArray(cols * rows * 3);
  const area = cellW * cellH;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sr = 0, sg = 0, sb = 0;
      for (let dy = 0; dy < cellH; dy++) {
        let p = ((r * cellH + dy) * width + c * cellW) * 4;
        for (let dx = 0; dx < cellW; dx++, p += 4) {
          sr += rgba[p];
          sg += rgba[p + 1];
          sb += rgba[p + 2];
        }
      }
      const o = (r * cols + c) * 3;
      colors[o] = lut[Math.round(sr / area)];
      colors[o + 1] = lut[Math.round(sg / area)];
      colors[o + 2] = lut[Math.round(sb / area)];
    }
  }
  return colors;
}

function rampChars(pattern, custom) {
  const chars = Array.from(pattern.id === 'custom' ? custom || '' : pattern.ramp);
  if (chars.length === 0) return [' ', '#'];
  if (chars.length === 1) return chars[0] === ' ' ? [' ', '#'] : [' ', chars[0]];
  return chars;
}

function textChars(text) {
  const chars = Array.from((text || '').replace(/\s+/g, ' '));
  return chars.length ? chars : ['#'];
}

export function gridToText(grid) {
  const lines = [];
  for (let r = 0; r < grid.rows; r++) {
    let line = '';
    for (let c = 0; c < grid.cols; c++) line += grid.glyphs[grid.index[r * grid.cols + c]];
    lines.push(line.trimEnd());
  }
  return lines.join('\n');
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
