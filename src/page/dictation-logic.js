// Dictation into a comment field, the pure half: one session at a time over a recognizer that the host provides
// (src/page/comments.js sends it to the app's Dictation.swift; node tests pass a fake). No DOM and no globals.
//
// recognizer: { start(id), stop(id), cancel(id) }. It answers with event({ id, event, ... }):
//   "listening"                     the microphone is on
//   "text"    { text }              everything recognized so far in this session
//   "end"                           the session is over
//   "denied"  { which, system }     "speech" or "microphone" is not allowed; system: macOS Dictation took over
//   "system"                        no recognizer here: macOS Dictation took over
//   "error"   { message }
// field: { read(): { value, start, end }, write(value, caret), key }.

/** How long (ms) Fn is held before it starts dictating, so a tap or Fn with another key does nothing. */
export const FN_HOLD_MS = 250;

/** The recognized text put where the selection was, spaced from the words around it, and where the caret goes. */
export function insertDictation(before, text, after) {
  const t = String(text || "").trim();
  if (!t) return { value: before + after, caret: before.length };
  const lead = before && !/\s$/.test(before) ? " " : "";
  const tail = after && !/^[\s.,;:!?)]/.test(after) ? " " : "";
  const head = before + lead + t;
  return { value: head + tail + after, caret: head.length };
}

/** The words under a field after a session that could not use the app's recognizer. which: the Settings pane to link. */
export function noticeFor(e) {
  if (e.event === "denied" && e.which === "microphone") return { text: "Microphone access is off for Canvas.", which: "microphone" };
  if (e.event === "denied") return { text: "Speech Recognition is off for Canvas." + (e.system ? " Using macOS Dictation." : ""), which: "speech" };
  if (e.event === "system") return { text: "Using macOS Dictation.", which: null };
  return { text: e.message || "Dictation stopped. Try again.", which: null };
}

export function createDictation(recognizer, { onChange = () => {}, newId = () => crypto.randomUUID() } = {}) {
  let run = null; // { id, field, before, after, phase: "starting" | "listening" | "stopping" }
  let notice = null; // { field, text, which }
  const changed = () => onChange();
  const idle = () => { run = null; changed(); };
  function cancel() {
    if (!run) return;
    recognizer.cancel(run.id);
    idle();
  }
  function start(field) {
    cancel();
    const { value, start: from, end } = field.read();
    notice = null;
    run = { id: newId(), field, before: value.slice(0, from), after: value.slice(end), phase: "starting" };
    changed();
    recognizer.start(run.id);
  }
  /** Stop listening and keep what is on the way: the last words, then "end". */
  function stop() {
    if (!run || run.phase === "stopping") return;
    if (run.phase === "starting") { cancel(); return; }
    run.phase = "stopping";
    recognizer.stop(run.id);
    changed();
  }
  return {
    start, stop, cancel,
    toggle(field) { if (run && run.field.key === field.key) stop(); else start(field); },
    /** "idle", "starting", "listening" or "stopping" for one field. */
    phase: (key) => (run && run.field.key === key ? run.phase : "idle"),
    notice: (key) => (notice && notice.field.key === key ? notice : null),
    get active() { return run ? run.field.key : null; },
    event(e) {
      if (!run || !e || e.id !== run.id) return;
      if (e.event === "listening") { if (run.phase === "starting") { run.phase = "listening"; changed(); } return; }
      if (e.event === "text") {
        const next = insertDictation(run.before, e.text, run.after);
        run.field.write(next.value, next.caret);
        return;
      }
      if (e.event === "end") { idle(); return; }
      if (e.event === "denied" || e.event === "system" || e.event === "error") {
        notice = { field: run.field, ...noticeFor(e) };
        idle();
      }
    },
  };
}
