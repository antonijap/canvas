// Screen-space grid lines, in device pixels. Major lines take the place of their minor lines.
export function gridLines(origin, zoom, extent, dpr, spacing, majorEvery) {
  const minor = [], major = [];
  const step = spacing * zoom * dpr;
  const interval = step * majorEvery;
  if (!(interval > 0) || !Number.isFinite(origin) || !Number.isFinite(interval)) return { minor, major };
  const phase = origin % interval;
  const eachLine = (distance, draw) => {
    for (let i = Math.ceil((-phase - 0.5) / distance); i * distance + phase < extent - 0.5; i++) {
      draw(Math.round(phase + i * distance), i);
    }
  };
  if (step >= 6 * dpr && majorEvery > 1) eachLine(step, (at, i) => {
    if (i % majorEvery !== 0) minor.push(at);
  });
  // At extreme zoom-out several majors can land on the same device pixel. Paint each pixel once.
  if (interval < 1) {
    for (let px = 0; px < extent; px++) major.push(px);
  } else eachLine(interval, (at) => major.push(at));
  return { minor, major };
}

export function blueprintColor(background, color) {
  if (color) return color;
  const [r, g, b] = (background.match(/[\d.]+/g) ?? [255, 255, 255]).map(Number);
  return r * 0.2126 + g * 0.7152 + b * 0.0722 > 140 ? "#000000" : "#FFFFFF";
}

export function blueprintLines(grid, cam, width, height, dpr) {
  const x = gridLines(cam.x * dpr, cam.z, width, dpr, grid.spacing, grid.major);
  const y = gridLines(cam.y * dpr, cam.z, height, dpr, grid.spacing, grid.major);
  return [x.minor, y.minor, x.major, y.major];
}

export function createBlueprintView(view, requestFrame) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
  canvas.hidden = true;
  view.insertBefore(canvas, view.querySelector("#world"));
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", requestFrame);
  let lastKey, lastEngine, lastColorKey, color;
  return (grid, cam, engine, w, h) => {
    const dpr = devicePixelRatio || 1;
    const width = Math.round(w * dpr), height = Math.round(h * dpr);
    const colorKey = JSON.stringify([scheme.matches, view.style.backgroundColor, grid?.lineColor]);
    const on = grid && grid.opacity > 0 && width > 0 && height > 0;
    const key = on ? JSON.stringify([grid, cam, width, height, dpr, colorKey]) : "";
    if (key === lastKey && engine === lastEngine) return;
    lastKey = key; lastEngine = engine;
    canvas.hidden = !on || !!engine;
    if (!on) {
      engine?.setBlueprint?.("#000000", new Float32Array());
      return;
    }
    if (colorKey !== lastColorKey) {
      color = blueprintColor(getComputedStyle(view).backgroundColor, grid.lineColor);
      lastColorKey = colorKey;
    }
    const lists = blueprintLines(grid, cam, width, height, dpr);
    const opacity = grid.opacity / 100;
    if (engine) {
      const lines = new Float32Array(lists.reduce((count, list) => count + list.length, 0) * 3);
      let i = 0;
      lists.forEach((positions, group) => {
        for (const at of positions) {
          lines[i++] = group % 2;
          lines[i++] = at;
          lines[i++] = opacity * (group < 2 ? 0.35 : 1);
        }
      });
      engine.setBlueprint(color, lines);
      return;
    }
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = color;
    lists.forEach((positions, group) => {
      ctx.globalAlpha = opacity * (group < 2 ? 0.35 : 1);
      for (const at of positions) {
        if (group % 2 === 0) ctx.fillRect(at, 0, 1, height);
        else ctx.fillRect(0, at, width, 1);
      }
    });
  };
}
