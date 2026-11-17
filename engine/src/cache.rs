//! Tile cache logic (GPU-free, so it is unit tested on the host).
//!
//! A board is drawn into textures at a scale (device px per world unit). While the zoom changes the
//! engine renders at power-of-two scales and composites what it has (box-filtered when minified);
//! once the camera settles it renders at the exact scale and snaps to whole device pixels.
//! A board whose ink fits in `SINGLE_MAX` px at that scale gets one texture; a bigger one is cut
//! into `TILE`-px tiles and only the tiles in view are rendered (the tile pyramid). Every texture has
//! a `GUTTER` of real content around it. Textures are kept in an LRU under a byte budget; tiles of an
//! older generation stay usable as stand-ins until fresh ones replace them, and each board near the
//! view keeps a small base texture so no slot is ever empty for long.

use std::collections::{HashMap, HashSet};

use kurbo::Rect;

pub const SINGLE_MAX: f64 = 2400.0;
pub const TILE: f64 = 1024.0;
pub const DEFAULT_BUDGET: u64 = 256 * 1024 * 1024;
/// Screenfuls of tile texture the budget holds at least: the exact tiles of a view with their overhang and the
/// stand-ins (up to 2x finer mid-zoom, four times the area) must fit together, or settling evicts what it draws.
pub const BUDGET_SCREENS: u64 = 6;

/// The tile budget for a `w` x `h` device px drawing buffer: the default, or more on a big display (5K, 6K).
pub fn tile_budget_for(w: u32, h: u32) -> u64 {
    DEFAULT_BUDGET.max(u64::from(w) * u64::from(h) * 4 * BUDGET_SCREENS)
}
/// How far a texture may be stretched on screen mid-gesture when the sharper level is more than the frame
/// budgets can render during the gesture: text is visibly soft by then, but it shows.
pub const UPSCALE_OK: f64 = 1.2;
/// No stretch at all: as soon as the scale passes a power of two the level above renders (minified on screen:
/// sharp), inside the frame budgets, with the level below standing in until it is there. Any stretch softens
/// text, however small: bilinear taps drift across the view, and 2% measured as soft as 19%.
pub const STRETCH_UNSEEN: f64 = 1.0;

/// How far a zoom gesture may stretch textures before the next power of two renders: `STRETCH_UNSEEN` when the
/// level above is affordable, `UPSCALE_OK` when it is not. The level above is up to four times the view's
/// pixels (`view_mpx`): affordable when the GPU's tile share of a frame (`gpu_ms`, at `ms_per_mpx`) renders it
/// within a second of frames (a pinch lasts about that) and it fits 70% of the tile budget beside what is shown.
pub fn gesture_stretch(view_mpx: f64, ms_per_mpx: f64, gpu_ms: f64, period: f64, budget: u64) -> f64 {
    let above = view_mpx * 4.0;
    let frames = above * ms_per_mpx / gpu_ms.max(1e-3);
    let fits = above * 4e6 <= budget as f64 * 0.7;
    if fits && frames * period <= 1000.0 { STRETCH_UNSEEN } else { UPSCALE_OK }
}

/// A board fitted to the device pixel grid at an exact scale. Every edge of every board's frame lands on the
/// whole device pixel nearest to where the world puts it, so two boards that share an edge in the world share it
/// on screen: no gap for the canvas to show through, no overlap. (Snapping each board's origin on its own left
/// up to a pixel between neighbours.) The frame is then a whole number of pixels wide, a fraction of a pixel
/// more or less than its size times the scale, and the board is rendered that much wider or narrower (`k`), not
/// resampled: text stays sharp.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fit {
    /// Rendered scale over the nominal one, per axis (within one pixel of 1 over the frame).
    pub k: (f64, f64),
    /// The board's origin in device px, before the camera.
    pub origin: (f64, f64),
    /// Which way each axis is stretched (0: neither is): tiles of different codes hold different pixels.
    pub code: u8,
}

impl Fit {
    /// No fitting: a zoom gesture draws boards where the world puts them.
    pub fn none(pos: (f64, f64), s: f64) -> Fit {
        Fit { k: (1.0, 1.0), origin: (pos.0 * s, pos.1 * s), code: 0 }
    }
    /// Board rect `r` (board space) in device px, with the camera's offset `cam` (device px).
    pub fn device(&self, r: Rect, s: f64, cam: (f64, f64)) -> Rect {
        let (ox, oy) = (self.origin.0 + cam.0, self.origin.1 + cam.1);
        Rect::new(ox + r.x0 * self.k.0 * s, oy + r.y0 * self.k.1 * s, ox + r.x1 * self.k.0 * s, oy + r.y1 * self.k.1 * s)
    }
    /// Board rect `r` where the fitted board draws it, in world units (the camera aside): what is tested against
    /// the view. Where the world puts `r` (the board's position plus `r`) is up to a pixel off.
    pub fn world(&self, r: Rect, s: f64) -> Rect {
        let d = self.device(r, s, (0.0, 0.0));
        Rect::new(d.x0 / s, d.y0 / s, d.x1 / s, d.y1 / s)
    }
    /// The board's origin as drawn, in world units.
    pub fn world_origin(&self, s: f64) -> kurbo::Vec2 {
        kurbo::Vec2::new(self.origin.0 / s, self.origin.1 / s)
    }
    /// The board-space point drawn at device px `dev` (the inverse of `device`): what a hit test asks, so a click
    /// lands on the node whose pixels are under it.
    pub fn board_point(&self, dev: (f64, f64), s: f64, cam: (f64, f64)) -> kurbo::Point {
        kurbo::Point::new((dev.0 - self.origin.0 - cam.0) / (self.k.0 * s), (dev.1 - self.origin.1 - cam.1) / (self.k.1 * s))
    }
}

/// A board is stretched to whole pixels only while its ink stays within this many frame sizes of its origin, per
/// axis. The stretch moves a point by up to half a pixel per frame size of distance: content far outside a small
/// frame (an unclipped 1-unit root with a child at x = 1000) was drawn hundreds of pixels from where the world,
/// hit testing and the overlays have it. Such a board keeps its true scale; only its origin snaps.
pub const FIT_REACH: f64 = 2.0;

/// Fit a board at world `pos` whose frame is `frame` (width, height) and whose ink is `ink` (board space) to
/// the pixel grid at scale `s`.
pub fn fit_board(pos: (f64, f64), frame: (f64, f64), ink: Rect, s: f64) -> Fit {
    let axis = |p: f64, f: f64, lo: f64, hi: f64| {
        let o = (p * s).round();
        let n = f * s;
        if !(n >= 1.0) || (-lo).max(hi) > f * FIT_REACH {
            return (1.0, o, 0u8);
        }
        let w = (((p + f) * s).round() - o).max(1.0);
        if w == n { (1.0, o, 0) } else { (w / n, o, if w < n { 1 } else { 2 }) }
    };
    let (kx, ox, cx) = axis(pos.0, frame.0, ink.x0, ink.x1);
    let (ky, oy, cy) = axis(pos.1, frame.1, ink.y0, ink.y1);
    Fit { k: (kx, ky), origin: (ox, oy), code: cx | (cy << 2) }
}

/// `tiles_in_view` for a board rendered `k` times its nominal scale per axis: the grid is cut in the stretched
/// board's pixels, and the rects come back in the board's own space. `view`: world units from the board's
/// drawn origin (`Fit::world_origin`), which is the stretched board's own space; it is not stretched again
/// (it was: the view of a stretched board was off by the stretch, a tile's worth for content far out).
pub fn fit_tiles(ink: Rect, s: f64, k: (f64, f64), view: Rect) -> Vec<TileRect> {
    if k == (1.0, 1.0) {
        return tiles_in_view(ink, s, view);
    }
    let to = |r: Rect| Rect::new(r.x0 * k.0, r.y0 * k.1, r.x1 * k.0, r.y1 * k.1);
    let mut out = tiles_in_view(to(ink), s, view);
    for t in &mut out {
        t.rect = Rect::new(t.rect.x0 / k.0, t.rect.y0 / k.1, t.rect.x1 / k.0, t.rect.y1 / k.1);
    }
    out
}
pub const MIN_POW2: i32 = -10;
pub const MAX_POW2: i32 = 6;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ScaleKey {
    Pow2(i32),
    /// f64 bits of an exact scale
    Exact(u64),
    /// An exact scale (its f64 bits) for a board fitted to whole device pixels (`fit_board`): the board is drawn
    /// a fraction of a pixel wider or narrower (`fit`: `Fit::code`), so these are other pixels than `Exact`'s.
    Fitted(u64, u8),
}

impl ScaleKey {
    pub fn scale(self) -> f64 {
        match self {
            ScaleKey::Pow2(l) => 2f64.powi(l),
            ScaleKey::Exact(b) | ScaleKey::Fitted(b, _) => f64::from_bits(b),
        }
    }
    /// The settled scale `s`. A power of two is keyed as one, so the textures drawn for it mid-zoom are the
    /// ones it shows once settled (they are the same pixels): settling at 100% on a 2x display renders nothing again.
    pub fn exact(s: f64) -> ScaleKey {
        let l = s.max(1e-300).log2().round();
        if (f64::from(MIN_POW2)..=f64::from(MAX_POW2)).contains(&l) && 2f64.powi(l as i32) == s {
            return ScaleKey::Pow2(l as i32);
        }
        ScaleKey::Exact(s.to_bits())
    }
    /// The power of two to draw at while the zoom changes and the scale on screen is `s`: the one below `s` while
    /// its textures are stretched by at most `stretch` (`gesture_stretch`), the one above after that. Rounding up at once made a
    /// zoom from 100% to 100.4% (on a 2x display) render the whole view again at four times the pixels, to
    /// replace textures stretched by 0.4%.
    pub fn gesture(s: f64, stretch: f64) -> ScaleKey {
        ScaleKey::pow2_for(s / stretch.max(1.0))
    }
    /// The settled scale `s` for a board fitted with `fit` (`Fit::code`; 0: not stretched, the plain key).
    pub fn fitted(s: f64, fit: u8) -> ScaleKey {
        if fit == 0 { ScaleKey::exact(s) } else { ScaleKey::Fitted(s.to_bits(), fit) }
    }
    /// The power of two at or just above `s`.
    pub fn pow2_for(s: f64) -> ScaleKey {
        ScaleKey::Pow2((s.max(1e-6).log2() - 1e-9).ceil().clamp(f64::from(MIN_POW2), f64::from(MAX_POW2)) as i32)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TileKey {
    pub board: u64,
    pub scale: ScaleKey,
    pub tx: i32,
    pub ty: i32,
}

/// One tile slot of a board at a scale.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TileRect {
    pub tx: i32,
    pub ty: i32,
    /// texture size in device px
    pub w: u32,
    pub h: u32,
    /// The rect the texture covers (w/scale × h/scale), in the space of the ink the grid was made for (the
    /// engine's are board space).
    pub rect: Rect,
}

/// The grid a board's ink falls into at scale `s`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Grid {
    pub single: bool,
    pub cols: i32,
    pub rows: i32,
    pub px_w: f64,
    pub px_h: f64,
}

pub fn grid(ink: Rect, s: f64) -> Grid {
    let px_w = (ink.width() * s).ceil().max(1.0);
    let px_h = (ink.height() * s).ceil().max(1.0);
    if px_w <= SINGLE_MAX && px_h <= SINGLE_MAX {
        Grid { single: true, cols: 1, rows: 1, px_w, px_h }
    } else {
        Grid { single: false, cols: (px_w / TILE).ceil() as i32, rows: (px_h / TILE).ceil() as i32, px_w, px_h }
    }
}

pub fn tile_rect(ink: Rect, s: f64, g: &Grid, tx: i32, ty: i32) -> TileRect {
    let (size_x, size_y) = if g.single { (g.px_w, g.px_h) } else { (TILE, TILE) };
    let x0 = f64::from(tx) * size_x;
    let y0 = f64::from(ty) * size_y;
    let w = (g.px_w - x0).min(size_x).max(1.0);
    let h = (g.px_h - y0).min(size_y).max(1.0);
    TileRect { tx, ty, w: w as u32, h: h as u32, rect: Rect::new(ink.x0 + x0 / s, ink.y0 + y0 / s, ink.x0 + (x0 + w) / s, ink.y0 + (y0 + h) / s) }
}

/// `ink` grown to whole device pixels at scale `s`, so texels land on device pixels whenever the
/// camera offset does (always at rest: the page keeps it on whole CSS px).
pub fn snap_ink(ink: Rect, s: f64) -> Rect {
    Rect::new((ink.x0 * s).floor() / s, (ink.y0 * s).floor() / s, (ink.x1 * s).ceil() / s, (ink.y1 * s).ceil() / s)
}

/// The tiles of a board (its ink) that intersect `view` (in the ink's space) at scale `s`.
pub fn tiles_in_view(ink: Rect, s: f64, view: Rect) -> Vec<TileRect> {
    let ink = snap_ink(ink, s);
    let g = grid(ink, s);
    let vis = ink.intersect(view);
    if vis.width() <= 0.0 || vis.height() <= 0.0 {
        return Vec::new();
    }
    if g.single {
        return vec![tile_rect(ink, s, &g, 0, 0)];
    }
    let t = TILE / s;
    let c0 = (((vis.x0 - ink.x0) / t).floor() as i32).max(0);
    let c1 = (((vis.x1 - ink.x0) / t).ceil() as i32).min(g.cols);
    let r0 = (((vis.y0 - ink.y0) / t).floor() as i32).max(0);
    let r1 = (((vis.y1 - ink.y0) / t).ceil() as i32).min(g.rows);
    let mut out = Vec::new();
    for ty in r0..r1 {
        for tx in c0..c1 {
            out.push(tile_rect(ink, s, &g, tx, ty));
        }
    }
    out
}

/// One frame's admission of tile renders under a CPU budget (ms spent encoding and submitting) and
/// the GPU time the cost model predicts. The first attempt is always admitted, so a frame with work
/// always makes progress whatever the model says.
pub struct TileBudget {
    cpu_ms: f64,
    gpu_ms: f64,
    base_ms: f64,
    ms_per_mpx: f64,
    pub attempts: u32,
    pub mpx: f64,
}

impl TileBudget {
    pub fn new(cpu_ms: f64, gpu_ms: f64, base_ms: f64, ms_per_mpx: f64) -> Self {
        TileBudget { cpu_ms, gpu_ms, base_ms, ms_per_mpx, attempts: 0, mpx: 0.0 }
    }
    /// Would a tile of `t_mpx` megapixels be admitted now, `elapsed_ms` into the frame? Asked before the work
    /// that prepares it (an image decode, a repaint), so a frame over budget does not pay for it.
    pub fn fits(&self, t_mpx: f64, elapsed_ms: f64) -> bool {
        let over_gpu = self.base_ms + self.ms_per_mpx * (self.mpx + t_mpx) > self.gpu_ms;
        self.attempts == 0 || !(elapsed_ms > self.cpu_ms || over_gpu)
    }
    /// May a tile of `t_mpx` megapixels render now, `elapsed_ms` into the frame?
    pub fn admit(&mut self, t_mpx: f64, elapsed_ms: f64) -> bool {
        if !self.fits(t_mpx, elapsed_ms) {
            return false;
        }
        self.attempts += 1;
        self.mpx += t_mpx;
        true
    }
}

/// Tiles up to this many device px join a batch render (`Batch`): an overview's boards, base textures.
pub const BATCH_TILE_PX: u64 = 384 * 384;
/// The batch's scratch atlas.
pub const BATCH_SIDE: u32 = 2048;
/// Cells in one batch at most.
pub const BATCH_CELLS: usize = 1024;
/// Image px the boards of one batch may draw together (vello's image atlas holds 8192², and every board's levels
/// are kept within 24 Mpx for the same reason).
pub const BATCH_IMAGE_PX: u64 = 24_000_000;

/// One small tile in a batch render: its board (index), tile, key, render scale and cell in the atlas.
#[derive(Clone, Copy, Debug)]
pub struct BatchCell {
    pub bi: usize,
    pub t: TileRect,
    pub key: TileKey,
    pub scale: (f64, f64),
    pub base: bool,
    /// Drawn with an image below the level its scale needs (see `Slot::lowres`).
    pub short: bool,
    /// Top-left of its cell in the atlas (the cell is the texture: the tile and its gutter).
    pub at: (u32, u32),
}

/// The small tiles one frame renders together: cells packed in rows of a `BATCH_SIDE` square atlas, while the
/// render they make together stays inside vello's fixed buffers (their estimates summed, with room for the clip
/// each cell adds) and the image atlas.
#[derive(Default)]
pub struct Batch {
    pub cells: Vec<BatchCell>,
    est: crate::cull::Estimate,
    pub atlas_px: u64,
    boards: HashSet<usize>,
    /// Why the last add() refused (stats: batchStop): 1 cells, 2 too big, 3 image atlas, 4 vello buffers, 5 atlas full.
    pub refused: u8,
    /// Shelf packing: the next free x in the current row, the row's top and height, the widest row so far.
    x: u32,
    y: u32,
    row: u32,
    wide: u32,
}

impl Batch {
    pub fn len(&self) -> u32 {
        self.cells.len() as u32
    }
    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }
    /// The atlas the cells need.
    pub fn size(&self) -> (u32, u32) {
        (self.wide.max(16), (self.y + self.row).max(16))
    }
    /// Add a tile whose render alone was estimated at `e`, of a board whose images and effect textures take
    /// `atlas_px`. False (nothing added) when it does not fit.
    #[allow(clippy::too_many_arguments)]
    pub fn add(&mut self, bi: usize, t: TileRect, key: TileKey, scale: (f64, f64), base: bool, short: bool, e: crate::cull::Estimate, atlas_px: u64) -> bool {
        if self.cells.len() >= BATCH_CELLS {
            self.refused = 1;
            return false;
        }
        let (w, h) = (t.w + 2 * GUTTER, t.h + 2 * GUTTER);
        if w > BATCH_SIDE || h > BATCH_SIDE {
            self.refused = 2;
            return false;
        }
        let new_board = !self.boards.contains(&bi);
        if new_board && self.atlas_px + atlas_px > BATCH_IMAGE_PX {
            self.refused = 3;
            return false;
        }
        // A cell's clip: a draw object and its tiles in the bins.
        let clip_tiles = f64::from(w.div_ceil(16) + 1) * f64::from(h.div_ceil(16) + 1);
        let sum = crate::cull::Estimate {
            lines: self.est.lines + e.lines,
            segments: self.est.segments + e.segments + 8.0,
            tiles: self.est.tiles + e.tiles + clip_tiles,
            bins: self.est.bins + e.bins + 16.0,
            items: self.est.items + e.items + 2,
        };
        if !sum.fits() {
            self.refused = 4;
            return false;
        }
        let (mut x, mut y, mut row) = (self.x, self.y, self.row);
        if x + w > BATCH_SIDE {
            y += row;
            x = 0;
            row = 0;
        }
        if y + h > BATCH_SIDE {
            self.refused = 5;
            return false;
        }
        self.cells.push(BatchCell { bi, t, key, scale, base, short, at: (x, y) });
        self.x = x + w;
        self.y = y;
        self.row = row.max(h);
        self.wide = self.wide.max(self.x);
        self.est = sum;
        if new_board {
            self.boards.insert(bi);
            self.atlas_px += atlas_px;
        }
        true
    }
}

/// What an edit since a tile was drawn asks of it (`Board::dirty_since` mapped onto the tile's texture).
#[derive(Debug, PartialEq)]
pub enum Redraw {
    /// Nothing in this tile changed: its texture only takes the new generation.
    Unchanged,
    /// Render this region again (texture px, gutter included), on vello's 16 px grid.
    Area([u32; 4]),
    /// Most of it, or not known: render it whole.
    Whole,
}

/// Where `dirty` (board space) lands on a tile's texture rendered at `scale`, grown by 2 px for antialiasing and
/// out to vello's 16 px tiles (a part on that grid renders the same pixels as the whole tile does there).
pub fn redraw_area(dirty: Option<Rect>, tile: Rect, px: (u32, u32), scale: (f64, f64)) -> Redraw {
    let Some(d) = dirty else { return Redraw::Whole };
    if d.width() <= 0.0 && d.height() <= 0.0 {
        return Redraw::Unchanged;
    }
    let g = f64::from(GUTTER);
    let (tw, th) = (f64::from(px.0) + 2.0 * g, f64::from(px.1) + 2.0 * g);
    let x0 = ((d.x0 - tile.x0) * scale.0 + g - 2.0).max(0.0);
    let y0 = ((d.y0 - tile.y0) * scale.1 + g - 2.0).max(0.0);
    let x1 = ((d.x1 - tile.x0) * scale.0 + g + 2.0).min(tw);
    let y1 = ((d.y1 - tile.y0) * scale.1 + g + 2.0).min(th);
    if x1 <= x0 || y1 <= y0 {
        return Redraw::Unchanged;
    }
    let snap0 = |v: f64| ((v / 16.0).floor() * 16.0).max(0.0);
    let (x0, y0) = (snap0(x0), snap0(y0));
    let (x1, y1) = (((x1 / 16.0).ceil() * 16.0).min(tw), ((y1 / 16.0).ceil() * 16.0).min(th));
    // Over 60 % of the texture: one whole render is no more work and needs no copy.
    if (x1 - x0) * (y1 - y0) > 0.6 * tw * th {
        return Redraw::Whole;
    }
    Redraw::Area([x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32])
}

/// The frame period the budgets assume until one is measured (60 Hz).
pub const FRAME_MS_DEFAULT: f64 = 1000.0 / 60.0;

/// One frame's tile budgets for a display with frame period `period` ms: (CPU ms spent encoding and
/// submitting, GPU ms the cost model predicts). Mid-gesture tiles take about a third of a frame (6 ms and 4 ms at
/// 60 Hz), settled ones 60% of it (10 ms): fixed 14 ms and 12 ms budgets were most of a 60 Hz frame and nearly two
/// 120 Hz ones, so a settling view dropped frames of whatever was playing.
pub fn frame_budgets(period: f64, moving: bool) -> (f64, f64) {
    let p = period.clamp(1000.0 / 240.0, 1000.0 / 30.0);
    if moving { (p * 0.36, p * 0.24) } else { (p * 0.6, p * 0.6) }
}

/// The GPU time one frame may be predicted to take (what `TileBudget` compares the cost model with): what a frame
/// costs before any tile (`base_ms`, measured: the composite) plus the frame's tile share `gpu_ms`, and never more
/// than three quarters of the period. Counting the base against the tile share left no room on a big display: at
/// 5K the composite alone measured 3.9 ms of a 4 ms budget, so a pan got one tile a frame while a column of the
/// view is three, and its leading edge fell behind.
pub fn gpu_limit(period: f64, gpu_ms: f64, base_ms: f64) -> f64 {
    (base_ms.max(0.0) + gpu_ms).min(period.clamp(1000.0 / 240.0, 1000.0 / 30.0) * 0.75)
}

/// The display's frame period, from when `frame()` is called: the calls come from requestAnimationFrame, so
/// consecutive ones are a period apart (or a few, when a frame was dropped).
pub struct FrameClock {
    last: f64,
    gaps: [f64; 9],
    n: usize,
}

impl Default for FrameClock {
    fn default() -> Self {
        FrameClock { last: f64::NEG_INFINITY, gaps: [0.0; 9], n: 0 }
    }
}

impl FrameClock {
    /// A frame starts at `t` ms. Returns the period: a low gap of the last nine (the third smallest), so
    /// dropped frames and a late callback do not stretch it; 60 Hz until three gaps are known. Gaps over 50 ms
    /// are pauses (nothing to draw), not frames. `chained`: the frame before asked for this one, so the caller
    /// came straight back on the next display frame. A frame woken by a timer (a card playing at 30 fps while
    /// nothing else draws) is not a display frame apart from the last: its 33 ms gaps read as a 30 Hz display and
    /// doubled the budgets of the next pan on a 120 Hz one.
    pub fn tick(&mut self, t: f64, chained: bool) -> f64 {
        let gap = t - self.last;
        self.last = t;
        if chained && gap > 1.0 && gap < 50.0 {
            self.gaps[self.n % 9] = gap;
            self.n += 1;
        }
        self.period()
    }
    pub fn period(&self) -> f64 {
        let k = self.n.min(9);
        if k < 3 {
            return FRAME_MS_DEFAULT;
        }
        let mut g = self.gaps[..k].to_vec();
        g.sort_by(f64::total_cmp);
        g[2].clamp(1000.0 / 240.0, 1000.0 / 30.0)
    }
}

/// The world rect to keep rendered around `view` at scale `s` (device px per world unit): half a tile on every
/// side, and further where the camera is heading (`pan`: world units the view moved per frame, smoothed), as far
/// as it gets in `PREFETCH_FRAMES` frames, at most `PREFETCH_TILES` tiles. Tiles in the ring and not in view
/// render after everything the view shows, so a pan's leading edge is sharp when it arrives.
pub fn prefetch_ring(view: Rect, s: f64, pan: kurbo::Vec2) -> Rect {
    let tile = TILE / s.max(1e-9);
    let lead = |v: f64| (v * PREFETCH_FRAMES).clamp(-PREFETCH_TILES * tile, PREFETCH_TILES * tile);
    let (lx, ly) = (lead(pan.x), lead(pan.y));
    let m = tile * 0.5;
    Rect::new(view.x0 - m + lx.min(0.0), view.y0 - m + ly.min(0.0), view.x1 + m + lx.max(0.0), view.y1 + m + ly.max(0.0))
}
pub const PREFETCH_FRAMES: f64 = 12.0;
pub const PREFETCH_TILES: f64 = 3.0;
/// Tiles ahead of the view render only while the cache is under this share of its budget: above it they would
/// push out textures the view needs, and be pushed out themselves.
pub const PREFETCH_HEADROOM: f64 = 0.8;

/// Is a tile rendered in parts over several frames (a dense one) kept for the next frame: only while this frame
/// still wanted its tile (a slot in view without its texture, or a tile ahead of it) and something worked on it
/// within the last second of frames. A job whose tile left the view kept its texture (up to 23 MB) until some
/// other tile rendered, which on a fully cached view was never.
pub fn keep_pending(last_worked: u64, frame: u64, wanted: bool) -> bool {
    wanted && last_worked + 60 >= frame
}

/// What a render of one tile of a board costs beyond its pixels, in megapixel equivalents: every tile renders the
/// board's whole scene (vello flattens and bins every path, whatever the target covers), so a dense board's tiles
/// cost more than their size says. `segments`: path segments; `glyphs`: glyphs (about 30 segments each).
pub fn scene_mpx(segments: u32, glyphs: usize) -> f64 {
    (f64::from(segments) + glyphs as f64 * 30.0) * 2.5e-6
}

/// Image atlas pixels three consecutive renders may hold before vello's atlas must be flushed (it is 8192² at most).
pub const ATLAS_FLUSH_PX: u64 = 48_000_000;

/// A render drawing `atlas_px` of images, after renders that drew `recent`, must flush the atlas first.
pub fn atlas_needs_flush(atlas_px: u64, recent: (u64, u64)) -> bool {
    atlas_px > 0 && atlas_px + recent.0 + recent.1 > ATLAS_FLUSH_PX
}

/// Whether the engine needs another frame: while the camera settles, and while any slot in view still
/// shows something other than its fresh texture (a stand-in, a placeholder or nothing). Counting the
/// slots after the renders, not the renders the budget put off, is what makes an idle camera always
/// converge: a render that failed or was skipped leaves its slot unfresh, so the frames keep coming.
pub fn wants_more(moving: bool, unfresh_slots: u32) -> bool {
    moving || unfresh_slots > 0
}

pub struct Slot<T> {
    pub tex: T,
    pub generation: u64,
    pub bytes: u64,
    pub last_used: u64,
    /// The rect of its board the texture covers, in board space (its interior: the gutter lies outside it).
    /// Board space, so a board that moves keeps every texture: only where the compositor draws them changes.
    pub rect: Rect,
    /// interior size in device px (the texture is `GUTTER` px larger on every side)
    pub px: (u32, u32),
    /// Drawn mid-gesture with image levels below what its scale needs: drawn again once settled.
    pub lowres: bool,
}

/// Texels of real content around every tile texture, so filtering at its edge reads its neighbour's
/// pixels instead of clamping (no seam where two tiles meet mid-zoom).
pub const GUTTER: u32 = 2;
/// The long side of a board's base texture: a coarse picture of the whole board kept for every board
/// near the view, so a slot always has something to show while finer tiles render.
pub const BASE_PX: f64 = 512.0;

/// The uv rect of a texture's interior (`px` without the gutter).
pub fn interior_uv(px: (u32, u32)) -> [f32; 4] {
    let (w, h) = (f64::from(px.0 + 2 * GUTTER), f64::from(px.1 + 2 * GUTTER));
    let g = f64::from(GUTTER);
    [(g / w) as f32, (g / h) as f32, ((g + f64::from(px.0)) / w) as f32, ((g + f64::from(px.1)) / h) as f32]
}

/// Bytes of a tile texture with `px` interior.
pub fn tile_bytes(px: (u32, u32)) -> u64 {
    u64::from(px.0 + 2 * GUTTER) * u64::from(px.1 + 2 * GUTTER) * 4
}

/// The scale of a board's base texture: the largest power of two at which its ink fits in `BASE_PX`.
pub fn base_scale(ink: Rect) -> ScaleKey {
    base_scale_at(ink, BASE_PX)
}

/// `base_scale` with base textures `px` long (`base_px_for`).
pub fn base_scale_at(ink: Rect, px: f64) -> ScaleKey {
    let long = ink.width().max(ink.height()).max(1e-6);
    ScaleKey::Pow2(((px / long).log2().floor()).clamp(f64::from(MIN_POW2), f64::from(MAX_POW2)) as i32)
}

/// The smallest base textures go.
pub const BASE_PX_MIN: f64 = 64.0;
/// The share of the tile budget the base textures of the boards near the view may take together.
pub const BASE_SHARE: f64 = 0.3;

/// How long the base textures of the boards near the view (`inks`) are made, from `now`: halved while they
/// would take more than `BASE_SHARE` of the tile `budget` together (down to `BASE_PX_MIN`), doubled back while
/// twice the size would take under a third of that (up to `BASE_PX`). The gap between the two keeps it from
/// going back and forth, since every change renders them all again.
pub fn base_px_for(inks: &[Rect], now: f64, budget: u64) -> f64 {
    let bytes = |px: f64| -> f64 {
        inks.iter().map(|r| {
            let s = base_scale_at(*r, px).scale();
            (r.width() * s + f64::from(2 * GUTTER)) * (r.height() * s + f64::from(2 * GUTTER)) * 4.0
        }).sum()
    };
    let cap = budget as f64 * BASE_SHARE;
    let mut px = now.clamp(BASE_PX_MIN, BASE_PX);
    while px > BASE_PX_MIN && bytes(px) > cap {
        px /= 2.0;
    }
    while px < BASE_PX && bytes(px * 2.0) < cap / 3.0 {
        px *= 2.0;
    }
    px
}

/// A scissor rect `[x, y, w, h]` for device rect `d`, clamped to a `w` × `h` target, holding exactly the
/// pixels a quad over `d` covers (centres inside, the rasteriser's rule). Two rects sharing an edge get
/// scissors that share it too: no pixel is drawn twice (translucent content would darken) or left out.
pub fn scissor_px(d: Rect, w: u32, h: u32) -> Option<[u32; 4]> {
    let edge = |v: f64, max: u32| (v - 0.5).ceil().clamp(0.0, f64::from(max));
    let (x0, y0, x1, y1) = (edge(d.x0, w), edge(d.y0, h), edge(d.x1, w), edge(d.y1, h));
    (x1 > x0 && y1 > y0).then_some([x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32])
}

/// `a` minus `b` as up to four rects.
pub fn subtract(a: Rect, b: Rect, out: &mut Vec<Rect>) {
    let i = a.intersect(b);
    if i.width() <= 0.0 || i.height() <= 0.0 {
        out.push(a);
        return;
    }
    if i.y0 > a.y0 {
        out.push(Rect::new(a.x0, a.y0, a.x1, i.y0));
    }
    if i.y1 < a.y1 {
        out.push(Rect::new(a.x0, i.y1, a.x1, a.y1));
    }
    if i.x0 > a.x0 {
        out.push(Rect::new(a.x0, i.y0, i.x0, i.y1));
    }
    if i.x1 < a.x1 {
        out.push(Rect::new(i.x1, i.y0, a.x1, i.y1));
    }
}

/// What stands in for a slot that has no fresh texture: pieces of cached textures of other scales (or
/// older generations), each clipped to the part of the slot it covers, best scale first. The pieces
/// never overlap, so translucent content is drawn once per pixel.
#[derive(Clone, Debug, Default)]
pub struct Cover {
    /// (texture, the world rect of the slot it fills)
    pub pieces: Vec<(TileKey, Rect)>,
    /// Every part of the slot has a piece.
    pub covered: bool,
    /// What no piece covers (world rects).
    pub left: Vec<Rect>,
    /// Some piece is of an older generation (old content).
    pub stale: bool,
    /// Coarsest and finest piece scale over the wanted one (< 1: blurrier, > 1: minified).
    pub coarsest: f64,
    pub finest: f64,
}

impl Cover {
    /// How urgent rendering the slot is mid-gesture: 0 = nothing (or too little) shows there, 1 = a stand-in
    /// up to 2x too coarse or of old content, 2 = good enough for now (current, stretched by at most
    /// `stretch`, minified at most 4x). `shown`: the wanted scale over the scale on screen; what counts is how
    /// a stand-in looks on screen, not how it compares with the power of two being rendered.
    pub fn class(&self, shown: f64, stretch: f64) -> u8 {
        if !self.covered {
            return 0;
        }
        let (coarsest, finest) = (self.coarsest * shown, self.finest * shown);
        if !self.stale && coarsest >= 1.0 / stretch.max(1.0) - 1e-9 && finest <= 4.0 + 1e-9 {
            2
        } else if coarsest >= 0.5 - 1e-9 {
            1
        } else {
            0
        }
    }
}

/// FxHash (rustc's): the tile and image maps are asked thousands of times a frame on a big overview, and the
/// standard SipHash took 300 ms of a 5,000-board open. Keys are the engine's own, never an attacker's.
#[derive(Default, Clone, Copy)]
pub struct Fx(u64);
impl std::hash::Hasher for Fx {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        let (words, rest) = bytes.as_chunks::<8>();
        for w in words {
            self.write_u64(u64::from_le_bytes(*w));
        }
        for &b in rest {
            self.write_u64(u64::from(b));
        }
    }
    fn write_u8(&mut self, i: u8) {
        self.write_u64(u64::from(i));
    }
    fn write_u32(&mut self, i: u32) {
        self.write_u64(u64::from(i));
    }
    fn write_u64(&mut self, i: u64) {
        self.0 = (self.0.rotate_left(5) ^ i).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
    fn write_usize(&mut self, i: usize) {
        self.write_u64(i as u64);
    }
}
pub type FastMap<K, V> = HashMap<K, V, std::hash::BuildHasherDefault<Fx>>;
pub type FastSet<K> = HashSet<K, std::hash::BuildHasherDefault<Fx>>;

pub struct TileCache<T> {
    map: FastMap<TileKey, Slot<T>>,
    /// Every key of a board: a stand-in lookup scans only that board's textures.
    by_board: FastMap<u64, FastSet<TileKey>>,
    pub bytes: u64,
    pub budget: u64,
}

impl<T> TileCache<T> {
    pub fn new(budget: u64) -> Self {
        TileCache { map: FastMap::default(), by_board: FastMap::default(), bytes: 0, budget }
    }
    pub fn len(&self) -> usize {
        self.map.len()
    }
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
    pub fn get(&self, k: &TileKey) -> Option<&Slot<T>> {
        self.map.get(k)
    }
    /// Holds the board's current generation (it may be a mid-gesture low-resolution one).
    pub fn fresh(&self, k: &TileKey, generation: u64) -> bool {
        self.map.get(k).is_some_and(|s| s.generation == generation)
    }
    /// Fresh and drawn with every image at the level its scale needs (what a settled camera wants).
    pub fn sharp(&self, k: &TileKey, generation: u64) -> bool {
        self.map.get(k).is_some_and(|s| s.generation == generation && !s.lowres)
    }
    /// The texture of `k` was brought up to `generation` in place (`Gpu::render_into`).
    pub fn restamp(&mut self, k: &TileKey, generation: u64, frame: u64) -> bool {
        match self.map.get_mut(k) {
            Some(s) => {
                s.generation = generation;
                s.last_used = frame;
                true
            }
            None => false,
        }
    }
    pub fn touch(&mut self, k: &TileKey, frame: u64) {
        if let Some(s) = self.map.get_mut(k) {
            s.last_used = frame;
        }
    }
    pub fn insert(&mut self, k: TileKey, tex: T, generation: u64, bytes: u64, frame: u64, rect: Rect) -> &mut Slot<T> {
        if let Some(old) = self.map.remove(&k) {
            self.bytes -= old.bytes;
        }
        self.bytes += bytes;
        self.by_board.entry(k.board).or_default().insert(k);
        self.map.entry(k).or_insert(Slot { tex, generation, bytes, last_used: frame, rect, px: (0, 0), lowres: false })
    }
    fn remove(&mut self, k: &TileKey) -> Option<Slot<T>> {
        let s = self.map.remove(k)?;
        self.bytes -= s.bytes;
        if let Some(set) = self.by_board.get_mut(&k.board) {
            set.remove(k);
            if set.is_empty() {
                self.by_board.remove(&k.board);
            }
        }
        Some(s)
    }
    pub fn remove_board(&mut self, board: u64) {
        for k in self.by_board.remove(&board).unwrap_or_default() {
            if let Some(s) = self.map.remove(&k) {
                self.bytes -= s.bytes;
            }
        }
    }
    /// Bytes of the textures drawn (touched) in `frame`: what eviction cannot free that frame.
    pub fn used_bytes(&self, frame: u64) -> u64 {
        self.map.values().filter(|s| s.last_used == frame).map(|s| s.bytes).sum()
    }
    pub fn keys_of(&self, board: u64) -> impl Iterator<Item = (&TileKey, &Slot<T>)> {
        self.by_board.get(&board).into_iter().flatten().filter_map(|k| self.map.get(k).map(|s| (k, s)))
    }

    /// Stand-ins for slot `world` (a rect of the board, board space) of `board` wanted at scale `want`: the best scale first (finer than
    /// wanted is fine, it gets minified; coarser costs sharpness), then whatever the next scales cover of
    /// what is still uncovered. Textures of an older generation (`generation` is the board's) come after
    /// every current one: a stale picture only where nothing current covers. `skip` leaves one texture
    /// out (the slot's own, held back while the rest of the view renders).
    pub fn cover(&self, board: u64, generation: u64, want: f64, world: Rect, skip: Option<TileKey>) -> Cover {
        let mut cands: Vec<(f64, TileKey, Rect)> = Vec::new();
        for (k, s) in self.keys_of(board) {
            if Some(*k) == skip {
                continue;
            }
            let ov = s.rect.intersect(world);
            if ov.width() <= 0.0 || ov.height() <= 0.0 {
                continue;
            }
            let sc = k.scale.scale();
            let cost = stand_in_cost(sc / want);
            let stale = if s.generation == generation { 0.0 } else { 100.0 };
            cands.push((cost + stale, *k, s.rect));
        }
        // By cost, then a fixed order so the pick never flickers between equals.
        cands.sort_by(|a, b| a.0.total_cmp(&b.0).then((a.1.ty, a.1.tx).cmp(&(b.1.ty, b.1.tx))));
        let mut out = Cover { pieces: Vec::new(), covered: false, left: Vec::new(), stale: false, coarsest: f64::INFINITY, finest: 0.0 };
        // Slivers below a millionth of a device px are float noise, not holes (anything wider may hold a
        // pixel centre, and dropping it would leave that column undrawn).
        let eps = 1e-6 / want.max(1e-9);
        let mut left = vec![world];
        for (_, k, r) in cands {
            if left.is_empty() {
                break;
            }
            let mut next = Vec::with_capacity(left.len() + 4);
            let mut used = false;
            for piece in &left {
                let i = piece.intersect(r);
                if i.width() > eps && i.height() > eps {
                    out.pieces.push((k, i));
                    used = true;
                }
                subtract(*piece, r, &mut next);
            }
            next.retain(|p| p.width() > eps && p.height() > eps);
            left = next;
            if used {
                out.stale |= self.map.get(&k).is_some_and(|s| s.generation != generation);
                let ratio = k.scale.scale() / want;
                out.coarsest = out.coarsest.min(ratio);
                out.finest = out.finest.max(ratio);
            }
        }
        out.covered = left.is_empty();
        out.left = left;
        if out.pieces.is_empty() {
            out.coarsest = 0.0;
        }
        out
    }

    /// Drop textures until under budget. Never drops what this frame uses. Order: stale
    /// generations, then other scales than `desired`, then least recently used; a board's base
    /// texture (`info` gives each board's generation and base scale) goes last. A stale base counts
    /// as fresh while its board has no fresh one: it is the only picture of the whole board (an image
    /// that sharpened at 800% repaints the board; zooming out to 2% then showed holes where it was).
    pub fn evict(&mut self, frame: u64, desired: ScaleKey, info: impl Fn(u64) -> Option<(u64, ScaleKey)>) -> Vec<(TileKey, T)> {
        let mut out = Vec::new();
        if self.bytes <= self.budget {
            return out;
        }
        let is_base = |k: &TileKey| info(k.board).is_some_and(|(_, b)| b == k.scale);
        let fresh_base: HashSet<u64> = self.map.iter().filter(|(k, s)| is_base(k) && info(k.board).is_some_and(|(g, _)| g == s.generation)).map(|(k, _)| k.board).collect();
        let mut order: Vec<(TileKey, (bool, bool, bool, u64))> = self
            .map
            .iter()
            .filter(|(_, s)| s.last_used != frame)
            .map(|(k, s)| {
                let i = info(k.board);
                let base = is_base(k);
                let fresh = i.is_some_and(|(g, _)| g == s.generation) || (base && !fresh_base.contains(&k.board));
                (*k, (fresh, base, k.scale.scale() == desired.scale(), s.last_used))
            })
            .collect();
        order.sort_by_key(|(_, rank)| *rank);
        for (k, _) in order {
            if self.bytes <= self.budget {
                break;
            }
            if let Some(s) = self.remove(&k) {
                out.push((k, s.tex));
            }
        }
        out
    }

    /// Make room for tiles ahead of the view: drop textures of older generations and of other scales than
    /// `desired`, least recently used first, until at most `target` bytes are held. Never a texture this frame
    /// used, a board's base texture, or a current texture of the wanted scale (the view's own and the ring's).
    /// `evict` only trims to the whole budget, and every zoom level visited stays cached: after a few zooms the
    /// cache sat between the prefetch headroom and the budget for good, and no tile was rendered ahead again.
    pub fn evict_for_prefetch(&mut self, frame: u64, desired: ScaleKey, info: impl Fn(u64) -> Option<(u64, ScaleKey)>, target: u64) -> Vec<(TileKey, T)> {
        let mut out = Vec::new();
        if self.bytes <= target {
            return out;
        }
        let mut order: Vec<(TileKey, (bool, u64))> = self
            .map
            .iter()
            .filter(|(k, s)| {
                let i = info(k.board);
                let base = i.is_some_and(|(_, b)| b == k.scale);
                let current = i.is_some_and(|(g, _)| g == s.generation);
                s.last_used != frame && !base && !(current && k.scale.scale() == desired.scale())
            })
            .map(|(k, s)| (*k, (info(k.board).is_some_and(|(g, _)| g == s.generation), s.last_used)))
            .collect();
        order.sort_by_key(|(_, rank)| *rank);
        for (k, _) in order {
            if self.bytes <= target {
                break;
            }
            if let Some(s) = self.remove(&k) {
                out.push((k, s.tex));
            }
        }
        out
    }
}

/// How bad a stand-in at `ratio` times the wanted scale looks (lower is better): finer is fine up to 4x (minified),
/// beyond that every texel the compositor averages costs GPU time (a 16x stand-in reads 400 texels per pixel, a
/// full screen of it spiked fast zoom-outs), so a 2x coarser one wins over an 8x finer one. Coarser costs sharpness.
pub fn stand_in_cost(ratio: f64) -> f64 {
    let l = ratio.log2();
    if l >= 0.0 {
        if l > 2.0 { l + 2.5 * (l - 2.0) } else { l }
    } else {
        4.0 - l
    }
}

/// Least-recently-used eviction of keyed GPU objects under a byte budget (effect textures). Items
/// used this frame stay. Returns the keys to drop, oldest first.
pub fn lru_over_budget(items: &[(u64, u64, u64)], budget: u64, frame: u64) -> Vec<u64> {
    let mut total: u64 = items.iter().map(|i| i.1).sum();
    if total <= budget {
        return Vec::new();
    }
    let mut order: Vec<&(u64, u64, u64)> = items.iter().filter(|i| i.2 != frame).collect();
    order.sort_by_key(|i| (i.2, i.0));
    let mut out = Vec::new();
    for (id, bytes, _) in order {
        if total <= budget {
            break;
        }
        total -= bytes;
        out.push(*id);
    }
    out
}

/// Which effect jobs (by index, in their order) a tile needs: those drawn where the tile is (`jobs`:
/// (where each is drawn, the content rect its texture renders)), plus every earlier job drawn inside the
/// content of one of those (a shadow inside a blurred group), transitively.
pub fn jobs_needed(jobs: &[(Rect, Rect)], tile: Rect) -> Vec<usize> {
    let meets = |a: Rect, b: Rect| {
        let i = a.intersect(b);
        i.width() > 0.0 && i.height() > 0.0
    };
    let mut need: Vec<bool> = jobs.iter().map(|j| meets(j.0, tile)).collect();
    for j in (0..jobs.len()).rev() {
        if need[j] {
            for k in 0..j {
                if !need[k] && meets(jobs[k].0, jobs[j].1) {
                    need[k] = true;
                }
            }
        }
    }
    (0..jobs.len()).filter(|&i| need[i]).collect()
}

/// Side of one layer of the small-tile atlas (gpu.rs `AtlasPool`): an array texture of such layers.
pub const ATLAS_SIDE: u32 = 2048;
/// Textures up to this many px a side (gutter included) live in the atlas; larger ones have a texture of their own.
pub const ATLAS_MAX_CELL: u32 = 128;

/// The atlas cell a w x h texture takes: each side rounded up to a multiple of 16 (powers of two left an overview's
/// 37 x 75 px tiles in 64 x 128 cells, three times their size). None: too big.
pub fn cell_class(w: u32, h: u32) -> Option<(u32, u32)> {
    let c = |v: u32| v.max(16).div_ceil(16) * 16;
    (w <= ATLAS_MAX_CELL && h <= ATLAS_MAX_CELL && w > 0 && h > 0).then(|| (c(w), c(h)))
}

/// Cells of the small-tile atlas: every layer holds cells of one class (a slab), handed out from a free list and
/// given back when their tile goes; a layer whose last cell goes takes any class next. An overview of thousands of
/// boards drew a texture of its own per board, each a bind group and a draw call of its own in the composite
/// (5,000 of each a frame); in the atlas they share one bind group and go in a few instanced draws.
#[derive(Default)]
pub struct CellAlloc {
    layers: Vec<Slab>,
}

#[derive(Default)]
struct Slab {
    class: Option<(u32, u32)>,
    free: Vec<(u32, u32)>,
    used: u32,
}

impl CellAlloc {
    pub fn layers(&self) -> u32 {
        self.layers.len() as u32
    }
    /// More (empty) layers: the texture grew.
    pub fn grow(&mut self, to: u32) {
        while self.layers.len() < to as usize {
            self.layers.push(Slab::default());
        }
    }
    /// A cell of `class`: (layer, x, y), or None when every layer is taken by other classes or full (grow, ask again).
    pub fn alloc(&mut self, class: (u32, u32)) -> Option<(u32, u32, u32)> {
        let li = self.layers.iter().position(|l| l.class == Some(class) && !l.free.is_empty()).or_else(|| self.layers.iter().position(|l| l.class.is_none()))?;
        let l = &mut self.layers[li];
        if l.class.is_none() {
            l.class = Some(class);
            let (nx, ny) = (ATLAS_SIDE / class.0, ATLAS_SIDE / class.1);
            // Popped from the end: the first cells handed out are the top-left ones.
            l.free = (0..ny).rev().flat_map(|y| (0..nx).rev().map(move |x| (x * class.0, y * class.1))).collect();
        }
        let (x, y) = l.free.pop()?;
        l.used += 1;
        Some((li as u32, x, y))
    }
    pub fn free(&mut self, layer: u32, x: u32, y: u32) {
        let Some(l) = self.layers.get_mut(layer as usize) else { return };
        l.used = l.used.saturating_sub(1);
        if l.used == 0 {
            l.class = None;
            l.free = Vec::new();
        } else {
            l.free.push((x, y));
        }
    }
    pub fn used(&self) -> u32 {
        self.layers.iter().map(|l| l.used).sum()
    }
    /// No layers (the texture was given back).
    pub fn clear(&mut self) {
        self.layers.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    const GEN: u64 = 1;

    #[test]
    fn atlas_cells_by_class() {
        assert_eq!(cell_class(25, 50), Some((32, 64)));
        assert_eq!(cell_class(3, 3), Some((16, 16)));
        assert_eq!(cell_class(128, 20), Some((128, 32)));
        assert_eq!(cell_class(37, 75), Some((48, 80)));
        assert_eq!(cell_class(129, 20), None);
        let mut a = CellAlloc::default();
        assert_eq!(a.alloc((32, 64)), None, "no layers yet");
        a.grow(2);
        assert_eq!(a.alloc((32, 64)), Some((0, 0, 0)));
        assert_eq!(a.alloc((32, 64)), Some((0, 32, 0)));
        // Another class takes the next empty layer.
        assert_eq!(a.alloc((16, 16)), Some((1, 0, 0)));
        assert_eq!(a.alloc((64, 64)), None, "both layers hold other classes");
        // Every cell of a layer, none twice.
        let mut seen = HashSet::new();
        seen.insert((0, 0));
        seen.insert((32, 0));
        while let Some((l, x, y)) = a.alloc((32, 64)) {
            assert_eq!(l, 0);
            assert!(seen.insert((x, y)), "cell handed out twice");
            assert!(x + 32 <= ATLAS_SIDE && y + 64 <= ATLAS_SIDE);
        }
        assert_eq!(seen.len() as u32, (ATLAS_SIDE / 32) * (ATLAS_SIDE / 64));
        a.free(0, 64, 0);
        assert_eq!(a.alloc((32, 64)), Some((0, 64, 0)), "a freed cell is handed out again");
        // A layer emptied takes any class.
        a.free(1, 0, 0);
        assert_eq!(a.alloc((64, 64)), Some((1, 0, 0)));
        assert_eq!(a.used(), seen.len() as u32 + 1);
    }

    /// A finer texture of an older generation (drawn before the board's images arrived, say) must not
    /// win over a current one: it shows old content. It only fills what nothing current covers.
    #[test]
    fn stale_generations_only_fill_holes() {
        let mut c: TileCache<()> = TileCache::new(DEFAULT_BUDGET);
        let r = Rect::new(0.0, 0.0, 100.0, 100.0);
        let fine_old = TileKey { board: 1, scale: ScaleKey::Pow2(2), tx: 0, ty: 0 };
        let coarse_new = TileKey { board: 1, scale: ScaleKey::Pow2(-1), tx: 0, ty: 0 };
        c.insert(fine_old, (), 1, 1, 1, r);
        c.insert(coarse_new, (), 2, 1, 1, Rect::new(0.0, 0.0, 100.0, 50.0));
        let cv = c.cover(1, 2, 1.0, r, None);
        assert_eq!(cv.pieces[0], (coarse_new, Rect::new(0.0, 0.0, 100.0, 50.0)));
        assert_eq!(cv.pieces[1], (fine_old, Rect::new(0.0, 50.0, 100.0, 100.0)));
        assert!(cv.covered && cv.stale);
        assert_eq!(cv.class(1.0, UPSCALE_OK), 1, "half of it 2x coarse, half old");
        let only_old = c.cover(1, 2, 2.0, Rect::new(0.0, 60.0, 100.0, 100.0), None);
        assert_eq!((only_old.class(1.0, UPSCALE_OK), only_old.stale), (1, true), "old content renders mid-gesture, after empty slots");
    }

    #[test]
    fn a_settled_power_of_two_scale_reuses_the_gesture_textures() {
        assert_eq!(ScaleKey::exact(2.0), ScaleKey::Pow2(1), "100% on a 2x display");
        assert_eq!(ScaleKey::exact(0.25), ScaleKey::Pow2(-2));
        assert_eq!(ScaleKey::exact(2.0), ScaleKey::pow2_for(2.0), "the zoom's key is the settled key");
        assert_eq!(ScaleKey::exact(1.5), ScaleKey::Exact(1.5f64.to_bits()));
        assert_eq!(ScaleKey::exact(2.0000001).scale(), 2.0000001);
        assert_eq!(ScaleKey::exact(1024.0), ScaleKey::Exact(1024f64.to_bits()), "out of the pyramid's range");
    }

    #[test]
    fn heavy_minification_loses_to_a_slightly_coarser_stand_in() {
        let mut c: TileCache<()> = TileCache::new(DEFAULT_BUDGET);
        let r = Rect::new(0.0, 0.0, 100.0, 100.0);
        let key = |l| TileKey { board: 1, scale: ScaleKey::Pow2(l), tx: 0, ty: 0 };
        c.insert(key(4), (), 1, 1, 1, r); // 16x finer than wanted
        c.insert(key(-1), (), 1, 1, 1, r); // 2x coarser
        assert_eq!(c.cover(1, GEN, 1.0, r, None).pieces[0].0, key(-1), "a fast zoom-out must not composite 16x minified");
        c.insert(key(3), (), 1, 1, 1, r);
        assert_eq!(c.cover(1, GEN, 1.0, r, None).pieces[0].0, key(-1), "8x finer loses too");
        c.insert(key(2), (), 1, 1, 1, r);
        assert_eq!(c.cover(1, GEN, 1.0, r, None).pieces[0].0, key(2), "4x finer is still the best picture");
        assert!(stand_in_cost(1.0) < stand_in_cost(2.0) && stand_in_cost(4.0) < stand_in_cost(0.5) && stand_in_cost(0.5) < stand_in_cost(8.0));
    }

    #[test]
    fn the_tile_budget_grows_with_the_display() {
        assert_eq!(tile_budget_for(2880, 1800), DEFAULT_BUDGET, "a 2x laptop keeps the default");
        assert_eq!(tile_budget_for(5120, 2880), 5120 * 2880 * 4 * BUDGET_SCREENS);
        assert!(tile_budget_for(6016, 3384) > 460 * 1024 * 1024, "6K: six screenfuls");
    }

    #[test]
    fn base_textures_of_a_big_overview_fit_their_share_of_the_budget() {
        let phone = Rect::new(0.0, 0.0, 390.0, 844.0);
        assert_eq!(base_px_for(&[phone; 20], BASE_PX, DEFAULT_BUDGET), BASE_PX, "a few boards keep 512 px");
        let px = base_px_for(&vec![phone; 2000], BASE_PX, DEFAULT_BUDGET);
        assert!(px < BASE_PX && px >= BASE_PX_MIN, "{px}");
        let bytes: f64 = (0..2000).map(|_| { let s = base_scale_at(phone, px).scale(); (390.0 * s + 4.0) * (844.0 * s + 4.0) * 4.0 }).sum();
        assert!(bytes <= DEFAULT_BUDGET as f64 * BASE_SHARE, "{bytes}");
        assert!(base_px_for(&vec![phone; 5000], px, DEFAULT_BUDGET) <= px, "more boards, no bigger");
        // Back to a few boards: it grows again, and not before it is well under the cap.
        assert_eq!(base_px_for(&[phone; 20], px, DEFAULT_BUDGET), BASE_PX);
        let edge = base_px_for(&vec![phone; 2000], px, DEFAULT_BUDGET);
        assert_eq!(base_px_for(&vec![phone; 1900], edge, DEFAULT_BUDGET), edge, "a few boards less does not flip it");
    }

    #[test]
    fn a_batch_packs_small_tiles_until_it_is_full() {
        let t = |w: u32, h: u32| TileRect { tx: 0, ty: 0, w, h, rect: Rect::new(0.0, 0.0, f64::from(w), f64::from(h)) };
        let key = |i: u64| TileKey { board: i, scale: ScaleKey::Pow2(0), tx: 0, ty: 0 };
        let e = crate::cull::Estimate { lines: 100.0, segments: 100.0, tiles: 10.0, bins: 10.0, items: 3 };
        let mut b = Batch::default();
        assert!(b.is_empty());
        for i in 0..100 {
            assert!(b.add(i, t(100, 200), key(i as u64), (1.0, 1.0), false, false, e, 1000), "{i}");
        }
        assert_eq!(b.len(), 100);
        let (w, h) = b.size();
        assert!(w <= BATCH_SIDE && h <= BATCH_SIDE);
        // Cells never overlap.
        for (i, a) in b.cells.iter().enumerate() {
            for c in &b.cells[i + 1..] {
                let (aw, ah, cw, ch) = (a.t.w + 4, a.t.h + 4, c.t.w + 4, c.t.h + 4);
                assert!(a.at.0 + aw <= c.at.0 || c.at.0 + cw <= a.at.0 || a.at.1 + ah <= c.at.1 || c.at.1 + ch <= a.at.1);
            }
        }
        // Full: no more room in the atlas.
        let mut full = Batch::default();
        let mut n = 0;
        while full.add(n, t(250, 250), key(n as u64), (1.0, 1.0), false, false, e, 0) {
            n += 1;
        }
        assert_eq!(n, 64, "8 x 8 cells of 254 px in 2048");
        // Images: a board's count once; past the cap, new boards wait.
        let mut img = Batch::default();
        assert!(img.add(1, t(10, 10), key(1), (1.0, 1.0), false, false, e, BATCH_IMAGE_PX - 10));
        assert!(img.add(1, t(10, 10), key(2), (1.0, 1.0), false, false, e, BATCH_IMAGE_PX - 10), "same board");
        assert!(!img.add(2, t(10, 10), key(3), (1.0, 1.0), false, false, e, 100), "another board over the image cap");
        // vello's buffers.
        let big = crate::cull::Estimate { lines: crate::cull::LIMIT_LINES * 0.6, ..e };
        let mut v = Batch::default();
        assert!(v.add(1, t(10, 10), key(1), (1.0, 1.0), false, false, big, 0));
        assert!(!v.add(2, t(10, 10), key(2), (1.0, 1.0), false, false, big, 0));
    }

    #[test]
    fn a_dirty_region_lands_on_the_texture_on_vellos_grid() {
        let tile = Rect::new(0.0, 0.0, 400.0, 800.0);
        assert_eq!(redraw_area(None, tile, (800, 1600), (2.0, 2.0)), Redraw::Whole);
        assert_eq!(redraw_area(Some(Rect::ZERO), tile, (800, 1600), (2.0, 2.0)), Redraw::Unchanged);
        assert_eq!(redraw_area(Some(Rect::new(500.0, 0.0, 600.0, 10.0)), tile, (800, 1600), (2.0, 2.0)), Redraw::Unchanged, "outside the tile");
        let Redraw::Area([x, y, w, h]) = redraw_area(Some(Rect::new(10.0, 20.0, 50.0, 50.0)), tile, (800, 1600), (2.0, 2.0)) else { panic!("an area") };
        assert!(x % 16 == 0 && y % 16 == 0, "on the 16 px grid");
        // board 10..50 x 20..50 at 2x, plus the 2 px gutter: texture px 22..102 x 42..102
        assert!(x <= 20 && y <= 40 && x + w >= 104 && y + h >= 104, "{x} {y} {w} {h}");
        assert!(x + w <= 804 && y + h <= 1604);
        assert_eq!(redraw_area(Some(Rect::new(0.0, 0.0, 390.0, 700.0)), tile, (800, 1600), (2.0, 2.0)), Redraw::Whole, "most of it");
    }

    #[test]
    fn admission_is_asked_before_the_work_that_prepares_a_tile() {
        let mut b = TileBudget::new(14.0, 12.0, 1.0, 4.0);
        assert!(b.fits(5.0, 100.0), "nothing admitted yet: the first always fits");
        assert!(b.admit(1.0, 0.0));
        assert!(!b.fits(1.0, 20.0), "over the CPU budget");
        assert!(!b.fits(3.0, 0.0), "over the GPU model");
        assert!(b.fits(1.0, 2.0));
        assert_eq!(b.mpx, 1.0, "asking admits nothing");
        assert!(scene_mpx(100_000, 0) > 0.2 && scene_mpx(0, 5000) > 0.3 && scene_mpx(100, 10) < 0.01);
    }

    #[test]
    fn atlas_flush_counts_the_last_two_renders() {
        assert!(!atlas_needs_flush(0, (ATLAS_FLUSH_PX, ATLAS_FLUSH_PX)), "a render without images keeps the atlas");
        assert!(!atlas_needs_flush(16_000_000, (16_000_000, 16_000_000)));
        assert!(atlas_needs_flush(16_000_001, (16_000_000, 16_000_000)));
    }

    #[test]
    fn pow2_rounds_up() {
        assert_eq!(ScaleKey::pow2_for(1.0), ScaleKey::Pow2(0));
        assert_eq!(ScaleKey::pow2_for(1.01), ScaleKey::Pow2(1));
        assert_eq!(ScaleKey::pow2_for(0.3), ScaleKey::Pow2(-1));
        assert_eq!(ScaleKey::pow2_for(1e9), ScaleKey::Pow2(MAX_POW2));
    }

    #[test]
    fn small_board_is_one_texture() {
        let ink = Rect::new(100.0, 100.0, 490.0, 944.0);
        let t = tiles_in_view(ink, 2.0, Rect::new(0.0, 0.0, 1000.0, 1000.0));
        assert_eq!(t.len(), 1);
        assert_eq!((t[0].w, t[0].h), (780, 1688));
        assert_eq!(t[0].rect, ink, "already on the pixel grid");
        let off = tiles_in_view(Rect::new(0.3, 0.6, 10.2, 10.0), 2.0, Rect::new(0.0, 0.0, 100.0, 100.0));
        assert_eq!(off[0].rect, Rect::new(0.0, 0.5, 10.5, 10.0), "grown to whole device px");
        assert!(tiles_in_view(ink, 2.0, Rect::new(600.0, 0.0, 900.0, 50.0)).is_empty(), "culled when out of view");
    }

    #[test]
    fn big_board_tiles_only_what_is_visible() {
        let ink = Rect::new(0.0, 0.0, 3200.0, 5151.0);
        let g = grid(ink, 2.0);
        assert!(!g.single);
        assert_eq!((g.cols, g.rows), (7, 11));
        // A 1440x900 css viewport at z=1 (s=2) in the top-left corner.
        let t = tiles_in_view(ink, 2.0, Rect::new(0.0, 0.0, 1440.0, 900.0));
        assert_eq!(t.len(), 3 * 2);
        let last = tiles_in_view(ink, 2.0, Rect::new(3100.0, 5130.0, 3300.0, 5300.0));
        assert_eq!(last.len(), 1);
        assert_eq!((last[0].tx, last[0].ty, last[0].w, last[0].h), (6, 10, 6400 - 6 * 1024, 10302 - 10 * 1024));
    }

    #[test]
    fn eviction_prefers_stale_then_other_scales_then_lru() {
        let mut c: TileCache<u32> = TileCache::new(300);
        let k = |board, scale, tx| TileKey { board, scale, tx, ty: 0 };
        let r = Rect::new(0.0, 0.0, 1.0, 1.0);
        c.insert(k(1, ScaleKey::Pow2(0), 0), 1, 5, 100, 1, r); // fresh, desired, old
        c.insert(k(1, ScaleKey::Pow2(1), 0), 2, 5, 100, 2, r); // fresh, other scale
        c.insert(k(2, ScaleKey::Pow2(0), 0), 3, 1, 100, 3, r); // stale (board 2 is at generation 2)
        c.insert(k(1, ScaleKey::Pow2(0), 1), 4, 5, 100, 9, r); // used this frame
        assert_eq!(c.bytes, 400);
        let info = |b| Some((if b == 2 { 2 } else { 5 }, ScaleKey::Pow2(-3)));
        let gone = c.evict(9, ScaleKey::Pow2(0), info);
        assert_eq!(gone.iter().map(|(_, t)| *t).collect::<Vec<_>>(), vec![3]);
        c.budget = 150;
        let gone = c.evict(9, ScaleKey::Pow2(0), info);
        assert_eq!(gone.iter().map(|(_, t)| *t).collect::<Vec<_>>(), vec![2, 1]);
        assert!(c.get(&k(1, ScaleKey::Pow2(0), 1)).is_some(), "this frame's tile survives");
    }

    #[test]
    fn a_stale_base_outlives_other_tiles_while_its_board_has_no_fresh_one() {
        let mut c: TileCache<u32> = TileCache::new(150);
        let k = |board, scale, tx| TileKey { board, scale, tx, ty: 0 };
        let r = Rect::new(0.0, 0.0, 1.0, 1.0);
        let base = ScaleKey::Pow2(-3);
        c.insert(k(1, base, 0), 1, 1, 100, 1, r); // board 1's only base, from generation 1 (now 2)
        c.insert(k(2, base, 0), 2, 1, 100, 1, r); // board 2's stale base: it has a fresh one too
        c.insert(k(2, base, 1), 3, 2, 10, 1, r); // (another key standing for board 2's fresh base)
        c.insert(k(1, ScaleKey::Pow2(3), 0), 4, 2, 100, 5, r); // a fresh close-up tile, recently used
        let info = |_| Some((2, base));
        let gone: Vec<u32> = c.evict(9, ScaleKey::Pow2(3), info).into_iter().map(|(_, t)| t).collect();
        assert_eq!(gone, vec![2, 4], "the stale base with a fresh twin goes first, then other tiles; board 1's only base stays");
        assert!(c.get(&k(1, base, 0)).is_some());
    }

    /// Dragging a board redrew it every frame: tiles were cut and keyed in world space, so each move made a new
    /// grid (audit: 354 renders, 376 Mpx, for 60 frames of a picture that never changed).
    #[test]
    fn a_moved_board_keeps_every_texture_fresh() {
        let mut c: TileCache<()> = TileCache::new(DEFAULT_BUDGET);
        let ink = Rect::new(0.0, 0.0, 3000.0, 3000.0);
        // The view, in the board's own space, as the board is dragged 0.75 world px a frame: the camera sees
        // the same part of it shifted, and every tile it needs keeps its key and its rect.
        let view0 = Rect::new(100.0, 100.0, 1540.0, 800.0);
        let first = tiles_in_view(ink, 2.0, view0);
        for t in &first {
            c.insert(TileKey { board: 3, scale: ScaleKey::Pow2(1), tx: t.tx, ty: t.ty }, (), 1, 10, 1, t.rect);
        }
        let mut renders = 0;
        for f in 1..=60 {
            let moved = view0 - kurbo::Vec2::new(0.75 * f64::from(f), 0.0);
            for t in tiles_in_view(ink, 2.0, moved) {
                let k = TileKey { board: 3, scale: ScaleKey::Pow2(1), tx: t.tx, ty: t.ty };
                if !c.fresh(&k, 1) {
                    renders += 1;
                    c.insert(k, (), 1, 10, 1, t.rect);
                }
                assert_eq!(c.get(&k).map(|s| s.rect), Some(t.rect), "the grid does not move with the board");
            }
        }
        assert_eq!(renders, 0, "45 px of drag stayed inside the tiles already drawn");
    }

    #[test]
    fn a_gesture_keeps_the_lower_power_of_two_while_the_stretch_is_unseen() {
        // 100% on a 2x display is the textures of scale 2; the first step past it wants the level above
        // (it renders inside the budgets, and both levels stay cached: hovering around 100% renders it once).
        assert_eq!(ScaleKey::gesture(2.0, STRETCH_UNSEEN), ScaleKey::Pow2(1));
        for z in [1.004, 1.013, 1.19, 2.0] {
            assert_eq!(ScaleKey::gesture(2.0 * z, STRETCH_UNSEEN), ScaleKey::Pow2(2), "zoom {z}");
        }
        // When the level above is not affordable the level below is kept up to 1.2x: a pinch from 100% to
        // 101.3% then renders nothing (the audit's 19 Mpx for a 0.4% stretch).
        for z in [1.0, 1.004, 1.013, 1.19] {
            assert_eq!(ScaleKey::gesture(2.0 * z, UPSCALE_OK), ScaleKey::Pow2(1), "zoom {z}");
        }
        assert_eq!(ScaleKey::gesture(2.0 * 1.21, UPSCALE_OK), ScaleKey::Pow2(2));
        assert_eq!(ScaleKey::gesture(0.05, UPSCALE_OK), ScaleKey::Pow2(-4), "zoomed out, textures are minified: 2^-4 = 0.0625");
        assert_eq!(ScaleKey::gesture(1e9, STRETCH_UNSEEN), ScaleKey::Pow2(MAX_POW2));
        // A stand-in stretched 1.1x is good enough only under the wide allowance.
        let mut c: TileCache<()> = TileCache::new(DEFAULT_BUDGET);
        let r = Rect::new(0.0, 0.0, 100.0, 100.0);
        c.insert(TileKey { board: 1, scale: ScaleKey::Pow2(1), tx: 0, ty: 0 }, (), 1, 10, 1, r);
        let cv = c.cover(1, 1, 4.0, r, None);
        assert_eq!((cv.class(4.0 / 2.2, STRETCH_UNSEEN), cv.class(4.0 / 2.2, UPSCALE_OK)), (1, 2));
    }

    #[test]
    fn the_sharper_level_renders_mid_gesture_when_it_is_affordable() {
        // 1440 x 700 at 2x (4 Mpx), measured 1.25 ms per Mpx, 4 ms of GPU a frame at 60 Hz: 16 Mpx in 5 frames.
        assert_eq!(gesture_stretch(4.03, 2.0, 4.0, FRAME_MS_DEFAULT, tile_budget_for(2880, 1400)), STRETCH_UNSEEN, "the cost model's start value");
        assert_eq!(gesture_stretch(4.03, 1.25, 4.0, FRAME_MS_DEFAULT, tile_budget_for(2880, 1400)), STRETCH_UNSEEN);
        // 5K (13.7 Mpx, 0.85 ms per Mpx): 12 frames, and the budget follows the display.
        assert_eq!(gesture_stretch(13.7, 0.85, 4.0, FRAME_MS_DEFAULT, tile_budget_for(5120, 2680)), STRETCH_UNSEEN);
        // A slow GPU (20 ms per Mpx: over a second of frames) or a small texture budget keeps the level below.
        assert_eq!(gesture_stretch(4.03, 20.0, 4.0, FRAME_MS_DEFAULT, tile_budget_for(2880, 1400)), UPSCALE_OK);
        assert_eq!(gesture_stretch(4.03, 1.25, 4.0, FRAME_MS_DEFAULT, 64 << 20), UPSCALE_OK);
    }

    /// Boards snapped to device pixels one by one (each origin rounded on its own) left up to a pixel between
    /// neighbours that touch in the world. Fitted, every shared edge is one device pixel boundary.
    #[test]
    fn boards_that_share_an_edge_in_the_world_share_it_on_screen() {
        // A row and a column of boards of awkward sizes, each starting exactly where the last one ends.
        let sizes = [317.7, 100.0, 0.3, 1234.56, 41.25, 800.0];
        for i in 0..20 {
            let s = 0.07 * 1.37f64.powi(i);
            let mut at = -5000.3;
            let mut last_edge: Option<f64> = None;
            for f in sizes {
                let fit = fit_board((at, at), (f, f), Rect::new(0.0, 0.0, f, f), s);
                let frame = fit.device(Rect::new(0.0, 0.0, f, f), s, (11.0, -7.0));
                if let Some(e) = last_edge {
                    assert_eq!(frame.x0, e, "scale {s}: the neighbour ended at {e}");
                }
                assert_eq!((frame.x0.fract(), frame.y0.fract()), (0.0, 0.0), "scale {s}");
                if f * s >= 1.0 {
                    assert!((frame.x1 - frame.x1.round()).abs() < 1e-6 && (frame.width() - f * s).abs() < 1.0, "scale {s}: {frame:?}");
                    assert!((fit.k.0 - 1.0).abs() <= 1.0 / (f * s) && fit.k.0 == fit.k.1);
                }
                // A board under a pixel wide has no pixel boundary of its own to share.
                last_edge = (f * s >= 1.0).then(|| frame.x1.round());
                at += f;
            }
        }
        // A board whose size is whole pixels is not stretched, wherever it is: it keeps the plain key.
        for x in [0.0, 0.3, 17.49, -3.5] {
            let fit = fit_board((x, x), (3000.0, 1500.0), Rect::new(0.0, 0.0, 3000.0, 1500.0), 2.0);
            assert_eq!((fit.k, fit.code), ((1.0, 1.0), 0));
            assert_eq!(ScaleKey::fitted(2.0, fit.code), ScaleKey::Pow2(1));
        }
        // Stretched tiles are other pixels than unstretched ones.
        assert_ne!(ScaleKey::fitted(2.74, 1), ScaleKey::fitted(2.74, 2));
        assert_eq!(ScaleKey::fitted(2.74, 2).scale(), 2.74);
    }

    #[test]
    fn a_fitted_boards_tiles_are_cut_in_its_own_pixels() {
        let ink = Rect::new(0.0, 0.0, 3000.0, 2000.0);
        let s = 1.3713;
        let fit = fit_board((10.3, 0.0), (3000.0, 2000.0), ink, s);
        assert_ne!(fit.code, 0);
        let tiles = fit_tiles(ink, s, fit.k, ink.inflate(1.0, 1.0));
        // Every tile starts on a whole device pixel of the fitted board and they tile it without gaps.
        for t in &tiles {
            let d = fit.device(t.rect, s, (0.0, 0.0));
            assert!((d.x0 - d.x0.round()).abs() < 1e-6 && (d.y0 - d.y0.round()).abs() < 1e-6, "{d:?}");
            assert!((d.width() - f64::from(t.w)).abs() < 1e-6, "one texel per device pixel: {d:?} {}", t.w);
        }
        let right = tiles.iter().map(|t| t.rect.x1).fold(0.0, f64::max);
        assert!((right - 3000.0).abs() < 1.0 / s, "{right}");
        assert_eq!(fit_tiles(ink, 2.0, (1.0, 1.0), ink), tiles_in_view(ink, 2.0, ink));
    }

    #[test]
    fn stand_ins_are_judged_by_how_they_look_on_screen() {
        let mut c: TileCache<()> = TileCache::new(DEFAULT_BUDGET);
        let r = Rect::new(0.0, 0.0, 100.0, 100.0);
        c.insert(TileKey { board: 1, scale: ScaleKey::Pow2(1), tx: 0, ty: 0 }, (), 1, 10, 1, r);
        // Wanted: scale 4 (the gesture passed 1.2x). On screen the scale is 2.5: the scale-2 texture is
        // stretched 1.25x, so it renders soon (class 1), but it is no empty slot.
        let cv = c.cover(1, 1, 4.0, r, None);
        assert_eq!(cv.class(4.0 / 2.5, UPSCALE_OK), 1);
        // Judged against the power of two alone it is "2x too coarse" whatever the screen shows.
        assert_eq!(cv.class(1.0, UPSCALE_OK), 1);
        // With the screen at 2.3 it is stretched 1.15x: good enough for the gesture.
        assert_eq!(cv.class(4.0 / 2.3, UPSCALE_OK), 2);
        // A finer texture minified more than 4x on screen is not good enough either way.
        c.insert(TileKey { board: 2, scale: ScaleKey::Pow2(4), tx: 0, ty: 0 }, (), 1, 10, 1, r);
        assert_eq!(c.cover(2, 1, 2.0, r, None).class(1.0, UPSCALE_OK), 1);
    }

    #[test]
    fn budgets_follow_the_display() {
        let (cpu, gpu) = frame_budgets(FRAME_MS_DEFAULT, true);
        assert!((cpu - 6.0).abs() < 0.01 && (gpu - 4.0).abs() < 0.01, "60 Hz mid-gesture: 6 ms and 4 ms as before");
        let (cpu, gpu) = frame_budgets(FRAME_MS_DEFAULT, false);
        assert!((cpu - 10.0).abs() < 0.01 && (gpu - 10.0).abs() < 0.01, "settled: 60% of the frame");
        let (cpu, gpu) = frame_budgets(1000.0 / 120.0, false);
        assert!(cpu <= 5.01 && gpu <= 5.01, "a settling view leaves 120 Hz frames room: {cpu} {gpu}");
        assert!((frame_budgets(1000.0 / 120.0, true).0 - 3.0).abs() < 1e-9);
        assert_eq!(frame_budgets(0.1, true), frame_budgets(1000.0 / 240.0, true), "a nonsense period is clamped");
    }

    #[test]
    fn a_pan_renders_as_many_tiles_as_the_gpu_has_time_for() {
        // 5K, measured: the composite takes 3.9 ms, a megapixel of tiles 0.61 ms.
        let (cpu, gpu) = frame_budgets(FRAME_MS_DEFAULT, true);
        let admitted_at = |limit: f64, base: f64| {
            let mut b = TileBudget::new(cpu, limit, base, 0.61);
            (0..10).filter(|_| b.admit(1.06, 1.0)).count()
        };
        let admitted = |limit: f64| admitted_at(limit, 3.9);
        assert_eq!(admitted(gpu), 1, "the base counted against the tile share: one tile a frame");
        let n = admitted(gpu_limit(FRAME_MS_DEFAULT, gpu, 3.9));
        assert!((4..=7).contains(&n), "{n} tiles fit 4 ms of GPU time");
        // A GPU whose composite alone takes most of the frame still gets its one tile, and no more.
        assert_eq!(admitted_at(gpu_limit(FRAME_MS_DEFAULT, gpu, 13.0), 13.0), 1);
        assert!(gpu_limit(1000.0 / 120.0, 2.0, 1.0) <= 6.25);
    }

    #[test]
    fn the_frame_clock_finds_the_refresh_rate() {
        let mut c = FrameClock::default();
        assert_eq!(c.tick(1000.0, true), FRAME_MS_DEFAULT, "nothing measured: 60 Hz");
        let mut t = 1000.0;
        // 120 Hz, with every third frame dropped and a little jitter.
        for i in 0..12 {
            t += if i % 3 == 2 { 16.7 } else { 8.33 + f64::from(i % 2) * 0.2 };
            c.tick(t, true);
        }
        assert!((c.period() - 8.4).abs() < 0.3, "{}", c.period());
        // A pause (nothing to draw for a second) is not a frame.
        c.tick(t + 1000.0, true);
        assert!((c.period() - 8.4).abs() < 0.3);
        // The display changes to 60 Hz: the clock follows within nine frames.
        let mut t = t + 1000.0;
        for _ in 0..9 {
            t += 16.67;
            c.tick(t, true);
        }
        assert!((c.period() - 16.67).abs() < 0.1, "{}", c.period());
    }

    /// Review round 6, Fable 13: only frames the engine asked for are a display frame apart. A card playing at
    /// 30 fps wakes the loop by timer (33 ms gaps), and a resize draws between two display frames (a few ms).
    #[test]
    fn the_frame_clock_ignores_frames_that_are_not_display_frames() {
        let mut c = FrameClock::default();
        let mut t = 0.0;
        for _ in 0..12 {
            t += 8.33;
            c.tick(t, true);
        }
        assert!((c.period() - 8.33).abs() < 0.01);
        // Only a 30 fps card draws for a while: each frame is woken by a timer.
        for _ in 0..30 {
            t += 33.3;
            c.tick(t, false);
        }
        assert!((c.period() - 8.33).abs() < 0.01, "still 120 Hz: {}", c.period());
        // The pan that follows: the first frame is not chained, the rest are, 8.33 ms apart.
        for i in 0..5 {
            t += 8.33;
            c.tick(t, i > 0);
        }
        assert!((c.period() - 8.33).abs() < 0.01);
    }

    /// Review round 6, Codex 1: a board whose ink reaches far outside its frame is not stretched (a 1-unit root
    /// at scale 1.5 was drawn at 4/3 of its size: its child at x = 1000 landed 500 px from where it is hit).
    #[test]
    fn a_board_that_overflows_its_frame_keeps_its_scale() {
        let fit = fit_board((0.0, 0.0), (1.0, 1.0), Rect::new(0.0, 0.0, 1100.0, 100.0), 1.5);
        assert_eq!((fit.k, fit.code), ((1.0, 1.0), 0), "no stretch on either axis");
        let d = fit.device(Rect::new(1000.0, 0.0, 1100.0, 100.0), 1.5, (0.0, 0.0));
        assert_eq!((d.x0, d.x1), (1500.0, 1650.0), "the child is drawn where the world has it");
        // The same frame with its ink inside it is fitted as before.
        assert_eq!(fit_board((0.0, 0.0), (1.0, 1.0), Rect::new(0.0, 0.0, 1.0, 1.0), 1.5).k, (4.0 / 3.0, 4.0 / 3.0));
        // A shadow or a label a little outside the frame does not turn fitting off, and costs at most a pixel.
        let ink = Rect::new(-40.0, -40.0, 440.3, 340.0);
        let fit = fit_board((7.3, 0.0), (400.3, 300.0), ink, 1.37);
        assert_ne!(fit.code, 0);
        let far = fit.device(Rect::new(440.3, 0.0, 440.3, 0.0), 1.37, (0.0, 0.0)).x0;
        assert!((far - (7.3 + 440.3) * 1.37).abs() <= 1.01, "{far}");
    }

    /// Review round 6, Codex 1: a click lands on what is drawn under it, and the view is tested against where a
    /// fitted board is drawn.
    #[test]
    fn hit_points_and_the_view_follow_the_fit() {
        let ink = Rect::new(0.0, 0.0, 3000.4, 2000.0);
        let s = 1.3713;
        let fit = fit_board((10.3, 20.7), (3000.4, 2000.0), ink, s);
        assert_ne!(fit.code, 0);
        let cam = (37.0, -12.0);
        // The device px a board point is drawn at maps back to that point.
        for (x, y) in [(0.0, 0.0), (2999.0, 1999.0), (1234.5, 77.25)] {
            let d = fit.device(Rect::new(x, y, x, y), s, cam);
            let p = fit.board_point((d.x0, d.y0), s, cam);
            assert!((p.x - x).abs() < 1e-9 && (p.y - y).abs() < 1e-9, "{p:?}");
        }
        // Where the board is drawn in the world: within a pixel of where the world puts it.
        let w = fit.world(ink, s);
        assert!((w.x0 - 10.3).abs() <= 0.5 / s + 1e-9 && (w.x1 - 3010.7).abs() <= 1.0 / s, "{w:?}");
        // A view over the board's last device pixel column finds its last tile column; so does one a hair inside.
        let last = fit.world(Rect::new(3000.4 - 0.5 / s, 0.0, 3000.4, 10.0), s) - fit.world_origin(s);
        let tiles = fit_tiles(ink, s, fit.k, last);
        assert!(!tiles.is_empty() && tiles.iter().all(|t| t.rect.x1 > 3000.0), "{tiles:?}");
        // The view is not stretched a second time: one just past the board's drawn edge sees no tile.
        let past = Rect::new(w.x1 + 2.0 / s, w.y0, w.x1 + 50.0, w.y1) - fit.world_origin(s);
        assert!(fit_tiles(ink, s, fit.k, past).is_empty());
    }

    /// Review round 6, Fable 4: the cache filled with other zoom levels makes room for tiles ahead of the view.
    #[test]
    fn prefetch_makes_room_among_other_scales() {
        let mut c: TileCache<u32> = TileCache::new(1000);
        let r = Rect::new(0.0, 0.0, 10.0, 10.0);
        let key = |scale: ScaleKey, tx: i32| TileKey { board: 1, scale, tx, ty: 0 };
        let now = ScaleKey::exact(1.37);
        // The view's tiles at the wanted scale (used this frame), tiles of five zoom levels visited before, a
        // stale tile, the board's base texture.
        for tx in 0..3 {
            c.insert(key(now, tx), 0, 7, 100, 50, r);
        }
        for (i, l) in [-1, 0, 1, 2, 3].into_iter().enumerate() {
            c.insert(key(ScaleKey::Pow2(l), 0), 1, 7, 100, 10 + i as u64, r);
        }
        c.insert(key(ScaleKey::exact(0.9), 0), 2, 6, 100, 49, r);
        c.insert(key(ScaleKey::Pow2(-4), 0), 3, 7, 50, 1, r);
        assert_eq!(c.bytes, 950);
        let info = |_| Some((7u64, ScaleKey::Pow2(-4)));
        // `evict` does nothing under the budget: the cache stays at 95%, above the 80% prefetch needs.
        assert!(c.evict(50, now, info).is_empty());
        // Room for one more tile under 80%: the stale texture goes first, then the least recently used other scales.
        let out = c.evict_for_prefetch(50, now, info, 700);
        assert_eq!(out.iter().map(|(_, t)| *t).collect::<Vec<_>>(), [2, 1, 1]);
        assert_eq!(out[1].0.scale, ScaleKey::Pow2(-1));
        assert_eq!(c.bytes, 650);
        // Asked for more than other scales can give: the wanted scale and the base texture stay.
        let out = c.evict_for_prefetch(50, now, info, 0);
        assert_eq!(out.len(), 3);
        assert_eq!(c.bytes, 350);
        assert!((0..3).all(|tx| c.get(&key(now, tx)).is_some()) && c.get(&key(ScaleKey::Pow2(-4), 0)).is_some());
        // Nothing left to give: nothing happens (the frame loop must not wait for room that cannot come).
        assert!(c.evict_for_prefetch(51, now, info, 0).is_empty());
    }

    /// Review round 6, Fable 12: a tile rendered in parts is dropped the frame its tile is no longer wanted.
    #[test]
    fn a_pending_render_is_kept_only_while_its_tile_is_wanted() {
        assert!(keep_pending(10, 11, true));
        assert!(!keep_pending(10, 11, false), "its tile left the view: the texture goes now");
        assert!(keep_pending(10, 70, true) && !keep_pending(10, 71, true), "wanted but not worked on for a second");
    }

    #[test]
    fn the_prefetch_ring_leads_the_pan() {
        let view = Rect::new(0.0, 0.0, 1440.0, 700.0);
        // Still: half a tile (256 world units at scale 2) on every side.
        assert_eq!(prefetch_ring(view, 2.0, kurbo::Vec2::ZERO), Rect::new(-256.0, -256.0, 1696.0, 956.0));
        // Panning right at 60 world px a frame: twelve frames ahead on that side only.
        assert_eq!(prefetch_ring(view, 2.0, kurbo::Vec2::new(60.0, 0.0)), Rect::new(-256.0, -256.0, 1696.0 + 720.0, 956.0));
        // A flick: three tiles at most.
        assert_eq!(prefetch_ring(view, 2.0, kurbo::Vec2::new(0.0, -5000.0)).y0, -256.0 - 3.0 * 512.0);
        // The ring's extra tiles at the audit's pan (a 12000 x 3000 board at 100% on a 2x display): the column
        // the view reaches next is among them before the view gets there.
        let ink = Rect::new(0.0, 0.0, 12000.0, 3000.0);
        let seen: Vec<(i32, i32)> = tiles_in_view(ink, 2.0, view).iter().map(|t| (t.tx, t.ty)).collect();
        let ahead: Vec<(i32, i32)> = tiles_in_view(ink, 2.0, prefetch_ring(view, 2.0, kurbo::Vec2::new(150.0, 0.0))).iter().map(|t| (t.tx, t.ty)).filter(|k| !seen.contains(k)).collect();
        assert!(ahead.contains(&(3, 0)) && ahead.contains(&(5, 1)), "{ahead:?}");
        assert!(!ahead.iter().any(|k| k.0 < 0 || k.0 > 6));
    }

    #[test]
    fn invalidation_keeps_stale_tiles_as_stand_ins() {
        let mut c: TileCache<()> = TileCache::new(DEFAULT_BUDGET);
        let r = Rect::new(0.0, 0.0, 100.0, 100.0);
        let old = TileKey { board: 7, scale: ScaleKey::Pow2(1), tx: 0, ty: 0 };
        c.insert(old, (), 1, 10, 1, r);
        // The board changed (generation 2): the exact-scale slot has nothing fresh...
        let want = TileKey { board: 7, scale: ScaleKey::exact(1.5), tx: 0, ty: 0 };
        assert!(!c.fresh(&want, 2));
        assert!(!c.fresh(&old, 2));
        // ...but the old texture still stands in until a fresh one lands.
        assert_eq!(c.cover(7, 2, 1.5, r, None).pieces, vec![(old, r)]);
        c.insert(want, (), 2, 10, 2, r);
        assert!(c.fresh(&want, 2));
        c.remove_board(7);
        assert!(c.is_empty() && c.bytes == 0);
    }

    /// The frame loop's tile work without a GPU: slots in view, renders admitted by the budget, some
    /// failing once (a tile render error), `wants_more` deciding whether the page schedules another
    /// frame. Regression: frames used to stop when nothing was left *deferred by the budget*, so a
    /// slot whose render failed kept its stand-in (or nothing) until the camera moved.
    #[test]
    fn idle_camera_converges_when_renders_fail_or_are_deferred() {
        let ink = Rect::new(0.0, 0.0, 2962.0, 4054.0);
        let s = 0.96;
        let view = Rect::new(0.0, 0.0, 1512.0 / 0.48, 803.0 / 0.48);
        let slots = tiles_in_view(ink, s, view);
        assert_eq!(slots.len(), 6, "3 x 2 tiles of 1024 px in view");
        let key = |t: &TileRect| TileKey { board: 1, scale: ScaleKey::exact(s), tx: t.tx, ty: t.ty };
        let mut c: TileCache<()> = TileCache::new(DEFAULT_BUDGET);
        // Generation 1 drawn, then the board is replaced (generation 2): every slot is stale.
        for t in &slots {
            c.insert(key(t), (), 1, 4, 1, t.rect);
        }
        let generation = 2;
        // The lower-right tiles fail on their first render.
        let mut fails: HashSet<(i32, i32)> = [(2, 1), (1, 1)].into_iter().collect();
        let mut old_rule_stalled = false;
        let mut frames = 0;
        loop {
            frames += 1;
            assert!(frames < 50, "never converged");
            let mut budget = TileBudget::new(14.0, 12.0, 2.0, 4.0);
            let (mut deferred, mut elapsed) = (0u32, 0.0);
            let todo: Vec<TileRect> = slots.iter().filter(|t| !c.fresh(&key(t), generation)).copied().collect();
            for t in &todo {
                let t_mpx = f64::from(t.w) * f64::from(t.h) / 1e6;
                if !budget.admit(t_mpx, elapsed) {
                    deferred += 1;
                    continue;
                }
                elapsed += 7.0;
                if fails.remove(&(t.tx, t.ty)) {
                    continue; // the render failed: no texture
                }
                c.insert(key(t), (), generation, 4, frames + 1, t.rect);
            }
            let unfresh = slots.iter().filter(|t| !c.fresh(&key(t), generation)).count() as u32;
            // The old rule: more frames only while the budget deferred something.
            if deferred == 0 && unfresh > 0 {
                old_rule_stalled = true;
            }
            if !wants_more(false, unfresh) {
                break;
            }
        }
        assert!(slots.iter().all(|t| c.fresh(&key(t), generation)), "every slot in view is drawn fresh");
        assert!(old_rule_stalled, "the scenario does hit the case the old rule stopped on");
        assert!(wants_more(true, 0), "a settling camera always wants frames");
    }

    #[test]
    fn budget_always_admits_one_render() {
        let mut b = TileBudget::new(14.0, 12.0, 50.0, 4.0);
        assert!(b.admit(1.0, 100.0), "the first render runs even over every budget");
        assert!(!b.admit(1.0, 0.0), "then the GPU model caps it");
        let mut b = TileBudget::new(14.0, 12.0, 1.0, 4.0);
        assert!(b.admit(1.0, 0.0) && b.admit(1.0, 5.0));
        assert!(!b.admit(1.0, 15.0), "the CPU budget caps it");
    }

    #[test]
    fn fallback_prefers_finer_scales() {
        let mut c: TileCache<()> = TileCache::new(DEFAULT_BUDGET);
        let r = Rect::new(0.0, 0.0, 100.0, 100.0);
        for l in [-2, 0, 2] {
            c.insert(TileKey { board: 1, scale: ScaleKey::Pow2(l), tx: 0, ty: 0 }, (), 1, 1, 1, r);
        }
        assert_eq!(c.cover(1, GEN, 1.5, r, None).pieces[0].0.scale, ScaleKey::Pow2(2));
        assert_eq!(c.cover(1, GEN, 0.5, r, None).pieces[0].0.scale, ScaleKey::Pow2(0));
        // One full piece: nothing under it, nothing drawn twice.
        assert_eq!(c.cover(1, GEN, 1.5, r, None).pieces.len(), 1);
    }

    /// Codex hunt 2, engine 1: the whole board cached at scale 1, only its centre at scale 4, the camera
    /// at scale 2. The fine centre is the best stand-in, but it must not hide the coarse texture
    /// everywhere else (that left blanks the gesture admission never refilled).
    #[test]
    fn partial_fine_cover_is_completed_by_coarser_scales() {
        let mut c: TileCache<()> = TileCache::new(DEFAULT_BUDGET);
        let whole = Rect::new(0.0, 0.0, 400.0, 400.0);
        let centre = Rect::new(150.0, 150.0, 250.0, 250.0);
        let coarse = TileKey { board: 1, scale: ScaleKey::Pow2(0), tx: 0, ty: 0 };
        let fine = TileKey { board: 1, scale: ScaleKey::Pow2(2), tx: 3, ty: 3 };
        c.insert(coarse, (), 1, 1, 1, whole);
        c.insert(fine, (), 1, 1, 1, centre);
        let slot = Rect::new(100.0, 100.0, 300.0, 300.0);
        let cv = c.cover(1, GEN, 2.0, slot, None);
        assert!(cv.covered, "{cv:?}");
        assert_eq!(cv.pieces[0], (fine, centre), "the finer texture where it exists");
        let area: f64 = cv.pieces.iter().map(|(_, r)| r.area()).sum();
        assert!((area - slot.area()).abs() < 1e-6, "pieces tile the slot exactly once: {area}");
        assert!(cv.pieces[1..].iter().all(|(k, _)| *k == coarse));
        for (i, (_, a)) in cv.pieces.iter().enumerate() {
            for (_, b) in &cv.pieces[i + 1..] {
                let o = a.intersect(*b);
                assert!(o.width() <= 0.0 || o.height() <= 0.0, "pieces overlap: {a:?} {b:?}");
            }
        }
        assert_eq!((cv.coarsest, cv.finest), (0.5, 2.0));
        assert_eq!(cv.class(1.0, UPSCALE_OK), 1, "a 2x coarse stand-in somewhere: render soon, but after empty slots");
        // Only the fine centre: not covered, so the slot renders first mid-gesture.
        let mut c2: TileCache<()> = TileCache::new(DEFAULT_BUDGET);
        c2.insert(fine, (), 1, 1, 1, centre);
        let cv2 = c2.cover(1, GEN, 2.0, slot, None);
        assert!(!cv2.covered);
        assert_eq!(cv2.class(1.0, UPSCALE_OK), 0);
        // Skipping the slot's own texture (it fades in over the rest).
        assert!(c.cover(1, GEN, 2.0, slot, Some(fine)).pieces.iter().all(|(k, _)| *k == coarse));
    }

    /// Codex hunt 2, engine 3: the stand-in lookup walks one board's textures, not the whole cache.
    #[test]
    fn cover_looks_only_at_the_boards_own_textures() {
        let mut c: TileCache<()> = TileCache::new(u64::MAX);
        let r = Rect::new(0.0, 0.0, 10.0, 10.0);
        for b in 0..5000u64 {
            c.insert(TileKey { board: b, scale: ScaleKey::Pow2(0), tx: 0, ty: 0 }, (), 1, 1, 1, r);
        }
        assert_eq!(c.keys_of(77).count(), 1);
        assert_eq!(c.cover(77, GEN, 1.0, r, None).pieces.len(), 1);
        c.remove_board(77);
        assert_eq!(c.keys_of(77).count(), 0);
        assert_eq!(c.len(), 4999);
        let gone = c.evict(2, ScaleKey::Pow2(0), |_| None);
        assert!(gone.is_empty(), "under budget");
        c.budget = 0;
        let gone = c.evict(2, ScaleKey::Pow2(0), |_| None);
        assert_eq!(gone.len(), 4999);
        assert_eq!(c.keys_of(5).count(), 0, "the board index follows eviction");
        assert!(c.is_empty() && c.bytes == 0);
    }

    /// Codex hunt 2, engine 8: slots meeting at a fractional device px (665.6) get scissors that meet at
    /// one whole px: no column drawn twice (a 50% translucent board went 75% along the seam) or skipped.
    #[test]
    fn adjacent_scissors_share_their_edge() {
        for edge in [665.6, 665.5, 665.4, 12.0, 30.25] {
            let a = scissor_px(Rect::new(10.0, 3.3, edge, 50.7), 2000, 2000).unwrap();
            let b = scissor_px(Rect::new(edge, 3.3, 1500.2, 50.7), 2000, 2000).unwrap();
            assert_eq!(a[0] + a[2], b[0], "edge {edge}");
            let below = scissor_px(Rect::new(10.0, 50.7, edge, 99.0), 2000, 2000).unwrap();
            assert_eq!(a[1] + a[3], below[1]);
        }
        // The pixels a quad covers: centres inside (x0 = 10.6 covers pixel 11 on, not 10).
        assert_eq!(scissor_px(Rect::new(10.6, 0.0, 20.4, 5.0), 100, 100), Some([11, 0, 9, 5]));
        assert_eq!(scissor_px(Rect::new(10.6, 0.0, 10.9, 5.0), 100, 100), None, "covers no pixel centre");
        assert_eq!(scissor_px(Rect::new(-50.0, -5.0, 150.0, 5.0), 100, 100), Some([0, 0, 100, 5]), "clamped to the target");
    }

    #[test]
    fn mid_gesture_low_resolution_tiles_are_not_sharp() {
        let mut c: TileCache<()> = TileCache::new(DEFAULT_BUDGET);
        let k = TileKey { board: 1, scale: ScaleKey::exact(2.0), tx: 0, ty: 0 };
        c.insert(k, (), 3, 1, 1, Rect::new(0.0, 0.0, 1.0, 1.0)).lowres = true;
        assert!(c.fresh(&k, 3), "good enough while the camera moves");
        assert!(!c.sharp(&k, 3), "drawn again once it settles (codex hunt 2, engine 7)");
        assert_eq!(c.cover(1, 3, 2.0, Rect::new(0.0, 0.0, 1.0, 1.0), None).pieces[0].0, k, "and stands in for itself meanwhile");
        c.insert(k, (), 3, 1, 2, Rect::new(0.0, 0.0, 1.0, 1.0));
        assert!(c.sharp(&k, 3));
    }

    #[test]
    fn gutters_and_base_textures() {
        let uv = interior_uv((1024, 512));
        assert!((f64::from(uv[0]) * 1028.0 - 2.0).abs() < 1e-3 && (f64::from(uv[2]) * 1028.0 - 1026.0).abs() < 1e-3);
        assert!((f64::from(uv[1]) * 516.0 - 2.0).abs() < 1e-3 && (f64::from(uv[3]) * 516.0 - 514.0).abs() < 1e-3);
        assert_eq!(tile_bytes((1024, 1024)), 1028 * 1028 * 4);
        // 390 x 844: 2^-1 -> 422 px long side, 2^0 would be 844.
        assert_eq!(base_scale(Rect::new(0.0, 0.0, 390.0, 844.0)), ScaleKey::Pow2(-1));
        assert_eq!(base_scale(Rect::new(0.0, 0.0, 100.0, 50.0)), ScaleKey::Pow2(2));
        assert_eq!(base_scale(Rect::new(0.0, 0.0, 40000.0, 50.0)), ScaleKey::Pow2(-7));
        // The base texture is evicted last, after the other scales of a fresh board.
        let mut c: TileCache<u32> = TileCache::new(150);
        let r = Rect::new(0.0, 0.0, 1.0, 1.0);
        c.insert(TileKey { board: 1, scale: ScaleKey::Pow2(-1), tx: 0, ty: 0 }, 1, 1, 100, 1, r);
        c.insert(TileKey { board: 1, scale: ScaleKey::Pow2(1), tx: 0, ty: 0 }, 2, 1, 100, 2, r);
        let gone = c.evict(5, ScaleKey::Pow2(3), |_| Some((1, ScaleKey::Pow2(-1))));
        assert_eq!(gone.iter().map(|(_, t)| *t).collect::<Vec<_>>(), vec![2]);
    }

    /// Codex hunt 2, engine 2: effect textures under a byte budget, least recently used first.
    #[test]
    fn effect_textures_lru() {
        let items = [(1, 40, 3), (2, 40, 1), (3, 40, 9), (4, 40, 2)];
        assert_eq!(lru_over_budget(&items, 200, 9), Vec::<u64>::new());
        assert_eq!(lru_over_budget(&items, 100, 9), vec![2, 4]);
        assert_eq!(lru_over_budget(&items, 0, 9), vec![2, 4, 1], "this frame's stays");
    }

    #[test]
    fn a_tile_renders_only_the_effect_jobs_it_shows() {
        // 0: a shadow inside 2 (a blurred group); 1: elsewhere; 2: the group; 3: far away.
        let r = |a, b, c, d| Rect::new(a, b, c, d);
        let same = |x: Rect| (x, x);
        let mut jobs = vec![same(r(10.0, 10.0, 20.0, 20.0)), same(r(500.0, 0.0, 600.0, 100.0)), same(r(0.0, 0.0, 100.0, 100.0)), same(r(0.0, 900.0, 10.0, 910.0))];
        assert_eq!(jobs_needed(&jobs, r(90.0, 90.0, 200.0, 200.0)), vec![0, 2]);
        assert_eq!(jobs_needed(&jobs, r(550.0, 0.0, 560.0, 10.0)), vec![1]);
        assert!(jobs_needed(&jobs, r(300.0, 300.0, 400.0, 400.0)).is_empty());
        // A shadow mask drawn 300 units below its content rect: the tile where it lands needs it.
        jobs[3] = (r(0.0, 1200.0, 10.0, 1210.0), r(0.0, 900.0, 10.0, 910.0));
        assert_eq!(jobs_needed(&jobs, r(0.0, 1190.0, 50.0, 1250.0)), vec![3]);
        assert!(jobs_needed(&jobs, r(0.0, 890.0, 50.0, 950.0)).is_empty());
    }
}
