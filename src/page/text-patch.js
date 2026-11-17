// The text editor's fast path for a typed key (src/page/text-edit.js edit): the field's one text node takes the
// change in place (Text.replaceData) instead of the whole field being built again. On a 400k-character text the
// rebuild made the browser lay the field out from scratch on the next selection set (about 25 ms a key); a change
// in place lets it keep the shaping of the text around the edit.
//
// It covers the plain field only: no styled ranges (one run of letters) and no paragraph mode (one block per
// paragraph). Anything else, or a field that is not what the last render left, returns false and the caller
// renders the field from the model as before.

/**
 * Put `text` in place of the letters [a, b) of the field, whose model held `old` before the edit and `te.value`
 * after it. True when the field now shows te.value; false when the caller must render it.
 */
export function patchField(te, old, a, b, text) {
  if (!te || te.paraMode || te.spans.length || !old || !te.value) return false;
  const f = te.ta;
  const kids = f.childNodes;
  const run = kids[0];
  const end = kids[1];
  // What render() leaves for plain text: a span holding one text node, then a <br data-end> when the text ends
  // in a new line (the caret's last line).
  if (!run || run.nodeName !== "SPAN" || (run.style && run.style.cssText) || !run.childNodes || run.childNodes.length !== 1 || kids.length > 2) return false;
  if (end && !(end.nodeName === "BR" && end.dataset && end.dataset.end === "")) return false;
  const node = run.childNodes[0];
  if (!node || node.nodeType !== 3 || typeof node.replaceData !== "function" || node.length !== old.length || node.data !== old) return false;
  node.replaceData(a, b - a, text);
  const wantEnd = te.value.endsWith("\n");
  if (wantEnd && !end) { const br = document.createElement("br"); br.dataset.end = ""; f.appendChild(br); }
  else if (!wantEnd && end) end.remove();
  return true;
}
