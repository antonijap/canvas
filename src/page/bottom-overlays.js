/** Geometry shared by every bottom notice, including the native toast. Coordinates are relative to the view. */
export function bottomOverlayArea(width, height, insets = {}, zoom = null, pill = 36, inset = 10, gap = 10, bottomClearance = 0, minimumWidth = 48) {
  const left = insets.l || 0, right = width - (insets.r || 0), x = (left + right) / 2;
  const widthBetweenPanels = Math.max(0, right - left - 2 * inset);
  if (bottomClearance) return { x, y: height - bottomClearance - pill / 2, width: widthBetweenPanels, aboveZoom: true };
  if (!(zoom?.bottom > 0)) return { x, y: height - inset - pill / 2, width: widthBetweenPanels };
  const zoomHeight = zoom.height || pill;
  const y = zoom.bottom - zoomHeight / 2;
  const widthBesideZoom = 2 * (zoom.left - gap - x);
  if (widthBesideZoom >= Math.min(minimumWidth, widthBetweenPanels)) {
    return { x, y, width: Math.min(widthBetweenPanels, widthBesideZoom) };
  }
  return { x, y: zoom.bottom - zoomHeight - gap - pill / 2, width: widthBetweenPanels, aboveZoom: true };
}

export function installBottomOverlays(host) {
  let zoom = null, nativeToast = false, bottomClearance = 0, frame = 0, sent = '';
  const selectors = ['#msg', '#webhint', '[data-bottom-toast]', '#scaleBadge', '.cm-hint.on'];
  const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
  function place() {
    frame = 0;
    const view = host.view, vr = view.getBoundingClientRect();
    const style = getComputedStyle(document.documentElement);
    const pill = parseFloat(style.getPropertyValue('--c-pill')) || 40;
    const inset = parseFloat(style.getPropertyValue('--c-inset')) || 10;
    const gap = parseFloat(style.getPropertyValue('--c-island-gap')) || 10;
    const z = zoom && { left: zoom.left - vr.left, bottom: zoom.bottom - vr.top, height: zoom.height };
    const bar = view.querySelector('.cm-bar.on');
    let minimumWidth = 48;
    if (bar) {
      const css = getComputedStyle(bar);
      // Each control keeps its width when wrapped. Count the gaps and padding as well.
      const controls = [...bar.children].reduce((w, child) => w + child.getBoundingClientRect().width, 0);
      minimumWidth = Math.max(minimumWidth, controls + Math.max(0, bar.children.length - 1) * parseFloat(css.columnGap)
        + parseFloat(css.paddingLeft) + parseFloat(css.paddingRight));
    }
    const area = bottomOverlayArea(vr.width, vr.height, host.insets, z, pill, inset, gap, bottomClearance, minimumWidth);
    let offset = nativeToast ? pill + 10 : 0;
    if (host.native) {
      const geometry = { x: vr.left + area.x, y: vr.top + area.y, width: area.width };
      const key = JSON.stringify(geometry);
      if (key !== sent) { sent = key; host.post({ bottomOverlay: geometry }); }
    }
    // The comments bar sits at the top centre, clear of the tool palette and its popovers at the bottom.
    if (bar) {
      const set = (key, value) => { if (bar.style[key] !== value) bar.style[key] = value; };
      set('maxWidth', area.width + 'px'); set('width', 'max-content'); set('boxSizing', 'border-box'); set('whiteSpace', 'normal');
      set('left', area.x + 'px'); set('right', 'auto'); set('bottom', 'auto');
      set('translate', '-50% 0'); set('transform', 'none');
      set('top', ((host.insets && host.insets.t) || 0) + inset + 'px');
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
      const lift = area.aboveZoom ? Math.max(0, h - pill) / 2 : 0;
      set('top', (area.y - offset - lift + (fixed ? vr.top : 0)) + 'px');
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
