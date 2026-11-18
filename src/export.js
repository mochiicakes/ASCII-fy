import { drawGrid } from './render.js';
import { cubeIndexer, cubePalette, rampIndexer, rampPalette } from './core/palette.js';

// Frames posted to the GIF worker before we wait for it to catch up.
const GIF_IN_FLIGHT = 3;
// Short animations are looped in video exports until they last this long.
const VIDEO_MIN_MS = 3000;
const VIDEO_TYPES = [
  ['video/mp4;codecs=avc1.640033', 'mp4'],
  ['video/mp4', 'mp4'],
  ['video/webm;codecs=vp9', 'webm'],
  ['video/webm;codecs=vp8', 'webm'],
  ['video/webm', 'webm'],
];

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function renderPng(grid, width, height, style) {
  const canvas = makeCanvas(width, height);
  drawGrid(canvas.getContext('2d'), grid, width, height, style);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('That size is too large for this browser. Pick a smaller one.'))), 'image/png');
  });
}

export async function encodeGif({ count, gridAt, delayAt, width, height, style, onProgress }) {
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const palette = style.color ? cubePalette() : rampPalette(style.fg, style.bg);
  const toIndices = style.color ? cubeIndexer() : rampIndexer(style.fg, style.bg);
  const worker = new Worker(new URL('./gif-worker.js', import.meta.url), { type: 'module' });

  let encoded = 0;
  let wake = null;
  let failure = null;
  let finished = null;
  const done = new Promise((resolve, reject) => {
    finished = { resolve, reject };
  });
  // Errors surface through `failure` in the loop below; this only avoids an unhandled rejection.
  done.catch(() => {});
  worker.onmessage = ({ data }) => {
    if (data.type === 'frame') {
      encoded++;
      onProgress?.(encoded / count);
      wake?.();
    } else if (data.type === 'done') {
      finished.resolve(data.bytes);
    }
  };
  worker.onerror = (e) => {
    failure = new Error(e.message || 'The GIF encoder stopped unexpectedly.');
    finished.reject(failure);
    wake?.();
  };

  try {
    worker.postMessage({ type: 'start', width, height, palette });
    for (let i = 0; i < count; i++) {
      while (!failure && i - encoded >= GIF_IN_FLIGHT) await new Promise((r) => (wake = r));
      if (failure) throw failure;
      drawGrid(ctx, gridAt(i), width, height, style);
      const indices = toIndices(ctx.getImageData(0, 0, width, height).data);
      worker.postMessage({ type: 'frame', indices, delay: delayAt(i) }, [indices.buffer]);
    }
    worker.postMessage({ type: 'finish' });
    return new Blob([await done], { type: 'image/gif' });
  } finally {
    worker.terminate();
  }
}

export function videoFormat() {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return null;
  for (const [type, ext] of VIDEO_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return { type, ext };
  }
  return null;
}

// Plays the frames onto a canvas in real time and records it.
export async function recordVideo({ count, gridAt, delayAt, width, height, style, onProgress }) {
  const format = videoFormat();
  if (!format) throw new Error("This browser can't record video. Try GIF instead.");

  // Most encoders reject odd dimensions.
  width -= width % 2;
  height -= height % 2;

  const canvas = makeCanvas(width, height);
  // Some browsers only capture canvases that are in the document.
  canvas.style.cssText = 'position:fixed;left:-200vw;top:0;pointer-events:none';
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  drawGrid(ctx, gridAt(0), width, height, style);

  let stream = canvas.captureStream(0);
  let track = stream.getVideoTracks()[0];
  const manual = typeof track.requestFrame === 'function';
  if (!manual) {
    track.stop();
    stream = canvas.captureStream(30);
    track = stream.getVideoTracks()[0];
  }

  const recorder = new MediaRecorder(stream, {
    mimeType: format.type,
    videoBitsPerSecond: Math.min(40e6, Math.max(8e6, width * height * 8)),
  });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));

  let total = 0;
  for (let i = 0; i < count; i++) total += delayAt(i);
  const loops = Math.min(10, Math.max(1, Math.ceil(VIDEO_MIN_MS / Math.max(1, total))));
  const steps = count * loops;

  recorder.start();
  try {
    for (let step = 0; step < steps; step++) {
      const started = performance.now();
      const i = step % count;
      if (step > 0) drawGrid(ctx, gridAt(i), width, height, style);
      if (manual) track.requestFrame();
      onProgress?.((step + 1) / steps);
      await sleep(Math.max(0, delayAt(i) - (performance.now() - started)));
    }
  } finally {
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    canvas.remove();
  }

  return { blob: new Blob(chunks, { type: format.type.split(';')[0] }), ext: format.ext };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
