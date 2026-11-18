// Minimal GIF89a writer: one global 256-color palette, full-size frames, looping.

const HASH_SIZE = 5003;
const MAX_CODE = 4096;

class ByteSink {
  constructor() {
    this.chunks = [];
    this.buf = new Uint8Array(1 << 16);
    this.pos = 0;
  }

  byte(b) {
    if (this.pos === this.buf.length) this.flush();
    this.buf[this.pos++] = b;
  }

  bytes(arr) {
    for (let i = 0; i < arr.length; i++) this.byte(arr[i]);
  }

  u16(v) {
    this.byte(v & 255);
    this.byte((v >> 8) & 255);
  }

  ascii(str) {
    for (let i = 0; i < str.length; i++) this.byte(str.charCodeAt(i));
  }

  flush() {
    if (!this.pos) return;
    this.chunks.push(this.buf.slice(0, this.pos));
    this.pos = 0;
  }

  result() {
    this.flush();
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

// LZW-compresses palette indices and writes them as GIF data sub-blocks.
function writeImageData(sink, indices, minCodeSize) {
  sink.byte(minCodeSize);

  const block = new Uint8Array(255);
  let blockLen = 0;
  const putByte = (b) => {
    block[blockLen++] = b;
    if (blockLen === 255) {
      sink.byte(255);
      sink.bytes(block);
      blockLen = 0;
    }
  };

  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const keys = new Int32Array(HASH_SIZE);
  const codes = new Int32Array(HASH_SIZE);
  let codeSize = 0;
  let nextCode = 0;
  let acc = 0;
  let accBits = 0;

  const emit = (code) => {
    acc |= code << accBits;
    accBits += codeSize;
    while (accBits >= 8) {
      putByte(acc & 255);
      acc >>>= 8;
      accBits -= 8;
    }
  };
  // The decoder widens codes once its table reaches the next power of two.
  // It runs one entry behind us, so compare before adding.
  const widen = () => {
    if (nextCode >= 1 << codeSize && codeSize < 12) codeSize++;
  };
  const reset = () => {
    keys.fill(-1);
    codeSize = minCodeSize + 1;
    nextCode = endCode + 1;
  };

  reset();
  emit(clearCode);

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (k << 12) | prefix;
    let h = (k << 4) ^ prefix;

    if (keys[h] === key) {
      prefix = codes[h];
      continue;
    }
    if (keys[h] >= 0) {
      const step = h === 0 ? 1 : HASH_SIZE - h;
      let found = false;
      do {
        h -= step;
        if (h < 0) h += HASH_SIZE;
        if (keys[h] === key) {
          found = true;
          break;
        }
      } while (keys[h] >= 0);
      if (found) {
        prefix = codes[h];
        continue;
      }
    }

    emit(prefix);
    widen();
    if (nextCode < MAX_CODE) {
      keys[h] = key;
      codes[h] = nextCode++;
    } else {
      emit(clearCode);
      reset();
    }
    prefix = k;
  }

  emit(prefix);
  widen();
  emit(endCode);
  if (accBits > 0) putByte(acc & 255);

  if (blockLen) {
    sink.byte(blockLen);
    sink.bytes(block.subarray(0, blockLen));
  }
  sink.byte(0);
}

export class GifWriter {
  constructor(width, height, palette, { loop = true } = {}) {
    this.width = width;
    this.height = height;
    this.sink = new ByteSink();
    const s = this.sink;

    s.ascii('GIF89a');
    s.u16(width);
    s.u16(height);
    s.byte(0xf7); // global table, 8-bit color resolution, 256 entries
    s.byte(0);
    s.byte(0);
    const table = new Uint8Array(768);
    table.set(palette.subarray(0, 768));
    s.bytes(table);

    if (loop) {
      s.bytes([0x21, 0xff, 0x0b]);
      s.ascii('NETSCAPE2.0');
      s.bytes([0x03, 0x01, 0x00, 0x00, 0x00]);
    }
  }

  addFrame(indices, delayMs) {
    if (indices.length !== this.width * this.height) throw new Error('Frame size does not match the GIF size');
    const s = this.sink;
    const delay = Math.max(2, Math.round(delayMs / 10));

    s.bytes([0x21, 0xf9, 0x04, 0x04]); // graphic control: keep previous frame, no transparency
    s.u16(delay);
    s.bytes([0x00, 0x00]);

    s.byte(0x2c);
    s.u16(0);
    s.u16(0);
    s.u16(this.width);
    s.u16(this.height);
    s.byte(0);

    writeImageData(s, indices, 8);
  }

  finish() {
    this.sink.byte(0x3b);
    return this.sink.result();
  }
}
