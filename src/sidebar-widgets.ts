import { kindOf } from "./widgets/registry.ts";

const rule = '<span class="widget-sample-rule"></span>';
const panel = (content: string) => `<span class="widget-sample-panel">${content}</span>`;
const paper = (content: string) => `<span class="widget-sample-panel widget-sample-paper">${content}</span>`;

// Sample previews use the same fixture content as the native picker.
const previews = {
  todo: panel('<del><i class="amber">✓</i> Ship the sidebar</del><span>○ Review cards</span><span>○ Plan next steps</span>'),
  note: paper(`<b>Field notes</b>${rule.repeat(3)}<span class="widget-sample-photo"></span>`),
  shader: '<code>fn shade</code>',
  video: `<span class="widget-sample-play"><svg width="9" height="9" viewBox="0 0 9 9"><path fill="currentColor" d="M1 0 8 4.5 1 9Z"/></svg></span><small>1:36</small>${rule}`,
  "git-status": panel('<b>main　<code class="positive">+12</code> <code class="negative">−3</code></b>' +
    '<span><code class="amber">M</code> Sidebar.swift</span><span><code class="positive">A</code> cards.ts</span>' +
    '<span><code class="negative">D</code> old-rail.ts</span>'),
  ci: panel('<b><i class="positive">✓</i> Build</b><span><i class="amber">○</i> Tests</span><span>Slim sidebar　#128</span>'),
  "claude-usage": '<strong>42%</strong><span><small>Session</small><b>Resets 3h</b></span>',
  metric: '<strong>12.4k</strong>　<b class="positive">+8.2%</b><small>Visitors, 7 days</small>' +
    '<svg viewBox="0 0 112 28"><path d="M0 22 14 18 28 20 42 12 56 14 70 6 84 9 98 2 112 4V28H0Z" fill="#f2b84b40"/>' +
    '<path d="M0 22 14 18 28 20 42 12 56 14 70 6 84 9 98 2 112 4" fill="none" stroke="#f2b84b"/></svg>',
  "page-preview": paper(`<small>example.com</small><b>Plans for studios</b>${rule.repeat(2)}<span class="widget-sample-cta"></span>`),
  "disk-space": `<strong>214 GB</strong><small>free of 1 TB</small>${rule}<small>Apps　 Docs　 System</small>`,
};

const escapeText = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const sidebarWidgetTiles = Object.entries(previews).map(([id, preview]) => {
  const kind = kindOf(id)!;
  return `<button class="sidebar-widget" type="button" draggable="true" data-widget="${id}" data-qa-id="widget-tile-${id}">
    <span class="sidebar-widget-art" data-qa-id="widget-preview-${id}" aria-hidden="true">${preview}</span>
    <strong>${escapeText(kind.title)}</strong><small>${escapeText(kind.cardSubtitle ?? kind.description ?? "")}</small>
  </button>`;
}).join("");
