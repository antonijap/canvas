//! Shader cards, the GPU-free half (unit tested on the host): checking untrusted WGSL before it
//! reaches the browser, wrapping it with our entry points, the texture size a card renders at, which
//! cards may play this frame, and each card's clock. The GPU half lives in `shade.rs`.
//!
//! A shader card is free-standing (never inside a board in phase 1). Its texture lives outside the
//! board tile cache: playing a shader never invalidates a tile.
//!
//! The source an author writes defines one function:
//!
//! ```wgsl
//! fn shade(p: vec2<f32>) -> vec4<f32> {
//!   // p: this pixel in card px, (0,0) top-left, u.resolution bottom-right
//!   let uv = p / u.resolution;
//!   return vec4<f32>(uv, 0.5 + 0.5 * sin(u.time), 1.0); // premultiplied RGBA
//! }
//! ```
//!
//! and may read the uniforms `u.resolution` (card size in card px), `u.time` (s), `u.delta` (s),
//! `u.frame`, `u.mouse` (x, y in card px; z = 1 while hovered; w = 1 while pressed) and `u.params`
//! (`PARAM_SLOTS` vec4 slots, set with setShaderParams; Paper Shaders presets keep their uniforms there,
//! src/paper.ts). `canvas_noise(uv)` samples Paper's 128 px noise texture (linear, clamped). The output is
//! premultiplied alpha: the compositor draws it as is.

/// Largest source accepted, in bytes.
pub const MAX_SOURCE: usize = 64 * 1024;
/// Texture cap (long side, device px) once the camera rests for a card whose cost is unknown or high, and
/// for every card during a gesture. At rest a card that can afford it gets more (`card_cap`).
pub const CAP_SETTLED: f64 = 1024.0;
pub const CAP_GESTURE: f64 = 512.0;
/// No card texture is longer than this.
pub const CAP_MAX: f64 = 4096.0;
/// A shader renders above `CAP_SETTLED` while one frame of it is predicted to stay under this.
pub const FULL_RES_MS: f64 = 2.0;
/// A card smaller than this (short side, device px) does not render at all.
pub const MIN_SIDE: f64 = 32.0;
/// At most this many cards play at once (the hovered one comes on top).
pub const MAX_PLAYING: usize = 4;
/// Predicted GPU ms per rendered shader frame, for every playing card together.
pub const GPU_BUDGET_MS: f64 = 4.0;
/// A hovered card plays outside the budget up to this predicted cost per frame.
pub const HOVER_CEIL_MS: f64 = 8.0;
/// Frame period: 30 fps by default, 60 while hovered.
pub const PERIOD_MS: f64 = 1000.0 / 30.0;
pub const PERIOD_HOVER_MS: f64 = 1000.0 / 60.0;
/// A deadline counts as reached this early (rAF ticks every 8.3 or 16.7 ms).
pub const SLACK_MS: f64 = 6.0;
/// Snapshot and poster time.
pub const POSTER_T: f64 = 2.0;
/// GPU bytes for every shader texture together.
pub const TEXTURE_BUDGET: u64 = 64 * 1024 * 1024;
/// vec4 slots in `u.params` (src/paper.ts PARAM_SLOTS).
pub const PARAM_SLOTS: usize = 32;
/// Floats in `u.params`.
pub const PARAM_FLOATS: usize = PARAM_SLOTS * 4;
/// Floats in the uniform block (see WRAPPER).
pub const UNIFORM_FLOATS: usize = 12 + PARAM_FLOATS;
/// Uniform block size (see WRAPPER).
pub const UNIFORM_BYTES: u64 = (UNIFORM_FLOATS * 4) as u64;
/// Paper Shaders' noise texture (get-shader-noise-texture.ts), RGBA8 premultiplied, 128 x 128; written by
/// scripts/paper/gen.ts.
pub const NOISE_RGBA: &[u8] = include_bytes!("paper_noise.rgba");
pub const NOISE_SIZE: u32 = 128;

/// One problem in a source, 1-based line and column (bytes) of where it starts.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct SrcError {
    pub line: u32,
    pub col: u32,
    pub message: String,
}

/// What we append to the author's source. It comes after their code, so their line numbers are the
/// compiler's line numbers. Names start with `canvas_` (and `u`) to stay out of the author's way.
pub const WRAPPER: &str = r#"
struct CanvasUniforms {
  resolution: vec2<f32>,
  time: f32,
  delta: f32,
  mouse: vec4<f32>,
  canvas_texel: vec2<f32>,
  frame: f32,
  canvas_pad: f32,
  params: array<vec4<f32>, 32>,
};
@group(0) @binding(0) var<uniform> u: CanvasUniforms;
@group(0) @binding(1) var canvas_noise_tex: texture_2d<f32>;
@group(0) @binding(2) var canvas_noise_smp: sampler;
fn canvas_noise(uv: vec2<f32>) -> vec4<f32> {
  return textureSampleLevel(canvas_noise_tex, canvas_noise_smp, uv, 0.0);
}
@vertex fn canvas_vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  var c = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(c[i], 0.0, 1.0);
}
@fragment fn canvas_fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let c = shade(pos.xy * u.canvas_texel);
  return clamp(c, vec4<f32>(0.0), vec4<f32>(1.0));
}
"#;

/// The author's source plus our entry points.
pub fn wrap(src: &str) -> String {
    let mut s = String::with_capacity(src.len() + WRAPPER.len() + 1);
    s.push_str(src);
    if !src.ends_with('\n') {
        s.push('\n');
    }
    s.push_str(WRAPPER);
    s
}

/// Lines of the author's source (compiler messages past it are about the wrapper).
pub fn user_lines(src: &str) -> u32 {
    src.lines().count().max(1) as u32
}

/// The source with comments blanked out (same length, newlines kept), so positions still match.
fn strip_comments(src: &str) -> Vec<u8> {
    let b = src.as_bytes();
    let mut out = b.to_vec();
    let mut i = 0;
    let mut depth = 0usize;
    while i < b.len() {
        if depth == 0 && b[i] == b'/' && b.get(i + 1) == Some(&b'/') {
            while i < b.len() && b[i] != b'\n' {
                out[i] = b' ';
                i += 1;
            }
            continue;
        }
        if b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
            depth += 1;
            out[i] = b' ';
            out[i + 1] = b' ';
            i += 2;
            continue;
        }
        if depth > 0 && b[i] == b'*' && b.get(i + 1) == Some(&b'/') {
            depth -= 1;
            out[i] = b' ';
            out[i + 1] = b' ';
            i += 2;
            continue;
        }
        if depth > 0 && b[i] != b'\n' {
            out[i] = b' ';
        }
        i += 1;
    }
    out
}

fn pos_of(b: &[u8], at: usize) -> (u32, u32) {
    let before = &b[..at];
    let line = before.iter().filter(|&&c| c == b'\n').count() as u32 + 1;
    let col = (at - before.iter().rposition(|&c| c == b'\n').map_or(0, |p| p + 1)) as u32 + 1;
    (line, col)
}

fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// Every place `word` stands as a whole token.
fn find_word(b: &[u8], word: &[u8]) -> Vec<usize> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + word.len() <= b.len() {
        if &b[i..i + word.len()] == word {
            let before_ok = i == 0 || !is_ident(b[i - 1]) || word[0] == b'@';
            let after_ok = b.get(i + word.len()).is_none_or(|&c| !is_ident(c));
            if before_ok && after_ok {
                out.push(i);
            }
        }
        i += 1;
    }
    out
}

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

/// Check an untrusted source before it is compiled. Fragment code only: no entry points of its own,
/// no bindings (we bind one uniform block), no storage, workgroup memory, atomics, textures or
/// samplers, no extensions. The loop check is best effort: it refuses `loop` without any `break`,
/// `while true` and `for (;;)`, but a loop with a huge or data-dependent bound still passes. The
/// real backstop for a hung GPU is the device-loss quarantine on the page.
pub fn check_source(src: &str) -> Result<(), Vec<SrcError>> {
    let mut errs = Vec::new();
    if src.len() > MAX_SOURCE {
        errs.push(SrcError { line: 1, col: 1, message: format!("The shader is {} KB; the limit is {} KB", src.len() / 1024, MAX_SOURCE / 1024) });
        return Err(errs);
    }
    let b = strip_comments(src);
    let at = |i: usize, message: String| {
        let (line, col) = pos_of(&b, i);
        SrcError { line, col, message }
    };
    const BANNED: &[(&str, &str)] = &[
        ("@compute", "compute shaders are not allowed; write fn shade(p) instead"),
        ("@vertex", "Canvas provides the vertex stage; write fn shade(p) instead"),
        ("@fragment", "Canvas provides the entry point; write fn shade(p) instead"),
        ("@group", "bindings are not allowed; read the uniforms through u"),
        ("@binding", "bindings are not allowed; read the uniforms through u"),
        ("@workgroup_size", "compute shaders are not allowed"),
        ("enable", "extensions are not allowed"),
        ("requires", "language extensions are not allowed"),
        ("storage", "storage memory is not allowed"),
        ("workgroup", "workgroup memory is not allowed"),
        ("atomic", "atomics are not allowed"),
        ("sampler", "samplers are not allowed: Canvas binds no textures in this version"),
        ("sampler_comparison", "samplers are not allowed"),
    ];
    for (word, why) in BANNED {
        for i in find_word(&b, word.as_bytes()) {
            errs.push(at(i, format!("{word}: {why}")));
        }
    }
    // Texture types: texture_2d, texture_storage_2d, texture_external, ...
    let mut i = 0;
    while let Some(p) = b[i..].windows(8).position(|w| w == b"texture_") {
        let k = i + p;
        if k == 0 || !is_ident(b[k - 1]) {
            errs.push(at(k, "textures are not allowed: Canvas binds no textures in this version".into()));
        }
        i = k + 8;
    }
    // Loops (best effort).
    let has_break = !find_word(&b, b"break").is_empty();
    for i in find_word(&b, b"loop") {
        if !has_break {
            errs.push(at(i, "loop without break never ends; use a for loop with a fixed bound".into()));
        }
    }
    for i in find_word(&b, b"while") {
        let mut j = skip_ws(&b, i + 5);
        let paren = b.get(j) == Some(&b'(');
        if paren {
            j = skip_ws(&b, j + 1);
        }
        if b[j..].starts_with(b"true") && b.get(j + 4).is_none_or(|&c| !is_ident(c)) {
            errs.push(at(i, "while true never ends; use a for loop with a fixed bound".into()));
        }
    }
    for i in find_word(&b, b"for") {
        let j = skip_ws(&b, i + 3);
        if b.get(j) == Some(&b'(') {
            let k = skip_ws(&b, j + 1);
            // for (;;) or for (init; ; step): an empty condition
            if let Some(semi) = b[k..].iter().position(|&c| c == b';') {
                let after = skip_ws(&b, k + semi + 1);
                if b.get(after) == Some(&b';') {
                    errs.push(at(i, "a for loop without a condition never ends".into()));
                }
            }
        }
    }
    // The entry the wrapper calls.
    let shade = find_word(&b, b"shade").into_iter().any(|i| {
        let before = &b[..i];
        let t = before.iter().rposition(|c| !c.is_ascii_whitespace());
        t.is_some_and(|t| t >= 1 && &before[t - 1..=t] == b"fn" && (t < 2 || !is_ident(before[t - 2])))
    });
    if !shade {
        errs.push(SrcError { line: 1, col: 1, message: "Define fn shade(p: vec2<f32>) -> vec4<f32>; it returns the premultiplied colour of the pixel at p (card px)".into() });
    }
    errs.sort_by_key(|e| (e.line, e.col));
    if errs.is_empty() { Ok(()) } else { Err(errs) }
}

/// The texture size for a card of `w` × `h` world units at zoom `z` and `dpr`, aspect kept and the
/// long side capped at `cap`. `None` when it is too small to draw: the same test (`renderable`) the
/// texture allocation applies, after the cap, so a card that gets no texture never waits for a frame.
pub fn tex_size(w: f64, h: f64, z: f64, dpr: f64, cap: f64) -> Option<(u32, u32)> {
    let (dw, dh) = (w * z * dpr, h * z * dpr);
    if !(dw.is_finite() && dh.is_finite()) {
        return None;
    }
    let k = (cap / dw.max(dh)).min(1.0);
    let size = ((dw * k).round().max(1.0) as u32, (dh * k).round().max(1.0) as u32);
    renderable(size).then_some(size)
}

/// The cap (long side, device px) for one card. A constant 1024 px drew every card wider than 512 CSS px on a
/// Retina display upscaled (audit finding 7). At rest a video gets what its frames hold (the part of the
/// `video_native` frame a card of `aspect` = w / h shows: a copy costs the same whatever the target), and a
/// shader as many pixels as `FULL_RES_MS` buys at its measured `ms_per_mpx`; never below `CAP_SETTLED`,
/// never above `CAP_MAX`. `tex_size` still stops at the on-screen size, and the textures of all cards
/// together at `TEXTURE_BUDGET`.
pub fn card_cap(moving: bool, video_native: Option<(u32, u32)>, ms_per_mpx: f64, aspect: f64) -> f64 {
    if moving {
        return CAP_GESTURE;
    }
    let aspect = if aspect.is_finite() && aspect > 0.0 { aspect } else { 1.0 };
    let long = match video_native {
        Some(n) => {
            let c = crop_px(n, cover_crop(n, aspect));
            f64::from(c.0.max(c.1))
        }
        None if ms_per_mpx > 0.0 => ((FULL_RES_MS - 0.05) / ms_per_mpx * 1e6 * aspect.max(1.0 / aspect)).sqrt(),
        None => CAP_SETTLED,
    };
    long.clamp(CAP_SETTLED, CAP_MAX)
}

/// A card texture this size is worth allocating and drawing.
pub fn renderable(size: (u32, u32)) -> bool {
    f64::from(size.0.min(size.1)) >= MIN_SIDE
}

/// Does a card that is not playing need a new still picture (a poster, the snapshot frame or a video's
/// current frame)? When it has none, and when the size it shows at changed since its picture was drawn
/// (`drawn_for`: the size asked for then): a card zoomed or resized while still would otherwise
/// stretch a small or wrongly cropped picture forever.
pub fn needs_still(has_frame: bool, drawn_for: Option<(u32, u32)>, size: (u32, u32)) -> bool {
    !has_frame || drawn_for.is_some_and(|d| d != size)
}

/// Keep the current texture? During a gesture anything within 2x of the wanted size stays (the quad
/// scales); at rest a size within 15% stays, so a slow zoom does not reallocate every frame.
pub fn keep_size(cur: (u32, u32), want: (u32, u32), moving: bool) -> bool {
    // Another shape (a resize, a poster of another aspect) never stays: the quad would stretch it.
    let aspect = |s: (u32, u32)| f64::from(s.0.max(1)) / f64::from(s.1.max(1));
    if (aspect(cur) / aspect(want) - 1.0).abs() > 0.03 {
        return false;
    }
    let (c, w) = (f64::from(cur.0.max(cur.1)), f64::from(want.0.max(want.1)));
    let r = c / w;
    if moving { (0.5..=2.0).contains(&r) } else { (r - 1.0).abs() <= 0.15 }
}

/// Predicted GPU ms for one frame of a shader: its measured cost per megapixel times the pixels, plus
/// a fixed draw cost.
pub fn predict_ms(ms_per_mpx: f64, size: (u32, u32)) -> f64 {
    0.05 + ms_per_mpx * f64::from(size.0) * f64::from(size.1) / 1e6
}

/// One card competing to play this frame.
#[derive(Clone, Copy, Debug, Default)]
pub struct Cand {
    /// On-screen area in device px².
    pub area: f64,
    /// Predicted ms per frame (needs a measured cost: unknown cost is not eligible).
    pub cost: f64,
    pub hovered: bool,
    /// Ready (compiled, measured), on screen, not paused or quarantined, autoplay allowed or hovered.
    pub eligible: bool,
}

/// Which cards play: hovered (or forced) ones first, outside the budget but together within
/// `HOVER_CEIL_MS` and inside the slot cap, then the largest on screen while there are slots and budget
/// left.
pub fn admit(c: &[Cand], budget_ms: f64, max: usize) -> Vec<bool> {
    let mut order: Vec<usize> = (0..c.len()).filter(|&i| c[i].eligible).collect();
    order.sort_by(|&a, &b| c[b].hovered.cmp(&c[a].hovered).then(c[b].area.total_cmp(&c[a].area)));
    let mut out = vec![false; c.len()];
    let (mut spent, mut hover_spent, mut n) = (0.0, 0.0, 0);
    for i in order {
        if n >= max {
            break;
        }
        if c[i].hovered {
            if hover_spent + c[i].cost <= HOVER_CEIL_MS {
                out[i] = true;
                hover_spent += c[i].cost;
                n += 1;
            }
            continue;
        }
        if spent + c[i].cost > budget_ms {
            continue;
        }
        out[i] = true;
        spent += c[i].cost;
        n += 1;
    }
    out
}

/// One card that might be measured (a cost probe renders it offscreen several times).
#[derive(Clone, Copy, Debug, Default)]
pub struct ProbeCand {
    /// Compiled, not measured (or due a second look), not probing now.
    pub wants: bool,
    /// On screen, in a visible window.
    pub visible: bool,
    /// On-screen area in device px².
    pub area: f64,
}

/// Probes in flight at once, at most.
pub const MAX_PROBES: usize = 2;

/// The card to start a cost probe for this frame, if any: visible ones only, the largest first, one per
/// frame and at most `MAX_PROBES` in flight. Cards off screen or in a hidden window wait: a probe is
/// several renders, and many offscreen shaders loading during a pan would otherwise all run theirs.
pub fn pick_probe(c: &[ProbeCand], in_flight: usize) -> Option<usize> {
    if in_flight >= MAX_PROBES {
        return None;
    }
    (0..c.len()).filter(|&i| c[i].wants && c[i].visible).max_by(|&a, &b| c[a].area.total_cmp(&c[b].area).then(b.cmp(&a)))
}

/// A cost measurement taken for source generation `measured_gen` lands on the card only while that is
/// still its generation (a newer source has its own cost). `keep_lowest`: probes keep the lowest
/// reading (callback latency only inflates it); explicit renders average with what is there.
pub fn apply_cost(cur: f64, k: f64, measured_gen: u64, current_gen: u64, keep_lowest: bool) -> f64 {
    if measured_gen != current_gen {
        return cur;
    }
    if cur <= 0.0 {
        k
    } else if keep_lowest {
        cur.min(k)
    } else {
        cur * 0.5 + k * 0.5
    }
}

/// A video card's still-picture state when the page gives it another element: the old clip's frame no
/// longer stands for the card, and the new one's first frame is wanted. Returns (has_frame, want,
/// last_time).
pub fn on_new_video_source() -> (bool, bool, f64) {
    (false, true, -1.0)
}

/// A card's time: advances only while it plays, from one engine timestamp per frame, and never by
/// more than 100 ms at once (a card coming back into view continues where it was).
#[derive(Clone, Copy, Debug, Default)]
pub struct Clock {
    pub t: f64,
    pub last: Option<f64>,
    pub frame: u64,
}

impl Clock {
    /// Advance to `now_ms`; returns the step in seconds.
    pub fn tick(&mut self, now_ms: f64) -> f64 {
        let dt = self.last.map_or(0.0, |l| (now_ms - l).clamp(0.0, 100.0) / 1000.0);
        self.t += dt;
        self.last = Some(now_ms);
        self.frame += 1;
        dt
    }
    /// Stopped: the next tick starts from zero step.
    pub fn stop(&mut self) {
        self.last = None;
    }
}

/// The uniform block (`UNIFORM_BYTES`, the layout of `CanvasUniforms` in WRAPPER).
pub fn uniforms(res: (f64, f64), tex: (u32, u32), t: f64, delta: f64, frame: u64, mouse: [f32; 4], params: &[f32; PARAM_FLOATS]) -> [f32; UNIFORM_FLOATS] {
    let mut u = [0f32; UNIFORM_FLOATS];
    u[0] = res.0 as f32;
    u[1] = res.1 as f32;
    u[2] = t as f32;
    u[3] = delta as f32;
    u[4..8].copy_from_slice(&mouse);
    u[8] = (res.0 / f64::from(tex.0.max(1))) as f32;
    u[9] = (res.1 / f64::from(tex.1.max(1))) as f32;
    u[10] = frame as f32;
    u[12..].copy_from_slice(params);
    u
}

/// Params from the page: up to `PARAM_FLOATS` finite numbers (the rest, and anything not finite, 0).
pub fn params_from(v: &[f32]) -> [f32; PARAM_FLOATS] {
    let mut p = [0f32; PARAM_FLOATS];
    for (d, s) in p.iter_mut().zip(v) {
        *d = if s.is_finite() { *s } else { 0.0 };
    }
    p
}

/// 64-bit FNV-1a of a source: two cards with the same source share nothing, but a re-sent source that
/// did not change is not compiled again.
pub fn source_hash(src: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &x in src.as_bytes() {
        h = (h ^ u64::from(x)).wrapping_mul(0x0100_0000_01b3);
    }
    h
}

// ---------------------------------------------------------------- video cards
//
// Video cards share everything above with shader cards: one list, one admission (at most
// MAX_PLAYING across both, largest on screen first, inside GPU_BUDGET_MS), the same texture budget,
// deadlines and rounded quads. What differs is where a frame comes from: the decoded frame of an
// HTMLVideoElement is copied (copyExternalImageToTexture) into a staging texture at the video's own
// size, then filtered down into the card's texture at its on-screen size (the quad never minifies a
// 4K frame). A frame is drawn only when the video's time moved since the last one.

/// GPU ms per megapixel of decoded frame for the copy (YUV to RGB, upload) until a copy is measured.
pub const VIDEO_COPY_MS_PER_MPX: f64 = 0.08;
/// GPU ms per megapixel per filter tap for the down-filter into the card texture.
pub const VIDEO_TAP_MS_PER_MPX: f64 = 0.01;
/// Largest number of taps per axis the down-filter takes (a 12x reduction still covers every texel).
pub const MAX_TAPS: u32 = 6;

/// The part of a `native` frame a card of `aspect` (w / h) shows, like CSS object-fit: cover: centred,
/// as large as fits. Returns (u0, v0, su, sv) in 0..1 of the frame.
pub fn cover_crop(native: (u32, u32), aspect: f64) -> [f32; 4] {
    let va = f64::from(native.0.max(1)) / f64::from(native.1.max(1));
    if !(aspect.is_finite() && aspect > 0.0) || (va - aspect).abs() < 1e-3 {
        return [0.0, 0.0, 1.0, 1.0];
    }
    if va > aspect {
        let su = aspect / va;
        [((1.0 - su) / 2.0) as f32, 0.0, su as f32, 1.0]
    } else {
        let sv = va / aspect;
        [0.0, ((1.0 - sv) / 2.0) as f32, 1.0, sv as f32]
    }
}

/// The source pixels a crop covers.
pub fn crop_px(native: (u32, u32), crop: [f32; 4]) -> (u32, u32) {
    (((f64::from(native.0) * f64::from(crop[2])).round() as u32).max(1), ((f64::from(native.1) * f64::from(crop[3])).round() as u32).max(1))
}

/// Taps per axis for filtering a `native` frame into a `size` texture: each bilinear tap covers two
/// texels, so a reduction of r needs ceil(r / 2) taps to leave no texel out.
pub fn blit_taps(native: (u32, u32), size: (u32, u32)) -> u32 {
    let r = (f64::from(native.0) / f64::from(size.0.max(1))).max(f64::from(native.1) / f64::from(size.1.max(1)));
    ((r / 2.0).ceil() as u32).clamp(1, MAX_TAPS)
}

/// Predicted GPU ms for one video frame: the copy at the decoded size (`copy_k` ms per megapixel,
/// measured or the default) plus the down-filter at the card size.
pub fn video_ms(copy_k: f64, native: (u32, u32), size: (u32, u32)) -> f64 {
    let mpx = |s: (u32, u32)| f64::from(s.0) * f64::from(s.1) / 1e6;
    let taps = f64::from(blit_taps(native, size));
    0.05 + copy_k * mpx(native) + VIDEO_TAP_MS_PER_MPX * mpx(size) * taps * taps
}

/// The down-filter's uniform block: source size, target size, taps per axis, the crop (see cover_crop).
pub fn blit_uniforms(native: (u32, u32), size: (u32, u32), crop: [f32; 4]) -> [f32; 12] {
    let taps = blit_taps(crop_px(native, crop), size) as f32;
    [native.0 as f32, native.1 as f32, size.0 as f32, size.1 as f32, taps, 0.0, 0.0, 0.0, crop[0], crop[1], crop[2], crop[3]]
}

/// Does a video card need a new upload? A playing card when its frame is due and the video's time
/// moved; a still card when it has no picture yet, or when the page asked for the current frame
/// (a seek, a scrub, the poster time). `ready` is HAVE_CURRENT_DATA or better: copying a video with
/// no current frame throws.
pub fn video_needs_frame(playing: bool, due: bool, ready: bool, has_frame: bool, want: bool, time: f64, last: f64) -> bool {
    if !ready {
        return false;
    }
    if playing {
        return due && (time != last || !has_frame);
    }
    !has_frame || want
}

/// Premultiplied to straight alpha, in place (a PNG stores straight alpha).
pub fn unpremultiply(px: &mut [u8]) {
    for p in px.as_chunks_mut::<4>().0 {
        let a = u32::from(p[3]);
        if a == 0 {
            p[0] = 0;
            p[1] = 0;
            p[2] = 0;
        } else if a < 255 {
            for c in &mut p[..3] {
                *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OK: &str = "fn shade(p: vec2<f32>) -> vec4<f32> {\n  let uv = p / u.resolution;\n  return vec4<f32>(uv, 0.5, 1.0);\n}\n";

    #[test]
    fn accepts_a_plain_shader() {
        assert_eq!(check_source(OK), Ok(()));
        let w = wrap(OK);
        assert!(w.starts_with(OK));
        assert!(w.contains("@fragment fn canvas_fs"));
        assert_eq!(user_lines(OK), 4);
    }

    #[test]
    fn refuses_entry_points_bindings_and_memory_with_positions() {
        let src = "@group(0) @binding(1) var<storage, read_write> b: array<f32>;\n@compute @workgroup_size(1) fn main() {}\nfn shade(p: vec2<f32>) -> vec4<f32> { return vec4<f32>(1.0); }\n";
        let e = check_source(src).unwrap_err();
        let at: Vec<(u32, u32)> = e.iter().map(|e| (e.line, e.col)).collect();
        assert!(at.contains(&(1, 1)), "{e:?}");
        assert!(at.contains(&(1, 11)), "{e:?}");
        assert!(e.iter().any(|e| e.message.starts_with("storage")), "{e:?}");
        assert!(e.iter().any(|e| e.line == 2 && e.message.starts_with("@compute")), "{e:?}");
    }

    #[test]
    fn refuses_textures_samplers_atomics_and_extensions() {
        let src = "enable f16;\nvar<private> a: atomic<u32>;\nfn f(t: texture_2d<f32>, s: sampler) {}\nfn shade(p: vec2<f32>) -> vec4<f32> { return vec4<f32>(1.0); }\n";
        let e = check_source(src).unwrap_err();
        assert!(e.iter().any(|e| e.line == 1 && e.message.starts_with("enable")));
        assert!(e.iter().any(|e| e.line == 2 && e.message.starts_with("atomic")));
        assert!(e.iter().any(|e| e.line == 3 && e.message.starts_with("textures")));
        assert!(e.iter().any(|e| e.line == 3 && e.message.starts_with("sampler")));
    }

    #[test]
    fn comments_do_not_count_and_identifiers_containing_words_pass() {
        let src = "// @compute storage loop\n/* while (true) { texture_2d } */\nfn shade(p: vec2<f32>) -> vec4<f32> {\n  let storage_like = 1.0; let my_loop = 2.0;\n  return vec4<f32>(storage_like, my_loop, 0.0, 1.0);\n}\n";
        assert_eq!(check_source(src), Ok(()));
    }

    #[test]
    fn unbounded_loops_are_refused_bounded_ones_pass() {
        let bad = "fn shade(p: vec2<f32>) -> vec4<f32> {\n  loop { }\n  while (true) { }\n  for (var i = 0; ; i++) { }\n  return vec4<f32>(1.0);\n}\n";
        let e = check_source(bad).unwrap_err();
        let lines: Vec<u32> = e.iter().map(|e| e.line).collect();
        assert_eq!(lines, vec![2, 3, 4], "{e:?}");
        let good = "fn shade(p: vec2<f32>) -> vec4<f32> {\n  var s = 0.0;\n  for (var i = 0; i < 64; i++) { s += 0.01; }\n  loop { s += 1.0; if (s > 3.0) { break; } }\n  return vec4<f32>(s);\n}\n";
        assert_eq!(check_source(good), Ok(()));
    }

    #[test]
    fn needs_fn_shade_and_a_size_limit() {
        let e = check_source("fn other() {}").unwrap_err();
        assert!(e[0].message.contains("fn shade"));
        // `shade` used but not defined as a function
        assert!(check_source("const shade = 1.0;").is_err());
        let big = format!("fn shade(p: vec2<f32>) -> vec4<f32> {{ return vec4<f32>(1.0); }}\n{}", " ".repeat(MAX_SOURCE));
        assert!(check_source(&big).unwrap_err()[0].message.contains("limit"));
    }

    #[test]
    fn texture_size_keeps_aspect_caps_and_floors() {
        assert_eq!(tex_size(480.0, 270.0, 1.0, 2.0, CAP_SETTLED), Some((960, 540)));
        assert_eq!(tex_size(800.0, 400.0, 1.0, 2.0, CAP_SETTLED), Some((1024, 512)));
        assert_eq!(tex_size(800.0, 400.0, 1.0, 2.0, CAP_GESTURE), Some((512, 256)));
        assert_eq!(tex_size(400.0, 300.0, 0.02, 2.0, CAP_SETTLED), None);
    }

    /// Audit finding 7: a 1000 x 600 card at 100% on a 2x display (2000 x 1200 device px) got a 1024 x 614
    /// texture. A cheap shader and a video with the pixels now render at the size on screen.
    #[test]
    fn a_card_that_can_afford_it_renders_at_the_on_screen_size() {
        let size = |cap| tex_size(1000.0, 600.0, 1.0, 2.0, cap);
        let a = 1000.0 / 600.0;
        assert_eq!(size(card_cap(false, None, 0.2, a)), Some((2000, 1200)), "0.2 ms per Mpx: 2.4 Mpx cost 0.5 ms");
        assert_eq!(size(card_cap(false, None, 5.0, a)), Some((1024, 614)), "an expensive shader stays at the old cap");
        assert_eq!(size(card_cap(false, None, 1.6, a)), Some((1425, 855)), "in between: what 2 ms buys");
        assert!(predict_ms(1.6, (1425, 855)) <= FULL_RES_MS + 0.01);
        assert_eq!(size(card_cap(false, None, 0.0, a)), Some((1024, 614)), "cost not measured yet");
        assert_eq!(size(card_cap(true, None, 0.2, a)), Some((512, 307)), "a gesture keeps the small cap");
        assert_eq!(size(card_cap(false, Some((3840, 2160)), 0.0, a)), Some((2000, 1200)), "a 4K video: the size on screen");
        assert_eq!(size(card_cap(false, Some((1280, 720)), 0.0, a)), Some((1200, 720)), "a 720p proxy: the 1200 x 720 the card shows of it, not more");
        assert_eq!(size(card_cap(false, Some((0, 0)), 0.0, a)), Some((1024, 614)), "a video not loaded yet");
        assert_eq!(tex_size(4000.0, 2000.0, 2.0, 2.0, card_cap(false, None, 0.001, 2.0)), Some((4096, 2048)), "never past CAP_MAX");
    }

    /// Codex hunt 2, engine 6: one renderability test for sizing and allocation. A 28 px short side
    /// used to pass `tex_size` (>= 24) and fail the allocation (< 32): no picture, frames forever. A
    /// long thin card also passed before its long side was capped.
    #[test]
    fn too_small_cards_get_no_size_at_all() {
        assert_eq!(tex_size(14.0, 100.0, 1.0, 2.0, CAP_SETTLED), None, "28 px short side");
        assert_eq!(tex_size(16.0, 100.0, 1.0, 2.0, CAP_SETTLED), Some((32, 200)));
        assert_eq!(tex_size(4000.0, 60.0, 1.0, 2.0, CAP_SETTLED), None, "120 px before the cap, 15 after");
        for (w, h, z) in [(30.0, 30.0, 0.5), (300.0, 17.0, 1.0), (1000.0, 1000.0, 0.01), (64.0, 900.0, 0.27)] {
            if let Some(s) = tex_size(w, h, z, 2.0, CAP_SETTLED) {
                assert!(renderable(s), "{w} {h} {z}: {s:?}");
            }
        }
    }

    /// Codex hunt 2, engine 11: a still card zoomed or resized gets a new picture at its new size.
    #[test]
    fn still_pictures_follow_the_size() {
        assert!(needs_still(false, None, (100, 100)));
        assert!(!needs_still(true, Some((100, 100)), (100, 100)));
        assert!(needs_still(true, Some((100, 100)), (300, 300)), "zoomed in");
        assert!(needs_still(true, Some((200, 100)), (100, 100)), "another aspect: a video's crop changes");
        // The size asked for counts, not the texture the budget granted: a starved card does not redraw
        // every frame.
        assert!(!needs_still(true, Some((1000, 1000)), (1000, 1000)));
    }

    /// Codex hunt 2, engine 12: a paused video card given another element drops the old clip's frame
    /// and asks for the new one.
    #[test]
    fn a_new_video_element_wants_its_own_first_frame() {
        let (has_frame, want, last) = on_new_video_source();
        assert!(!has_frame && want && last < 0.0);
        assert!(video_needs_frame(false, false, true, has_frame, want, 0.0, last));
    }

    /// Codex hunt 2, engine 13: a measurement of a replaced source does not overwrite the new one's cost.
    #[test]
    fn stale_measurements_are_dropped() {
        assert_eq!(apply_cost(2.0, 9.0, 3, 4, false), 2.0, "measured gen 3, the card is at 4");
        assert_eq!(apply_cost(2.0, 4.0, 4, 4, false), 3.0);
        assert_eq!(apply_cost(2.0, 4.0, 4, 4, true), 2.0);
        assert_eq!(apply_cost(0.0, 4.0, 4, 4, true), 4.0);
    }

    /// Codex hunt 2, engine 4: probes only for visible cards, one start per frame, two in flight.
    #[test]
    fn probes_wait_for_visibility_and_run_two_at_a_time() {
        let p = |wants, visible, area| ProbeCand { wants, visible, area };
        let cards = [p(true, false, 900.0), p(true, true, 100.0), p(false, true, 800.0), p(true, true, 400.0)];
        assert_eq!(pick_probe(&cards, 0), Some(3));
        assert_eq!(pick_probe(&cards, MAX_PROBES), None);
        assert_eq!(pick_probe(&[p(true, false, 10.0)], 0), None, "offscreen cards wait");
    }

    #[test]
    fn resize_hysteresis() {
        assert!(keep_size((1000, 500), (1100, 550), false));
        assert!(!keep_size((1000, 500), (1200, 600), false));
        assert!(keep_size((512, 256), (1000, 500), true));
        assert!(!keep_size((200, 100), (1000, 500), true));
        assert!(!keep_size((1024, 576), (1024, 1024), false));
    }

    #[test]
    fn admission_ranks_by_area_within_budget_and_slots() {
        let c = |area: f64, cost: f64| Cand { area, cost, hovered: false, eligible: true };
        let cands = [c(100.0, 1.0), c(400.0, 1.0), c(300.0, 3.5), c(200.0, 1.0), c(50.0, 0.5), c(10.0, 0.1)];
        // 400 (1.0) + 300 (3.5) would be 4.5 > 4: 300 is skipped; then 200, 100, 50: four slots.
        assert_eq!(admit(&cands, GPU_BUDGET_MS, MAX_PLAYING), vec![true, true, false, true, true, false]);
    }

    #[test]
    fn hovered_plays_outside_the_budget_up_to_its_ceiling() {
        let mut cands = vec![Cand { area: 1.0, cost: 6.0, hovered: true, eligible: true }, Cand { area: 9.0, cost: 3.0, hovered: false, eligible: true }];
        assert_eq!(admit(&cands, GPU_BUDGET_MS, MAX_PLAYING), vec![true, true]);
        cands[0].cost = 20.0;
        assert_eq!(admit(&cands, GPU_BUDGET_MS, MAX_PLAYING), vec![false, true]);
        cands[1].eligible = false;
        assert_eq!(admit(&cands, GPU_BUDGET_MS, MAX_PLAYING), vec![false, false]);
        // A hovered card counts toward the four.
        let c = |hovered: bool| Cand { area: 1.0, cost: 0.1, hovered, eligible: true };
        let five = [c(true), c(false), c(false), c(false), c(false)];
        assert_eq!(admit(&five, GPU_BUDGET_MS, MAX_PLAYING).iter().filter(|&&a| a).count(), 4);
    }

    /// Codex hunt 2, engine 5: eight forced videos (the person pressed play on each) still play at most
    /// four at a time, and together within the hover ceiling.
    #[test]
    fn forced_cards_respect_the_cap_and_one_ceiling() {
        let c = |area: f64, cost: f64| Cand { area, cost, hovered: true, eligible: true };
        let eight: Vec<Cand> = (0..8).map(|i| c(f64::from(i), 1.0)).collect();
        let a = admit(&eight, GPU_BUDGET_MS, MAX_PLAYING);
        assert_eq!(a.iter().filter(|&&x| x).count(), MAX_PLAYING);
        assert!(a[4..].iter().all(|&x| x), "the largest four");
        let heavy: Vec<Cand> = (0..4).map(|i| c(f64::from(i), 3.0)).collect();
        assert_eq!(admit(&heavy, GPU_BUDGET_MS, MAX_PLAYING).iter().filter(|&&x| x).count(), 2, "2 x 3 ms fit the 8 ms ceiling, 3 do not");
    }

    #[test]
    fn clock_advances_only_while_ticking_and_caps_gaps() {
        let mut c = Clock::default();
        assert_eq!(c.tick(1000.0), 0.0);
        assert!((c.tick(1033.0) - 0.033).abs() < 1e-9);
        c.stop();
        assert_eq!(c.tick(9000.0), 0.0);
        assert!((c.tick(9500.0) - 0.1).abs() < 1e-9);
        assert!((c.t - 0.133).abs() < 1e-9);
    }

    #[test]
    fn unpremultiply_restores_straight_alpha() {
        let mut px = [128, 64, 0, 128, 10, 10, 10, 0, 200, 100, 50, 255];
        unpremultiply(&mut px);
        assert_eq!(px, [255, 128, 0, 128, 0, 0, 0, 0, 200, 100, 50, 255]);
    }

    #[test]
    fn video_taps_cover_every_texel_and_cap() {
        assert_eq!(blit_taps((1920, 1080), (1920, 1080)), 1);
        assert_eq!(blit_taps((1920, 1080), (960, 540)), 1);
        assert_eq!(blit_taps((3840, 2160), (1024, 576)), 2);
        assert_eq!(blit_taps((3840, 2160), (400, 225)), 5);
        assert_eq!(blit_taps((3840, 2160), (40, 22)), MAX_TAPS);
        // Upscaling never takes more than one.
        assert_eq!(blit_taps((320, 180), (1024, 576)), 1);
    }

    #[test]
    fn cover_crop_keeps_the_middle() {
        assert_eq!(cover_crop((1920, 1080), 16.0 / 9.0), [0.0, 0.0, 1.0, 1.0]);
        // A square card shows the middle 9/16 of a 16:9 frame.
        let c = cover_crop((3840, 2160), 1.0);
        assert!((c[2] - 0.5625).abs() < 1e-6 && (c[0] - 0.21875).abs() < 1e-6 && c[1] == 0.0 && c[3] == 1.0, "{c:?}");
        assert_eq!(crop_px((3840, 2160), c), (2160, 2160));
        // A wide card crops top and bottom.
        let w = cover_crop((1000, 1000), 2.0);
        assert!((w[3] - 0.5).abs() < 1e-6 && (w[1] - 0.25).abs() < 1e-6, "{w:?}");
        assert_eq!(blit_uniforms((3840, 2160), (1024, 1024), c)[4], 2.0);
    }

    #[test]
    fn video_cost_grows_with_the_decoded_size() {
        let hd = video_ms(VIDEO_COPY_MS_PER_MPX, (1920, 1080), (1024, 576));
        let uhd = video_ms(VIDEO_COPY_MS_PER_MPX, (3840, 2160), (1024, 576));
        assert!(hd > 0.05 && uhd > hd * 3.0, "{hd} {uhd}");
        // Four 4K videos fit the shared budget with the default copy cost.
        assert!(uhd * 4.0 <= GPU_BUDGET_MS, "{uhd}");
        // A video competes in the same admission as shader cards.
        let c = |area: f64, cost: f64| Cand { area, cost, hovered: false, eligible: true };
        // 0.78 + 1.5 + 0.78 = 3.06; the next shader (1.5) does not fit, the smaller video does.
        let mix = [c(900.0, uhd), c(800.0, 1.5), c(700.0, uhd), c(600.0, 1.5), c(500.0, uhd)];
        assert_eq!(admit(&mix, GPU_BUDGET_MS, MAX_PLAYING), vec![true, true, true, false, true]);
    }

    #[test]
    fn video_uploads_only_new_frames() {
        // Playing: due and the time moved.
        assert!(video_needs_frame(true, true, true, true, false, 1.5, 1.4));
        assert!(!video_needs_frame(true, true, true, true, false, 1.5, 1.5));
        assert!(!video_needs_frame(true, false, true, true, false, 1.5, 1.4));
        // Playing but nothing shown yet: the first frame even if the time has not moved.
        assert!(video_needs_frame(true, true, true, false, false, 0.0, 0.0));
        // Still: the first picture, or a frame the page asked for.
        assert!(video_needs_frame(false, false, true, false, false, 0.0, -1.0));
        assert!(!video_needs_frame(false, false, true, true, false, 3.0, 1.0));
        assert!(video_needs_frame(false, false, true, true, true, 3.0, 1.0));
        // No current frame: never (the copy would throw).
        assert!(!video_needs_frame(true, true, false, false, true, 1.0, 0.0));
    }

    #[test]
    fn uniform_layout() {
        let u = uniforms((480.0, 270.0), (960, 540), 2.0, 0.016, 7, [1.0, 2.0, 1.0, 0.0], &[0.0; PARAM_FLOATS]);
        assert_eq!(std::mem::size_of_val(&u) as u64, UNIFORM_BYTES);
        assert_eq!((u[0], u[1], u[2], u[8], u[10]), (480.0, 270.0, 2.0, 0.5, 7.0));
        // The WRAPPER's params array is the same length.
        assert!(WRAPPER.contains(&format!("params: array<vec4<f32>, {PARAM_SLOTS}>")));
        assert_eq!(UNIFORM_BYTES % 16, 0);
    }

    #[test]
    fn params_are_finite_and_padded() {
        let p = params_from(&[1.0, f32::NAN, f32::INFINITY, 4.0]);
        assert_eq!(&p[..4], &[1.0, 0.0, 0.0, 4.0]);
        assert!(p[4..].iter().all(|&x| x == 0.0));
        let long = vec![2.0; PARAM_FLOATS + 10];
        assert_eq!(params_from(&long)[PARAM_FLOATS - 1], 2.0);
    }

    #[test]
    fn noise_texture_is_whole() {
        assert_eq!(NOISE_RGBA.len() as u32, NOISE_SIZE * NOISE_SIZE * 4);
    }

    #[test]
    fn wrapper_passes_its_own_checks_words() {
        // The noise binding lives in the wrapper, after the author's checked source: an author still
        // cannot declare textures or samplers.
        assert!(check_source("fn shade(p: vec2<f32>) -> vec4<f32> { return canvas_noise(p * 0.01); }").is_ok());
        assert!(check_source("@group(0) @binding(1) var t: texture_2d<f32>;\nfn shade(p: vec2<f32>) -> vec4<f32> { return vec4<f32>(1.0); }").is_err());
    }
}
