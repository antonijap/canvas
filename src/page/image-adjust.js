// Image fill adjustments (Exposure, Contrast, Saturation, Temperature, Tint), each -1 to 1 in the file
// (`adjust: {exposure, contrast, saturation, temperature, tint}`). All five are linear in sRGB, so they fold into one
// colour matrix: the engine's page applies it to the decoded pixels (engine-view.js, the image URL carries
// `#adjust=` from src/scene.ts), the HTML renderer as an SVG feColorMatrix (src/doc/render/html.ts). Pure.

export const ADJUST_KEYS = ["exposure", "contrast", "saturation", "temperature", "tint"];

/** The five values, clamped, or null when all are 0 (nothing to do). */
export function adjustValues(a) {
  if (!a || typeof a !== "object") return null;
  const v = ADJUST_KEYS.map((k) => { const x = Number(a[k]); return Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0; });
  return v.some((x) => x !== 0) ? v : null;
}

/** The URL fragment that names an adjusted copy of an image ("" for none). Rounded so a drag does not decode 1,000 copies. */
export function adjustFragment(a) {
  const v = adjustValues(a);
  return v ? `#adjust=${v.map((x) => Math.round(x * 100)).join(",")}` : "";
}

/** The five values a URL's fragment names, or null. */
export function adjustFromUrl(url) {
  const m = /#adjust=(-?\d+),(-?\d+),(-?\d+),(-?\d+),(-?\d+)$/.exec(String(url));
  if (!m) return null;
  const v = m.slice(1).map((x) => Math.max(-1, Math.min(1, Number(x) / 100)));
  return v.some((x) => x !== 0) ? v : null;
}

/**
 * A 3 x 4 matrix (rows r, g, b: three weights and an offset, 0..1 sRGB) for [exposure, contrast, saturation,
 * temperature, tint]: exposure scales by 2^e, temperature warms red and cools blue (and the other way round), tint
 * moves green against magenta, saturation mixes with the Rec. 709 luma, contrast spreads around mid grey.
 */
export function adjustMatrix([e, c, s, t, tint]) {
  const g = 2 ** e;
  const gains = [g * (1 + 0.2 * t), g * (1 - 0.2 * tint), g * (1 - 0.2 * t)];
  const sat = 1 + s;
  const L = [0.2126, 0.7152, 0.0722];
  const k = 1 + c;
  const m = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let col = 0; col < 3; col++) row.push(k * ((1 - sat) * L[col] + (r === col ? sat : 0)) * gains[col]);
    row.push(0.5 * (1 - k));
    m.push(row);
  }
  return m;
}

/** Apply the matrix to RGBA bytes (not premultiplied), in place. */
export function adjustPixels(data, m) {
  const [a, b, c] = m;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, bl = data[i + 2] / 255;
    data[i] = 255 * (a[0] * r + a[1] * g + a[2] * bl + a[3]);
    data[i + 1] = 255 * (b[0] * r + b[1] * g + b[2] * bl + b[3]);
    data[i + 2] = 255 * (c[0] * r + c[1] * g + c[2] * bl + c[3]);
  }
  return data;
}

/** feColorMatrix `values` (4 x 5) for the matrix. */
export function svgMatrixValues(m) {
  const f = (x) => String(Math.round(x * 1e5) / 1e5);
  return [...m.map((row) => [row[0], row[1], row[2], 0, row[3]].map(f).join(" ")), "0 0 0 1 0"].join(" ");
}
