// The same world-space box is used for the preview and the stored layer.
export function drawRect(start, end, { square = false, centered = false, click = false, snap = (v) => v } = {}) {
  const x = snap(start.x, "x"), y = snap(start.y, "y");
  if (click) return { x: x - (centered ? 50 : 0), y: y - (centered ? 50 : 0), w: 100, h: 100 };
  let dx = snap(end.x, "x") - x, dy = snap(end.y, "y") - y;
  if (square) {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    dx = end.x < start.x ? -size : size;
    dy = end.y < start.y ? -size : size;
  }
  if (centered) return { x: x - Math.abs(dx), y: y - Math.abs(dy), w: 2 * Math.abs(dx), h: 2 * Math.abs(dy) };
  return { x: x + Math.min(0, dx), y: y + Math.min(0, dy), w: Math.abs(dx), h: Math.abs(dy) };
}
