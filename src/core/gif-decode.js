// GIF decoder that composites every frame into a full RGBA image.
// Delays are returned in hundredths of a second, as stored in the file.

export function decodeGif(bytes, { maxFrames = Infinity, maxBytes = Infinity } = {}) {
  if (bytes.length < 13 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'GIF8') {
    throw new Error('Not a GIF file');
  }

  const u16 = (at) => bytes[at] | (bytes[at + 1] << 8);
  const width = u16(6);
  const height = u16(8);
  if (!width || !height) throw new Error('GIF has no size');

  const frameLimit = Math.max(1, Math.min(maxFrames, Math.floor(maxBytes / (width * height * 4))));
  const flags = bytes[10];
  let pos = 13;
  let globalTable = null;
  if (flags & 0x80) {
    const size = 2 << (flags & 7);
    globalTable = bytes.subarray(pos, pos + size * 3);
    pos += size * 3;
  }

  const canvas = new Uint8ClampedArray(width * height * 4);
  const frames = [];
  let control = null;
  let truncated = false;

  while (pos < bytes.length) {
    const type = bytes[pos++];

    if (type === 0x3b) break;

    if (type === 0x21) {
      const label = bytes[pos++];
      if (label === 0xf9 && bytes[pos] >= 4) {
        const packed = bytes[pos + 1];
        control = {
          disposal: (packed >> 2) & 7,
          delay: u16(pos + 2),
          transparent: packed & 1 ? bytes[pos + 4] : -1,
        };
      }
      pos = skipSubBlocks(bytes, pos);
      continue;
    }

    if (type === 0x2c) {
      if (frames.length >= frameLimit) {
        truncated = true;
        break;
      }

      const fx = u16(pos);
      const fy = u16(pos + 2);
      const fw = u16(pos + 4);
      const fh = u16(pos + 6);
      const packed = bytes[pos + 8];
      pos += 9;

      let table = globalTable;
      if (packed & 0x80) {
        const size = 2 << (packed & 7);
        table = bytes.subarray(pos, pos + size * 3);
        pos += size * 3;
      }

      const minCodeSize = bytes[pos++];
      const { data, end } = readSubBlocks(bytes, pos);
      pos = end;

      const indices = lzwDecode(minCodeSize, data, fw * fh);
      const disposal = control ? control.disposal : 0;
      const saved = disposal === 3 ? canvas.slice() : null;

      blit(canvas, width, height, indices, {
        x: fx,
        y: fy,
        w: fw,
        h: fh,
        table: table || grayTable(),
        transparent: control ? control.transparent : -1,
        interlaced: (packed & 0x40) !== 0,
      });
      frames.push({ pixels: canvas.slice(), delay: control ? control.delay : 0 });

      if (disposal === 2) clearRect(canvas, width, height, fx, fy, fw, fh);
      else if (disposal === 3) canvas.set(saved);
      control = null;
      continue;
    }

    // Unknown block: stop and keep what was decoded.
    break;
  }

  if (!frames.length) throw new Error('GIF contains no frames');
  return { width, height, frames, truncated };
}

export function lzwDecode(minCodeSize, data, pixelCount) {
  const out = new Uint8Array(pixelCount);
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  for (let i = 0; i < clearCode; i++) suffix[i] = i;

  let codeSize = minCodeSize + 1;
  let mask = (1 << codeSize) - 1;
  let next = endCode + 1;
  let old = -1;
  let first = 0;
  let acc = 0;
  let bits = 0;
  let pos = 0;
  let op = 0;

  while (op < pixelCount) {
    while (bits < codeSize && pos < data.length) {
      acc |= data[pos++] << bits;
      bits += 8;
    }
    if (bits < codeSize) break;

    let code = acc & mask;
    acc >>>= codeSize;
    bits -= codeSize;

    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      mask = (1 << codeSize) - 1;
      next = endCode + 1;
      old = -1;
      continue;
    }
    if (code === endCode) break;

    if (old === -1) {
      if (code >= clearCode) break;
      out[op++] = code;
      old = first = code;
      continue;
    }

    const current = code;
    let sp = 0;
    if (code >= next) {
      if (code > next) break; // corrupt stream
      stack[sp++] = first;
      code = old;
    }
    while (code >= clearCode) {
      stack[sp++] = suffix[code];
      code = prefix[code];
    }
    first = code;
    stack[sp++] = code;
    while (sp > 0 && op < pixelCount) out[op++] = stack[--sp];

    if (next < 4096) {
      prefix[next] = old;
      suffix[next] = first;
      next++;
      if (next === 1 << codeSize && codeSize < 12) {
        codeSize++;
        mask = (1 << codeSize) - 1;
      }
    }
    old = current;
  }

  return out;
}

function blit(canvas, width, height, indices, { x, y, w, h, table, transparent, interlaced }) {
  const rows = interlaced ? interlaceOrder(h) : null;
  const colors = table.length / 3;
  let i = 0;
  for (let n = 0; n < h; n++) {
    const row = rows ? rows[n] : n;
    const cy = y + row;
    for (let col = 0; col < w; col++, i++) {
      const idx = indices[i];
      const cx = x + col;
      if (idx === transparent || idx >= colors || cx >= width || cy >= height) continue;
      const p = (cy * width + cx) * 4;
      canvas[p] = table[idx * 3];
      canvas[p + 1] = table[idx * 3 + 1];
      canvas[p + 2] = table[idx * 3 + 2];
      canvas[p + 3] = 255;
    }
  }
}

function interlaceOrder(h) {
  const rows = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let r = start; r < h; r += step) rows.push(r);
  }
  return rows;
}

function clearRect(canvas, width, height, x, y, w, h) {
  for (let cy = y; cy < Math.min(height, y + h); cy++) {
    const start = (cy * width + x) * 4;
    canvas.fill(0, start, start + Math.max(0, Math.min(w, width - x)) * 4);
  }
}

function grayTable() {
  const t = new Uint8Array(768);
  for (let i = 0; i < 256; i++) t[i * 3] = t[i * 3 + 1] = t[i * 3 + 2] = i;
  return t;
}

function skipSubBlocks(bytes, pos) {
  while (pos < bytes.length) {
    const len = bytes[pos++];
    if (len === 0) break;
    pos += len;
  }
  return pos;
}

function readSubBlocks(bytes, pos) {
  let total = 0;
  let p = pos;
  while (p < bytes.length) {
    const len = bytes[p];
    if (len === 0) break;
    total += len;
    p += len + 1;
  }
  const data = new Uint8Array(total);
  let at = 0;
  p = pos;
  while (p < bytes.length) {
    const len = bytes[p++];
    if (len === 0) break;
    data.set(bytes.subarray(p, p + len), at);
    at += len;
    p += len;
  }
  return { data: data.subarray(0, at), end: p };
}
