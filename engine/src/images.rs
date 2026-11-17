//! Image memory (GPU-free bookkeeping, unit tested on the host).
//!
//! The page hands the engine decoded images (an `ImageBitmap`, or pixels it keeps on the JS side);
//! nothing full-size is copied into WASM memory. A board draws each image at a mip level chosen by
//! how big it is on screen: the smallest halving of the original (long side) that is at least
//! the on-screen size, or the original when that is smaller. A level too big for one texture (`WHOLE_PX`)
//! is drawn from `TILE` px tiles, only those in or near the view (`plan`), over a smaller whole level. A level is decoded on demand into a GPU
//! texture (vello copies it into its atlas when a tile needs it). Levels are reference counted by the
//! boards whose encoded scene draws them; unreferenced ones stay cached until the byte budget says
//! otherwise, least recently used first. A board far from the view gives its levels back.


/// Mip levels are halvings of the original: long side `orig`, then half (rounded up), and so on down to
/// `MIN_LEVEL`. Each is made by 2x box steps (gpu.rs `upload_image`), the mip chain Chrome draws an `<img>`
/// from. A fixed ladder (256 ... 2048) made by one scaled copy carried moire of its own: a 1600 px image of
/// 1 px stripes came out banded at any size, where Chrome shows flat grey.
pub const MIN_LEVEL: u32 = 32;
/// The halving after `level` (long side px).
pub fn half(level: u32) -> u32 {
    level.div_ceil(2).max(1)
}
/// 2x box steps that take `from` px down to `to` px (0 when it is not at least about half).
pub fn box_steps(from: f64, to: f64) -> u32 {
    if !(from.is_finite() && to > 0.0) || from <= to {
        return 0;
    }
    ((from / to).log2().round() as u32).min(12)
}
/// How many halvings `level` is below an original whose long side is `orig_long`.
pub fn halvings(level: u32, orig_long: u32) -> u32 {
    let (mut l, mut k) = (orig_long.max(1), 0);
    while l > level && l > 1 {
        l = half(l);
        k += 1;
    }
    k
}
pub const DEFAULT_IMAGE_BUDGET: u64 = 192 * 1024 * 1024;
/// The most pixels one whole-image level holds (2048 x 2048, whatever the shape: a 1200 x 8000 screenshot keeps
/// 793 px of width, not 307). What needs more is drawn from tiles of the level it needs.
pub const WHOLE_PX: u64 = 2048 * 2048;
/// vello's image atlas is square, 8192 px at most: no single texture may be longer.
pub const MAX_SIDE: u32 = 8192;
/// Tile size in level px, and the border of real neighbouring pixels each tile texture carries so bilinear taps
/// at its edge read what the next tile holds.
pub const TILE: u32 = 512;
pub const APRON: u32 = 2;

/// The level (long side in px) to draw an image whose long side is `orig_long` px when it covers
/// `need_px` device px on screen: the smallest halving of the original at least that big (so a bilinear tap
/// never minifies it 2x or more), the original itself when even that is smaller, never below `MIN_LEVEL`.
pub fn level_for(need_px: f64, orig_long: u32) -> u32 {
    let mut l = orig_long.max(1);
    while l > MIN_LEVEL && f64::from(half(l)) >= need_px.max(1.0) {
        l = half(l);
    }
    l
}

/// Pixel size of `level` for an image of `w` × `h`.
pub fn level_dims(w: u32, h: u32, level: u32) -> (u32, u32) {
    let long = w.max(h).max(1);
    if level >= long {
        return (w.max(1), h.max(1));
    }
    let s = f64::from(level) / f64::from(long);
    (((f64::from(w) * s).round() as u32).max(1), ((f64::from(h) * s).round() as u32).max(1))
}

/// Pixels one board's images may take in vello's image atlas (8192 x 8192 at most, shared with the
/// images of the two renders before it). An image that does not fit is silently not drawn, so a board
/// whose levels would add up to more gets smaller levels instead (see `fit_plans`).
pub const ATLAS_PX: u64 = 24_000_000;

/// The next smaller level than `level` for an image whose long side is `orig_long`.
fn level_below(level: u32, orig_long: u32) -> Option<u32> {
    let mut l = orig_long.max(1);
    while l >= level.min(orig_long) && l > MIN_LEVEL {
        l = half(l);
    }
    (l < level.min(orig_long)).then_some(l)
}

/// The largest level up to `level` that one texture of at most `cap` px may hold whole (and `MAX_SIDE`).
pub fn whole_level(w: u32, h: u32, level: u32, cap: u64) -> u32 {
    let long = w.max(h).max(1);
    let fits = |l: u32| {
        let (a, b) = level_dims(w, h, l);
        u64::from(a) * u64::from(b) <= cap && a.max(b) <= MAX_SIDE
    };
    let mut l = level.min(long);
    while !fits(l) {
        match level_below(l, long) {
            Some(n) => l = n,
            None => break,
        }
    }
    l
}

/// A block of tiles of one level: columns `x0..x1`, rows `y0..y1`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Cells {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
}

impl Cells {
    pub fn count(&self) -> u64 {
        u64::from(self.x1.saturating_sub(self.x0)) * u64::from(self.y1.saturating_sub(self.y0))
    }
    pub fn contains(&self, o: &Cells) -> bool {
        self.x0 <= o.x0 && self.y0 <= o.y0 && self.x1 >= o.x1 && self.y1 >= o.y1
    }
    pub fn iter(&self) -> impl Iterator<Item = (u32, u32)> + use<> {
        let c = *self;
        (c.y0..c.y1).flat_map(move |y| (c.x0..c.x1).map(move |x| (x, y)))
    }
    /// One more tile on every side, inside a grid of `cols` × `rows`.
    pub fn grown(&self, cols: u32, rows: u32) -> Cells {
        Cells { x0: self.x0.saturating_sub(1), y0: self.y0.saturating_sub(1), x1: (self.x1 + 1).min(cols), y1: (self.y1 + 1).min(rows) }
    }
}

/// Tiles per axis of a level of `lw` × `lh` px.
pub fn grid(lw: u32, lh: u32) -> (u32, u32) {
    (lw.max(1).div_ceil(TILE), lh.max(1).div_ceil(TILE))
}

/// The tiles of a `lw` × `lh` level that the part `vis` of the image touches (`vis`: x0, y0, x1, y1 as
/// fractions of the image).
pub fn cells_for(lw: u32, lh: u32, vis: [f64; 4]) -> Cells {
    let (cols, rows) = grid(lw, lh);
    let lo = |v: f64, n: u32, c: u32| (((v.clamp(0.0, 1.0) * f64::from(n)) / f64::from(TILE)).floor() as u32).min(c - 1);
    let hi = |v: f64, n: u32, c: u32| (((v.clamp(0.0, 1.0) * f64::from(n)) / f64::from(TILE)).ceil() as u32).clamp(1, c);
    let (x0, y0) = (lo(vis[0], lw, cols), lo(vis[1], lh, rows));
    Cells { x0, y0, x1: hi(vis[2], lw, cols).max(x0 + 1), y1: hi(vis[3], lh, rows).max(y0 + 1) }
}

/// Tile (`tx`, `ty`) of a `lw` × `lh` level in level px: x, y, width, height.
pub fn cell_rect(lw: u32, lh: u32, tx: u32, ty: u32) -> (u32, u32, u32, u32) {
    let (x, y) = (tx * TILE, ty * TILE);
    (x, y, TILE.min(lw.saturating_sub(x)).max(1), TILE.min(lh.saturating_sub(y)).max(1))
}

/// What tile (`tx`, `ty`)'s texture holds: its rectangle and `APRON` px of its neighbours, inside the level.
pub fn cell_src(lw: u32, lh: u32, tx: u32, ty: u32) -> (u32, u32, u32, u32) {
    let (x, y, w, h) = cell_rect(lw, lh, tx, ty);
    let (x0, y0) = (x.saturating_sub(APRON), y.saturating_sub(APRON));
    (x0, y0, (x + w + APRON).min(lw.max(1)) - x0, (y + h + APRON).min(lh.max(1)) - y0)
}

/// The cache slot of a whole level (`tile` None) or of one tile of it.
pub fn slot(level: u32, tile: Option<(u32, u32)>) -> u64 {
    u64::from(level) | tile.map_or(0, |(x, y)| (1 + (u64::from(y) << 16 | u64::from(x))) << 32)
}

/// What one board asks of an image: its size, the level its largest use needs, and the part of it in (or near)
/// the view as fractions of the image (None: none of it).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Want {
    pub w: u32,
    pub h: u32,
    pub level: u32,
    pub vis: Option<[f64; 4]>,
    /// No transparency: it may be drawn from tiles.
    pub opaque: bool,
}

/// How a board draws an image: one whole level, and over the part in view the tiles of a larger one.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Plan {
    pub whole: u32,
    pub tiles: Option<(u32, Cells)>,
}

impl Plan {
    /// The level the part in view is drawn from.
    pub fn sharpest(&self) -> u32 {
        self.tiles.map_or(self.whole, |t| t.0)
    }
}

/// The plan for one image: whole when its level fits one texture, else whole at the largest that does plus tiles
/// of the level over what is in view. Out of view it is never tiled.
pub fn plan(q: &Want) -> Plan {
    let whole = whole_level(q.w, q.h, q.level, WHOLE_PX);
    let level = q.level.min(q.w.max(q.h).max(1));
    let tiles = match q.vis {
        // An image with transparency is never tiled: tiles overlap by a pixel so no background shows between
        // them, and where both are translucent the overlap blends twice (a visible grid). It stays one texture
        // (a bigger one was tried: vello's atlas packer dropped a 3000 x 3000 image next to another board's tiles).
        Some(vis) if level > whole && q.opaque => {
            let (lw, lh) = level_dims(q.w, q.h, level);
            Some((level, cells_for(lw, lh, vis)))
        }
        _ => None,
    };
    Plan { whole, tiles }
}

/// A tile rendered ahead of the view shows the part `part` of an image (fractions of it; None: none) that its
/// board holds as `p`, wanted as `q`: is that below what the scale needs? Then the tile is cached as low
/// resolution and drawn again when it comes into view. Out of view an image is never tiled (`plan`), so a tile
/// rendered ahead drew it from the capped whole level and was cached as sharp: bands at half resolution next to
/// sharp ones when the pan arrived. `opaque`: whether the image has transparency, when that is known (not known:
/// it may turn out to be tiled once it is in view).
pub fn ahead_short(q: &Want, opaque: Option<bool>, p: &Plan, part: Option<[f64; 4]>) -> bool {
    let Some(part) = part else { return false };
    let level = q.level.min(q.w.max(q.h).max(1));
    // Whole at the level it needs, or an image with transparency (never tiled): this is its best picture.
    if level <= p.whole || opaque == Some(false) {
        return false;
    }
    match p.tiles {
        Some((l, cells)) if l == level => {
            let (lw, lh) = level_dims(q.w, q.h, l);
            !cells.contains(&cells_for(lw, lh, part))
        }
        _ => true,
    }
}

/// Rows of a `w` px wide image read in one step of the scan for transparency: about `SCAN_PX` pixels.
pub const SCAN_PX: u32 = 2 << 20;
pub fn scan_rows(w: u32, h: u32, from: u32) -> u32 {
    (SCAN_PX / w.max(1)).max(1).min(h.saturating_sub(from))
}

/// Atlas pixels of a plan for an image of `w` × `h`.
pub fn plan_px(w: u32, h: u32, p: &Plan) -> u64 {
    let (a, b) = level_dims(w, h, p.whole);
    let side = u64::from(TILE + 2 * APRON);
    u64::from(a) * u64::from(b) + p.tiles.map_or(0, |(_, c)| c.count() * side * side)
}

/// Plans for every image of a board that fit `budget` atlas pixels together: the costliest image out of view
/// gives up a level first, and only when none of those can go lower, the costliest one in view. A moodboard
/// zoomed into one photo keeps that photo sharp; before, the photos off screen claimed the atlas and every
/// image dropped a level.
pub fn fit_plans(wants: &mut [Want], budget: u64) -> Vec<Plan> {
    loop {
        let plans: Vec<Plan> = wants.iter().map(plan).collect();
        let px: Vec<u64> = wants.iter().zip(&plans).map(|(q, p)| plan_px(q.w, q.h, p)).collect();
        if px.iter().sum::<u64>() <= budget {
            return plans;
        }
        let can = |i: usize| level_below(wants[i].level, wants[i].w.max(wants[i].h)).is_some();
        let pick = |seen: bool| (0..wants.len()).filter(|&i| wants[i].vis.is_some() == seen && can(i)).max_by_key(|&i| (px[i], std::cmp::Reverse(i)));
        let Some(i) = pick(false).or_else(|| pick(true)) else { return plans };
        wants[i].level = level_below(wants[i].level, wants[i].w.max(wants[i].h)).expect("filtered above");
    }
}

/// Keep the tiles a board holds (`cur`) when they cover what it needs now (`need`, same level) without holding
/// more than about twice as many: a pan inside the block decodes nothing and paints nothing. Otherwise the
/// needed block with one more tile around it (of a `cols` × `rows` grid), so the next change is a tile away.
pub fn keep_cells(cur: Option<Cells>, need: Cells, cols: u32, rows: u32) -> Cells {
    let grown = need.grown(cols, rows);
    match cur {
        Some(c) if c.contains(&need) && c.count() <= grown.count() * 2 => c,
        _ => grown,
    }
}

/// Does a board give its image levels back now: out of view for `grace` rendered frames, or parked (another
/// page shows) while the image cache is over its budget. A parked board that kept its references would hold
/// them past the budget for as long as the engine sits idle (only rendered frames count towards `grace`);
/// given back, its levels stay cached unreferenced, least recently used first out, so coming back usually
/// costs no decode. Under the budget a parked board keeps them: no repaint on a page switch.
pub fn gives_back_levels(hidden: bool, over_budget: bool, seen_frame: u64, frame: u64, grace: u64) -> bool {
    (hidden && over_budget) || seen_frame + grace <= frame
}

pub struct Mip<T> {
    pub tex: T,
    pub w: u32,
    pub h: u32,
    pub bytes: u64,
    pub refs: u32,
    pub last_used: u64,
}

pub struct MipCache<T> {
    /// By url, then level: a lookup by &str allocates nothing (a (String, u64) key made a String per lookup).
    map: crate::cache::FastMap<String, crate::cache::FastMap<u64, Mip<T>>>,
    pub bytes: u64,
    pub budget: u64,
}

impl<T> MipCache<T> {
    pub fn new(budget: u64) -> Self {
        MipCache { map: Default::default(), bytes: 0, budget }
    }
    pub fn len(&self) -> usize {
        self.map.values().map(|m| m.len()).sum()
    }
    pub fn is_empty(&self) -> bool {
        self.map.values().all(|m| m.is_empty())
    }
    pub fn get(&self, url: &str, level: u64) -> Option<&Mip<T>> {
        self.map.get(url)?.get(&level)
    }
    fn get_mut(&mut self, url: &str, level: u64) -> Option<&mut Mip<T>> {
        self.map.get_mut(url)?.get_mut(&level)
    }
    pub fn insert(&mut self, url: &str, level: u64, tex: T, w: u32, h: u32, frame: u64) {
        let bytes = u64::from(w) * u64::from(h) * 4;
        let levels = match self.map.get_mut(url) {
            Some(l) => l,
            None => self.map.entry(url.to_string()).or_default(),
        };
        if let Some(old) = levels.insert(level, Mip { tex, w, h, bytes, refs: 0, last_used: frame }) {
            self.bytes -= old.bytes;
        }
        self.bytes += bytes;
    }
    pub fn acquire(&mut self, url: &str, level: u64, frame: u64) -> bool {
        match self.get_mut(url, level) {
            Some(m) => {
                m.refs += 1;
                m.last_used = frame;
                true
            }
            None => false,
        }
    }
    pub fn release(&mut self, url: &str, level: u64, frame: u64) {
        if let Some(m) = self.get_mut(url, level) {
            m.refs = m.refs.saturating_sub(1);
            m.last_used = frame;
        }
    }
    pub fn over_budget(&self) -> bool {
        self.bytes > self.budget
    }
    /// Every level of `url` (an image was registered again): the caller makes sure no board still
    /// draws them.
    pub fn remove_url(&mut self, url: &str) -> Vec<T> {
        let Some(levels) = self.map.remove(url) else { return Vec::new() };
        levels
            .into_values()
            .map(|m| {
                self.bytes -= m.bytes;
                m.tex
            })
            .collect()
    }
    /// Drop unreferenced levels, least recently used first, until under budget.
    pub fn evict(&mut self) -> Vec<T> {
        let mut out = Vec::new();
        if self.bytes <= self.budget {
            return out;
        }
        let mut idle: Vec<((String, u64), u64)> = self.map.iter().flat_map(|(u, l)| l.iter().filter(|(_, m)| m.refs == 0).map(move |(k, m)| ((u.clone(), *k), m.last_used))).collect();
        idle.sort_by_key(|(_, t)| *t);
        for ((u, k), _) in idle {
            if self.bytes <= self.budget {
                break;
            }
            let Some(levels) = self.map.get_mut(&u) else { continue };
            if let Some(m) = levels.remove(&k) {
                self.bytes -= m.bytes;
                out.push(m.tex);
            }
            if levels.is_empty() {
                self.map.remove(&u);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_follow_the_on_screen_size_and_never_exceed_the_original() {
        assert_eq!(level_for(10.0, 4000), 32, "4000, 2000 ... 63, 32: the chain stops at MIN_LEVEL");
        assert_eq!(level_for(40.0, 4000), 63, "a thumbnail at overview zoom is minified less than 2x");
        assert_eq!(level_for(300.0, 4000), 500);
        assert_eq!(level_for(1500.0, 4000), 2000);
        assert_eq!(level_for(9000.0, 4000), 4000, "the original, not a smaller copy");
        assert_eq!(level_for(9000.0, 16000), 16000);
        assert_eq!(level_for(300.0, 400), 400, "the original when half of it is too small");
        assert_eq!(level_for(720.0, 1600), 800, "golden image-minify: the 2x box level, where 1 px stripes are flat grey");
        assert_eq!(level_dims(4000, 3000, 500), (500, 375));
        assert_eq!(level_dims(400, 300, 400), (400, 300));
        assert_eq!(level_dims(10, 4000, 250), (1, 250));
        assert_eq!((box_steps(1600.0, 1600.0), box_steps(1600.0, 800.0), box_steps(1601.0, 801.0), box_steps(4000.0, 63.0), box_steps(514.0, 516.0), box_steps(1028.0, 516.0)), (0, 1, 1, 6, 0, 1));
        assert_eq!((halvings(4000, 4000), halvings(2000, 4000), halvings(500, 4000), halvings(63, 4000), halvings(801, 1601)), (0, 1, 3, 6, 1));
        assert_eq!((level_below(4000, 4000), level_below(2000, 4000), level_below(32, 4000), level_below(20, 20)), (Some(2000), Some(1000), None, None));
        for need in [33.0, 100.0, 700.0, 3000.0] {
            let l = level_for(need, 20000);
            assert!(f64::from(l) >= need && f64::from(l) < need * 2.0 + 2.0, "{need} px drawn from {l}: never minified 2x or more");
        }
    }

    /// Audit finding 4: a 1200 x 8000 screenshot was drawn from 307 x 2048 px (a long-side cap). One texture
    /// is capped by area now, and what needs more comes from tiles.
    #[test]
    fn whole_levels_are_capped_by_area_not_by_the_long_side() {
        assert_eq!(whole_level(1200, 2000, 2000, WHOLE_PX), 2000, "2.4 Mpx: whole, at the original");
        assert_eq!(whole_level(2048, 2048, 2048, WHOLE_PX), 2048);
        assert_eq!(whole_level(1200, 8000, 8000, WHOLE_PX), 4000, "600 x 4000, not 307 x 2048");
        assert_eq!(whole_level(3000, 4000, 4000, WHOLE_PX), 2000);
        assert_eq!(whole_level(100, 16000, 16000, WHOLE_PX), 8000, "never longer than the atlas side");
        assert_eq!(whole_level(3000, 4000, 500, WHOLE_PX), 500, "never above what was asked");
        let p = plan(&Want { w: 1200, h: 8000, level: 8000, vis: Some([0.0, 0.0, 1.0, 0.25]), opaque: true });
        assert_eq!(p, Plan { whole: 4000, tiles: Some((8000, Cells { x0: 0, y0: 0, x1: 3, y1: 4 })) }, "the visible quarter at the original's pixels");
        assert_eq!(plan(&Want { w: 1200, h: 8000, level: 8000, vis: None, opaque: true }).tiles, None, "out of view: no tiles");
        assert_eq!(plan(&Want { w: 1200, h: 2000, level: 2000, vis: Some([0.0, 0.0, 1.0, 1.0]), opaque: true }).tiles, None, "fits one texture: not tiled");
        // Transparency: one texture under the area cap, never tiles (they would show as a grid).
        assert_eq!(plan(&Want { w: 3000, h: 4000, level: 4000, vis: Some([0.0, 0.0, 1.0, 1.0]), opaque: false }), Plan { whole: 2000, tiles: None });
        assert_eq!(plan(&Want { w: 1200, h: 16000, level: 16000, vis: Some([0.0, 0.0, 1.0, 1.0]), opaque: false }), Plan { whole: 4000, tiles: None });
    }

    #[test]
    fn tiles_cover_the_level_and_carry_their_neighbours_pixels() {
        assert_eq!(grid(1200, 8000), (3, 16));
        assert_eq!(grid(512, 513), (1, 2));
        assert_eq!(cell_rect(1200, 8000, 2, 15), (1024, 7680, 176, 320), "edge tiles are what is left");
        assert_eq!(cell_src(1200, 8000, 0, 0), (0, 0, 514, 514), "no apron past the image");
        assert_eq!(cell_src(1200, 8000, 1, 1), (510, 510, 516, 516));
        assert_eq!(cell_src(1200, 8000, 2, 15), (1022, 7678, 178, 322));
        assert_eq!(cells_for(1200, 8000, [0.0, 0.5, 1.0, 0.5625]), Cells { x0: 0, y0: 7, x1: 3, y1: 9 });
        assert_eq!(cells_for(1200, 8000, [0.99, 0.999, 1.5, 2.0]), Cells { x0: 2, y0: 15, x1: 3, y1: 16 }, "clamped to the image");
        assert_eq!(cells_for(1200, 8000, [0.2, 0.2, 0.2, 0.2]).count(), 1, "never empty");
        assert_ne!(slot(4096, None), slot(4096, Some((0, 0))));
        assert_ne!(slot(4096, Some((1, 0))), slot(4096, Some((0, 1))));
        assert_eq!(slot(4096, None), 4096);
        let all: Vec<_> = Cells { x0: 1, y0: 2, x1: 3, y1: 4 }.iter().collect();
        assert_eq!(all, vec![(1, 2), (2, 2), (1, 3), (2, 3)]);
    }

    #[test]
    fn a_pan_inside_the_held_tiles_changes_nothing() {
        let held = Cells { x0: 0, y0: 3, x1: 3, y1: 8 };
        assert_eq!(keep_cells(Some(held), Cells { x0: 0, y0: 4, x1: 3, y1: 7 }, 3, 16), held);
        assert_eq!(keep_cells(Some(held), Cells { x0: 0, y0: 5, x1: 3, y1: 9 }, 3, 16), Cells { x0: 0, y0: 4, x1: 3, y1: 10 }, "past the block: the new one, one tile around");
        assert_eq!(keep_cells(None, Cells { x0: 0, y0: 0, x1: 2, y1: 2 }, 3, 16), Cells { x0: 0, y0: 0, x1: 3, y1: 3 });
        let wide = Cells { x0: 0, y0: 0, x1: 3, y1: 16 };
        assert_eq!(keep_cells(Some(wide), Cells { x0: 1, y0: 5, x1: 2, y1: 6 }, 3, 16), Cells { x0: 0, y0: 4, x1: 3, y1: 7 }, "a block far bigger than needed is given back");
    }

    /// vello drops images that do not fit its atlas: a board zoomed to 800% asked for twelve 2048 px
    /// levels, and tiles drawn after that showed its photos missing.
    #[test]
    fn a_boards_levels_fit_the_atlas() {
        let px = |wants: &[Want], plans: &[Plan]| wants.iter().zip(plans).map(|(q, p)| plan_px(q.w, q.h, p)).sum::<u64>();
        let mut items = vec![Want { w: 3000, h: 4000, level: 2000, vis: None, opaque: true }; 12];
        items.push(Want { w: 100, h: 50, level: 100, vis: None, opaque: true });
        let plans = fit_plans(&mut items, ATLAS_PX);
        assert!(px(&items, &plans) <= ATLAS_PX);
        assert!(plans[..12].iter().all(|p| p.whole == 1000 || p.whole == 2000), "{plans:?}");
        assert_eq!(plans[12].whole, 100, "small images keep their level");
        let mut few = vec![Want { w: 3000, h: 4000, level: 2000, vis: None, opaque: true }, Want { w: 800, h: 600, level: 400, vis: None, opaque: true }];
        let plans = fit_plans(&mut few, ATLAS_PX);
        assert_eq!(plans.iter().map(|p| p.whole).collect::<Vec<_>>(), vec![2000, 400], "untouched when they fit");
        let mut tiny = vec![Want { w: 10, h: 10, level: 10, vis: None, opaque: true }; 3];
        assert_eq!(fit_plans(&mut tiny, 1)[0].whole, 10, "nothing below the smallest level: gives up instead of looping");
    }

    /// Audit finding 10: twelve photos on one board, zoomed into one. The photos off screen took the atlas and
    /// the one on screen dropped to 1024 px. Now the ones out of view give way first.
    #[test]
    fn the_image_in_view_keeps_its_level_when_the_atlas_is_short() {
        let mut items = vec![Want { w: 3000, h: 4000, level: 4000, vis: None, opaque: true }; 12];
        items[5].vis = Some([0.1, 0.1, 0.6, 0.5]);
        let plans = fit_plans(&mut items, ATLAS_PX);
        let total: u64 = items.iter().zip(&plans).map(|(q, p)| plan_px(q.w, q.h, p)).sum();
        assert!(total <= ATLAS_PX, "{total}");
        assert_eq!(plans[5].sharpest(), 4000, "the photo in view is drawn from its own pixels: {:?}", plans[5]);
        assert!(plans[5].tiles.is_some());
        assert!(plans.iter().enumerate().all(|(i, p)| i == 5 || (p.tiles.is_none() && p.whole <= 2000)), "{plans:?}");
        // Only when nothing out of view can give more does the one in view go down.
        let mut alone = vec![Want { w: 16000, h: 16000, level: 16000, vis: Some([0.0, 0.0, 1.0, 1.0]), opaque: true }];
        let plans = fit_plans(&mut alone, ATLAS_PX);
        assert!(plans[0].sharpest() < 16000 && plan_px(16000, 16000, &plans[0]) <= ATLAS_PX, "{plans:?}");
    }

    #[test]
    fn eviction_spares_levels_in_use_and_goes_lru() {
        let mut c: MipCache<u8> = MipCache::new(3 * 100 * 100 * 4);
        c.insert("a", 256, 1, 100, 100, 1);
        c.insert("b", 256, 2, 100, 100, 2);
        c.insert("c", 256, 3, 100, 100, 3);
        assert!(c.acquire("a", 256, 4));
        c.insert("d", 256, 4, 100, 100, 5);
        assert!(c.over_budget());
        assert_eq!(c.evict(), vec![2], "b is the oldest idle level; a is in use");
        c.release("a", 256, 6);
        c.budget = 100 * 100 * 4;
        assert_eq!(c.evict(), vec![3, 4]);
        assert_eq!(c.len(), 1);
        assert_eq!(c.remove_url("a"), vec![1]);
        assert_eq!(c.bytes, 0);
    }

    #[test]
    fn removing_a_url_frees_every_level_of_it_and_only_it() {
        let mut c: MipCache<u8> = MipCache::new(u64::MAX);
        c.insert("a", 256, 1, 100, 100, 1);
        c.insert("a", 512, 2, 200, 200, 1);
        c.insert("b", 256, 3, 100, 100, 1);
        let mut gone = c.remove_url("a");
        gone.sort();
        assert_eq!(gone, vec![1, 2]);
        assert_eq!(c.len(), 1);
        assert_eq!(c.bytes, 100 * 100 * 4, "only b's bytes remain");
        assert!(c.get("a", 256).is_none() && c.get("b", 256).is_some());
        assert!(c.remove_url("a").is_empty(), "removing twice is a no-op");
    }

    /// Codex hunt 3 (engine 2): parked boards (other pages) held their levels referenced until 120 more frames
    /// were rendered, so an idle engine after a page switch stayed over the image budget. Over budget, a parked
    /// board gives them back at once and eviction gets under the budget; under it, it keeps them (no repaint).
    #[test]
    fn parked_boards_give_levels_back_when_over_budget() {
        assert!(!gives_back_levels(true, false, 10, 11, 120), "parked, under budget: kept");
        assert!(gives_back_levels(true, true, 10, 11, 120), "parked, over budget: given back at once");
        assert!(!gives_back_levels(false, true, 10, 11, 120), "in view: kept");
        assert!(gives_back_levels(false, false, 10, 130, 120), "long out of view: given back");
        // Four parked pages of 2048x2048 levels against a budget of three: the engine's drop step.
        let lvl = 2048u64 * 2048 * 4;
        let mut c: MipCache<u8> = MipCache::new(3 * lvl);
        let parked: Vec<(String, bool, u64)> = (0..4).map(|i| (format!("p{i}"), true, 100)).collect();
        for (i, (u, _, _)) in parked.iter().enumerate() {
            c.insert(u, 2048, i as u8, 2048, 2048, 1);
            c.acquire(u, 2048, 1);
        }
        assert!(c.over_budget());
        assert!(c.evict().is_empty(), "referenced levels cannot go");
        let over = c.over_budget();
        for (u, hidden, seen) in &parked {
            if gives_back_levels(*hidden, over, *seen, 101, 120) {
                c.release(u, 2048, 101);
            }
        }
        assert_eq!(c.evict().len(), 1);
        assert!(!c.over_budget());
        assert_eq!(c.len(), 3, "the rest stay cached for the way back");
    }
    /// Review round 6, Fable 3: a tile rendered ahead of the view draws an out-of-view image from its capped
    /// whole level. That is below what the scale needs whenever the image would be tiled in view.
    #[test]
    fn a_tile_ahead_of_the_view_knows_when_its_image_is_soft() {
        // A 1200 x 8000 screenshot at its own resolution: the level is 8000, one texture holds 4000.
        let q = Want { w: 1200, h: 8000, level: 8000, vis: None, opaque: true };
        let p = plan(&q);
        assert_eq!(p, Plan { whole: 4000, tiles: None }, "out of view: never tiled");
        let part = Some([0.0, 0.1, 1.0, 0.2]);
        assert!(ahead_short(&q, Some(true), &p, part), "drawn at half resolution: not sharp");
        assert!(ahead_short(&q, None, &p, part), "not asked yet whether it has transparency: it may be tiled in view");
        assert!(!ahead_short(&q, Some(false), &p, part), "an image with transparency is never tiled: this is its picture");
        assert!(!ahead_short(&q, Some(true), &p, None), "the tile shows none of it");
        // Shown small enough for one texture: whole and sharp.
        let small = Want { level: 2000, ..q };
        assert!(!ahead_short(&small, Some(true), &plan(&small), part));
        // The board holds tiles (the image is partly in view): sharp where they cover the tile's part only.
        let held = Plan { whole: 4000, tiles: Some((8000, Cells { x0: 0, y0: 0, x1: 3, y1: 4 })) };
        assert!(!ahead_short(&q, Some(true), &held, Some([0.0, 0.0, 1.0, 0.25])), "rows 0..4 cover image y 0..2048");
        assert!(ahead_short(&q, Some(true), &held, Some([0.0, 0.2, 1.0, 0.3])), "the tile reaches rows the board does not hold");
        // Tiles of another level than the one needed do not count.
        assert!(ahead_short(&q, Some(true), &Plan { whole: 4000, tiles: Some((4000, Cells { x0: 0, y0: 0, x1: 2, y1: 8 })) }, part));
    }

    #[test]
    fn the_transparency_scan_reads_about_two_megapixels_a_step() {
        assert_eq!(scan_rows(2880, 11000, 0), 728);
        assert_eq!(scan_rows(2880, 11000, 10900), 100, "never past the image");
        assert_eq!(scan_rows(4_000_000, 10, 3), 1, "at least a row");
        let mut y = 0;
        let mut steps = 0;
        while y < 11000 {
            y += scan_rows(2880, 11000, y);
            steps += 1;
        }
        assert_eq!((y, steps), (11000, 16));
    }
}
