// A small JSON path: $ .key ["key"] [n] [-1], and [*] where the caller allows it (sparklines).
// Hand-written on purpose: no eval, no library, and keys that reach the prototype are rejected.

export type Seg = { t: "key"; v: string } | { t: "idx"; v: number } | { t: "all" };

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

export function parsePath(src: string, opts: { wildcard?: boolean } = {}): Seg[] {
  if (typeof src !== "string" || src.length > 200) throw new Error("path is too long");
  if (src[0] !== "$") throw new Error('path must start with "$"');
  const out: Seg[] = [];
  let i = 1;
  const key = (k: string) => {
    if (FORBIDDEN.has(k)) throw new Error(`key "${k}" is not allowed`);
    out.push({ t: "key", v: k });
  };
  while (i < src.length) {
    const c = src[i];
    if (c === ".") {
      const m = /^[A-Za-z0-9_$-]+/.exec(src.slice(i + 1));
      if (!m) throw new Error(`expected a key after "." at ${i}`);
      key(m[0]);
      i += 1 + m[0].length;
    } else if (c === "[") {
      const rest = src.slice(i + 1);
      let m: RegExpExecArray | null;
      if ((m = /^(-?\d+)\]/.exec(rest))) {
        out.push({ t: "idx", v: Number(m[1]) });
        i += 1 + m[0].length;
      } else if (rest.startsWith("*]")) {
        if (!opts.wildcard) throw new Error('"[*]" is only allowed in the sparkline path');
        out.push({ t: "all" });
        i += 3;
      } else if ((m = /^(["'])((?:\\.|(?!\1)[^\\])*)\1\]/.exec(rest))) {
        key(m[2].replace(/\\(.)/g, "$1"));
        i += 1 + m[0].length;
      } else throw new Error(`cannot read "[" at ${i}`);
    } else throw new Error(`unexpected "${c}" at ${i}`);
    if (out.length > 20) throw new Error("path is too deep");
  }
  return out;
}

/** The value at the path, or undefined when anything along it is missing. [*] collects an array. */
export function evalPath(data: unknown, segs: Seg[]): unknown {
  let cur: unknown = data;
  for (let n = 0; n < segs.length; n++) {
    const s = segs[n];
    if (s.t === "all") {
      if (!Array.isArray(cur)) return undefined;
      const rest = segs.slice(n + 1);
      return cur.map((item) => evalPath(item, rest)).filter((v) => v !== undefined);
    }
    if (cur === null || typeof cur !== "object") return undefined;
    if (s.t === "idx") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[s.v < 0 ? cur.length + s.v : s.v];
    } else {
      if (Array.isArray(cur) || !Object.hasOwn(cur, s.v)) return undefined;
      cur = (cur as Record<string, unknown>)[s.v];
    }
  }
  return cur;
}

/** Parse and evaluate in one go. */
export function pick(data: unknown, src: string, opts: { wildcard?: boolean } = {}): unknown {
  return evalPath(data, parsePath(src, opts));
}
