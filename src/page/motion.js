import { composeAffine, motionPose, poseAffine } from "./motion-logic.js";
import { hideMotionRoots, planMotion } from "./motion-lift.js";

const host = window.canvasHost;
if (host) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const stats = { evaluations: 0, wakes: 0, sprites: 0, skipped: [], hoverToFirstPoseMs: null, poses: 0 };
  let desired = null, entered = 0, active = null, preview = false, playing = false, trace = null;
  let rejected = null;
  let wasReduced = reduce.matches;
  const wake = () => { stats.wakes++; host.requestFrame(); };

  function stop() {
    if (!active) return false;
    const { board, source, scene, ev, sprites } = active;
    active = null;
    playing = false;
    stats.sprites = 0;
    if (host.engineView === ev) {
      const current = ev.motionSource(board);
      if (current?.content === source.content) {
        ev.motionBoard(board, current.x, current.y, scene, source.text);
        ev.engine.drawNow(board);
      } else if (ev.isParked(board)) {
        ev.motionBoard(board, source.x, source.y, scene, source.text);
        ev.engine.setBoardHidden(board, true);
      }
      for (const sprite of sprites) ev.engine.removeBoard(sprite.id);
    }
    host.emit("motionSprites");
    return true;
  }

  function start(board) {
    const ev = host.engineView, e = ev?.engine;
    const source = ev?.motionSource(board);
    if (!source || !e?.setBoardSprite || ev.compactOverview() || host.live?.touched(board)) {
      rejected = null;
      return;
    }
    const scale = host.cam.z * devicePixelRatio, budget = e.textureBudget() * 0.25;
    const { content, x, y, fontLayout } = source;
    if (rejected?.ev === ev && rejected.board === board && rejected.content === content &&
        rejected.x === x && rejected.y === y && rejected.fontLayout === fontLayout &&
        rejected.scale === scale && rejected.budget === budget) return;
    rejected = null;
    const scene = JSON.parse(source.text);
    const { sprites, skipped } = planMotion(scene.root, n => {
      const placement = e.nodeMotionRect(board, n.id);
      const box = n.type === "group" ? e.nodeRectIn(board, n.id) : placement;
      return { box, placement, ink: e.nodeInkIn(board, n.id), get bounds() { return e.nodeRectIn(board, n.id); } };
    }, { scale, budget });
    stats.skipped = skipped;
    stats.hoverToFirstPoseMs = null;
    if (!sprites.length) {
      rejected = { ev, board, content, x, y, fontLayout, scale, budget };
      return;
    }
    const made = [], parents = new Map();
    const promoted = new Set(sprites.map(s => s.node.id));
    try {
      for (const sprite of sprites) {
        const { node, placement: r, clip, animateOpacity } = sprite;
        const id = "\u0000motion:" + made.length;
        // Keep the layer in board coordinates so its raster uses the same pixel grid as the static board.
        const child = { ...node, x: r.x - source.x, y: r.y - source.y, layoutPosition: "absolute" };
        if (child.children?.length) child.children = child.children.map(k => hideMotionRoots(k, promoted));
        if (node.width !== undefined || node.type !== "group") child.width = r.w;
        if (node.height !== undefined || node.type !== "group") child.height = r.h;
        if (animateOpacity) child.opacity = 1;
        const root = { id, type: "frame", width: r.w, height: r.h, layout: "none", children: [child] };
        // Keep the board's registered resources. Only the subtree's paint refers to them.
        ev.motionBoard(id, source.x, source.y, { ...scene, id, root });
        const restAlpha = animateOpacity ? (sprite.compiled.tracks.find(t => t.prop === "opacity")?.rest ?? 1) : 1;
        const entry = { ...sprite, id, rest: poseAffine({ opacity: restAlpha }, sprite.pivot), last: null, pose: null, presentedPose: null, basis: null, parent: parents.get(sprite.parent) };
        made.push(entry);
        if (node.children?.length) parents.set(sprite, entry);
        if (!e.setBoardSprite(id, board, new Float64Array(clip ? [clip.x, clip.y, clip.w, clip.h] : []))) throw new Error("Could not attach motion sprite");
        e.drawNow(id);
      }
      active = { board, source, scene, ev, sprites: made, phase: "enter", at: 0, preview };
      ev.motionBoard(board, source.x, source.y, { ...scene, root: hideMotionRoots(scene.root, promoted) });
      e.drawNow(board);
      active.at = performance.now();
      stats.sprites = made.length;
      host.emit("motionSprites");
    } catch (err) {
      if (active) stop();
      else for (const sprite of made) e.removeBoard(sprite.id);
      console.warn("[canvas] motion:", err);
    }
  }

  function phase(name, now) {
    active.phase = name;
    active.at = now;
    for (const s of active.sprites) s.basis = s.presentedPose;
  }

  function tick() {
    playing = false;
    // A queued playback frame can see the new preference before the change event arrives.
    const reduced = reduce.matches, becameReduced = reduced && !wasReduced;
    wasReduced = reduced;
    if (!active && !desired) return;
    if (host.motionBlocked()) {
      desired = null; preview = false; rejected = null;
      stop();
      return;
    }
    const now = performance.now();
    if (active) {
      const { ev, board, source } = active, next = ev.motionSource(board);
      if (host.engineView !== ev || !host.boards.has(board) || !next || next.content !== source.content || next.x !== source.x || next.y !== source.y || host.live?.touched(board)) stop();
    }
    if (active && desired && (active.board !== desired || (preview && !active.preview))) stop();
    if (!active && desired) start(desired);
    if (!active) return;
    if (becameReduced) {
      if (!desired) { stop(); return; }
      phase("enter", now);
    }
    active.frame = active.ev.engine.spriteFrame?.();
    if (desired && (active.phase === "leave" || active.phase === "still") && !active.preview) phase("enter", now);
    if (!desired && (active.phase === "enter" || active.phase === "settled") && !active.preview) {
      if (reduced || !active.presented) { stop(); return; }
      phase("leave", now);
    }
    if (active.phase === "preview-end") {
      if (!active.presented) { stop(); return; }
      phase("leave", now);
    }
    if (active.phase === "still" || active.phase === "settled") return;
    const elapsed = Math.max(0, now - active.at);
    let done = true, held = false;
    for (const s of active.sprites) {
      // An explicit preview runs one cycle, including tracks that normally loop indefinitely.
      const compiled = active.preview ? s.previewMotion ??= { ...s.compiled, tracks: s.compiled.tracks.map(t => ({ ...t, cycles: 1 })) } : s.compiled;
      const options = { end: reduced && active.phase === "enter" };
      if (active.phase === "leave") options.leave = s.basis;
      else options.enter = s.basis;
      const pose = motionPose(compiled, elapsed, options);
      stats.evaluations++;
      const local = poseAffine(pose.values, s.pivot, compiled.origins);
      const affine = s.parent ? composeAffine(s.parent.last ?? s.parent.rest, local) : local;
      const prior = s.last ?? s.rest;
      const changed = affine.some((v, i) => v !== prior[i]);
      if ((s.last && !changed) || active.ev.engine.setBoardTransform(s.id, ...affine)) {
        active.posePending ||= changed;
        s.last = affine;
        s.pose = pose;
      }
      done &&= pose.done;
      held ||= pose.held;
    }
    if (done && active.phase === "leave") {
      if (held && !active.preview) {
        active.phase = "still";
        host.emit("motionSprites");
      } else stop();
    } else if (done && active.preview) {
      desired = null; preview = false;
      if (reduced) {
        // Keep the end pose visible for the preview before restoring it.
        active.phase = "still";
        const run = active;
        setTimeout(() => { if (active === run && stop()) wake(); }, 500);
      } else {
        active.phase = "preview-end";
        playing = true;
      }
    } else if (done) active.phase = "settled";
    else playing = true;
  }

  const canHover = id => !!id && host.prefs().playHoverMotion && !host.motionBlocked() && !!host.engineView?.motionSource(id);
  const setHover = (id, time = performance.now()) => {
    if (preview || active?.preview) return;
    if (!id && !desired && !active) return;
    if (!canHover(id)) id = null;
    if (desired === id) return;
    desired = id;
    rejected = null;
    entered = time;
    wake();
  };
  host.beforeFrame(tick);
  host.motion = {
    hover: setHover,
    canHover,
    get active() { return !!active; },
    get outlineBoard() { return active && (active.phase !== "still" || active.preview) ? active.board : null; },
    invalidate(id) { if (active?.board === id || desired === id) this.cancel(); },
    cancel() { desired = null; preview = false; rejected = null; if (stop()) wake(); },
    preview(id) {
      const ev = host.engineView, board = host.boards.has(id) ? id : ev?.boardOf(id);
      const rect = board && ev?.rect(board);
      if (rect && Math.min(rect.w, rect.h) * host.cam.z >= 48 && ev.motionSource(board) && !host.motionBlocked()) {
        desired = board; preview = true; rejected = null; entered = performance.now(); wake();
      }
    },
    // Only wake the existing frame loop when a pose can still advance.
    afterFrame() {
      if (active && active.ev.engine.spriteFrame?.() !== active.frame) {
        active.presented = true;
        for (const s of active.sprites) s.presentedPose = s.pose;
        if (active.posePending) {
          active.posePending = false;
          const now = performance.now();
          stats.poses++;
          if (stats.hoverToFirstPoseMs === null) stats.hoverToFirstPoseMs = now - entered;
          if (trace && trace.length < 2000) trace.push(now);
        }
      }
      if (playing && !document.hidden) wake();
    },
  };
  const cancel = () => host.motion.cancel();
  for (const event of ["page", "tab"]) host.on(event, cancel);
  host.on("prefs", p => { if (!p.playHoverMotion) cancel(); });
  host.on("cmd", c => { if (c.cmd === "motionPreview") host.motion.preview(c.id); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancel(); });
  reduce.addEventListener("change", () => {
    if (active) wake();
  });
  host.view.addEventListener("pointerdown", cancel, true);
  host.view.addEventListener("pointerleave", () => setHover(null));
  window.__motion = Object.assign(stats, {
    record() { trace = []; },
    recorded() { const frames = trace ?? []; trace = null; return frames; },
  });
}
