/** A trigger only at a word boundary, before the caret. Email addresses are ordinary text. */
export function mentionQuery(text, caret) {
  const m = /(?:^|\s)@([^@\n]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[1].length - 1, end: caret, query: m[1] } : null;
}
export function mentionPeople(people, query) {
  const q = query.toLocaleLowerCase();
  const seen = new Set();
  return people.filter(p => {
    const key = p.email || p.id || p.name;
    if (!p.name || p.agent || seen.has(key)) return false;
    seen.add(key);
    return p.name.toLocaleLowerCase().includes(q);
  }).slice(0, 8);
}
/** Plain body text remains readable by earlier versions. Ranges identify the picked people. */
export function mentionTokens(body, picked) {
  const out = [];
  for (const p of picked) {
    const text = '@' + p.name;
    let at = -1;
    while ((at = body.indexOf(text, at + 1)) >= 0) {
      if (at && !/\s/.test(body[at - 1])) continue;
      if (body[at + text.length] && /[\p{L}\p{N}_]/u.test(body[at + text.length])) continue;
      if (!out.some(m => at < m.end && at + text.length > m.start)) out.push({ start: at, end: at + text.length, name: p.name, ...(p.email ? { email: p.email } : {}), ...(p.id ? { id: p.id } : {}) });
    }
  }
  return out.sort((a,b) => a.start - b.start);
}
export function mentionedYou(comment, me) {
  return !comment.deletedAt && (comment.mentions || []).some(m => me.email ? m.email === me.email : me.id ? m.id === me.id : m.name === me.name);
}
