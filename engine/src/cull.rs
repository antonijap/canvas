//! Per-render culling of a board's scene (GPU-free, so it is unit tested on the host).
//!
//! vello flattens and bins every path of the scene it is given, wherever the target is, into GPU buffers of a
//! fixed size (2^21 lines, segments and path tiles, 2^18 bin entries). A scene over any of them renders as
//! nothing at all, without an error. So a board's encoding is indexed while it is painted: a flat list of items
//! in paint order, each a contiguous range of the encoding's streams with the board-space bounds of what it
//! draws. A render copies only the ranges that meet its target, and a target whose items would still overflow
//! is rendered in parts ([`plan`]).
//!
//! Items: a draw (one node's own content, or a few small neighbours merged), a layer's push and its pop (the
//! push carries the bounds of everything inside and where the scan continues when the layer is skipped whole),
//! and a group (no encoding of its own: a subtree's bounds, so a scan skips it in one step). Every item starts
//! with its transform and style encoded again (`force_next_transform_and_style`), so a range stands on its own
//! wherever it lands in the copy.

use kurbo::{Affine, Rect};
use vello::Scene;
use vello::low_level::vello_encoding::{Encoding, Patch, Transform};

/// vello's bump buffers (vello_encoding `BufferSizes::new`), and how much of each an estimate may claim. The
/// estimates are rough (they err high), so a render is planned to stay well inside.
pub const LIMIT_LINES: f64 = 1_300_000.0;
pub const LIMIT_SEGMENTS: f64 = 1_300_000.0;
pub const LIMIT_TILES: f64 = 1_000_000.0;
/// vello's bin buffer (2^18 words) holds one word of draw info per fill (more for gradients and images) and one
/// per draw object and bin it touches: 131,072 small fills fill it exactly.
pub const LIMIT_BINS: f64 = 190_000.0;
/// The smallest part a target is split into (vello's own tile size).
pub const MIN_PART: u32 = 16;
/// Parts one target may be rendered in before it counts as too dense to draw.
pub const MAX_PARTS: usize = 256;

/// The lengths of an encoding's streams (and its path counts) at one moment.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Mark {
    /// path_tags, path_data, draw_tags, draw_data, transforms, styles, patches, color_stops, glyphs, glyph_runs, normalized_coords
    s: [u32; 11],
    n_paths: u32,
    n_segs: u32,
}

impl Mark {
    pub fn of(e: &Encoding) -> Mark {
        let r = &e.resources;
        let s = [e.path_tags.len(), e.path_data.len(), e.draw_tags.len(), e.draw_data.len(), e.transforms.len(), e.styles.len(), r.patches.len(), r.color_stops.len(), r.glyphs.len(), r.glyph_runs.len(), r.normalized_coords.len()];
        Mark { s: s.map(|n| n as u32), n_paths: e.n_paths, n_segs: e.n_path_segments }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Draw,
    Push,
    Pop,
    Group,
}

/// What rendering an item costs vello, as terms of the render's scale `s` (device px per board unit).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Cost {
    /// Lines whatever the scale: straight segments, one per curve, 18 per glyph.
    lines: f32,
    /// Lines that grow with √s: curves flatten into more the larger they are drawn.
    curve: f32,
    /// Paths (a glyph run is one).
    paths: f32,
    /// Σ over paths of (width + height) of their bounds, board units.
    perim: f32,
    /// Σ over paths of the area of their bounds, board units².
    area: f32,
    /// Draw objects.
    draws: f32,
    /// Words of draw info they take in the bin buffer.
    info: f32,
}

impl Cost {
    fn add(&mut self, o: &Cost) {
        self.lines += o.lines;
        self.curve += o.curve;
        self.paths += o.paths;
        self.perim += o.perim;
        self.area += o.area;
        self.draws += o.draws;
        self.info += o.info;
    }
}

#[derive(Clone, Copy, Debug)]
struct Item {
    start: Mark,
    /// Board-space bounds, rounded outward. Empty (x1 < x0): never drawn.
    bounds: [f32; 4],
    /// The item a scan continues with when this one is skipped (a layer or group: the one after its end).
    next: u32,
    kind: Kind,
    cost: Cost,
}

const NEVER: [f32; 4] = [1.0, 1.0, 0.0, 0.0];
const ALWAYS: [f32; 4] = [f32::NEG_INFINITY, f32::NEG_INFINITY, f32::INFINITY, f32::INFINITY];

fn to_f32(r: Rect) -> [f32; 4] {
    if !(r.x1 >= r.x0 && r.y1 >= r.y0) {
        return NEVER;
    }
    // Outward: an f32 holds about 7 digits, a board coordinate can need more.
    let pad = |v: f64| 0.01 + v.abs() * 1e-6;
    [(r.x0 - pad(r.x0)) as f32, (r.y0 - pad(r.y0)) as f32, (r.x1 + pad(r.x1)) as f32, (r.y1 + pad(r.y1)) as f32]
}

fn empty(b: &[f32; 4]) -> bool {
    b[2] < b[0] || b[3] < b[1]
}

fn union(a: &[f32; 4], b: &[f32; 4]) -> [f32; 4] {
    if empty(a) {
        return *b;
    }
    if empty(b) {
        return *a;
    }
    [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]
}

fn intersect(a: &[f32; 4], b: &[f32; 4]) -> [f32; 4] {
    let r = [a[0].max(b[0]), a[1].max(b[1]), a[2].min(b[2]), a[3].min(b[3])];
    if empty(a) || empty(b) || empty(&r) { NEVER } else { r }
}

fn meets(b: &[f32; 4], r: &[f32; 4]) -> bool {
    b[0] <= r[2] && b[2] >= r[0] && b[1] <= r[3] && b[3] >= r[1]
}

/// The cost of the encoding between two marks, drawn within `bounds`.
fn cost_of(e: &Encoding, a: &Mark, b: &Mark, bounds: &[f32; 4]) -> Cost {
    if empty(bounds) {
        return Cost::default();
    }
    let (w, h) = (f64::from(bounds[2] - bounds[0]).min(1e7), f64::from(bounds[3] - bounds[1]).min(1e7));
    let (mut lines, mut curves) = (0u32, 0u32);
    for t in &e.path_tags[a.s[0] as usize..b.s[0] as usize] {
        match t.0 & 3 {
            1 => lines += 1,
            2 | 3 => curves += 1,
            _ => {}
        }
    }
    // A stroke is expanded on the GPU: both sides, joins and caps.
    let stroked = e.styles[a.s[5] as usize..b.s[5] as usize].iter().any(|s| s.flags_and_miter_limit & 0x8000_0000 != 0);
    let k = if stroked { 4.0 } else { 1.0 };
    let dim = w.max(h);
    let mut c = Cost { lines: (f64::from(lines + curves) * k) as f32, curve: (f64::from(curves) * 1.2 * dim.sqrt() * k) as f32, ..Cost::default() };
    let runs = &e.resources.glyph_runs[a.s[9] as usize..b.s[9] as usize];
    for run in runs {
        let [m0, m1, m2, m3] = run.transform.matrix;
        let size = f64::from(run.font_size) * f64::from((m0 * m3 - m1 * m2).abs()).sqrt();
        let n = run.glyphs.len() as f64;
        c.lines += (n * 18.0) as f32;
        c.curve += (n * 1.6 * size.max(0.0).sqrt()) as f32;
    }
    let paths = f64::from(b.n_paths - a.n_paths) + runs.len() as f64;
    c.paths = paths as f32;
    c.perim = (paths * (w + h)) as f32;
    c.area = (paths * w * h) as f32;
    let tags = &e.draw_tags[a.s[2] as usize..b.s[2] as usize];
    c.draws = tags.len() as f32;
    c.info = tags.iter().map(|t| (t.0 >> 6) & 0xf).sum::<u32>() as f32;
    c
}

struct Open {
    item: usize,
    acc: [f32; 4],
    limit: [f32; 4],
}

/// Builds a [`SceneIndex`] while a scene is encoded: the painter says where one item ends and what it covers.
pub struct Builder {
    items: Vec<Item>,
    last: Mark,
    stack: Vec<Open>,
    /// Items before this index are closed off (a layer or group boundary): never merged into.
    barrier: usize,
}

impl Default for Builder {
    fn default() -> Self {
        Builder::new()
    }
}

impl Builder {
    pub fn new() -> Builder {
        Builder { items: Vec::new(), last: Mark::default(), stack: Vec::new(), barrier: 0 }
    }

    /// Items so far (a scene prefix is the first that many).
    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// The items so far as a prefix (`SceneIndex::build`'s `upto`): nothing encoded later joins them.
    pub fn mark(&mut self) -> usize {
        self.barrier = self.items.len();
        self.items.len()
    }

    fn close(&mut self, scene: &mut Scene, kind: Kind, bounds: [f32; 4]) -> Option<usize> {
        let now = Mark::of(scene.encoding());
        if now == self.last && kind != Kind::Group {
            return None;
        }
        let i = self.items.len();
        self.items.push(Item { start: self.last, bounds, next: i as u32 + 1, kind, cost: Cost::default() });
        self.last = now;
        // The next item encodes its own transform and style: it must not lean on this one being drawn.
        scene.encoding_mut().force_next_transform_and_style();
        Some(i)
    }

    fn grow(&mut self, b: &[f32; 4]) {
        if let Some(o) = self.stack.last_mut() {
            o.acc = union(&o.acc, b);
        }
    }

    /// What was encoded since the last call is one draw item covering `bounds` (board space).
    pub fn cut(&mut self, scene: &mut Scene, bounds: Rect) {
        let start = self.last;
        let Some(i) = self.close(scene, Kind::Draw, NEVER) else { return };
        let b = to_f32(bounds);
        let cost = cost_of(scene.encoding(), &start, &self.last, &b);
        // Transform and style tags alone (an empty shape) draw nothing.
        let b = if cost.draws == 0.0 { NEVER } else { b };
        self.items[i].bounds = b;
        self.items[i].cost = cost;
        self.grow(&b);
        // Small neighbours share an item: a board of 260,000 tiny shapes keeps an index a tenth that long.
        if i > self.barrier && self.items[i - 1].kind == Kind::Draw && !empty(&b) {
            let p = self.items[i - 1];
            if !empty(&p.bounds) && p.cost.draws + cost.draws <= 64.0 {
                let u = union(&p.bounds, &b);
                let area = |r: &[f32; 4]| f64::from(r[2] - r[0]) * f64::from(r[3] - r[1]);
                if (u[2] - u[0]).max(u[3] - u[1]) <= 96.0 && area(&u) <= 2.0 * (area(&p.bounds) + area(&b)) + 16.0 {
                    self.items.pop();
                    let p = &mut self.items[i - 1];
                    p.bounds = u;
                    p.cost.add(&cost);
                    p.next = i as u32;
                }
            }
        }
    }

    /// What was encoded since the last cut is a layer's push; nothing in the layer shows outside `limit`.
    pub fn pushed(&mut self, scene: &mut Scene, limit: Rect) {
        if let Some(i) = self.close(scene, Kind::Push, NEVER) {
            self.stack.push(Open { item: i, acc: NEVER, limit: to_f32(limit) });
            self.barrier = self.items.len();
        }
    }

    /// What was encoded since the last cut is the pop of the innermost open layer.
    pub fn popped(&mut self, scene: &mut Scene) {
        let start = self.last;
        if self.close(scene, Kind::Pop, ALWAYS).is_none() {
            return;
        }
        let Some(o) = self.stack.pop() else { return };
        let b = intersect(&o.acc, &o.limit);
        let end = self.items.get(o.item + 1).map_or(start, |it| it.start);
        let cost = cost_of(scene.encoding(), &self.items[o.item].start, &end, &b);
        let len = self.items.len() as u32;
        let it = &mut self.items[o.item];
        it.bounds = b;
        it.cost = cost;
        it.next = len;
        self.grow(&b);
        self.barrier = self.items.len();
    }

    /// Start a group: the items until `close_group` are skipped together when none of them meets a render.
    pub fn open_group(&mut self, scene: &mut Scene) {
        if let Some(i) = self.close(scene, Kind::Group, NEVER) {
            self.stack.push(Open { item: i, acc: NEVER, limit: ALWAYS });
            self.barrier = self.items.len();
        }
    }

    pub fn close_group(&mut self) {
        let Some(o) = self.stack.pop() else { return };
        let len = self.items.len() as u32;
        let it = &mut self.items[o.item];
        it.bounds = o.acc;
        it.next = len;
        let b = o.acc;
        self.grow(&b);
        self.barrier = self.items.len();
    }

    pub fn finish(self, scene: &Scene) -> SceneIndex {
        debug_assert!(self.stack.is_empty(), "every layer and group is closed");
        let mut items = self.items;
        items.shrink_to_fit();
        SceneIndex { items, end: Mark::of(scene.encoding()) }
    }
}

/// What a render would ask of vello's fixed buffers.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Estimate {
    pub lines: f64,
    pub segments: f64,
    pub tiles: f64,
    pub bins: f64,
    /// Items the render draws.
    pub items: u32,
}

impl Estimate {
    pub fn fits(&self) -> bool {
        self.lines <= LIMIT_LINES && self.segments <= LIMIT_SEGMENTS && self.tiles <= LIMIT_TILES && self.bins <= LIMIT_BINS
    }
    /// The estimate as megapixels of tile work (what `cache::scene_mpx` charges per segment).
    pub fn mpx(&self) -> f64 {
        self.lines * 2.5e-6
    }
}

/// A render target over a board: texture px = board units × scale − origin × scale.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Target {
    /// Board point at texture px (0, 0).
    pub origin: (f64, f64),
    /// Texture px per board unit, per axis.
    pub scale: (f64, f64),
}

impl Target {
    pub fn transform(&self) -> Affine {
        Affine::scale_non_uniform(self.scale.0, self.scale.1) * Affine::translate((-self.origin.0, -self.origin.1))
    }
    /// The board rect under texture px rect `[x, y, w, h]`, one px wider on every side (antialiasing reaches
    /// half a px; the rest is slack).
    pub fn board_rect(&self, part: [u32; 4]) -> Rect {
        let [x, y, w, h] = part.map(f64::from);
        Rect::new(self.origin.0 + (x - 1.0) / self.scale.0, self.origin.1 + (y - 1.0) / self.scale.1, self.origin.0 + (x + w + 1.0) / self.scale.0, self.origin.1 + (y + h + 1.0) / self.scale.1)
    }
}

/// A board's scene as items (see the module docs). Belongs to the scene it was built with.
#[derive(Default)]
pub struct SceneIndex {
    items: Vec<Item>,
    end: Mark,
}

impl SceneIndex {
    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn bytes(&self) -> usize {
        self.items.capacity() * std::mem::size_of::<Item>()
    }

    fn end_of(&self, i: usize) -> &Mark {
        self.items.get(i + 1).map_or(&self.end, |it| &it.start)
    }

    /// Every item among the first `upto` that a render over `rect` draws, in paint order.
    fn visit(&self, upto: usize, rect: Rect, mut f: impl FnMut(usize, &Item)) {
        let r = [rect.x0 as f32, rect.y0 as f32, rect.x1 as f32, rect.y1 as f32];
        let upto = upto.min(self.items.len());
        let mut i = 0;
        while i < upto {
            let it = &self.items[i];
            if !meets(&it.bounds, &r) {
                i = (it.next as usize).max(i + 1);
                continue;
            }
            f(i, it);
            i += 1;
        }
    }

    /// What rendering the first `upto` items over `part` (texture px `[x, y, w, h]`) of `t` asks of vello.
    pub fn estimate(&self, upto: usize, t: &Target, part: [u32; 4]) -> Estimate {
        let rect = t.board_rect(part);
        let s = t.scale.0.max(t.scale.1);
        let (w, h) = (f64::from(part[2]), f64::from(part[3]));
        let target_tiles = ((w / 16.0).ceil() + 1.0) * ((h / 16.0).ceil() + 1.0);
        let r = [rect.x0 as f32, rect.y0 as f32, rect.x1 as f32, rect.y1 as f32];
        let mut e = Estimate::default();
        self.visit(upto, rect, |_, it| {
            let c = &it.cost;
            if it.kind == Kind::Group || c.draws == 0.0 && c.paths == 0.0 {
                return;
            }
            let (paths, perim, area) = (f64::from(c.paths), f64::from(c.perim), f64::from(c.area));
            let lines = f64::from(c.lines) + f64::from(c.curve) * s.sqrt();
            e.items += 1;
            e.lines += lines;
            // No path of the item reaches past the item's bounds, nor (for these buffers) past the target.
            let v = intersect(&it.bounds, &r);
            let (bw, bh) = (f64::from(v[2] - v[0]).max(0.0) * t.scale.0, f64::from(v[3] - v[1]).max(0.0) * t.scale.1);
            let seen_tiles = ((bw / 16.0 + 1.0) * (bh / 16.0 + 1.0)).min(target_tiles);
            e.tiles += (paths + s * perim / 16.0 + s * s * area / 256.0).min(paths * seen_tiles);
            e.segments += lines + (2.0 * s * perim / 16.0).min(paths * 2.0 * (bw + bh).min(w + h) / 16.0);
            e.bins += f64::from(c.info) + f64::from(c.draws) * (bw / 256.0 + 1.0) * (bh / 256.0 + 1.0);
        });
        e
    }

    /// Replace `out` with the first `upto` items of `scene` that a render over `part` of `t` draws, in the
    /// target's px (layers left open by the cut are closed). Returns how many items it copied.
    pub fn build(&self, scene: &Scene, upto: usize, t: &Target, part: [u32; 4], out: &mut Scene) -> u32 {
        let rect = t.board_rect(part);
        out.reset();
        let src = scene.encoding();
        let dst = out.encoding_mut();
        let mut run: Option<(Mark, Mark)> = None;
        let (mut n, mut clips, mut open) = (0u32, 0u32, 0i64);
        self.visit(upto, rect, |i, it| {
            match it.kind {
                Kind::Group => return,
                Kind::Push => {
                    clips += 1;
                    open += 1;
                }
                Kind::Pop => {
                    clips += 1;
                    open -= 1;
                }
                Kind::Draw => {}
            }
            n += 1;
            let end = *self.end_of(i);
            // Neighbours in the encoding are copied as one range.
            match &mut run {
                Some((_, b)) if *b == it.start => *b = end,
                _ => {
                    if let Some((a, b)) = run.take() {
                        append_range(dst, src, &a, &b);
                    }
                    run = Some((it.start, end));
                }
            }
        });
        if let Some((a, b)) = run {
            append_range(dst, src, &a, &b);
        }
        dst.n_clips = clips;
        dst.n_open_clips = open.max(0) as u32;
        let part_xf = Affine::translate((-f64::from(part[0]), -f64::from(part[1]))) * t.transform();
        let xf = Transform::from_kurbo(&part_xf);
        for x in &mut dst.transforms {
            *x = xf * *x;
        }
        for r in &mut dst.resources.glyph_runs {
            r.transform = xf * r.transform;
        }
        for _ in 0..open.max(0) {
            out.pop_layer();
        }
        // The copy may end in a glyph run, whose transform and style the encoder cannot see.
        out.encoding_mut().force_next_transform_and_style();
        n
    }
}

/// Append `src`'s streams between two marks to `dst` (what `Encoding::append` does for a whole encoding).
fn append_range(dst: &mut Encoding, src: &Encoding, a: &Mark, b: &Mark) {
    let r = |k: usize| a.s[k] as usize..b.s[k] as usize;
    let base = Mark::of(dst).s.map(|n| n as usize);
    let from = a.s.map(|n| n as usize);
    let (sr, dr) = (&src.resources, &mut dst.resources);
    dr.glyphs.extend_from_slice(&sr.glyphs[r(8)]);
    dr.normalized_coords.extend_from_slice(&sr.normalized_coords[r(10)]);
    dr.color_stops.extend_from_slice(&sr.color_stops[r(7)]);
    dr.glyph_runs.extend(sr.glyph_runs[r(9)].iter().cloned().map(|mut run| {
        run.glyphs = run.glyphs.start - from[8] + base[8]..run.glyphs.end - from[8] + base[8];
        run.normalized_coords = run.normalized_coords.start - from[10] + base[10]..run.normalized_coords.end - from[10] + base[10];
        let o = &mut run.stream_offsets;
        o.path_tags = o.path_tags - from[0] + base[0];
        o.path_data = o.path_data - from[1] + base[1];
        o.draw_tags = o.draw_tags - from[2] + base[2];
        o.draw_data = o.draw_data - from[3] + base[3];
        o.transforms = o.transforms - from[4] + base[4];
        o.styles = o.styles - from[5] + base[5];
        run
    }));
    dr.patches.extend(sr.patches[r(6)].iter().map(|p| match p {
        Patch::Ramp { draw_data_offset, stops, extend, interpolation_alpha_space } => {
            Patch::Ramp { draw_data_offset: draw_data_offset - from[3] + base[3], stops: stops.start - from[7] + base[7]..stops.end - from[7] + base[7], extend: *extend, interpolation_alpha_space: *interpolation_alpha_space }
        }
        Patch::GlyphRun { index } => Patch::GlyphRun { index: index - from[9] + base[9] },
        Patch::Image { image, draw_data_offset } => Patch::Image { image: image.clone(), draw_data_offset: draw_data_offset - from[3] + base[3] },
    }));
    dst.path_tags.extend_from_slice(&src.path_tags[r(0)]);
    dst.path_data.extend_from_slice(&src.path_data[r(1)]);
    dst.draw_tags.extend_from_slice(&src.draw_tags[r(2)]);
    dst.draw_data.extend_from_slice(&src.draw_data[r(3)]);
    dst.transforms.extend_from_slice(&src.transforms[r(4)]);
    dst.styles.extend_from_slice(&src.styles[r(5)]);
    dst.n_paths += b.n_paths - a.n_paths;
    dst.n_path_segments += b.n_segs - a.n_segs;
}

/// A target no split makes drawable: more than vello's buffers hold lands in one `MIN_PART` px square (or
/// the split would take more than `MAX_PARTS` renders).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TooDense(pub Estimate);

impl std::fmt::Display for TooDense {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "too dense to draw at this zoom (about {:.1} M lines and {:.0} k shapes in one render)", self.0.lines / 1e6, self.0.bins / 1e3)
    }
}

/// The parts (`[x, y, w, h]` in texture px, together exactly `w` × `h`) to render the first `upto` items over
/// target `t` in, each within vello's buffers: the whole target when it fits, else halves of halves.
pub fn plan(index: &SceneIndex, upto: usize, t: &Target, w: u32, h: u32) -> Result<Vec<[u32; 4]>, TooDense> {
    plan_costed(index, upto, t, w, h).map(|v| v.into_iter().map(|p| p.0).collect())
}

/// `plan`, with each part's estimate.
pub fn plan_costed(index: &SceneIndex, upto: usize, t: &Target, w: u32, h: u32) -> Result<Vec<([u32; 4], Estimate)>, TooDense> {
    plan_costed_in(index, upto, t, [0, 0, w, h])
}

/// `plan_costed` for the region `area` (x, y, width, height in target px) of a target: the parts a render of only
/// that region takes.
pub fn plan_costed_in(index: &SceneIndex, upto: usize, t: &Target, area: [u32; 4]) -> Result<Vec<([u32; 4], Estimate)>, TooDense> {
    let mut out = Vec::new();
    let mut todo = vec![area];
    while let Some(part) = todo.pop() {
        let e = index.estimate(upto, t, part);
        if e.fits() {
            out.push((part, e));
            continue;
        }
        let [x, y, pw, ph] = part;
        if pw.max(ph) <= MIN_PART || out.len() + todo.len() + 4 > MAX_PARTS {
            return Err(TooDense(e));
        }
        // Halves on vello's tile grid, the longer side first (both when they are alike).
        let half = |n: u32| (n / 2).div_ceil(MIN_PART) * MIN_PART;
        let (sx, sy) = (pw > MIN_PART && pw * 2 > ph, ph > MIN_PART && ph * 2 > pw);
        let xs = if sx { vec![(x, half(pw)), (x + half(pw), pw - half(pw))] } else { vec![(x, pw)] };
        let ys = if sy { vec![(y, half(ph)), (y + half(ph), ph - half(ph))] } else { vec![(y, ph)] };
        for &(py, hh) in &ys {
            for &(px, ww) in &xs {
                if ww > 0 && hh > 0 {
                    todo.push([px, py, ww, hh]);
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use kurbo::Stroke;
    use peniko::{Color, Fill, Mix};

    fn rect(sc: &mut Scene, r: Rect) {
        sc.fill(Fill::NonZero, Affine::translate((r.x0, r.y0)), Color::BLACK, None, &Rect::new(0.0, 0.0, r.width(), r.height()));
    }

    /// A grid of `cols` × `rows` 4 × 4 squares, 8 apart, each its own item.
    fn grid(cols: usize, rows: usize) -> (Scene, SceneIndex) {
        let mut sc = Scene::new();
        let mut b = Builder::new();
        for y in 0..rows {
            for x in 0..cols {
                let r = Rect::new(x as f64 * 8.0, y as f64 * 8.0, x as f64 * 8.0 + 4.0, y as f64 * 8.0 + 4.0);
                rect(&mut sc, r);
                b.cut(&mut sc, r);
            }
        }
        let ix = b.finish(&sc);
        (sc, ix)
    }

    fn unit(origin: (f64, f64), s: f64) -> Target {
        Target { origin, scale: (s, s) }
    }

    #[test]
    fn a_render_copies_only_what_meets_it() {
        let (sc, ix) = grid(100, 100);
        let whole = sc.encoding();
        let mut out = Scene::new();
        // A 64 px target at scale 1 over the board's corner: 8 × 8 squares, and the neighbours merged with them
        // (runs of twelve along a row).
        let n = ix.build(&sc, ix.len(), &unit((0.0, 0.0), 1.0), [0, 0, 64, 64], &mut out);
        let e = out.encoding();
        assert!(e.n_paths >= 64 && e.n_paths <= 9 * 12, "{} paths of {}", e.n_paths, whole.n_paths);
        assert!(n >= 1 && (n as usize) < ix.len());
        assert_eq!(e.n_paths as usize, e.draw_tags.len());
        assert_eq!(e.transforms.len(), e.n_paths as usize, "every item brings its own transform");
        // Everywhere: the whole encoding, stream for stream.
        ix.build(&sc, ix.len(), &unit((0.0, 0.0), 1.0), [0, 0, 800, 800], &mut out);
        let e = out.encoding();
        assert_eq!((e.n_paths, e.n_path_segments, e.path_tags.len(), e.path_data.len(), e.draw_data.len()), (whole.n_paths, whole.n_path_segments, whole.path_tags.len(), whole.path_data.len(), whole.draw_data.len()));
        // Nowhere near: nothing.
        assert_eq!(ix.build(&sc, ix.len(), &unit((5000.0, 5000.0), 1.0), [0, 0, 64, 64], &mut out), 0);
        assert!(out.encoding().is_empty());
    }

    #[test]
    fn the_copy_is_in_the_targets_pixels() {
        let (sc, ix) = grid(4, 1);
        let mut out = Scene::new();
        // Scale 2, the part starting 10 px into a target whose origin is board x = 3.
        ix.build(&sc, ix.len(), &unit((3.0, 0.0), 2.0), [10, 0, 64, 16], &mut out);
        let t = out.encoding().transforms[0];
        // The square at board x = 8 lands at (8 - 3) * 2 - 10 = 0.
        assert_eq!(t.matrix, [2.0, 0.0, 0.0, 2.0]);
        // The four squares are one item (small neighbours merge), so the first comes along: (0 - 3) * 2 - 10.
        assert_eq!(t.translation, [-16.0, 0.0]);
        assert_eq!(out.encoding().transforms[1].translation, [0.0, 0.0], "board x = 8 lands at (8 - 3) * 2 - 10");
    }

    #[test]
    fn small_neighbours_merge_and_far_ones_do_not() {
        let (_, ix) = grid(1000, 20);
        assert!(ix.len() < 20_000 / 8, "{} items for 20,000 squares", ix.len());
        let mut sc = Scene::new();
        let mut b = Builder::new();
        for r in [Rect::new(0.0, 0.0, 4.0, 4.0), Rect::new(5000.0, 0.0, 5004.0, 4.0)] {
            rect(&mut sc, r);
            b.cut(&mut sc, r);
        }
        assert_eq!(b.finish(&sc).len(), 2, "two squares a board apart stay two items");
    }

    #[test]
    fn a_layer_is_skipped_whole_or_kept_with_its_pop() {
        let mut sc = Scene::new();
        let mut b = Builder::new();
        rect(&mut sc, Rect::new(0.0, 0.0, 10.0, 10.0));
        b.cut(&mut sc, Rect::new(0.0, 0.0, 10.0, 10.0));
        sc.push_layer(Fill::NonZero, Mix::Normal, 0.5, Affine::IDENTITY, &Rect::new(1000.0, 0.0, 1100.0, 100.0));
        b.pushed(&mut sc, Rect::new(1000.0, 0.0, 1100.0, 100.0));
        for x in [1000.0, 1050.0, 2000.0] {
            rect(&mut sc, Rect::new(x, 0.0, x + 10.0, 10.0));
            b.cut(&mut sc, Rect::new(x, 0.0, x + 10.0, 10.0));
        }
        sc.pop_layer();
        b.popped(&mut sc);
        rect(&mut sc, Rect::new(0.0, 20.0, 10.0, 30.0));
        b.cut(&mut sc, Rect::new(0.0, 20.0, 10.0, 30.0));
        let ix = b.finish(&sc);
        let mut out = Scene::new();
        // Away from the layer: the two squares outside it, no clip.
        ix.build(&sc, ix.len(), &unit((0.0, 0.0), 1.0), [0, 0, 64, 64], &mut out);
        assert_eq!((out.encoding().n_clips, out.encoding().n_open_clips, out.encoding().n_paths), (0, 0, 2));
        // Over the layer's second square: push, that square, pop.
        ix.build(&sc, ix.len(), &unit((1040.0, 0.0), 1.0), [0, 0, 32, 32], &mut out);
        let e = out.encoding();
        assert_eq!((e.n_clips, e.n_open_clips), (2, 0));
        assert_eq!(e.n_paths, 3, "the clip path, one square, the pop's path");
        // The square the layer clips away (x = 2000) does not make the layer show there.
        ix.build(&sc, ix.len(), &unit((1990.0, 0.0), 1.0), [0, 0, 32, 32], &mut out);
        assert!(out.encoding().is_empty());
    }

    #[test]
    fn a_prefix_closes_the_layers_it_leaves_open() {
        let mut sc = Scene::new();
        let mut b = Builder::new();
        sc.push_layer(Fill::NonZero, Mix::Normal, 1.0, Affine::IDENTITY, &Rect::new(0.0, 0.0, 100.0, 100.0));
        b.pushed(&mut sc, Rect::new(0.0, 0.0, 100.0, 100.0));
        rect(&mut sc, Rect::new(0.0, 0.0, 10.0, 10.0));
        b.cut(&mut sc, Rect::new(0.0, 0.0, 10.0, 10.0));
        let upto = b.mark();
        rect(&mut sc, Rect::new(20.0, 0.0, 30.0, 10.0));
        b.cut(&mut sc, Rect::new(20.0, 0.0, 30.0, 10.0));
        sc.pop_layer();
        b.popped(&mut sc);
        let ix = b.finish(&sc);
        let mut out = Scene::new();
        ix.build(&sc, upto, &unit((0.0, 0.0), 1.0), [0, 0, 64, 64], &mut out);
        let e = out.encoding();
        assert_eq!((e.n_clips, e.n_open_clips), (2, 0), "pushed, then closed by the cut");
        assert_eq!(e.n_paths, 3, "clip path, the first square, the closing pop");
    }

    #[test]
    fn groups_are_skipped_in_one_step() {
        let mut sc = Scene::new();
        let mut b = Builder::new();
        b.open_group(&mut sc);
        for i in 0..1000 {
            let r = Rect::new(f64::from(i) * 200.0, 0.0, f64::from(i) * 200.0 + 100.0, 100.0);
            rect(&mut sc, r);
            b.cut(&mut sc, r);
        }
        b.close_group();
        rect(&mut sc, Rect::new(0.0, 5000.0, 10.0, 5010.0));
        b.cut(&mut sc, Rect::new(0.0, 5000.0, 10.0, 5010.0));
        let ix = b.finish(&sc);
        let mut seen = 0;
        ix.visit(ix.len(), Rect::new(0.0, 4990.0, 64.0, 5054.0), |_, _| seen += 1);
        assert_eq!(seen, 1, "the group's thousand items were never looked at");
        assert_eq!(ix.items[0].next as usize, ix.len() - 1);
    }

    #[test]
    fn glyph_runs_and_gradients_keep_their_offsets() {
        let mut sc = Scene::new();
        let mut b = Builder::new();
        rect(&mut sc, Rect::new(0.0, 0.0, 10.0, 10.0));
        b.cut(&mut sc, Rect::new(0.0, 0.0, 10.0, 10.0));
        let g = peniko::Gradient::new_linear((0.0, 0.0), (10.0, 0.0)).with_stops([Color::BLACK, Color::WHITE].as_slice());
        sc.fill(Fill::NonZero, Affine::translate((1000.0, 0.0)), &g, None, &Rect::new(0.0, 0.0, 10.0, 10.0));
        b.cut(&mut sc, Rect::new(1000.0, 0.0, 1010.0, 10.0));
        sc.stroke(&Stroke::new(2.0), Affine::translate((2000.0, 0.0)), Color::BLACK, None, &kurbo::Circle::new((5.0, 5.0), 5.0));
        b.cut(&mut sc, Rect::new(1999.0, -1.0, 2011.0, 11.0));
        let ix = b.finish(&sc);
        let mut out = Scene::new();
        ix.build(&sc, ix.len(), &unit((990.0, 0.0), 1.0), [0, 0, 32, 32], &mut out);
        let e = out.encoding();
        assert_eq!(e.n_paths, 1);
        let [Patch::Ramp { draw_data_offset, stops, .. }] = e.resources.patches.as_slice() else { panic!("one gradient patch") };
        assert_eq!((*draw_data_offset, stops.clone()), (0, 0..2), "offsets are the copy's own, not the board's");
        assert_eq!(e.resources.color_stops.len(), 2);
        // The stroke costs more lines than its segments: the GPU expands both sides.
        let stroke = ix.estimate(ix.len(), &unit((1990.0, -10.0), 1.0), [0, 0, 32, 32]);
        let fill = ix.estimate(ix.len(), &unit((-10.0, -10.0), 1.0), [0, 0, 32, 32]);
        assert!(stroke.lines > fill.lines * 2.0, "{stroke:?} {fill:?}");
    }

    #[test]
    fn estimates_grow_with_what_is_in_the_target() {
        let (_, ix) = grid(1000, 260);
        // The audit's dense board: 260,000 squares in one texture rendered nothing (bin_data holds 2^18).
        let all = ix.estimate(ix.len(), &unit((0.0, 0.0), 0.2), [0, 0, 1600, 416]);
        assert!(all.bins >= 520_000.0 && !all.fits(), "{all:?}");
        assert!(all.lines >= 4.0 * 260_000.0);
        // 130,000 drew, by a hair: one info word and one bin word each is 260,000 of the buffer's 262,144.
        let (_, half) = grid(1000, 130);
        let e = half.estimate(half.len(), &unit((0.0, 0.0), 0.2), [0, 0, 1600, 208]);
        assert!(e.bins > 260_000.0 && e.bins < 290_000.0, "{e:?}");
        let (_, third) = grid(1000, 80);
        let e = third.estimate(third.len(), &unit((0.0, 0.0), 0.2), [0, 0, 1600, 128]);
        assert!(e.fits(), "{e:?}");
        // One tile of the big board at 100% on a 2x display holds a sliver of it.
        let tile = ix.estimate(ix.len(), &unit((0.0, 0.0), 2.0), [0, 0, 1028, 1028]);
        assert!(tile.fits() && tile.bins < 20_000.0, "{tile:?}");
    }

    #[test]
    fn a_target_over_the_limits_is_rendered_in_parts() {
        let (_, ix) = grid(1000, 260);
        let t = unit((0.0, 0.0), 0.2);
        let parts = plan(&ix, ix.len(), &t, 1600, 416).expect("splits");
        assert!(parts.len() >= 3 && parts.len() <= 8, "{} parts", parts.len());
        // The parts tile the target exactly and each fits.
        let area: u64 = parts.iter().map(|p| u64::from(p[2]) * u64::from(p[3])).sum();
        assert_eq!(area, 1600 * 416);
        for (i, a) in parts.iter().enumerate() {
            assert!(ix.estimate(ix.len(), &t, *a).fits());
            for b in &parts[i + 1..] {
                let apart = a[0] + a[2] <= b[0] || b[0] + b[2] <= a[0] || a[1] + a[3] <= b[1] || b[1] + b[3] <= a[1];
                assert!(apart, "{a:?} overlaps {b:?}");
            }
        }
        // A target that fits is one part.
        assert_eq!(plan(&ix, ix.len(), &unit((0.0, 0.0), 2.0), 1028, 1028).unwrap(), vec![[0, 0, 1028, 1028]]);
    }

    #[test]
    fn what_no_split_can_draw_is_refused() {
        // 400,000 squares stacked on one spot: every part holds them all.
        let mut sc = Scene::new();
        let mut b = Builder::new();
        for _ in 0..400_000 {
            rect(&mut sc, Rect::new(0.0, 0.0, 4.0, 4.0));
            b.cut(&mut sc, Rect::new(0.0, 0.0, 4.0, 4.0));
        }
        let ix = b.finish(&sc);
        let err = plan(&ix, ix.len(), &unit((0.0, 0.0), 1.0), 512, 512).unwrap_err();
        assert!(err.0.bins > LIMIT_BINS);
        assert!(err.to_string().contains("too dense"));
    }

    #[test]
    fn text_estimates_match_what_failed_in_the_audit() {
        // 12 px text: per glyph, 18 lines and 1.6 √ppem more. vello's buffer holds 2^21 lines.
        let per_glyph = |s: f64| 18.0 + 1.6 * (12.0 * s).sqrt();
        let cap = f64::from(1u32 << 21);
        // Rendered nothing: 114,000 glyphs at scale 2, 74,100 at scale 16. The estimate must say so.
        assert!(114_000.0 * per_glyph(2.0) > cap);
        assert!(74_100.0 * per_glyph(16.0) > cap);
        // And a render planned to the limit stays under what did draw (91,200 at scale 2, 57,000 at 16).
        assert!(LIMIT_LINES / per_glyph(2.0) < 91_200.0);
        assert!(LIMIT_LINES / per_glyph(16.0) < 57_000.0);
    }
}
