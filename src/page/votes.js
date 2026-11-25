import { button, el, icon } from "./whiteboard.js";
import { STICKY_COLORS, WHITEBOARD_PAINT } from "./whiteboard-model.js";

const NIL_DOC = "00000000-0000-4000-8000-000000000000";
const VOTE_ICON = icon("M4 21h16M6 21V7h12v14m-9-8 2 2 4-4");
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

function heading(label) {
  const h = el("h2", "vote-title");
  h.innerHTML = VOTE_ICON;
  h.append(document.createTextNode(label));
  return h;
}

function optionRow(label, ...controls) {
  const row = el("div", "vote-form-row");
  row.append(el("span", "", label), ...controls);
  return row;
}

function segments(label, options, changed) {
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
    if (label === "Vote on") b.dataset.voteMode = value;
    group.append(b);
  }
  return { group, select };
}

function toggle(label, key, checked = false) {
  const row = el("label", "vote-toggle");
  const input = el("input");
  input.type = "checkbox";
  input.checked = checked;
  input.dataset[key] = "";
  row.append(input, el("span", "", label));
  return { row, input };
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
  sheet.append(heading("Start a vote"));
  let draft = null;
  const things = segments("Vote on", [["stickies", "Stickies"], ["anything", "Anything"]], value => { draft.on = value; });
  const scopes = segments("Scope", [["frame", "Selected frame"], ["page", "This page"]], value => { draft.scopeKind = value; });
  const scopeRow = optionRow("Scope", scopes.group);
  const each = el("output", "", "3");
  each.setAttribute("aria-label", "Votes each");
  const less = control("−", () => step(-1));
  const more = control("+", () => step(1));
  less.setAttribute("aria-label", "Fewer votes");
  more.setAttribute("aria-label", "More votes");
  const stepper = el("div", "vote-stepper");
  stepper.append(less, each, more);
  const hidden = toggle("Hide votes until the end", "voteHidden", true);
  const anonymous = toggle("Anonymous results", "voteAnonymous");
  const startVote = control("Start", submitStart, "voteStart", true);
  const sheetActions = el("div", "vote-actions");
  sheetActions.append(control("Cancel", closeSheet), startVote);
  sheet.append(optionRow("Vote on", things.group), scopeRow, optionRow("Votes each", stepper), hidden.row, anonymous.row, sheetActions);
  layer.append(sheet);

  const bar = panel("vote-bar", "Voting");
  bar.setAttribute("role", "region");
  layer.append(bar);
  const results = panel("vote-results", "Vote results");
  results.dataset.voteResults = "";
  layer.append(results);

  let page = host.page, votes = [], showResults = null, lastActive = null, busy = false, loading = 0, anchored = [], hovered = null;
  const current = () => votes.find(v => v.scope.page === host.page);
  const active = () => current()?.state === "active";
  const capturing = () => !!draft || active();
  const path = host.api("/api/votes");

  function step(delta) {
    if (!draft) return;
    draft.perPerson = Math.max(1, Math.min(10, draft.perPerson + delta));
    each.value = String(draft.perPerson);
    less.disabled = draft.perPerson === 1;
    more.disabled = draft.perPerson === 10;
  }

  function closeSheet() {
    if (sheet.contains(document.activeElement)) document.activeElement.blur();
    draft = null;
    sheet.hidden = true;
    host.requestFrame();
  }

  function activate() {
    if (host.readOnly || !host.page) return;
    const v = current();
    if (v?.state === "active") return;
    if (v?.state === "ended") { showResults = v.id; paint(); return; }
    if (draft) { closeSheet(); return; }
    host.emit("draw-tool", "vote");
    const selected = host.selection();
    const frame = selected.length === 1 && host.layerInfo(selected[0])?.type === "frame" ? selected[0] : undefined;
    draft = { page: host.page, frame, scopeKind: frame ? "frame" : "page", on: "stickies", perPerson: 3 };
    things.select(draft.on);
    scopes.select(draft.scopeKind);
    scopeRow.hidden = !frame;
    hidden.input.checked = true;
    anonymous.input.checked = false;
    step(0);
    sheet.hidden = false;
    things.group.firstElementChild.focus({ preventScroll: true });
    host.requestFrame();
  }

  async function submitStart() {
    if (!draft) return;
    const { page, frame, scopeKind, on, perPerson } = draft;
    const ok = await send({
      kind: "vote.start", vote: crypto.randomUUID(),
      scope: { page, ...(scopeKind === "frame" && { frame }) },
      on, perPerson, hidden: hidden.input.checked, anonymous: anonymous.input.checked,
    });
    if (ok) { closeSheet(); if (host.page === page) host.clearSel(); }
  }

  function update(data) {
    votes = data.votes;
    const v = current();
    if (v?.state === "ended" && v.id === lastActive) showResults = v.id;
    lastActive = v?.state === "active" ? v.id : null;
    paint();
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
      void load();
    }
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
      bar.append(heading("Voting"), el("span", "vote-muted", v.on === "stickies" ? "Click a sticky to vote" : "Click an object to vote"), dots);
      if (v.host) bar.append(control("End vote", () => send({ kind: "vote.end", vote: v.id }), "voteEnd"));
      return;
    }
    bar.append(heading("Vote ended"), el("span", "vote-muted", (v.anonymous ? "Anonymous, " : "") + voteTotal(v.total)));
    if (showResults !== v.id) bar.append(control("Results", () => { showResults = v.id; paint(); }));
    if (!v.host) return;
    if (v.pendingConclusion) bar.append(control("Place conclusion", () => send({ kind: "vote.end", vote: v.id }), "voteEnd"));
    else bar.append(control("Clear votes", () => send({ kind: "vote.clear", vote: v.id }), "voteClear"));
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
      el("p", "vote-muted", v.anonymous ? "Anonymous, counts only" : (v.scopeName || voteTotal(v.total))));
    const list = el("ol", "vote-result-list");
    for (const row of v.results) {
      const item = el("li", "vote-result-row" + (row.rank === 1 ? " vote-winner" : ""));
      const label = el("span", "vote-result-label", row.name);
      label.title = row.name;
      const swatch = el("span", "vote-result-swatch");
      if (Object.hasOwn(STICKY_COLORS, row.color)) swatch.style.setProperty("--vote-swatch", STICKY_COLORS[row.color]);
      const people = el("span", "vote-people");
      for (const name of row.names) {
        const avatar = el("span", "vote-avatar", Array.from(name)[0].toUpperCase());
        avatar.title = name;
        avatar.setAttribute("aria-label", name);
        people.append(avatar);
      }
      item.append(el("span", "vote-muted", String(row.rank)), swatch, label, people, el("strong", "", String(row.count)));
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
    if (!bar.hidden) bar.style.top = (host.native ? Math.max(12, host.insets.t + 8) : 60) + "px";
    if (!results.hidden) results.style.right = (host.native ? host.insets.r + 16 : 16) + "px";
    if (!host.cam) return;
    const { x, y, z } = host.cam;
    const v = current();
    const hover = !host.hand && v?.state === "active" && v.mine < v.perPerson && hovered && host.worldRectOf(hovered);
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

  function paint() {
    const v = current();
    if (showResults && showResults !== v?.id) showResults = null;
    paintBar(v);
    paintResults(v);
    paintMarks(v);
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
    if (e.key === "Escape" && draft) closeSheet();
    else if (e.key.toLowerCase() === "d" && e.shiftKey && !e.target.closest?.(field)) activate();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  addEventListener("pointerdown", e => {
    const v = current();
    if (v?.state !== "active" || host.hand || host.readOnly || e.button !== 0 || !view.contains(e.target)) return;
    const id = targetAt(e, v);
    if (!id && e.target.closest?.(canvasChrome)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!id || busy) return;
    if (v.mine >= v.perPerson) { host.toast("You have no votes left. Click one of your dots to remove it."); return; }
    void send({ kind: "vote.cast", vote: v.id, ballot: crypto.randomUUID(), layer: id });
  }, true);
  addEventListener("pointermove", e => {
    if (!active()) return;
    const hit = view.contains(e.target) ? targetAt(e, current()) : null;
    if (hit !== hovered) { hovered = hit; host.requestFrame(); }
  }, true);

  host.on("cmd", c => { if (c.cmd === "draw" && c.type === "vote") activate(); });
  host.on("draw-tool", type => { if (draft && type !== "vote") closeSheet(); });
  host.on("page", () => {
    if (page !== host.page) {
      page = host.page;
      closeSheet();
      lastActive = showResults = hovered = null;
    }
    paint();
  });
  host.on("tab", shown => { if (!shown) closeSheet(); else void load(); });
  host.on("resync", load);
  host.es?.addEventListener("comments", load);
  host.beforeFrame(positionMarks);
  host.votes = { activate, active, capturing };
  void load();
}

const host = window.canvasHost;
if (host?.file && host.view) start(host);
