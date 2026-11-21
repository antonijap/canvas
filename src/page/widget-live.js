import { ageLabel, ageSec, sparkPoints } from "./geometry.js";

const h = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

export function widgetButton(label, action, text = label) {
  const button = h("button", "wd-action", text);
  button.type = "button";
  button.dataset.nodrag = "";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.onclick = async () => {
    button.disabled = true;
    try { await action(); } catch {}
    finally { button.disabled = false; }
  };
  return button;
}

function updateAge(time) {
  const stamp = Number(time.dataset.updated);
  const age = stamp && ageLabel(ageSec(stamp));
  time.hidden = !age;
  if (age) time.textContent = (time.dataset.stale === "true" ? "◷ Stale, updated " : "Updated ") + age + " ago";
}

export function updateWidgetAges() {
  for (const time of document.querySelectorAll(".wd-age")) updateAge(time);
}

export function widgetAge() {
  const el = h("time", "wd-age");
  el.hidden = true;
  return {
    el,
    update(r) {
      el.dataset.updated = r?.updatedAt || "";
      el.dataset.stale = r?.state === "stale";
      if (r?.updatedAt) el.dateTime = new Date(r.updatedAt).toISOString();
      el.title = r?.error?.message || "";
      updateAge(el);
    },
  };
}

export function widgetSkeleton() {
  const el = h("div", "wd-skeleton");
  el.setAttribute("aria-hidden", "true");
  el.append(h("i"), h("i"), h("i"));
  return el;
}

function external(url, text) {
  if (!url) return h("span", "", text);
  const a = h("a", "", text);
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.dataset.nodrag = "";
  a.onclick = (event) => {
    if (!window.canvasHost?.native) return;
    event.preventDefault();
    window.canvasHost.post({ widgetExternalURL: a.href });
  };
  return a;
}

function spark(values) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "st-spark");
  svg.setAttribute("viewBox", "0 0 100 30");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-label", "Trend");
  const line = document.createElementNS(ns, "polyline");
  line.setAttribute("points", sparkPoints(values.length === 1 ? [values[0], values[0]] : values));
  svg.append(line);
  return svg;
}

const number = (n) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
const bytes = (size) => {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const unit = size > 0 ? Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1000))) : 0;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(size / 1000 ** unit) + " " + units[unit];
};

function bar(fraction, label, marker) {
  const meter = h("div", "wd-meter");
  meter.setAttribute("role", "meter");
  meter.setAttribute("aria-label", label);
  meter.setAttribute("aria-valuemin", "0");
  meter.setAttribute("aria-valuemax", "100");
  meter.setAttribute("aria-valuenow", String(Math.min(100, Math.round(fraction * 100))));
  meter.style.setProperty("--fill", Math.min(100, fraction * 100) + "%");
  if (marker) meter.append(h("i", "wd-marker"));
  return meter;
}

function gitView(g) {
  const summary = h("div", "wd-summary");
  summary.append(h("strong", "", g.branch), h("span", "", g.changed + (g.changed === 1 ? " changed file" : " changed files")));
  summary.append(h("span", "", g.ahead === null ? "No upstream" : "↑ " + g.ahead + " ahead   ↓ " + g.behind + " behind"));
  const commits = h("ul", "wd-rows");
  for (const commit of g.commits) {
    const row = h("li");
    row.append(h("code", "", commit.id), h("span", "", commit.title));
    commits.append(row);
  }
  return [summary, g.commits.length ? commits : h("div", "wd-muted", "No commits yet.")];
}

function ciView(c) {
  const runs = h("ul", "wd-rows wd-runs");
  for (const run of c.runs) {
    const result = run.result.replaceAll("_", " ");
    const icon = result === "success" ? "✓" : run.failed.length || result === "failure" ? "!" : "◷";
    const item = h("li");
    const detail = h("div");
    detail.append(external(run.url, run.name), h("small", "", [result, ...run.failed].filter(Boolean).join(" / ")));
    item.append(h("span", "wd-state-icon", icon), detail);
    runs.append(item);
  }
  const pulls = h("ul", "wd-rows");
  for (const pr of c.pulls) {
    const item = h("li");
    item.append(h("span", "wd-muted", "#" + pr.number), external(pr.url, pr.title));
    pulls.append(item);
  }
  return [
    h("strong", "", "Workflow runs"), c.runs.length ? runs : h("div", "wd-muted", "No recent runs."),
    h("strong", "", "Open pull requests"), c.pulls.length ? pulls : h("div", "wd-muted", "No open pull requests."),
  ];
}

function usageView(u, limit) {
  const graph = h("div", "wd-days");
  const max = Math.max(1, ...u.days.map((day) => day.tokens));
  for (const day of u.days) {
    const col = h("div");
    const fill = h("i");
    fill.style.setProperty("--fill", day.tokens / max * 100 + "%");
    col.title = day.label + ": " + day.tokens.toLocaleString() + " tokens";
    col.append(h("span", "", number(day.tokens)), fill, h("span", "", day.label));
    graph.append(col);
  }
  const models = h("ul", "wd-rows wd-models");
  for (const model of u.models) {
    const row = h("li");
    row.append(h("span", "", model.model), h("strong", "", number(model.tokens)));
    models.append(row);
  }
  const nodes = [graph, models];
  if (limit > 0) {
    const fraction = u.days.reduce((sum, d) => sum + d.tokens, 0) / limit;
    const caption = h("div", "wd-muted", Math.round(fraction * 100) + "% of weekly limit");
    const meter = bar(fraction, "Weekly token limit", true);
    meter.title = "Marker at 70%";
    nodes.push(caption, meter);
  }
  return nodes;
}

function view(w, r) {
  const data = r.content || {};
  if (data.git) return gitView(data.git);
  if (data.ci) return ciView(data.ci);
  if (data.usage) return usageView(data.usage, w.config.weeklyLimit);
  if (data.preview) {
    const img = h("img", "wd-preview");
    img.src = data.preview;
    img.alt = "Snapshot of " + w.config.url;
    return [img];
  }
  if (data.disk) {
    const { free, total } = data.disk;
    return [h("div", "st-num", bytes(free) + " free"), h("div", "wd-muted", "of " + bytes(total)), bar(free / total, "Free disk space")];
  }
  if (w.kind === "metric") return [h("div", "st-num", r.display), ...(r.spark?.length ? [spark(r.spark)] : [])];
  return [];
}

export function liveCard(ctx) {
  const root = h("div", "wd-live");
  const head = h("header", "wd-head");
  const title = h("div", "wd-title");
  const refresh = widgetButton("Refresh", ctx.refresh, "↻");
  head.append(title, refresh);
  const main = h("div", "wd-live-main");
  main.dataset.nodrag = "";
  const status = h("div", "wd-live-status");
  status.setAttribute("role", "status");
  const age = widgetAge();
  root.append(head, main, status, age.el);
  let prev;
  return {
    el: root,
    update(w, r) {
      const state = r?.state || "loading";
      root.dataset.state = state;
      title.textContent = w.name;
      age.update(r);
      if (w === prev?.w && state === prev.state && r?.content === prev.r?.content && r?.display === prev.r?.display && r?.spark === prev.r?.spark && r?.error?.message === prev.r?.error?.message) return;
      prev = { w, r, state };
      const scrollTop = main.scrollTop;
      main.replaceChildren();
      status.replaceChildren();
      status.hidden = state === "ok" || state === "stale";
      if (state === "loading") {
        status.append(h("span", "wd-state-icon", "◷"), h("span", "", "Loading"));
        main.append(widgetSkeleton());
      } else if (state === "ok" || state === "stale") {
        main.append(...view(w, r));
        main.scrollTop = scrollTop;
        if (state === "stale") {
          status.hidden = false;
          status.append(widgetButton("Retry", ctx.refresh), h("span", "", r.error?.message || "Waiting for new data."));
        }
      } else {
        status.append(h("span", "wd-state-icon", state === "empty" ? "○" : "!"), h("span", "", r.empty || r.error?.message || "Could not load data."));
        if (state === "needs-approval" && r.approvalTarget) status.append(widgetButton("Allow", () => ctx.trust(undefined, r.approvalTarget)));
        else if (state !== "empty") status.append(widgetButton("Retry", ctx.refresh));
      }
    },
  };
}
