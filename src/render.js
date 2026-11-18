export const FONT_STACK = 'ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

// Cell height as a multiple of the font size.
const LINE_HEIGHT = 1;

let advance = 0;

function glyphAdvance() {
  if (!advance) {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `100px ${FONT_STACK}`;
    advance = ctx.measureText('M').width / 100 || 0.6;
  }
  return advance;
}

// Width / height of one character cell.
export function cellAspect() {
  return glyphAdvance() / LINE_HEIGHT;
}

// Draws the grid stretched to exactly width x height. Each glyph is centered
// in its own cell, so rounding never makes rows drift.
export function drawGrid(ctx, grid, width, height, { fg, bg, color }) {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  const cw = width / grid.cols;
  const ch = height / grid.rows;
  const size = Math.min(ch / LINE_HEIGHT, cw / glyphAdvance());
  ctx.font = `${size}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = fg;

  const { glyphs, index, colors, alpha, cols, rows } = grid;
  let i = 0;
  for (let r = 0; r < rows; r++) {
    const y = (r + 0.5) * ch;
    for (let c = 0; c < cols; c++, i++) {
      const g = glyphs[index[i]];
      if (g === ' ') continue;
      if (color) {
        const p = i * 3;
        ctx.fillStyle = `rgb(${colors[p]},${colors[p + 1]},${colors[p + 2]})`;
      }
      if (alpha) ctx.globalAlpha = Math.max(0.15, Math.min(1, alpha[i]));
      ctx.fillText(g, (c + 0.5) * cw, y);
    }
  }
  ctx.restore();
}
