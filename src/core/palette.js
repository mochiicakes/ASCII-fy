// 256-color palettes for GIF export, each with an O(1) pixel-to-index mapper.

export function parseHex(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Even steps from background to foreground. Mono renders only ever produce
// blends of these two colors, so this palette reproduces them exactly.
export function rampPalette(fgHex, bgHex) {
  const fg = parseHex(fgHex);
  const bg = parseHex(bgHex);
  const palette = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    for (let k = 0; k < 3; k++) palette[i * 3 + k] = Math.round(bg[k] + ((fg[k] - bg[k]) * i) / 255);
  }
  return palette;
}

export function rampIndexer(fgHex, bgHex) {
  const fg = parseHex(fgHex);
  const bg = parseHex(bgHex);
  const d = [fg[0] - bg[0], fg[1] - bg[1], fg[2] - bg[2]];
  const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  return (rgba) => {
    const out = new Uint8Array(rgba.length / 4);
    if (!len2) return out;
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      const t = ((rgba[p] - bg[0]) * d[0] + (rgba[p + 1] - bg[1]) * d[1] + (rgba[p + 2] - bg[2]) * d[2]) / len2;
      out[i] = t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255);
    }
    return out;
  };
}

// 6 x 7 x 6 color cube (green gets the extra level). Indices 252-255 are unused.
export function cubePalette() {
  const palette = new Uint8Array(768);
  let i = 0;
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 7; g++) {
      for (let b = 0; b < 6; b++, i++) {
        palette[i * 3] = Math.round((r * 255) / 5);
        palette[i * 3 + 1] = Math.round((g * 255) / 6);
        palette[i * 3 + 2] = Math.round((b * 255) / 5);
      }
    }
  }
  return palette;
}

export function cubeIndexer() {
  return (rgba) => {
    const out = new Uint8Array(rgba.length / 4);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      out[i] = Math.round((rgba[p] * 5) / 255) * 42 + Math.round((rgba[p + 1] * 6) / 255) * 6 + Math.round((rgba[p + 2] * 5) / 255);
    }
    return out;
  };
}
