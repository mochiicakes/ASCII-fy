import { PATTERNS, convert, findPattern, gridToText, luminance, usesDither } from './core/ascii.js';
import { capSize, coverCrop, fitInside, gridRows, sizeForLongSide } from './core/geometry.js';
import { parseHex } from './core/palette.js';
import { cellAspect, drawGrid } from './render.js';
import { disposeSource, loadFile, makeSample } from './source.js';
import { encodeGif, recordVideo, renderPng, saveBlob, videoFormat } from './export.js';

const STORAGE_KEY = 'ascii-fy/settings';

const THEMES = [
  { name: 'Terminal', fg: '#e8e6e1', bg: '#0c0c0c' },
  { name: 'Phosphor', fg: '#4dff7c', bg: '#04140a' },
  { name: 'Amber', fg: '#ffb23f', bg: '#160d02' },
  { name: 'Paper', fg: '#1d1b18', bg: '#efebe1' },
  { name: 'Blueprint', fg: '#dce8ff', bg: '#10305f' },
];

const COLOR_MODES = [
  { id: 'mono', label: 'Single color' },
  { id: 'source', label: 'Original colors' },
];

const FRAMES = [
  { id: 'source', label: 'Original' },
  { id: 'screen', label: 'Screen' },
  { id: '16:9', label: '16:9' },
  { id: '9:16', label: '9:16' },
  { id: '1:1', label: '1:1' },
];

const FORMATS = [
  { id: 'png', label: 'PNG' },
  { id: 'gif', label: 'GIF' },
  { id: 'video', label: 'Video' },
  { id: 'txt', label: 'Text' },
];

const LONG_SIDES = [
  { px: 1920, tag: 'HD' },
  { px: 2560, tag: 'QHD' },
  { px: 3840, tag: '4K' },
  { px: 7680, tag: '8K' },
];
const GIF_MAX = 1280;
const VIDEO_MAX = 3840;

const DEFAULTS = {
  pattern: 'classic',
  ramp: ' .:oO#@',
  text: 'ASCII ',
  columns: window.innerWidth < 760 ? 72 : 120,
  brightness: 0,
  contrast: 1,
  invert: false,
  dither: false,
  color: 'mono',
  fg: THEMES[0].fg,
  bg: THEMES[0].bg,
  frame: 'source',
  format: 'png',
  size: '3840',
  panelHidden: false,
};

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const view = $('view');
const viewCtx = view.getContext('2d');
const sampler = document.createElement('canvas');
const samplerCtx = sampler.getContext('2d', { willReadFrequently: true });

const settings = loadSettings();
const grids = new Map();
let source = null;
let frameIndex = 0;
let playing = true;
let busy = false;
let timer = 0;
let statusTimer = 0;
let renderQueued = false;

// ---------- settings ----------

function loadSettings() {
  const merged = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof saved[key] === typeof DEFAULTS[key]) merged[key] = saved[key];
    }
  } catch {
    // Storage can be blocked or hold junk; defaults are fine.
  }
  return merged;
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Not being able to remember settings shouldn't break anything.
  }
}

function changed() {
  grids.clear();
  saveSettings();
  syncControls();
  requestRender();
}

// ---------- derived values ----------

function screenSize() {
  const dpr = window.devicePixelRatio || 1;
  return { width: Math.round(screen.width * dpr), height: Math.round(screen.height * dpr) };
}

function frameAspect() {
  if (settings.frame === 'screen') {
    const s = screenSize();
    return s.width / s.height;
  }
  if (settings.frame.includes(':')) {
    const [w, h] = settings.frame.split(':').map(Number);
    return w / h;
  }
  return source ? source.width / source.height : 4 / 3;
}

function hexLuminance(hex) {
  return luminance(...parseHex(hex));
}

// On a light background the dense characters should land on dark areas.
function inkInverted() {
  return settings.invert !== hexLuminance(settings.bg) > hexLuminance(settings.fg);
}

function style() {
  return { fg: settings.fg, bg: settings.bg, color: settings.color === 'source' };
}

function gridSize() {
  const cols = settings.columns;
  return { cols, rows: gridRows(cols, frameAspect(), cellAspect()) };
}

function availableFormats() {
  if (!source?.animated) return ['png', 'txt'];
  return videoFormat() ? ['png', 'gif', 'video', 'txt'] : ['png', 'gif', 'txt'];
}

function outputSize() {
  const base = settings.size === 'screen' && settings.frame === 'screen'
    ? screenSize()
    : sizeForLongSide(frameAspect(), Number(settings.size) || 3840);
  if (settings.format === 'gif') return capSize(base, GIF_MAX);
  if (settings.format === 'video') return capSize(base, VIDEO_MAX);
  return base;
}

function gridFor(i) {
  const cached = grids.get(i);
  if (cached) return cached;

  const pattern = findPattern(settings.pattern);
  const aspect = frameAspect();
  const { cols, rows } = gridSize();
  const sx = pattern.braille ? 2 : 1;
  const sy = pattern.braille ? 4 : 1;
  const invert = inkInverted();

  sampler.width = cols * sx;
  sampler.height = rows * sy;
  // Transparent areas count as empty.
  samplerCtx.fillStyle = invert ? '#fff' : '#000';
  samplerCtx.fillRect(0, 0, sampler.width, sampler.height);
  samplerCtx.imageSmoothingEnabled = true;
  samplerCtx.imageSmoothingQuality = 'high';
  const crop = coverCrop(source.width, source.height, aspect);
  samplerCtx.drawImage(source.frames[i].image, crop.x, crop.y, crop.w, crop.h, 0, 0, sampler.width, sampler.height);
  const { data } = samplerCtx.getImageData(0, 0, sampler.width, sampler.height);

  const grid = convert(data, sampler.width, sampler.height, {
    pattern: pattern.id,
    ramp: settings.ramp,
    text: settings.text,
    brightness: settings.brightness,
    contrast: settings.contrast,
    invert,
    dither: settings.dither,
  });
  grids.set(i, grid);
  return grid;
}

// ---------- preview ----------

function isFullscreen() {
  return document.fullscreenElement === stage || document.body.classList.contains('pseudo-full');
}

function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  stage.style.setProperty('--art-bg', settings.bg);
  if (!source) return;

  const full = isFullscreen();
  const pad = full ? 0 : 24;
  const reserve = full ? 0 : 40;
  const box = stage.getBoundingClientRect();
  const fit = fitInside(Math.max(1, box.width - pad * 2), Math.max(1, box.height - pad * 2 - reserve), frameAspect());
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(fit.width * dpr));
  const height = Math.max(1, Math.round(fit.height * dpr));

  view.style.width = `${fit.width}px`;
  view.style.height = `${fit.height}px`;
  view.style.marginBottom = `${reserve}px`;
  if (view.width !== width) view.width = width;
  if (view.height !== height) view.height = height;

  const grid = gridFor(frameIndex);
  drawGrid(viewCtx, grid, width, height, style());

  const frames = source.animated ? ` · frame ${frameIndex + 1}/${source.frames.length}` : '';
  $('info').textContent = `${grid.cols} × ${grid.rows} characters${frames}`;
}

function schedule() {
  clearTimeout(timer);
  if (!source?.animated || !playing || busy) return;
  timer = setTimeout(() => {
    frameIndex = (frameIndex + 1) % source.frames.length;
    render();
    schedule();
  }, source.frames[frameIndex].delay);
}

function togglePlay() {
  if (!source?.animated) return;
  playing = !playing;
  $('playBtn').textContent = playing ? 'Pause' : 'Play';
  schedule();
}

// ---------- controls ----------

function makeButton(label, onClick, className) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (className) b.className = className;
  b.addEventListener('click', onClick);
  return b;
}

function buildSeg(container, items, onPick) {
  container.replaceChildren(
    ...items.map((item) => {
      const b = makeButton(item.label, () => onPick(item.id));
      b.dataset.value = item.id;
      return b;
    }),
  );
}

function syncSeg(container, value) {
  for (const b of container.children) b.setAttribute('aria-pressed', String(b.dataset.value === value));
}

function patternSample(pattern) {
  if (pattern.id === 'custom') return settings.ramp || ' ';
  if (pattern.id === 'text') return settings.text || ' ';
  return pattern.sample ?? pattern.ramp.trimStart();
}

function buildControls() {
  $('patterns').replaceChildren(
    ...PATTERNS.map((pattern) => {
      const b = makeButton('', () => {
        settings.pattern = pattern.id;
        changed();
      }, 'pattern');
      b.dataset.value = pattern.id;
      const name = document.createElement('span');
      name.textContent = pattern.name;
      const sample = document.createElement('span');
      sample.className = 'sample';
      b.append(name, sample);
      return b;
    }),
  );

  buildSeg($('colorMode'), COLOR_MODES, (id) => {
    settings.color = id;
    changed();
  });

  $('themes').replaceChildren(
    ...THEMES.map((theme) => {
      const b = makeButton('A', () => {
        settings.fg = theme.fg;
        settings.bg = theme.bg;
        changed();
      }, 'theme');
      b.title = theme.name;
      b.setAttribute('aria-label', `${theme.name} colors`);
      b.style.background = theme.bg;
      b.style.color = theme.fg;
      b.dataset.fg = theme.fg;
      b.dataset.bg = theme.bg;
      return b;
    }),
  );

  buildSeg($('frame'), FRAMES, (id) => {
    const wasScreen = settings.frame === 'screen';
    settings.frame = id;
    if (id === 'screen') settings.size = 'screen';
    else if (wasScreen && settings.size === 'screen') settings.size = DEFAULTS.size;
    changed();
  });

  buildSeg($('format'), FORMATS, (id) => {
    settings.format = id;
    syncControls();
    saveSettings();
  });

  const bindRange = (id, parse) => {
    $(id).addEventListener('input', (e) => {
      settings[id] = parse(e.target.value);
      changed();
    });
  };
  bindRange('columns', (v) => parseInt(v, 10));
  bindRange('brightness', Number);
  bindRange('contrast', Number);

  for (const id of ['invert', 'dither']) {
    $(id).addEventListener('change', (e) => {
      settings[id] = e.target.checked;
      changed();
    });
  }
  for (const id of ['ramp', 'text', 'fg', 'bg']) {
    $(id).addEventListener('input', (e) => {
      settings[id] = e.target.value;
      changed();
    });
  }
  $('size').addEventListener('change', (e) => {
    settings.size = e.target.value;
    syncControls();
    saveSettings();
  });

  $('resetBtn').addEventListener('click', () => {
    Object.assign(settings, DEFAULTS, { panelHidden: settings.panelHidden });
    changed();
  });
}

function syncControls() {
  syncSeg($('patterns'), settings.pattern);
  for (const b of $('patterns').children) {
    b.querySelector('.sample').textContent = patternSample(findPattern(b.dataset.value));
  }
  $('rampField').hidden = settings.pattern !== 'custom';
  $('textField').hidden = settings.pattern !== 'text';
  if (document.activeElement !== $('ramp')) $('ramp').value = settings.ramp;
  if (document.activeElement !== $('text')) $('text').value = settings.text;

  $('columns').value = settings.columns;
  $('brightness').value = settings.brightness;
  $('contrast').value = settings.contrast;
  const { cols, rows } = gridSize();
  $('columnsOut').textContent = source ? `${cols} × ${rows}` : String(cols);
  $('brightnessOut').textContent = (settings.brightness > 0 ? '+' : '') + settings.brightness.toFixed(2);
  $('contrastOut').textContent = `${settings.contrast.toFixed(2)}×`;
  $('invert').checked = settings.invert;
  $('dither').checked = settings.dither;
  $('dither').disabled = !usesDither(settings.pattern);

  syncSeg($('colorMode'), settings.color);
  $('fgField').hidden = settings.color === 'source';
  $('fg').value = settings.fg;
  $('bg').value = settings.bg;
  for (const b of $('themes').children) {
    b.setAttribute('aria-pressed', String(b.dataset.fg === settings.fg && b.dataset.bg === settings.bg));
  }

  syncSeg($('frame'), settings.frame);

  const formats = availableFormats();
  if (!formats.includes(settings.format)) settings.format = 'png';
  for (const b of $('format').children) b.hidden = !formats.includes(b.dataset.value);
  syncSeg($('format'), settings.format);

  syncSizeOptions();
  $('sizeField').hidden = settings.format === 'txt';
  $('dims').textContent = describeOutput();
}

function syncSizeOptions() {
  const select = $('size');
  const options = [];
  if (settings.frame === 'screen') {
    const s = screenSize();
    options.push({ value: 'screen', label: `Your screen · ${s.width} × ${s.height}` });
  }
  for (const { px, tag } of LONG_SIDES) options.push({ value: String(px), label: `${px} px · ${tag}` });
  if (!options.some((o) => o.value === settings.size)) settings.size = DEFAULTS.size;

  const key = options.map((o) => o.value).join();
  if (select.dataset.key !== key) {
    select.replaceChildren(...options.map((o) => new Option(o.label, o.value)));
    select.dataset.key = key;
  }
  select.value = settings.size;
}

function describeOutput() {
  if (!source) return 'Open a file to download.';
  const { cols, rows } = gridSize();
  if (settings.format === 'txt') return `${cols} × ${rows} characters as plain text.`;
  const { width, height } = outputSize();
  let note = `${width} × ${height} px`;
  if (settings.format === 'gif') note += `, ${source.frames.length} frames. GIFs max out at ${GIF_MAX} px.`;
  else if (settings.format === 'video') note += `. Records in real time; keep this tab open.`;
  else if (source.animated) note += ', current frame.';
  return note;
}

// ---------- files ----------

function showStatus(message) {
  const el = $('status');
  el.textContent = message;
  el.hidden = !message;
  clearTimeout(statusTimer);
  if (message) statusTimer = setTimeout(() => (el.hidden = true), 5000);
}

function showLoading(message) {
  $('loading').textContent = message;
  $('loading').hidden = !message;
}

async function openFile(file) {
  if (!file || busy) return;
  busy = true;
  showLoading('Reading file…');
  try {
    const next = await loadFile(file, (p) => showLoading(`Reading clip… ${Math.round(p * 100)}%`));
    setSource(next);
  } catch (err) {
    console.error(err);
    showStatus(err.message || "Couldn't open that file.");
  } finally {
    busy = false;
    showLoading('');
    schedule();
  }
}

function setSource(next) {
  disposeSource(source);
  source = next;
  frameIndex = 0;
  playing = true;
  grids.clear();

  $('drop').hidden = true;
  view.hidden = false;
  $('stageBar').hidden = false;
  $('playBtn').hidden = !source.animated;
  $('playBtn').textContent = 'Pause';
  $('fullBtn').disabled = false;
  $('downloadBtn').disabled = false;
  $('fileName').textContent = source.name;
  showStatus(source.note);

  syncControls();
  render();
  schedule();
}

function drawDropArt() {
  const sample = makeSample();
  const cols = 44;
  const rows = gridRows(cols, sample.width / sample.height, cellAspect());
  sampler.width = cols;
  sampler.height = rows;
  samplerCtx.drawImage(sample.frames[0].image, 0, 0, cols, rows);
  const grid = convert(samplerCtx.getImageData(0, 0, cols, rows).data, cols, rows, { pattern: 'classic' });
  $('dropArt').textContent = gridToText(grid);
}

// ---------- download ----------

async function download() {
  if (!source || busy) return;
  busy = true;
  clearTimeout(timer);
  const button = $('downloadBtn');
  button.disabled = true;
  // Changing settings mid-export would mix frames from two different looks.
  $('panel').inert = true;
  const progress = (label) => (p) => (button.textContent = `${label} ${Math.round(p * 100)}%`);
  const base = `${source.name}-ascii`;

  try {
    if (settings.format === 'txt') {
      saveBlob(new Blob([gridToText(gridFor(frameIndex))], { type: 'text/plain;charset=utf-8' }), `${base}.txt`);
      return;
    }

    const { width, height } = outputSize();
    if (settings.format === 'png') {
      button.textContent = 'Rendering…';
      await nextFrame();
      saveBlob(await renderPng(gridFor(frameIndex), width, height, style()), `${base}.png`);
      return;
    }

    const job = {
      count: source.frames.length,
      gridAt: gridFor,
      delayAt: (i) => source.frames[i].delay,
      width,
      height,
      style: style(),
    };
    if (settings.format === 'gif') {
      const blob = await encodeGif({ ...job, onProgress: progress('Encoding') });
      saveBlob(blob, `${base}.gif`);
    } else {
      const { blob, ext } = await recordVideo({ ...job, onProgress: progress('Recording') });
      saveBlob(blob, `${base}.${ext}`);
    }
  } catch (err) {
    console.error(err);
    showStatus(`Download failed: ${err.message}`);
  } finally {
    busy = false;
    $('panel').inert = false;
    button.disabled = false;
    button.textContent = 'Download';
    schedule();
  }
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
}

// ---------- view toggles ----------

function setPanelHidden(hidden) {
  settings.panelHidden = hidden;
  document.body.classList.toggle('panel-hidden', hidden);
  $('panelBtn').textContent = hidden ? 'Show settings' : 'Hide settings';
  $('panelBtn').setAttribute('aria-expanded', String(!hidden));
  saveSettings();
  requestRender();
}

function toggleFullscreen() {
  if (!source) return;
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else if (document.body.classList.contains('pseudo-full')) {
    setPseudoFull(false);
  } else if (stage.requestFullscreen) {
    stage.requestFullscreen().catch(() => setPseudoFull(true));
  } else {
    // iPhone Safari has no element fullscreen; cover the viewport instead.
    setPseudoFull(true);
  }
}

function setPseudoFull(on) {
  document.body.classList.toggle('pseudo-full', on);
  requestRender();
}

// ---------- events ----------

function bindEvents() {
  const input = $('fileInput');
  input.addEventListener('change', () => {
    openFile(input.files[0]);
    input.value = '';
  });
  $('openBtn').addEventListener('click', () => input.click());
  $('drop').addEventListener('click', (e) => {
    if (e.target.closest('#sampleBtn')) return;
    input.click();
  });
  $('drop').addEventListener('keydown', (e) => {
    if (e.target === $('drop') && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      input.click();
    }
  });
  $('sampleBtn').addEventListener('click', () => setSource(makeSample()));
  $('fullBtn').addEventListener('click', toggleFullscreen);
  $('panelBtn').addEventListener('click', () => setPanelHidden(!settings.panelHidden));
  $('playBtn').addEventListener('click', togglePlay);
  $('downloadBtn').addEventListener('click', download);
  stage.addEventListener('dblclick', (e) => {
    if (e.target === view || isFullscreen()) toggleFullscreen();
  });

  document.addEventListener('fullscreenchange', requestRender);
  new ResizeObserver(requestRender).observe(stage);

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.matches?.('input[type="text"], select, textarea')) return;
    const key = e.key.toLowerCase();
    if (key === 'h') setPanelHidden(!settings.panelHidden);
    else if (key === 'f') toggleFullscreen();
    else if (key === 'escape' && document.body.classList.contains('pseudo-full')) setPseudoFull(false);
    else if (key === ' ' && source?.animated && !e.target.closest?.('button, [role="button"]')) {
      e.preventDefault();
      togglePlay();
    }
  });

  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    document.body.classList.remove('dragging');
    openFile(e.dataTransfer.files[0]);
  });
  window.addEventListener('paste', (e) => {
    const file = [...(e.clipboardData?.files ?? [])][0];
    if (!file) return;
    e.preventDefault();
    openFile(file);
  });
}

buildControls();
bindEvents();
setPanelHidden(settings.panelHidden);
syncControls();
drawDropArt();
render();
