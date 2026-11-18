// Position keys: the order of a parent's children (and of the cards) in the room's rows. A key is a string of base 62
// digits that sorts by byte value (SQLite's BINARY collation, and JavaScript's < on these characters). A new item gets
// a key between its neighbours. Keys grow when items keep landing in the same gap; a key over MAX_KEY characters makes
// the room renumber that parent's children instead (evenly spaced, short keys), which it meters as row writes.

export const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const MAX_KEY = 64;
const ZERO = DIGITS[0];

function digit(c: string | undefined): number {
  const i = c === undefined ? -1 : DIGITS.indexOf(c);
  if (i < 0) throw new Error(`"${c}" is not a position digit`);
  return i;
}

/** A key strictly between a and b ("" and null are the open ends). Neither may end in the zero digit. */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? digit(a[0]) : 0;
  const db = b !== null ? digit(b[0]) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da] + midpoint(a.slice(1), null);
}

/** Is `k` a well formed key: base 62 digits, at least one, no trailing zero digit? */
export function isKey(k: unknown): k is string {
  return typeof k === "string" && k.length > 0 && !k.endsWith(ZERO) && [...k].every((c) => DIGITS.includes(c));
}

/** A key that sorts after `a` and before `b` (null: no bound). */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && !isKey(a)) throw new Error(`bad position key "${a}"`);
  if (b !== null && !isKey(b)) throw new Error(`bad position key "${b}"`);
  if (a !== null && b !== null && a >= b) throw new Error(`position keys out of order: "${a}" >= "${b}"`);
  return midpoint(a ?? "", b);
}

/** `n` short keys in order, evenly spaced, for renumbering a list. */
export function evenKeys(n: number): string[] {
  let width = 1;
  while (DIGITS.length ** width <= n + 1) width++;
  const span = DIGITS.length ** width;
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    let x = Math.floor((i * span) / (n + 1));
    let s = "";
    for (let j = 0; j < width; j++) {
      s = DIGITS[x % DIGITS.length] + s;
      x = Math.floor(x / DIGITS.length);
    }
    out.push(s.replace(/0+$/, ""));
  }
  return out;
}

/**
 * The key for an item that goes at `index` of `keys` (the list without the item). When the key would be longer than
 * MAX_KEY, `renumber` holds new keys for the whole list with the item in place (length keys.length + 1).
 */
export function keyAt(keys: readonly string[], index: number): { key: string; renumber?: string[] } {
  if (!Number.isInteger(index) || index < 0 || index > keys.length) throw new Error(`position ${index} is outside 0..${keys.length}`);
  const key = keyBetween(keys[index - 1] ?? null, keys[index] ?? null);
  if (key.length <= MAX_KEY) return { key };
  const renumber = evenKeys(keys.length + 1);
  return { key: renumber[index], renumber };
}
