// A small YAML subset for qa/features.yaml, so the catalog needs no dependency: block maps and lists by indentation,
// flow lists ([a, b]), plain and quoted scalars, numbers, true/false/null, and # comments. No anchors, no flow maps,
// no multi-line strings. Anything outside the subset throws with the line number.

export type Yaml = null | boolean | number | string | Yaml[] | { [k: string]: Yaml };

type Line = { n: number; indent: number; text: string };

function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function scalar(raw: string, n: number): Yaml {
  const s = raw.trim();
  if (s === "") return null;
  if (s.startsWith("[")) {
    if (!s.endsWith("]")) throw new Error(`line ${n}: unclosed [`);
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    const out: Yaml[] = [];
    let q: string | null = null, start = 0;
    for (let i = 0; i <= inner.length; i++) {
      const c = inner[i];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === "[" || c === "{") throw new Error(`line ${n}: nested flow collections are not supported`);
      else if (c === "," || i === inner.length) { out.push(scalar(inner.slice(start, i), n)); start = i + 1; }
    }
    return out;
  }
  if (s.startsWith("{")) throw new Error(`line ${n}: flow maps are not supported`);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    if (s.length < 2) throw new Error(`line ${n}: bad quote`);
    return s[0] === '"' ? JSON.parse(s) : s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^[&*!|>]/.test(s)) throw new Error(`line ${n}: "${s[0]}" is not supported`);
  return s;
}

/** The key and the rest of a "key: value" line, or null when the line is not a map entry. */
function splitKey(text: string): [string, string] | null {
  const m = /^("[^"]*"|'[^']*'|[^\s"'#\[\]{},:][^:#]*?)\s*:(\s|$)/.exec(text);
  if (!m) return null;
  const k = m[1].startsWith('"') || m[1].startsWith("'") ? String(scalar(m[1], 0)) : m[1].trim();
  return [k, text.slice(m[0].length)];
}

export function parseYaml(src: string): Yaml {
  const lines: Line[] = [];
  src.split("\n").forEach((raw, i) => {
    if (raw.includes("\t")) {
      const lead = /^\s*/.exec(raw)![0];
      if (lead.includes("\t")) throw new Error(`line ${i + 1}: tabs in indentation`);
    }
    const text = stripComment(raw).replace(/\s+$/, "");
    if (!text.trim() || text.trim() === "---") return;
    lines.push({ n: i + 1, indent: /^ */.exec(text)![0].length, text: text.trim() });
  });
  let i = 0;
  const block = (indent: number): Yaml => {
    if (i >= lines.length) return null;
    const first = lines[i];
    if (first.indent !== indent) throw new Error(`line ${first.n}: indentation ${first.indent}, want ${indent}`);
    if (first.text === "-" || first.text.startsWith("- ")) {
      const list: Yaml[] = [];
      while (i < lines.length && lines[i].indent === indent && (lines[i].text === "-" || lines[i].text.startsWith("- "))) {
        const l = lines[i];
        const rest = l.text === "-" ? "" : l.text.slice(2);
        if (!rest.trim()) {
          i++;
          list.push(i < lines.length && lines[i].indent > indent ? block(lines[i].indent) : null);
        } else if (splitKey(rest)) {
          // "- key: v" starts a map whose keys sit at indent + 2.
          const inner = indent + 2 + (/^ */.exec(rest)![0].length);
          lines[i] = { n: l.n, indent: inner, text: rest.trim() };
          list.push(block(inner));
        } else {
          i++;
          list.push(scalar(rest, l.n));
        }
      }
      if (i < lines.length && lines[i].indent > indent) throw new Error(`line ${lines[i].n}: unexpected indentation`);
      return list;
    }
    const map: { [k: string]: Yaml } = {};
    while (i < lines.length && lines[i].indent === indent) {
      const l = lines[i];
      const kv = splitKey(l.text);
      if (!kv) throw new Error(`line ${l.n}: expected "key: value", got "${l.text}"`);
      const [k, v] = kv;
      if (k in map) throw new Error(`line ${l.n}: duplicate key ${k}`);
      i++;
      if (v.trim()) map[k] = scalar(v, l.n);
      else if (i < lines.length && lines[i].indent > indent) map[k] = block(lines[i].indent);
      else if (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ")) map[k] = block(indent); // a list at the key's own indent
      else map[k] = null;
    }
    if (i < lines.length && lines[i].indent > indent) throw new Error(`line ${lines[i].n}: unexpected indentation`);
    return map;
  };
  const out = block(lines.length ? lines[0].indent : 0);
  if (i < lines.length) throw new Error(`line ${lines[i].n}: unexpected outdent`);
  return out;
}
