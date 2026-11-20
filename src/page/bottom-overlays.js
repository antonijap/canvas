/** Geometry shared by every bottom notice, including the native toast. Coordinates are relative to the view. */
export function bottomOverlayArea(width, height, insets = {}, zoom = null, pill = 36) {
  const left = insets.l || 0, right = width - (insets.r || 0), x = (left + right) / 2;
  const y = zoom?.bottom > 0 ? zoom.bottom - (zoom.height || pill) / 2 : height - 18 - pill / 2;
  const edge = Math.min(right, zoom?.left > x ? zoom.left - 12 : right);
  return { x, y, width: Math.max(48, 2 * Math.min(x - left - 8, edge - x - 8)) };
}

export function installBottomOverlays(host) {
  let zoom = null, nativeToast = false, frame = 0, sent = '';
  const selectors = ['#msg', '#webhint', '[data-bottom-toast]', '#scaleBadge', '.cm-hint.on', '.cm-bar.on'];
  const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
  function place() {
    frame = 0;
    const view = host.view, vr = view.getBoundingClientRect();
    const pill = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--c-pill')) || 36;
    const z = zoom && { left: zoom.left - vr.left, bottom: zoom.bottom - vr.top, height: zoom.height };
    const area = bottomOverlayArea(vr.width, vr.height, host.insets, z, pill);
    let offset = nativeToast ? pill + 10 : 0;
    if (host.native) {
      const geometry = { x: vr.left + area.x, y: vr.top + area.y, width: area.width };
      const key = JSON.stringify(geometry);
      if (key !== sent) { sent = key; host.post({ bottomOverlay: geometry }); }
    }
    for (const selector of selectors) for (const el of document.querySelectorAll(selector)) {
      if (!el.getClientRects().length || getComputedStyle(el).display === 'none') continue;
      const fixed = getComputedStyle(el).position === 'fixed';
      const set = (key, value) => { if (el.style[key] !== value) el.style[key] = value; };
      set('maxWidth', area.width + 'px');
      set('width', 'max-content');
      set('boxSizing', 'border-box');
      set('whiteSpace', 'normal');
      set('left', (area.x + (fixed ? vr.left : 0)) + 'px');
      set('right', 'auto'); set('bottom', 'auto');
      set('translate', '-50% -50%'); set('transform', 'none');
      const h = el.getBoundingClientRect().height;
      set('top', (area.y - offset + (fixed ? vr.top : 0)) + 'px');
      offset += h + 10;
    }
  }
  host.on('cmd', c => { if (c.cmd === 'zoomCorner') zoom = c; if (c.cmd === 'bottomToast') nativeToast = !!c.shown; schedule(); });
  // The native shell may have sent its first frame before this module loaded.
  if (host.native) host.post({ bottomOverlayReady: true });
  for (const event of ['render', 'visible', 'page']) host.on(event, schedule);
  addEventListener('resize', schedule);
  new MutationObserver(schedule).observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true, attributeFilter: ['style', 'class', 'hidden'] });
  schedule();
}
