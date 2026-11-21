import { widgetAge, widgetButton } from "./widget-live.js";

function el(tag, cls, text = "") {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = text;
  return node;
}

function frameDocument(source, native) {
  const code = JSON.stringify(source).replaceAll("<", "\\u003c");
  return `<!doctype html><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
    <meta name="color-scheme" content="light dark">
    <style>html{font:14px system-ui;color:CanvasText;background:transparent}body{margin:0;overflow-wrap:anywhere}a{color:inherit}</style>
    <div id="root"></div>
    <script type="module">
      const send = (type, value) => parent.postMessage({ type, value }, "*");
      const root = document.getElementById("root");
      try {
        const url = URL.createObjectURL(new Blob([${code}], { type: "text/javascript" }));
        const { default: render } = await import(url).finally(() => URL.revokeObjectURL(url));
        if (typeof render !== "function") throw new Error();
        addEventListener("message", ({ source, data }) => {
          if (source !== parent || data?.type !== "canvas-local-render") return;
          try {
            render(root, data.value);
            send("canvas-local-rendered");
          } catch {
            send("canvas-local-error");
          }
        });
        document.addEventListener("click", (event) => {
          const link = event.target.closest?.("a[href]");
          if (!link) return;
          let url;
          try { url = new URL(link.getAttribute("href")); } catch {}
          if (!url || !["http:", "https:"].includes(url.protocol) || ${native}) {
            event.preventDefault();
            if (event.isTrusted && url && ["http:", "https:"].includes(url.protocol)) send("canvas-local-open", url.href);
          } else {
            link.target = "_blank";
            link.rel = "noopener noreferrer";
          }
        }, true);
        send("canvas-local-ready");
      } catch {
        send("canvas-local-error");
      }
    </script>`;
}

export function localCard(ctx, kind) {
  const root = el("div", "wd-live wd-local");
  const head = el("header", "wd-head");
  const title = el("div", "wd-title");
  const status = el("div", "wd-live-status");
  status.setAttribute("role", "status");
  const message = el("span", "");
  const age = widgetAge();
  head.append(title);
  status.append(message);
  root.append(head, status, age.el);
  let frame, ready = false, w, r, failed = false, disposed = false;

  function draw() {
    if (!ready || !w || failed) return;
    const state = r?.state || (kind.live ? "loading" : "ok");
    const data = r?.content?.local?.hash === kind.bundle ? r.content.local.data : undefined;
    message.textContent = state === "loading" ? "Loading" : r?.error?.message || "";
    status.hidden = !message.textContent;
    frame.hidden = state === "loading" || state === "error" || state === "needs-approval";
    frame.contentWindow?.postMessage({ type: "canvas-local-render", value: {
      name: w.name, config: { ...kind.defaults, ...w.config }, data, state, theme: ctx.theme(),
    } }, "*");
  }

  function onMessage({ source, data }) {
    if (!frame || source !== frame.contentWindow || !data) return;
    if (data.type === "canvas-local-ready") {
      ready = true;
      draw();
    } else if (data.type === "canvas-local-error") {
      failed = true;
      frame.hidden = true;
      message.textContent = "Could not display this local widget. Check renderer.js.";
      status.hidden = false;
    } else if (data.type === "canvas-local-rendered") {
      frame.dataset.rendered = "true";
    } else if (data.type === "canvas-local-open" && ctx.native) {
      ctx.openLink(data.value);
    }
  }

  if (!kind.approved) {
    message.textContent = "Allow \"" + kind.title + "\" to run its local renderer" + (kind.live ? " and fetch data?" : "?");
    status.append(widgetButton("Allow widget", () => ctx.trust(kind.bundle)));
  } else {
    if (kind.live) head.append(widgetButton("Refresh", ctx.refresh, "↻"));
    message.textContent = "Loading";
    ctx.renderer(kind).then(({ renderer }) => {
      if (disposed) return;
      frame = el("iframe", "wd-local-frame");
      frame.title = kind.title;
      frame.hidden = true;
      frame.dataset.nodrag = "";
      frame.setAttribute("sandbox", ctx.native ? "allow-scripts" : "allow-scripts allow-popups allow-popups-to-escape-sandbox");
      frame.style.colorScheme = ctx.theme();
      window.addEventListener("message", onMessage);
      frame.srcdoc = frameDocument(renderer, ctx.native);
      root.insertBefore(frame, age.el);
    }).catch(() => {
      message.textContent = "Local widget unavailable.";
    });
  }
  return {
    el: root,
    update(widget, reading) {
      w = widget;
      r = reading;
      title.textContent = w.name;
      if (frame) frame.style.colorScheme = ctx.theme();
      if (kind.approved && kind.live) age.update(r);
      draw();
    },
    dispose() {
      disposed = true;
      window.removeEventListener("message", onMessage);
      frame?.remove();
    },
  };
}
