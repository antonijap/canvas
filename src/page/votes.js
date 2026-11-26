import { colorOf } from "./comments-logic.js";
import { button, el, icon, rememberWhiteboardSetting, whiteboardSetting } from "./whiteboard.js";
import { timerDial } from "./timer-dial.js";
import { STICKY_COLORS, WHITEBOARD_PAINT } from "./whiteboard-model.js";

const NIL_DOC = "00000000-0000-4000-8000-000000000000";
const VOTE_ICON = icon("M4 21h16M6 21V7h12v14m-9-8 2 2 4-4");
const HIDE_ICON = icon("m3 3 18 18M10 10a3 3 0 0 0 4 4m-2-5a3 3 0 0 1 3 3M10.6 5.1c.5-.1.9-.1 1.4-.1 5 0 8.3 4.7 10 7a16 16 0 0 1-3.2 3.5M6.2 6.2A21 21 0 0 0 2 12c1.7 2.3 5 7 10 7a9 9 0 0 0 4.2-1.2");
const ANONYMOUS_ICON = icon("M3 21v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1zM12 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm4-1a2.5 2.5 0 1 1 4 2c-1 .6-1.5 1-1.5 2m0 3h.01");
const PAUSE_ICON = icon("M9 5v14m6-14v14");
const RESUME_ICON = icon("M8 5l11 7-11 7Z");
const COMPLETE_ICON = icon("M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM8 12l3 3 5-6");
const DURATIONS = [["0", "Off"], ["180000", "3m"], ["300000", "5m"], ["600000", "10m"]];
const TIMER_SETTING = "timer-duration";
const MUTE_KEY = "canvas.timer.muted";
const field = "input,textarea,select,[contenteditable]";
const canvasChrome = "button,a,#labels,#rulerTop,#rulerLeft,#rulerCorner,[data-whiteboard-ui]," + field;

function control(label, action, key, primary = false) {
  const b = button(label, "vote-button" + (primary ? " vote-primary" : ""), action);
  b.textContent = label;
  if (key) b.dataset[key] = "";
  return b;
}

function panel(cls, label) {
  const body = el("section", "whiteboard-panel " + cls);
  body.dataset.whiteboardUi = "";
  body.setAttribute("aria-label", label);
  body.hidden = true;
  return body;
}

function heading(label, glyph = VOTE_ICON) {
  const h = el("h2", "vote-title");
  h.innerHTML = glyph;
  h.append(document.createTextNode(label));
  return h;
}

function doneHeading() {
  const h = heading("Time's up", COMPLETE_ICON);
  h.classList.add("timer-complete");
  return h;
}

function segments(label, options, changed, key) {
  const group = el("div", "vote-segments");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", label);
  const select = value => {
    for (const b of group.children) b.setAttribute("aria-pressed", String(b.value === value));
    changed(value);
  };
  for (const [value, text] of options) {
    const b = control(text, () => select(value));
    b.value = value;
    if (key) b.dataset[key] = value;
    group.append(b);
  }
  return { group, select };
}

function toggle(label, key, glyph, changed) {
  const set = value => b.setAttribute("aria-pressed", String(value));
  const checked = () => b.getAttribute("aria-pressed") === "true";
  const b = button(label, "vote-toggle", () => { set(!checked()); changed?.(); });
  b.dataset[key] = "";
  b.innerHTML = glyph;
  return { b, set, checked };
}

function start(host) {
  const { view } = host;
  const layer = el("div", "whiteboard-layer vote-layer");
  for (const [key, paint] of Object.entries(WHITEBOARD_PAINT)) layer.style.setProperty("--wb-" + key, paint);
  view.append(layer);
  layer.addEventListener("pointerdown", e => e.stopPropagation());
  const marks = el("div", "vote-marks");
  const candidate = el("span", "vote-affordance");
  candidate.innerHTML = icon("M12 5v14M5 12h14");
  candidate.hidden = true;
  layer.append(marks, candidate);

  const sheet = panel("vote-sheet", "Start a vote");
  sheet.dataset.voteSheet = "";
  sheet.setAttribute("role", "dialog");
  let draft = null;
  const each = el("output", "vote-each");
  const less = button("Fewer votes", "vote-step", () => step(-1));
  less.innerHTML = icon("M5 12h14");
  const more = button("More votes", "vote-step", () => step(1));
  more.innerHTML = icon("M5 12h14m-7-7v14");
  const dots = el("div", "vote-stepper-dots");
  dots.setAttribute("aria-hidden", "true");
  const stepper = el("div", "vote-stepper");
  stepper.append(less, dots, more);
  const voteDurations = segments("Timer", DURATIONS, value => { draft.timerMs = Number(value); }, "timerDuration");
  const timerNotice = el("p", "vote-muted");
  timerNotice.hidden = true;
  const hidden = toggle("Hide votes until the end", "voteHidden", HIDE_ICON);
  const anonymous = toggle("Anonymous results", "voteAnonymous", ANONYMOUS_ICON, paintSheetPeople);
  const settings = el("div", "vote-settings");
  const privacy = el("div", "vote-privacy-options");
  privacy.append(hidden.b, anonymous.b);
  settings.append(voteDurations.group, privacy);
  const startVote = control("Start vote", submitStart, "voteStart", true);
  const sheetPeople = el("div", "vote-sheet-people");
  sheet.append(stepper, each, settings, timerNotice, startVote, sheetPeople);
  layer.append(sheet);

  const timerSheet = panel("vote-sheet timer-sheet", "Start a timer");
  timerSheet.dataset.timerSheet = "";
  timerSheet.setAttribute("role", "dialog");
  const dial = timerDial(async (ms) => {
    if (await send({ kind: "timer.set", standalone: true, action: "start", vote: crypto.randomUUID(), ms })) {
      rememberWhiteboardSetting(TIMER_SETTING, ms);
      closeTimerSheet();
    }
  });
  const timerLayout = el("div", "timer-dial-layout");
  timerLayout.append(dial.face, ...dial.presets);
  timerSheet.append(timerLayout);
  layer.append(timerSheet);

  const bar = panel("vote-bar", "Voting");
  bar.setAttribute("role", "region");
  const timerBar = panel("vote-bar standalone-timer-bar", "Timer");
  timerBar.dataset.timerBar = "";
  layer.append(bar, timerBar);
  const bars = new ResizeObserver(() => {
    layer.style.setProperty("--vote-bar-height", bar.offsetHeight + "px");
    layer.style.setProperty("--timer-bar-height", timerBar.offsetHeight + "px");
    layer.classList.toggle("timer-with-vote", !bar.hidden && !timerBar.hidden);
  });
  bars.observe(bar);
  bars.observe(timerBar);
  const results = panel("vote-results", "Vote results");
  results.dataset.voteResults = "";
  layer.append(results);

  let canVote = true, canStart = true, canTimer = true, cloud = false, message, timerMessage, people = [];
  let clockTime = Date.now(), clockSample = performance.now();
  const hostTime = () => clockTime + performance.now() - clockSample;
  const checkedDeadlines = new Set();
  let recovery;
  const dismissKey = "canvas.timer.dismissed:" + host.file;
  let standalone, clock, clocks = [], muted = localStorage.getItem(MUTE_KEY) === "1";
  let dismissedTimer = localStorage.getItem(dismissKey);
  const shownErrors = new Set();
  let page = host.page, votes = [], showResults = null, lastActive = null, repeatVote = null, busy = false, loading = 0, anchored = [], hovered = null;
  const current = () => votes.find(v => v.scope.page === host.page);
  const active = () => current()?.state === "active";
  const capturing = () => !!draft || active();
  const path = host.api("/api/votes");
  const reportTool = () => {
    if (host.native) host.post({ voteTool: capturing(), timerTool: !timerSheet.hidden });
  };

  function step(delta) {
    if (!draft) return;
    draft.perPerson = Math.max(1, Math.min(10, draft.perPerson + delta));
    each.value = `${draft.perPerson} ${draft.perPerson === 1 ? "vote" : "votes"} each`;
    dots.style.setProperty("--vote-allowance", draft.perPerson);
    dots.replaceChildren(...Array.from({ length: draft.perPerson + 1 }, () => el("span")));
    less.disabled = draft.perPerson === 1;
    more.disabled = draft.perPerson === 10;
  }

  function closeSheet() {
    if (!draft) return;
    if (sheet.contains(document.activeElement)) document.activeElement.blur();
    draft = null;
    sheet.hidden = true;
    reportTool();
    host.requestFrame();
  }

  function closeTimerSheet() {
    if (timerSheet.hidden) return;
    dial.cancel();
    if (timerSheet.contains(document.activeElement)) document.activeElement.blur();
    timerSheet.hidden = true;
    reportTool();
  }

  function activateTimer() {
    if (!host.page || host.textEdit?.active) return;
    if (!canStart || host.readOnly) { host.toast("Owners and editors can start a timer."); return; }
    if (!canTimer) { host.toast(timerMessage); return; }
    if (standalone && !standalone.endedAt) { timerBar.querySelector("button")?.focus(); return; }
    if (!timerSheet.hidden) { closeTimerSheet(); return; }
    host.emit("draw-tool", "timer");
    timerSheet.hidden = false;
    reportTool();
    dial.reset(whiteboardSetting(TIMER_SETTING));
  }

  function updateTimerOptions() {
    for (const b of voteDurations.group.children) b.disabled = !canTimer && b.value !== "0";
    if (!canTimer && draft?.timerMs) voteDurations.select("0");
    timerNotice.hidden = canTimer;
    timerNotice.textContent = canTimer ? "" : timerMessage;
  }

  function activate() {
    if (!host.page || host.textEdit?.active) return;
    const v = current();
    if (v?.state === "active") return;
    if (v?.state === "ended") { showResults = v.id; paint(); return; }
    if (!canVote) { host.toast(message); return; }
    if (!canStart || host.readOnly) { host.toast("Owners and editors can start a vote."); return; }
    if (draft) { closeSheet(); return; }
    host.emit("draw-tool", "vote");
    const frames = host.selection().filter(id => (host.boards.get(id)?.meta.type ?? host.layerInfo(id)?.type) === "frame");
    draft = { page: host.page, frame: frames.length === 1 ? frames[0] : undefined, perPerson: 3 };
    voteDurations.select("0");
    updateTimerOptions();
    hidden.set(true);
    anonymous.set(false);
    step(0);
    sheet.hidden = false;
    paintSheetPeople();
    reportTool();
    less.focus({ preventScroll: true });
    host.requestFrame();
  }

  async function submitStart() {
    if (!draft) return;
    const { page, frame, perPerson, timerMs } = draft;
    const hasStickies = [...host.boards.values()].some(({ meta, gone }) =>
      !gone && (frame ? meta.stickyScopes?.includes(frame) : meta.stickyScopes?.length));
    const ok = await send({
      kind: "vote.start", vote: crypto.randomUUID(),
      scope: { page, ...(frame && { frame }) },
      on: hasStickies ? "stickies" : "anything", perPerson, ...(timerMs && { timerMs }), hidden: hidden.checked(), anonymous: anonymous.checked(),
    });
    if (ok) { closeSheet(); if (host.page === page) host.clearSel(); }
  }

  function update(data) {
    const activeBefore = new Set(votes.filter(vote => vote.state === "active").map(vote => vote.id));
    const soloWas = standalone;
    votes = data.votes;
    standalone = data.timer;
    cloud = data.canVote !== undefined;
    canVote = data.canVote ?? true;
    canStart = data.canStart ?? true;
    people = data.people ?? [];
    message = data.message;
    const serverTime = Date.parse(data.serverTime ?? "");
    if (Number.isFinite(serverTime)) {
      clockTime = serverTime;
      clockSample = performance.now();
    }
    canTimer = data.canTimer ?? true;
    timerMessage = data.timerMessage;
    if (data.waitingForTimerSupport && !shownErrors.has(timerMessage)) {
      shownErrors.add(timerMessage);
      host.toast(timerMessage);
    }
    const v = current();
    for (const vote of votes) if (vote.timedOut && activeBefore.has(vote.id)) playEnd(vote.id);
    if (standalone?.endedAt && standalone.id === soloWas?.id && !soloWas.endedAt) playEnd(standalone.id);
    if (draft && !canStart) closeSheet();
    if (!canStart || !canTimer || (standalone && !standalone.endedAt)) closeTimerSheet();
    updateTimerOptions();
    recovery = data.rejected?.find(error => error.retryable);
    for (const error of data.rejected ?? []) {
      if (error.retryable || shownErrors.has(error.id)) continue;
      shownErrors.add(error.id);
      repeatVote = null;
      host.toast(error.message);
    }
    if (v?.state === "ended" && v.id === lastActive) showResults = v.id;
    lastActive = v?.state === "active" ? v.id : null;
    paint();
    if (repeatVote && v?.id !== repeatVote) {
      repeatVote = null;
      activate();
    }
  }

  async function load() {
    const n = ++loading;
    try {
      const r = await fetch(path);
      if (!r.ok) return;
      const data = await r.json();
      if (n === loading && !busy) update(data);
    } catch { /* A reconnect will load the latest vote. */ }
  }

  async function send(op) {
    if (busy) return false;
    busy = true;
    loading++;
    startVote.disabled = true;
    dial.setDisabled(true);
    try {
      const r = await fetch(path, {
        method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" },
        body: JSON.stringify({
          name: host.prefs().whiteboardName,
          envelope: { doc: NIL_DOC, opId: crypto.randomUUID(), at: new Date().toISOString(), op },
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Could not update the vote.");
      if (op.kind === "vote.end" && data.votes.some(v => v.id === op.vote && v.scope.page === host.page && v.state === "ended")) showResults = op.vote;
      loading++;
      update(data);
      return true;
    } catch (error) {
      host.toast(error.message);
      return false;
    } finally {
      busy = false;
      startVote.disabled = false;
      dial.setDisabled(false);
      void load();
    }
  }

  function avatars(people, progress = false) {
    const list = el("span", "vote-people" + (progress ? " vote-progress" : ""));
    for (const p of people) {
      const avatar = el("span", "vote-avatar", Array.from(p.name)[0]?.toUpperCase() || "?");
      const label = progress && p.done ? `${p.name}, done voting` : p.name;
      avatar.style.background = colorOf(p.name);
      avatar.title = label;
      avatar.setAttribute("aria-label", label);
      if (progress && p.done) {
        const check = el("span", "vote-done-check");
        check.dataset.voteProgressDone = "";
        check.innerHTML = icon("m5 12 4 4L19 6");
        avatar.append(check);
      }
      list.append(avatar);
    }
    return list;
  }

  function paintSheetPeople() {
    const here = anonymous.checked() ? [] : people;
    sheetPeople.replaceChildren();
    if (here.length) sheetPeople.append(avatars(here), el("span", "vote-muted", `${here.length} here`));
  }

  function playEnd(id) {
    const last = "canvas.timer.lastEnd";
    if (localStorage.getItem(last) === id) return;
    localStorage.setItem(last, id);
    if (muted) return;
    if (host.native) host.post({ timerEnded: true });
    else host.chime?.();
  }

  function muteControl() {
    const mute = control(muted ? "Unmute" : "Mute", () => {
      muted = !muted;
      localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
      for (const button of layer.querySelectorAll("[data-timer-mute]")) {
        button.textContent = muted ? "Unmute" : "Mute";
        button.setAttribute("aria-label", muted ? "Unmute timer sound" : "Mute timer sound");
      }
    }, "timerMute");
    mute.setAttribute("aria-label", muted ? "Unmute timer sound" : "Mute timer sound");
    return mute;
  }

  function timerControls(timer, vote, standalone) {
    const change = action => send({ kind: "timer.set", vote, ...(standalone && { standalone }), action });
    const paused = !!timer.pausedAt;
    const pause = control(paused ? "Resume" : "Pause", () => change(paused ? "resume" : "pause"), paused ? "timerResume" : "timerPause");
    pause.classList.add("timer-icon-button");
    pause.innerHTML = paused ? RESUME_ICON : PAUSE_ICON;
    const controls = [
      pause,
      control("+1 min", () => change("extend"), "timerExtend"),
    ];
    if (standalone) controls.push(control("Stop", () => change("stop"), "timerStop"));
    return controls;
  }

  function countdown(id, timer, status, voting) {
    const display = el("span", "timer-readout");
    const ring = el("span", "timer-ring");
    const number = el("span", "timer-number");
    ring.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="13"/><circle cx="16" cy="16" r="13" pathLength="1"/></svg>';
    number.dataset.timerCountdown = "";
    number.setAttribute("role", "timer");
    display.append(ring, number);
    clocks.push({ id, timer, display, number, ring, status, voting });
    return display;
  }

  function tick() {
    clearTimeout(clock);
    if (!clocks.length) return;
    let next = Infinity;
    for (const { id, timer, display, number, ring, status, voting } of clocks) {
      const ms = Math.max(0, timer.pausedAt ? timer.remainingMs ?? 0 : Date.parse(timer.endsAt) - hostTime());
      const seconds = Math.ceil(ms / 1000);
      const time = [Math.floor(seconds / 60), seconds % 60].map(n => String(n).padStart(2, "0")).join(":");
      if (number.textContent !== time) number.textContent = time;
      const urgent = !timer.pausedAt && seconds <= 10;
      display.classList.toggle("timer-urgent", urgent);
      ring.style.setProperty("--timer-progress", Math.min(1, ms / timer.ms));
      const text = timer.pausedAt ? (voting ? "Timer paused" : "Paused")
        : urgent && voting ? (seconds ? `Votes lock in ${seconds} s` : "Votes locked")
        : voting ? status.dataset.prompt : "";
      if (status.textContent !== text) status.textContent = text;
      status.hidden = !text;
      if (timer.pausedAt) continue;
      if (seconds) next = Math.min(next, ms - (seconds - 1) * 1000 + 10);
      else {
        const key = id + ":" + timer.endsAt;
        if (!checkedDeadlines.has(key)) {
          checkedDeadlines.add(key);
          if (!busy) void load();
        }
      }
    }
    if (Number.isFinite(next)) clock = setTimeout(tick, next);
  }

  function paintStandalone() {
    timerBar.replaceChildren();
    timerBar.hidden = !standalone || dismissedTimer === standalone.id;
    if (timerBar.hidden) return;
    if (standalone.endedAt) {
      timerBar.append(doneHeading(), control("Done", () => {
        dismissedTimer = standalone.id;
        localStorage.setItem(dismissKey, dismissedTimer);
        paintTimerBars(current());
      }, "timerDone"));
      return;
    }
    const status = el("span", "vote-muted");
    timerBar.append(countdown(standalone.id, standalone, status, false), status);
    if (!canTimer) timerBar.append(el("span", "vote-muted", timerMessage));
    if (canStart && canTimer) timerBar.append(...timerControls(standalone, standalone.id, true));
    timerBar.append(muteControl());
  }

  function paintTimerBars(v) {
    clocks = [];
    paintBar(v);
    if (recovery) {
      const { id, message } = recovery;
      bar.hidden = false;
      bar.append(el("span", "vote-muted", message),
        control("Retry", () => recoverVote("retry", id), "voteRecoveryRetry"),
        control("Discard", () => recoverVote("discard", id), "voteRecoveryDiscard"));
    }
    paintStandalone();
    tick();
  }

  async function recoverVote(action, id) {
    try {
      const response = await fetch(host.api(`/api/comments/${action}`), {
        method: "POST", headers: { "x-canvas": "1", "content-type": "application/json" }, body: JSON.stringify({ opId: id }),
      });
      if (!response.ok) throw new Error((await response.json()).error || "Could not update the recovered vote.");
      await load();
    } catch (error) { host.toast(error.message); }
  }

  function paintBar(v) {
    bar.replaceChildren();
    bar.hidden = !v;
    if (!v) return;
    if (v.state === "active") {
      const remaining = v.perPerson - v.mine;
      const dots = el("span", "vote-budget");
      dots.setAttribute("aria-label", `${remaining} votes left`);
      for (let i = 0; i < v.perPerson; i++) dots.append(el("span", i < remaining ? "available" : ""));
      const status = el("span", "vote-muted");
      status.dataset.prompt = v.on === "stickies" ? "Click a sticky to vote" : "Click an object to vote";
      if (v.timer?.endsAt || v.timer?.pausedAt) bar.append(countdown(v.id, v.timer, status, true));
      else { bar.append(heading("Voting")); status.textContent = status.dataset.prompt; }
      bar.append(status, dots);
      if (v.people?.length) bar.append(avatars(v.people, true));
      if (v.done > (v.people?.filter(p => p.done).length ?? 0)) bar.append(el("span", "vote-muted", `${v.done} done`));
      if (!canVote) bar.append(el("span", "vote-muted", message));
      if (v.host && canVote) {
        const end = control(v.pendingEnd ? "Ending…" : "End vote", () => send({ kind: "vote.end", vote: v.id }), "voteEnd");
        end.disabled = v.pendingEnd;
        if (v.timer && canTimer) bar.append(...timerControls(v.timer, v.id, false));
        bar.append(end);
      }
      if (v.timer) bar.append(muteControl());
      return;
    }
    const count = v.timedOut && v.voters ? `${voteTotal(v.total)} from ${v.voters} ${v.voters === 1 ? "person" : "people"}` : voteTotal(v.total);
    bar.append(v.timedOut ? doneHeading() : heading("Vote ended"), el("span", "vote-muted", (v.anonymous ? "Anonymous, " : "") + count));
    if (showResults !== v.id) bar.append(control("Results", () => { showResults = v.id; paint(); }));
    if (!canVote && !v.archived) bar.append(el("span", "vote-muted", message));
    if (!v.host || (!canVote && !v.archived)) return;
    if (v.pendingConclusion) bar.append(control("Place conclusion", () => cloud ? load() : send({ kind: "vote.end", vote: v.id }), "voteEnd"));
    else bar.append(control(v.timedOut && !v.archived ? "Vote again" : "Clear votes", async () => {
      if (v.timedOut && !v.archived) repeatVote = v.id;
      if (!await send({ kind: "vote.clear", vote: v.id })) repeatVote = null;
    }, "voteClear"));
  }

  const voteTotal = count => count + (count === 1 ? " vote" : " votes");

  async function copy(v) {
    const rows = v.results.map(({ rank, name, count }) => `${rank}. ${name} (${voteTotal(count)})`);
    const text = rows.join("\n");
    try {
      if (host.native) host.post({ clipboard: text });
      else await navigator.clipboard.writeText(text);
      host.toast("Vote results copied");
    } catch { host.toast("Could not copy vote results"); }
  }

  function paintResults(v) {
    results.hidden = v?.state !== "ended" || showResults !== v.id;
    results.replaceChildren();
    if (results.hidden) return;
    results.append(el("h2", "vote-title", "Results"),
      el("p", "vote-muted", v.anonymous ? "Anonymous, counts only" : (v.scopeName || (v.voters ? `${voteTotal(v.total)} from ${v.voters} ${v.voters === 1 ? "person" : "people"}` : voteTotal(v.total)))));
    const list = el("ol", "vote-result-list");
    for (const row of v.results) {
      const item = el("li", "vote-result-row" + (row.rank === 1 ? " vote-winner" : ""));
      const label = el("span", "vote-result-label", row.name);
      label.title = row.name;
      const swatch = el("span", "vote-result-swatch");
      if (Object.hasOwn(STICKY_COLORS, row.color)) swatch.style.setProperty("--vote-swatch", STICKY_COLORS[row.color]);
      const voters = avatars(row.names.map(name => ({ name })));
      item.append(el("span", "vote-muted", String(row.rank)), swatch, label, voters, el("strong", "", String(row.count)));
      list.append(item);
    }
    if (list.childElementCount) results.append(list);
    else results.append(el("p", "vote-muted", "No votes cast"));
    const actions = el("div", "vote-actions");
    const copyList = control("Copy as list", () => copy(v), "voteCopy");
    copyList.disabled = !v.results.length;
    actions.append(copyList, control("Done", () => { showResults = null; paint(); }, "voteDone", true));
    results.append(actions);
  }

  function paintMarks(v) {
    marks.replaceChildren();
    anchored = [];
    if (!v) return;
    const byLayer = new Map();
    const groupFor = layerId => {
      if (!byLayer.has(layerId)) {
        const group = el("div", v.state === "active" ? "vote-dots" : "vote-count");
        byLayer.set(layerId, group);
        marks.append(group);
        anchored.push({ layer: layerId, group, count: v.state === "ended" });
      }
      return byLayer.get(layerId);
    };
    if (v.state === "ended") {
      for (const row of v.results) {
        const group = groupFor(row.layer);
        group.dataset.voteCount = "";
        group.setAttribute("aria-label", voteTotal(row.count));
        if (row.rank === 1) group.classList.add("vote-primary");
        group.innerHTML = VOTE_ICON;
        group.append(document.createTextNode(String(row.count)));
      }
    } else {
      for (const { layer, count } of v.peerTotals ?? []) {
        const group = groupFor(layer);
        for (let i = 0; i < Math.min(count, 10); i++) group.append(el("span", "vote-dot vote-peer"));
      }
      for (const ballot of v.ballots) {
        const mark = ballot.own ? button("Remove your vote", "vote-dot", () => send({ kind: "vote.retract", vote: v.id, ballot: ballot.id })) : el("span", "vote-dot vote-peer");
        mark.dataset.voteMark = "";
        if (ballot.name && !ballot.own) mark.title = ballot.name;
        groupFor(ballot.layer).append(mark);
      }
    }
    positionMarks();
  }

  function positionMarks() {
    if (!host.cam) return;
    const { x, y, z } = host.cam;
    const v = current();
    const hover = canVote && !host.hand && v?.state === "active" && v.mine < v.perPerson && hovered && host.worldRectOf(hovered);
    candidate.hidden = !hover;
    if (hover) candidate.style.transform = `translate(${x + (hover.x + hover.w) * z - 8}px,${y + hover.y * z}px)`;
    for (const badge of anchored) {
      const r = host.worldRectOf(badge.layer);
      badge.group.hidden = !r;
      if (!r) continue;
      const sx = x + r.x * z, sy = y + r.y * z;
      const left = badge.count ? sx + r.w * z - 8 : sx + 7;
      const top = badge.count ? sy - 10 : sy + r.h * z - (host.layerInfo(badge.layer)?.type === "sticky" ? 61 : 22);
      const position = `translate(${left}px,${Math.max(sy + (badge.count ? -10 : 2), top)}px)`;
      if (badge.group.style.transform !== position) badge.group.style.transform = position;
    }
  }

  const privatePresence = () => votes.some(v => v.state === "active" && (v.hidden || v.anonymous));
  let lastPrivatePresence = false;
  function paint() {
    const privacy = privatePresence();
    if (privacy !== lastPrivatePresence) {
      lastPrivatePresence = privacy;
      host.emit("vote-privacy", privacy);
    }
    const v = current();
    if (showResults && showResults !== v?.id) showResults = null;
    paintTimerBars(v);
    if (draft) paintSheetPeople();
    paintResults(v);
    paintMarks(v);
    reportTool();
    host.requestFrame();
  }

  function targetAt(e, v) {
    const seal = e.target.closest?.("[data-sticker-layer]")?.dataset.stickerLayer;
    if (e.target.closest?.(canvasChrome) && !seal) return;
    const hits = seal ? [seal] : host.pickAll(e.clientX, e.clientY);
    return hits.find(id => {
      const chain = host.chainOf(id);
      if (v.scope.frame && !chain.includes(v.scope.frame)) return false;
      return v.on === "anything" || host.layerInfo(id)?.type === "sticky";
    });
  }

  addEventListener("keydown", e => {
    if (e.defaultPrevented || e.isComposing || e.repeat || e.metaKey || e.ctrlKey || e.altKey || host.textEdit?.active) return;
    if (e.key === "Escape" && !timerSheet.hidden) closeTimerSheet();
    else if (e.key === "Escape" && draft) closeSheet();
    else if (e.key.toLowerCase() === "t" && e.shiftKey && !e.target.closest?.(field)) activateTimer();
    else if (e.key.toLowerCase() === "d" && e.shiftKey && !e.target.closest?.(field)) activate();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  addEventListener("pointerdown", e => {
    if (!timerSheet.hidden && !timerSheet.contains(e.target)) closeTimerSheet();
    if (draft && !sheet.contains(e.target)) closeSheet();
    const v = current();
    if (v?.state !== "active" || !canVote || host.hand || e.button !== 0 || !view.contains(e.target)) return;
    const id = targetAt(e, v);
    if (!id && e.target.closest?.(canvasChrome)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!id || busy || (v.timer?.endsAt && !v.timer.pausedAt && Date.parse(v.timer.endsAt) <= hostTime())) return;
    if (v.mine >= v.perPerson) { host.toast("You have no votes left. Click one of your dots to remove it."); return; }
    void send({ kind: "vote.cast", vote: v.id, ballot: crypto.randomUUID(), layer: id });
  }, true);
  addEventListener("pointermove", e => {
    if (!active()) return;
    const hit = view.contains(e.target) ? targetAt(e, current()) : null;
    if (hit !== hovered) { hovered = hit; host.requestFrame(); }
  }, true);

  host.on("cmd", c => {
    if (c.cmd === "draw" && c.type === "vote") activate();
    if (c.cmd === "draw" && c.type === "timer") activateTimer();
    if (c.cmd === "cancelDraw") { closeSheet(); closeTimerSheet(); }
    if (c.cmd === "syncVoteTool") reportTool();
  });
  host.on("draw-tool", type => {
    if (type !== "vote") closeSheet();
    if (type !== "timer") closeTimerSheet();
  });
  host.on("page", () => {
    if (page !== host.page) {
      page = host.page;
      closeSheet();
      closeTimerSheet();
      lastActive = showResults = hovered = repeatVote = null;
    }
    paint();
  });
  host.on("tab", shown => {
    if (!shown) { closeSheet(); closeTimerSheet(); }
    else { reportTool(); void load(); }
  });
  host.on("resync", load);
  host.es?.addEventListener("comments", load);
  host.es?.addEventListener("cloudfile", load);
  host.beforeFrame(positionMarks);
  host.votes = { activate, activateTimer, active, capturing, get privatePresence() { return privatePresence(); } };
  void load();
}

const host = window.canvasHost;
if (host?.file && host.view) start(host);
