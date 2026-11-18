import { decodeGif } from './core/gif-decode.js';

const CLIP_FPS = 15;
const CLIP_SECONDS = 10;
const CLIP_MAX_SIDE = 720;
const GIF_MAX_FRAMES = 300;
const GIF_MAX_BYTES = 300e6;
const SEEK_TIMEOUT = 10000;

/**
 * Reads a file into { name, width, height, frames: [{ image, delay }], animated, note }.
 * `image` is anything drawImage accepts; `delay` is in milliseconds.
 */
export async function loadFile(file, onProgress) {
  const name = file.name.replace(/\.[^.]+$/, '') || 'ascii';
  const isGif = file.type === 'image/gif' || /\.gif$/i.test(file.name);
  const isVideo = file.type.startsWith('video/') || /\.(mp4|m4v|webm|mov|ogv)$/i.test(file.name);

  if (isGif) {
    try {
      const gif = await loadGif(file);
      if (gif.animated) return { name, ...gif };
    } catch (err) {
      // Odd GIFs still open as a still image through the browser's own decoder.
      console.warn('GIF decode failed, falling back to a still image', err);
    }
  }
  if (isVideo) return { name, ...(await loadVideo(file, onProgress)) };
  return { name, ...(await loadImage(file)) };
}

export function disposeSource(source) {
  for (const frame of source?.frames ?? []) frame.image.close?.();
}

async function loadImage(file) {
  try {
    const image = await createImageBitmap(file);
    return { width: image.width, height: image.height, frames: [{ image, delay: 0 }], animated: false, note: '' };
  } catch {
    // createImageBitmap rejects SVG; an <img> element handles it.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const width = img.naturalWidth || 1024;
      const height = img.naturalHeight || 1024;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      return { width, height, frames: [{ image: canvas, delay: 0 }], animated: false, note: '' };
    } catch {
      throw new Error("This file can't be opened in this browser. Try a PNG, JPG, GIF, WebP, MP4 or WebM.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

async function loadGif(file) {
  const gif = decodeGif(new Uint8Array(await file.arrayBuffer()), { maxFrames: GIF_MAX_FRAMES, maxBytes: GIF_MAX_BYTES });
  const frames = [];
  for (const f of gif.frames) {
    const image = await createImageBitmap(new ImageData(f.pixels, gif.width, gif.height));
    // Browsers play delays under 20 ms at 100 ms; match them.
    frames.push({ image, delay: f.delay < 2 ? 100 : f.delay * 10 });
  }
  return {
    width: gif.width,
    height: gif.height,
    frames,
    animated: frames.length > 1,
    note: gif.truncated ? `Using the first ${frames.length} frames` : '',
  };
}

async function loadVideo(file, onProgress) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  try {
    await waitFor(video, 'loadeddata');
    let duration = video.duration;
    if (!Number.isFinite(duration)) {
      // Recorded WebM files often report Infinity until you seek to the end.
      video.currentTime = 1e7;
      await waitFor(video, 'seeked');
      duration = Number.isFinite(video.duration) ? video.duration : video.currentTime;
    }
    if (!video.videoWidth || !video.videoHeight) throw new Error('This clip has no video track.');

    const length = Math.min(duration, CLIP_SECONDS);
    const count = Math.max(1, Math.floor(length * CLIP_FPS));
    const scale = Math.min(1, CLIP_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    const frames = [];
    for (let i = 0; i < count; i++) {
      // Sample mid-frame so rounding never lands on the previous frame.
      await seek(video, Math.min((i + 0.5) / CLIP_FPS, Math.max(0, duration - 0.001)));
      ctx.drawImage(video, 0, 0, width, height);
      frames.push({ image: await createImageBitmap(canvas), delay: 1000 / CLIP_FPS });
      onProgress?.((i + 1) / count);
    }

    return {
      width,
      height,
      frames,
      animated: frames.length > 1,
      note: duration > CLIP_SECONDS + 0.05 ? `Using the first ${CLIP_SECONDS} seconds` : '',
    };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

function seek(video, time) {
  if (Math.abs(video.currentTime - time) < 1e-4 && video.readyState >= 2) return Promise.resolve();
  const done = waitFor(video, 'seeked');
  video.currentTime = time;
  return done;
}

function waitFor(video, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('The clip took too long to load.')), SEEK_TIMEOUT);
    const onEvent = () => finish();
    const onError = () => finish(new Error("This video format can't be played in this browser. Try MP4 or WebM."));
    function finish(err) {
      clearTimeout(timer);
      video.removeEventListener(event, onEvent);
      video.removeEventListener('error', onError);
      if (err) reject(err);
      else resolve();
    }
    video.addEventListener(event, onEvent);
    video.addEventListener('error', onError);
  });
}

// A lit sphere, so there's something to play with before opening a file.
export function makeSample() {
  const width = 960;
  const height = 720;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');

  g.fillStyle = '#000';
  g.fillRect(0, 0, width, height);

  const ball = g.createRadialGradient(400, 250, 10, 470, 350, 250);
  ball.addColorStop(0, '#f4fdff');
  ball.addColorStop(0.35, '#8fc6d4');
  ball.addColorStop(0.75, '#2a5a68');
  ball.addColorStop(1, '#071418');
  g.fillStyle = ball;
  g.beginPath();
  g.arc(480, 360, 250, 0, Math.PI * 2);
  g.fill();

  return { name: 'sample', width, height, frames: [{ image: canvas, delay: 0 }], animated: false, note: '' };
}
