/** Geometry shared by every bottom notice, including the native toast. Coordinates are relative to the view. */
export function bottomOverlayArea(width, height, insets = {}, zoom = null, pill = 36, bottomClearance = 0) {
  const left = insets.l || 0, right = width - (insets.r || 0), x = (left + right) / 2;
  const zoomCenter = zoom?.bottom > 0 ? zoom.bottom - (zoom.height || pill) / 2 : height - 18 - pill / 2;
  const y = bottomClearance ? height - bottomClearance - pill / 2 : zoomCenter;
  const edge = Math.min(right, !bottomClearance && zoom?.left > x ? zoom.left - 12 : right);
  return { x, y, width: Math.max(48, 2 * Math.min(x - left - 8, edge - x - 8)) };
}

export function installBottomOverlays(host) {
  let zoom = null, nativeToast = false, bottomClearance = 0, frame = 0, sent = '';
  const selectors = ['#msg', '#webhint', '[data-bottom-toast]', '#scaleBadge', '.cm-hint.on', '.cm-bar.on'];
  const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
  function place() {
    frame = 0;
    const view = host.view, vr = view.getBoundingClientRect();
    const pill = zoom?.height || parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--c-pill')) || 36;
    const z = zoom && { left: zoom.left - vr.left, bottom: zoom.bottom - vr.top, height: zoom.height };
    const area = bottomOverlayArea(vr.width, vr.height, host.insets, z, pill, bottomClearance);
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
      const y = area.y - offset + (bottomClearance ? (pill - h) / 2 : 0);
      set('top', (y + (fixed ? vr.top : 0)) + 'px');
      offset += h + 10;
    }
  }
  host.on('cmd', c => {
    if (c.cmd === 'zoomCorner') zoom = c;
    if (c.cmd === 'bottomToast') nativeToast = !!c.shown;
    if (c.cmd === 'insets') {
      bottomClearance = c.bottomClearance || 0;
      // The whiteboard's flyouts sit above the app's palette, and above the zoom controls when those are raised.
      if (bottomClearance) document.documentElement.style.setProperty('--native-bottom', bottomClearance + 'px');
      else document.documentElement.style.removeProperty('--native-bottom');
    }
    schedule();
  });
  host.on('tab', shown => { if (shown) { sent = ''; schedule(); } });
  // The native shell may have sent its first frame before this module loaded.
  if (host.native) host.post({ bottomOverlayReady: true });
  for (const event of ['render', 'visible', 'page']) host.on(event, schedule);
  addEventListener('resize', schedule);
  new MutationObserver(schedule).observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true, attributeFilter: ['style', 'class', 'hidden'] });
  schedule();
}
