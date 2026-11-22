// At fit, fixed frames of small photos can share one 2D backing canvas. Keep the full engine's
// layout and use its renderer as soon as a board needs unsupported paint or the camera zooms in.

const frameKeys = new Set(["id", "type", "name", "x", "y", "width", "height", "fill", "children", "clip", "cornerRadius", "layout", "enabled"]);
const rectKeys = new Set(["id", "type", "name", "x", "y", "width", "height", "fill", "cornerRadius", "enabled"]);
const imageKeys = new Set(["type", "url", "mode"]);
const only = (o, keys) => Object.keys(o).every((k) => keys.has(k));
const size = (n) => Number.isFinite(n.width) && n.width > 0 && Number.isFinite(n.height) && n.height > 0;
const radius = (n) => n.cornerRadius === undefined || (Number.isFinite(n.cornerRadius) && n.cornerRadius >= 0);

export function localJpegPath(url) {
  const match = /^\/asset\?p=([^#]+)$/.exec(url);
  if (!match) return null;
  try {
    const path = decodeURIComponent(match[1]);
    return /\.jpe?g$/i.test(path) ? path : null;
  } catch { return null; }
}

export function imageOverviewBoard(root) {
  if (!root || root.type !== "frame" || !only(root, frameKeys) || !size(root) || !radius(root) ||
      (root.layout && root.layout !== "none") ||
      (root.fill && (typeof root.fill !== "string" || !/^#[0-9a-f]{6}$/i.test(root.fill))) ||
      !root.children?.length) return null;
  const rects = [];
  for (const node of root.children) {
    const fill = Array.isArray(node.fill) ? node.fill.length === 1 && node.fill[0] : node.fill;
    const x = node.x ?? 0, y = node.y ?? 0;
    if (node.type !== "rectangle" || !only(node, rectKeys) || !size(node) || !radius(node) ||
        !Number.isFinite(x) || !Number.isFinite(y) ||
        (!root.clip && (x < 0 || y < 0 || x + node.width > root.width || y + node.height > root.height)) ||
        !fill || !only(fill, imageKeys) || fill.type !== "image" || (fill.mode && fill.mode !== "fill") ||
        !localJpegPath(fill.url)) return null;
    rects.push({ x, y, w: node.width, h: node.height, radius: node.cornerRadius || 0, url: fill.url });
  }
  return { w: root.width, h: root.height, radius: root.cornerRadius || 0, fill: root.fill, clip: root.clip === true, rects };
}

export function createImageOverview() {
  const canvas = document.createElement("canvas"), g = canvas.getContext("2d", { alpha: false });
  canvas.id = "engine";
  canvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;display:block";
  const atlases = [];
  let dead = false;

  async function add(tiles) {
    let cellW = 0, cellH = 0;
    for (const { w, h } of tiles) { cellW = Math.max(cellW, w); cellH = Math.max(cellH, h); }
    const cols = Math.min(32, tiles.length);
    const width = cellW * cols, height = cellH * Math.ceil(tiles.length / cols);
    const atlas = new ImageData(width, height);
    const placed = tiles.map(({ pixels, w, h }, i) => {
      const x = i % cols * cellW, y = Math.floor(i / cols) * cellH;
      for (let row = 0; row < h; row++) {
        atlas.data.set(pixels.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * width + x) * 4);
      }
      return { x, y, w, h };
    });
    const picture = await createImageBitmap(atlas);
    if (dead) { picture.close(); return null; }
    atlases.push(picture);
    return placed.map((rect) => ({ ...rect, surface: picture }));
  }

  function draw(cam, width, height, bg, boards, image) {
    // One backing pixel per CSS pixel is enough for the fit view. The detailed renderer uses display density.
    const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      canvas.style.width = width + "px"; canvas.style.height = height + "px";
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.setTransform(cam.z, 0, 0, cam.z, cam.x, cam.y);
    for (const { x, y, overview: b } of boards) {
      g.save();
      g.beginPath();
      g.roundRect(x, y, b.w, b.h, b.radius);
      if (b.fill) { g.fillStyle = b.fill; g.fill(); }
      if (b.clip) g.clip();
      for (const r of b.rects) {
        const p = image(r.url);
        if (!p) continue;
        const aspect = r.w / r.h, sw = Math.min(p.w, p.h * aspect), sh = Math.min(p.h, p.w / aspect);
        const dx = x + r.x, dy = y + r.y;
        if (r.radius) {
          g.save();
          g.beginPath();
          g.roundRect(dx, dy, r.w, r.h, r.radius);
          g.clip();
        }
        g.drawImage(p.surface, p.x + (p.w - sw) / 2, p.y + (p.h - sh) / 2, sw, sh, dx, dy, r.w, r.h);
        if (r.radius) g.restore();
      }
      g.restore();
    }
  }

  return { canvas, add, draw, destroy() {
    dead = true;
    canvas.remove();
    canvas.width = 0; canvas.height = 0;
    for (const picture of atlases) picture.close();
    atlases.length = 0;
  } };
}
