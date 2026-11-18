// Rows needed so a grid of `cols` cells matches `aspect` (width / height).
// `cellAspect` is one cell's width divided by its height.
export function gridRows(cols, aspect, cellAspect) {
  return Math.max(1, Math.round((cols * cellAspect) / aspect));
}

// Centered crop of a width x height source that fills `aspect` exactly.
export function coverCrop(width, height, aspect) {
  if (width / height > aspect) {
    const w = height * aspect;
    return { x: (width - w) / 2, y: 0, w, h: height };
  }
  const h = width / aspect;
  return { x: 0, y: (height - h) / 2, w: width, h };
}

export function fitInside(boxWidth, boxHeight, aspect) {
  if (boxWidth / boxHeight > aspect) return { width: boxHeight * aspect, height: boxHeight };
  return { width: boxWidth, height: boxWidth / aspect };
}

export function sizeForLongSide(aspect, longSide) {
  if (aspect >= 1) return { width: longSide, height: Math.max(1, Math.round(longSide / aspect)) };
  return { width: Math.max(1, Math.round(longSide * aspect)), height: longSide };
}

// Scales a size down so neither side exceeds `limit`.
export function capSize({ width, height }, limit) {
  const scale = Math.min(1, limit / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
