//! Paint: one board's laid-out tree encoded into a vello `Scene`, in board coordinates, in the
//! order the browser paints html.ts's output.
//!
//! Per box (frame, rectangle, plain ellipse), CSS order: outer box-shadows, the backdrop blur,
//! background layers (colour and gradient fills, first fill at the bottom), inset shadows, image
//! fills (`<img>` children), the uniform stroke (`outline`: Chrome paints it before positioned
//! children, and it ignores the element's own clip), then the clip (`overflow: hidden`), the
//! children, and the gradient / per-side stroke overlay (the last child, so inside the clip and
//! above the children). `opacity` wraps the whole subtree in a layer.
//!
//! Blur (vello has no filters): what needs a Gaussian becomes an [`EffectJob`], a sub-scene the GPU
//! renders into a texture at a resolution tied to the blur (σ ≈ 2.5 texels, so the blurred result
//! loses nothing), blurs with a separable kernel and hands to vello as an image. Layer blur
//! (`filter: blur`) renders the node's whole subtree; background blur (`backdrop-filter`) renders
//! everything painted before the node and draws it clipped to the node's shape; drop shadows on
//! text, paths and icons (`filter: drop-shadow`) and box shadows on shapes vello's analytic blurred
//! rounded rect cannot express (per-corner radii, ellipses) render an alpha mask tinted with the
//! shadow colour.
//!
//! Text: macOS (CoreGraphics font smoothing, on by default in Chrome and WebKit) dilates glyph
//! outlines by a size-dependent fraction of a device pixel; glyphs get the same outward offset
//! (vello's embolden), added per render by [`smooth_glyphs`] for the device px that render draws them at
//! (the scene itself holds only synthetic bold), so text zoomed in is as light as Chrome draws it.
//!
//! Gradient fills on vector shapes draw their first stop colour, as html.ts does (it only sets an
//! unused `--grad` custom property).

use std::collections::HashMap;

use std::sync::Arc;

use kurbo::{Affine, BezPath, Cap, Ellipse, Join, Point, Rect, RoundedRect, RoundedRectRadii, Shape, Stroke};
use peniko::{BlendMode, Blob, Brush, Color, ColorStop, Compose, Extend, Fill, Gradient as PGradient, ImageAlphaType, ImageBrush, ImageData, ImageFormat, ImageQuality, Mix};
use vello::{FontEmbolden, Glyph, Scene};

use crate::geom::{ellipse_path, parse_svg_path, polygon_path};
use crate::layout::LayoutResult;
use crate::images::{APRON, Cells, cell_rect, cell_src};
use crate::scene::{Blend, Doc, Effect, Gradient, GradientKind, ImageFit, Kind, Node, Paint, ShaderPaint, StrokeAlign, StrokeWidth};
use crate::text::Ink;

/// An image a board may draw: the original's size, and the decoded level to draw when one is
/// attached (an `ImageData` whose pixels the GPU side supplies; see `images.rs`).
#[derive(Clone)]
pub struct BoardImage {
    pub w: u32,
    pub h: u32,
    pub data: Option<ImageData>,
    /// Tiles of a larger level over the part in view (see `images::plan`).
    pub tiles: Option<ImageTiles>,
    /// Per use of the image on the board, in paint order (`Painted::image_places`): a smaller level for a use
    /// that is drawn smaller than `data` suits (None: `data`, or the tiles).
    pub picks: Vec<Option<ImageData>>,
}

/// A block of tiles of one level of an image: the level's size, which tiles, and their textures in row order
/// (each holds `images::cell_src` of its tile). A tile without a texture leaves the image untiled.
#[derive(Clone)]
pub struct ImageTiles {
    pub lw: u32,
    pub lh: u32,
    pub cells: Cells,
    pub data: Vec<Option<ImageData>>,
}

/// Where a board draws an image: the image's own px to board space, and the box it is clipped to (board space).
#[derive(Clone, Copy, Debug)]
pub struct ImagePlace {
    pub to_board: Affine,
    pub clip: Rect,
    /// The drawn long side in board units: × the render scale it is the texel density this use needs. One
    /// level per image served every use of it, so a thumbnail of a picture also shown large on the same board
    /// was minified 3x and more through one bilinear tap (golden image-minify: moire).
    pub shown: f64,
    /// Drawn in the board's own scene (not inside a blurred sub-scene): it may be drawn from tiles.
    pub tileable: bool,
}

/// The part of a `w` × `h` image drawn at `places` that falls in `view` (board space), as fractions of the
/// image: x0, y0, x1, y1. None when none of it does.
pub fn image_part_in(places: &[ImagePlace], w: u32, h: u32, view: Rect) -> Option<[f64; 4]> {
    let mut out: Option<Rect> = None;
    for p in places.iter().filter(|p| p.tileable) {
        let r = view.intersect(p.clip);
        if r.width() <= 0.0 || r.height() <= 0.0 || p.to_board.determinant().abs() < 1e-12 {
            continue;
        }
        let img = p.to_board.inverse().transform_rect_bbox(r).intersect(Rect::new(0.0, 0.0, f64::from(w), f64::from(h)));
        if img.width() <= 0.0 || img.height() <= 0.0 {
            continue;
        }
        out = Some(out.map_or(img, |o| o.union(img)));
    }
    out.map(|r| [r.x0 / f64::from(w), r.y0 / f64::from(h), r.x1 / f64::from(w), r.y1 / f64::from(h)])
}

/// Images by URL, as one board is to draw them.
pub type ImageStore = HashMap<String, BoardImage>;

/// What a paint needs besides the tree.
pub struct PaintOptions<'a> {
    pub images: &'a ImageStore,
    pub debug_boxes: bool,
    /// The jobs of the paint this one replaces, when only image levels changed since: a job that draws no image
    /// and is the same job again keeps its placeholder, so its blurred texture stays (see `Painter::job`).
    pub reuse: Option<&'a [EffectJob]>,
}

/// How an effect job's blurred texture is used.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum JobKind {
    /// The blurred content itself (layer and background blur).
    Layer,
    /// The blurred content's alpha in this colour (shadows).
    Tint(Color),
}

/// What an effect job renders.
pub enum JobScene {
    /// Its own content (a subtree, a shadow's silhouette).
    Own(Scene),
    /// What the board's scene had drawn when a backdrop blur looked behind itself: a prefix of the board's own
    /// encoding, materialized when the job renders. Copying the scene so far for every backdrop blur kept a
    /// board's whole scene once per blurred box (quadratic in their number).
    Behind(ScenePrefix),
}

impl JobScene {
    /// The scene to render, given the board's scene (a prefix is materialized from it).
    pub fn scene<'a>(&'a self, board: &Scene) -> std::borrow::Cow<'a, Scene> {
        match self {
            JobScene::Own(s) => std::borrow::Cow::Borrowed(s),
            JobScene::Behind(p) => std::borrow::Cow::Owned(p.materialize(board)),
        }
    }
    /// Bytes this job keeps (a prefix keeps none of its own).
    pub fn bytes(&self) -> usize {
        match self {
            JobScene::Own(s) => scene_bytes(s),
            JobScene::Behind(_) => 0,
        }
    }
}

/// The lengths of a scene's encoding streams at one moment, and the layers open then. Encodings only grow, so
/// the first that many entries of each stream, with those layers closed, are the scene as it was.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScenePrefix {
    streams: [usize; 11],
    counts: [u32; 5],
    open: usize,
    /// The items of the board's scene index (cull.rs) the prefix holds.
    pub items: usize,
}

impl ScenePrefix {
    pub fn of(scene: &Scene, open: usize) -> ScenePrefix {
        let e = scene.encoding();
        let r = &e.resources;
        ScenePrefix {
            streams: [e.path_tags.len(), e.path_data.len(), e.draw_tags.len(), e.draw_data.len(), e.transforms.len(), e.styles.len(), r.patches.len(), r.color_stops.len(), r.glyphs.len(), r.glyph_runs.len(), r.normalized_coords.len()],
            counts: [e.n_paths, e.n_path_segments, e.n_clips, e.n_open_clips, e.flags],
            open,
            items: 0,
        }
    }

    /// `scene` (which this is a prefix of) as it was, with the layers then open closed.
    pub fn materialize(&self, scene: &Scene) -> Scene {
        let src = scene.encoding();
        let [pt, pd, dt, dd, tf, st, pa, cs, gl, gr, nc] = self.streams;
        let mut out = Scene::new();
        let e = out.encoding_mut();
        e.path_tags.extend_from_slice(&src.path_tags[..pt]);
        e.path_data.extend_from_slice(&src.path_data[..pd]);
        e.draw_tags.extend_from_slice(&src.draw_tags[..dt]);
        e.draw_data.extend_from_slice(&src.draw_data[..dd]);
        e.transforms.extend_from_slice(&src.transforms[..tf]);
        e.styles.extend_from_slice(&src.styles[..st]);
        e.resources.patches.extend_from_slice(&src.resources.patches[..pa]);
        e.resources.color_stops.extend_from_slice(&src.resources.color_stops[..cs]);
        e.resources.glyphs.extend_from_slice(&src.resources.glyphs[..gl]);
        e.resources.glyph_runs.extend_from_slice(&src.resources.glyph_runs[..gr]);
        e.resources.normalized_coords.extend_from_slice(&src.resources.normalized_coords[..nc]);
        [e.n_paths, e.n_path_segments, e.n_clips, e.n_open_clips, e.flags] = self.counts;
        for _ in 0..self.open {
            out.pop_layer();
        }
        out
    }
}

/// A sub-scene to render, blur and draw back as an image (see the module docs).
pub struct EffectJob {
    /// Content, in board coordinates.
    pub scene: JobScene,
    /// The board-space rect the texture covers.
    pub bounds: Rect,
    /// Where the board draws it (board space): `bounds`, moved by a shadow's offset (one mask can be
    /// drawn at several offsets). What a tile must intersect to need the job.
    pub drawn: Rect,
    /// Gaussian standard deviation in board units.
    pub sigma: f64,
    pub kind: JobKind,
    /// Texture size.
    pub w: u32,
    pub h: u32,
    /// What the board's scene draws; the GPU side attaches the blurred texture to it.
    pub image: ImageData,
    /// Its content draws an image (or what is behind it may): another image level makes it another picture.
    pub has_image: bool,
}

pub struct Painted {
    pub scene: Scene,
    /// Board-space bounds of everything drawn.
    pub ink: Rect,
    /// Image URLs this board draws (whether or not they have arrived yet).
    pub images: Vec<String>,
    /// Per registered image: its largest drawn long side in board units (× the tile scale = the
    /// device px it covers, which picks its mip level).
    pub image_need: HashMap<String, f64>,
    /// Per registered image: every use of it, in paint order.
    pub image_places: HashMap<String, Vec<ImagePlace>>,
    pub jobs: Vec<EffectJob>,
    /// The scene as items with bounds (cull.rs): a render copies only the ones that meet it.
    pub index: crate::cull::SceneIndex,
    /// Per node, board space: everything it draws itself (its scene items, with their slack) and everything its
    /// subtree draws. An edit of a subtree changes pixels only inside the union of this before and after
    /// (`Board::dirty_since`), so its tiles render only that part again.
    pub node_ink: Vec<Rect>,
    /// Shader fills, one per node that has one (the topmost shader in its list draws; see `Painter::shader_fill`).
    pub fills: Vec<FillUse>,
}

/// A node's shader fill as painted: the placeholder image the board's scene draws (the engine attaches the texture
/// a shader renders into, like an effect job's), and what renders it.
#[derive(Clone, Debug)]
pub struct FillUse {
    pub node: usize,
    pub id: String,
    pub image: ImageData,
    /// The node's own size (the shader's `u.resolution`), board units.
    pub w: f64,
    pub h: f64,
    /// What it covers, board space (its box turned with it).
    pub rect: Rect,
    pub shader: std::rc::Rc<ShaderPaint>,
}

/// Texels a shader fill renders at for a `w` x `h` node: 2 per unit (a Retina screen at 100%), the long side at
/// most `FILL_MAX_SIDE`. Fixed per node size, not per zoom: the board's scene draws one placeholder of this size,
/// so a zoom needs no new paint.
pub const FILL_MAX_SIDE: f64 = 1024.0;
pub fn fill_tex_size(w: f64, h: f64) -> (u32, u32) {
    let (w, h) = (w.max(1.0), h.max(1.0));
    let k = (FILL_MAX_SIDE / w.max(h)).min(2.0);
    (((w * k).round() as u32).max(1), ((h * k).round() as u32).max(1))
}

/// Texels per board unit for a blur of `sigma`: σ ≈ 2.5 texels, at most 4 per unit, and the
/// texture stays within 2048 px a side and 4 Mpx.
pub fn job_resolution(bounds: Rect, sigma: f64) -> f64 {
    let mut q = if sigma > 0.0 { (2.5 / sigma).min(4.0) } else { 4.0 };
    let (w, h) = (bounds.width().max(1.0), bounds.height().max(1.0));
    q = q.min(2048.0 / w).min(2048.0 / h).min((4.0e6 / (w * h)).sqrt());
    q.max(1e-3)
}

/// A unique placeholder `ImageData` of `w` × `h` (its pixels come from a GPU texture).
pub fn gpu_image(w: u32, h: u32, alpha_type: ImageAlphaType) -> ImageData {
    ImageData { data: Blob::new(Arc::new(Vec::<u8>::new())), format: ImageFormat::Rgba8, alpha_type, width: w.max(1), height: h.max(1) }
}

/// Add the macOS font-smoothing dilation to glyph runs `from..` of `scene` (a render's scratch scene, after the
/// board's scene was appended with the render's transform): each run grows by `stem_darkening` of the device px
/// per em it lands at, in its own text units. Chrome sizes the dilation for the final device scale, zoom included,
/// and drops it around `STEM_MAX_PPEM` (faded out here, see `stem_darkening`); a dilation baked at zoom 1 drew zoomed-in text up to 2.5x too heavy.
///
/// It also puts each upright run's baseline on a whole device pixel of this render, as Chrome (Skia's baseline
/// snap) does at any zoom. Measured on the golden suite, with and without: zoom-ladder 0.1x 2.8% against 4.2%
/// mismatch, 0.33x 1.2% against 1.8%, 1x 0.34% against 0.63%. The shift is at most half a device px and is
/// decided per render, so text moves smoothly between settled scales; rotated and skewed runs are left alone.
///
/// `snap`: false for effect renders. Their textures hold a few board units per texel (2.5 texels per sigma), so
/// a snap to their grid moved each line of a blurred text shadow by up to half a texel, on its own, away from
/// the text it belongs to.
pub fn smooth_glyphs(scene: &mut Scene, from: usize, snap: bool) {
    let res = &mut scene.encoding_mut().resources;
    let (runs, glyphs) = (&mut res.glyph_runs, &res.glyphs);
    for run in runs.iter_mut().skip(from) {
        let [a, b, c, d] = run.transform.matrix;
        let dev = f64::from((a * d - b * c).abs()).sqrt();
        if dev <= 0.0 {
            continue;
        }
        if snap && b.abs() < 1e-6 && c.abs() < 1e-6 && d > 0.0 && run.glyph_transform.is_none()
            && let Some(g) = glyphs.get(run.glyphs.start)
        {
            let y = d * g.y + run.transform.translation[1];
            run.transform.translation[1] += y.round() - y;
        }
        let grow = stem_darkening(f64::from(run.font_size) * dev) / dev;
        if grow > 0.0 {
            let amt = run.font_embolden.amount;
            run.font_embolden.amount = kurbo::Diagonal2::new(amt.xx + grow, amt.yy + grow);
        }
    }
}

/// The device-px outward offset macOS font smoothing gives glyphs at `ppem` device px per em
/// (calibrated against Chrome screenshots of Inter, SF Pro and Roboto at 10 to 48 px, 1x and 2x:
/// 0.006 px per ppem matches the ink and minimises the diff at both scales).
pub fn stem_darkening(ppem: f64) -> f64 {
    let (factor, max) = STEM.with(|c| c.get());
    if ppem <= 0.0 || ppem >= STEM_FADE_TO {
        return 0.0;
    }
    // Fades out around the size where Chrome stops (72 ppem): cut off in one step, 36 px text lost 9.5% of
    // its ink between 71.99 and 72.01 ppem, a visible pop on a slow zoom.
    let fade = ((STEM_FADE_TO - ppem) / (STEM_FADE_TO - STEM_FADE_FROM)).clamp(0.0, 1.0);
    (ppem * factor).min(max) * fade
}

thread_local! {
    static STEM: std::cell::Cell<(f64, f64)> = const { std::cell::Cell::new((STEM_FACTOR, STEM_MAX)) };
}

/// Tune the dilation (device px per ppem, cap in device px); textures must render again.
pub fn set_stem_darkening(factor: f64, max: f64) {
    STEM.with(|c| c.set((factor.max(0.0), max.max(0.0))));
}
pub const STEM_FACTOR: f64 = 0.006;
pub const STEM_MAX: f64 = 0.3;
pub const STEM_MAX_PPEM: f64 = 72.0;
/// The dilation is full up to `STEM_FADE_FROM` ppem and fades to nothing at `STEM_FADE_TO`.
pub const STEM_FADE_FROM: f64 = 64.0;
pub const STEM_FADE_TO: f64 = 88.0;

const PLACEHOLDER: Color = Color::from_rgba8(0xF4, 0xF4, 0xF5, 0xFF);
const NOTE_BG: Color = Color::from_rgba8(0xFE, 0xF3, 0xC7, 0xFF);
const PROMPT_BG: Color = Color::from_rgba8(0xED, 0xE9, 0xFE, 0xFF);
const NOTE_FG: Color = Color::from_rgba8(0x18, 0x18, 0x1B, 0xFF);

/// The geometry of a CSS box: a rect with (clamped) corner radii, or an ellipse (`border-radius: 50%`).
#[derive(Clone, Copy, Debug)]
pub struct BoxShape {
    pub rect: Rect,
    pub radii: [f64; 4],
    pub ellipse: bool,
    /// Corner smoothing, 0..1 (`cornerSmoothing`).
    pub smooth: f64,
}

impl BoxShape {
    pub fn new(w: f64, h: f64, corner: Option<[f64; 4]>, ellipse: bool) -> BoxShape {
        let rect = Rect::new(0.0, 0.0, w.max(0.0), h.max(0.0));
        BoxShape { rect, radii: corner.map_or([0.0; 4], |r| css_radii(r, w, h)), ellipse, smooth: 0.0 }
    }
    /// The same box with corner smoothing (0..1).
    pub fn smoothed(mut self, s: f64) -> BoxShape {
        self.smooth = if s.is_finite() { s.clamp(0.0, 1.0) } else { 0.0 };
        self
    }
    pub fn rounded(&self) -> bool {
        self.ellipse || self.radii.iter().any(|r| *r > 0.0)
    }
    pub fn path(&self) -> BezPath {
        if self.ellipse {
            Ellipse::from_rect(self.rect).to_path(0.1)
        } else if self.rounded() && self.smooth > 0.0 {
            smooth_path(self.rect, self.radii, self.smooth)
        } else if self.rounded() {
            rounded_path(self.rect, self.radii)
        } else {
            self.rect.to_path(0.1)
        }
    }
    /// Grow (or shrink, negative) by `d` on every side; radii follow CSS (`r + d` for rounded corners).
    pub fn inflate(&self, d: f64) -> BoxShape {
        let rect = self.rect.inflate(d, d);
        let rect = Rect::new(rect.x0, rect.y0, rect.x1.max(rect.x0), rect.y1.max(rect.y0));
        // Radii stay within the sides (CSS): a shape shrunk to nothing kept its radii and `rounded_path` drew a
        // lens where an inner shadow's hole had collapsed.
        let radii = css_radii(self.radii.map(|r| if r > 0.0 { (r + d).max(0.0) } else { 0.0 }), rect.width(), rect.height());
        BoxShape { rect, radii, ellipse: self.ellipse, smooth: self.smooth }
    }
    /// vello's analytic blurred rounded rect fits: not an ellipse (unless a circle), one radius.
    pub fn analytic(&self) -> bool {
        if self.ellipse || (self.smooth > 0.0 && self.rounded()) {
            return false;
        }
        self.radii.iter().all(|r| (r - self.radii[0]).abs() < 1e-6)
    }
}

/// A rectangle with smoothed corners (the squircle curve adapted from Tien Pham's MIT-licensed implementation; licence in
/// THIRD_PARTY_NOTICES.md): each corner's arc is shorter
/// by `smooth` and two cubic curves ease into it from up to (1 + smooth) x radius along each side, within half the
/// shorter side. `smooth` 0 is the plain circular corner.
pub fn smooth_path(rect: Rect, radii: [f64; 4], smooth: f64) -> BezPath {
    let (w, h) = (rect.width(), rect.height());
    let budget = w.min(h) / 2.0;
    // Per corner: (start point, a list of cubic segments) in a frame where the path runs along +x into the corner
    // and leaves it along +y; `p` is how far before the corner it starts.
    struct Corner {
        p: f64,
        segs: Vec<[(f64, f64); 3]>,
    }
    let corner = |r: f64| -> Corner {
        let r = r.min(budget).max(0.0);
        if r <= 0.0 {
            return Corner { p: 0.0, segs: Vec::new() };
        }
        let s = smooth.min(budget / r - 1.0).max(0.0);
        let p = ((1.0 + s) * r).min(budget);
        let arc = 90.0 * (1.0 - s);
        let l = (arc / 2.0).to_radians().sin() * r * std::f64::consts::SQRT_2;
        let alpha = (90.0 - arc) / 2.0;
        let p3p4 = r * (alpha / 2.0).to_radians().tan();
        let beta = 45.0 * s;
        let c = p3p4 * beta.to_radians().cos();
        let d = c * beta.to_radians().tan();
        let b = ((p - l - c - d) / 3.0).max(0.0);
        let a = 2.0 * b;
        let e1 = (a + b + c, d);
        let e2 = (e1.0 + l, e1.1 + l);
        // The arc as one cubic: tangents at alpha and 90 - alpha degrees.
        let th = arc.to_radians();
        let k = 4.0 / 3.0 * (th / 4.0).tan() * r;
        let (sa, ca) = alpha.to_radians().sin_cos();
        let segs = vec![
            [(a, 0.0), (a + b, 0.0), e1],
            [(e1.0 + k * ca, e1.1 + k * sa), (e2.0 - k * sa, e2.1 - k * ca), e2],
            [(e2.0 + d, e2.1 + c), (e2.0 + d, e2.1 + b + c), (e2.0 + d, e2.1 + a + b + c)],
        ];
        Corner { p, segs }
    };
    let Rect { x0, y0, x1, y1 } = rect;
    // top right, bottom right, bottom left, top left: (corner point, along, then)
    let frames = [((x1, y0), (1.0, 0.0), (0.0, 1.0), radii[1]), ((x1, y1), (0.0, 1.0), (-1.0, 0.0), radii[2]), ((x0, y1), (-1.0, 0.0), (0.0, -1.0), radii[3]), ((x0, y0), (0.0, -1.0), (1.0, 0.0), radii[0])];
    let mut path = BezPath::new();
    for (n, (pt, u, v, r)) in frames.iter().enumerate() {
        let c = corner(*r);
        let map = |(x, y): (f64, f64)| (pt.0 + (x - c.p) * u.0 + y * v.0, pt.1 + (x - c.p) * u.1 + y * v.1);
        let start = map((0.0, 0.0));
        if n == 0 {
            // Start where the top left corner's curve ends.
            let tl = corner(radii[0]);
            path.move_to((x0 + tl.p, y0));
        }
        path.line_to(start);
        for [c1, c2, e] in &c.segs {
            path.curve_to(map(*c1), map(*c2), map(*e));
        }
    }
    path.close_path();
    path
}

/// A rectangle with one radius per corner (top-left, top-right, bottom-right, bottom-left), each already within
/// its sides (`css_radii`). kurbo's `RoundedRect` clamps every radius to half the shorter side, so
/// `cornerRadius: [80, 80, 0, 0]` on a 110 x 80 box (CSS: two 55 px arcs, a full arch) came out with 40 px
/// corners and a flat top; that case is drawn arc by arc here.
pub fn rounded_path(rect: Rect, radii: [f64; 4]) -> BezPath {
    let [tl, tr, br, bl] = radii;
    let half = rect.width().min(rect.height()) / 2.0;
    if radii.iter().all(|r| *r <= half + 1e-9) {
        return RoundedRect::from_rect(rect, RoundedRectRadii::new(tl, tr, br, bl)).to_path(0.1);
    }
    // A quarter circle as one cubic: control points at 0.5523 of the radius.
    const K: f64 = 0.552_284_749_830_793_4;
    let Rect { x0, y0, x1, y1 } = rect;
    let mut p = BezPath::new();
    p.move_to((x0 + tl, y0));
    p.line_to((x1 - tr, y0));
    if tr > 0.0 {
        p.curve_to((x1 - tr + tr * K, y0), (x1, y0 + tr - tr * K), (x1, y0 + tr));
    }
    p.line_to((x1, y1 - br));
    if br > 0.0 {
        p.curve_to((x1, y1 - br + br * K), (x1 - br + br * K, y1), (x1 - br, y1));
    }
    p.line_to((x0 + bl, y1));
    if bl > 0.0 {
        p.curve_to((x0 + bl - bl * K, y1), (x0, y1 - bl + bl * K), (x0, y1 - bl));
    }
    p.line_to((x0, y0 + tl));
    if tl > 0.0 {
        p.curve_to((x0, y0 + tl - tl * K), (x0 + tl - tl * K, y0), (x0 + tl, y0));
    }
    p.close_path();
    p
}

/// Is `q` inside the rectangle with those corner radii (the shape `rounded_path` draws)?
pub fn rounded_contains(rect: Rect, radii: [f64; 4], q: Point) -> bool {
    if q.x < rect.x0 || q.x > rect.x1 || q.y < rect.y0 || q.y > rect.y1 {
        return false;
    }
    let [tl, tr, br, bl] = radii;
    // Each corner: inside its square but outside its circle is outside.
    for (r, cx, cy, sx, sy) in [(tl, rect.x0 + tl, rect.y0 + tl, -1.0, -1.0), (tr, rect.x1 - tr, rect.y0 + tr, 1.0, -1.0), (br, rect.x1 - br, rect.y1 - br, 1.0, 1.0), (bl, rect.x0 + bl, rect.y1 - bl, -1.0, 1.0)] {
        let (dx, dy) = ((q.x - cx) * sx, (q.y - cy) * sy);
        if r > 0.0 && dx > 0.0 && dy > 0.0 && dx * dx + dy * dy > r * r {
            return false;
        }
    }
    true
}

/// CSS border-radius: when adjacent radii exceed a side, all of them scale down by the same factor.
/// The vello mix for a `blendMode`.
pub fn mix_of(b: Blend) -> Mix {
    match b {
        Blend::Normal => Mix::Normal,
        Blend::Darken => Mix::Darken,
        Blend::Multiply => Mix::Multiply,
        Blend::ColorBurn => Mix::ColorBurn,
        Blend::Lighten => Mix::Lighten,
        Blend::Screen => Mix::Screen,
        Blend::ColorDodge => Mix::ColorDodge,
        Blend::Overlay => Mix::Overlay,
        Blend::SoftLight => Mix::SoftLight,
        Blend::HardLight => Mix::HardLight,
        Blend::Difference => Mix::Difference,
        Blend::Exclusion => Mix::Exclusion,
        Blend::Hue => Mix::Hue,
        Blend::Saturation => Mix::Saturation,
        Blend::Color => Mix::Color,
        Blend::Luminosity => Mix::Luminosity,
    }
}

/// The most copies a tiled image fill draws: smaller tiles grow so the layer still fills.
pub const MAX_TILES: f64 = 2500.0;

/// Where an image fill draws in a `w` x `h` box: one transform (image px to box) per copy. `rot` quarter turns
/// clockwise first (Rotate 90°), then the mode places the turned image: Fill covers the box, Fit fits in
/// it, Crop puts it at its fractions of the box, Tile repeats it from the top left at `scale` x its own size.
pub fn image_places(fit: ImageFit, rot: u8, w: f64, h: f64, iw: f64, ih: f64) -> Vec<Affine> {
    let turn = match rot % 4 {
        1 => Affine::new([0.0, 1.0, -1.0, 0.0, ih, 0.0]),
        2 => Affine::new([-1.0, 0.0, 0.0, -1.0, iw, ih]),
        3 => Affine::new([0.0, -1.0, 1.0, 0.0, 0.0, iw]),
        _ => Affine::IDENTITY,
    };
    let (rw, rh) = if rot % 2 == 1 { (ih, iw) } else { (iw, ih) };
    if rw <= 0.0 || rh <= 0.0 || w <= 0.0 || h <= 0.0 {
        return Vec::new();
    }
    let one = |a: Affine| vec![a * turn];
    match fit {
        ImageFit::Cover | ImageFit::Contain => {
            let s = if fit == ImageFit::Cover { (w / rw).max(h / rh) } else { (w / rw).min(h / rh) };
            one(Affine::translate(((w - rw * s) / 2.0, (h - rh * s) / 2.0)) * Affine::scale(s))
        }
        ImageFit::Stretch => one(Affine::scale_non_uniform(w / rw, h / rh)),
        ImageFit::Crop([x, y, cw, ch]) => one(Affine::translate((x * w, y * h)) * Affine::scale_non_uniform(cw * w / rw, ch * h / rh)),
        ImageFit::Tile(scale) => {
            let mut s = scale;
            let count = |s: f64| (w / (rw * s)).ceil() * (h / (rh * s)).ceil();
            if count(s) > MAX_TILES {
                s *= (count(s) / MAX_TILES).sqrt().ceil();
            }
            let (tw, th) = (rw * s, rh * s);
            let mut out = Vec::new();
            let mut y = 0.0;
            while y < h {
                let mut x = 0.0;
                while x < w {
                    out.push(Affine::translate((x, y)) * Affine::scale(s) * turn);
                    x += tw;
                }
                y += th;
            }
            out
        }
    }
}

pub fn css_radii(r: [f64; 4], w: f64, h: f64) -> [f64; 4] {
    let r = r.map(|x| x.max(0.0));
    let mut f: f64 = 1.0;
    for (sum, side) in [(r[0] + r[1], w), (r[3] + r[2], w), (r[0] + r[3], h), (r[1] + r[2], h)] {
        if sum > 0.0 {
            f = f.min(side.max(0.0) / sum);
        }
    }
    r.map(|x| x * f)
}

/// CSS `linear-gradient` / `radial-gradient` / `conic-gradient` exactly as html.ts writes them,
/// mapped to a w×h box. Returns the brush and the brush transform (in box space).
pub fn gradient_brush(g: &Gradient, w: f64, h: f64) -> (Brush, Affine) {
    let stops: Vec<ColorStop> = g.stops.iter().map(|(o, c)| ColorStop::from((*o, *c))).collect();
    let stops = if stops.is_empty() { vec![ColorStop::from((0.0, Color::TRANSPARENT)), ColorStop::from((1.0, Color::TRANSPARENT))] } else { stops };
    match g.kind {
        GradientKind::Linear => {
            // CSS: angle -rotation, 0deg points up, clockwise; the gradient line spans the box corners.
            let a = (-g.rotation).to_radians();
            let (s, c) = a.sin_cos();
            let len = (w * s).abs() + (h * c).abs();
            let center = Point::new(w / 2.0, h / 2.0);
            let d = kurbo::Vec2::new(s, -c) * (len / 2.0);
            let grad = PGradient::new_linear(center - d, center + d).with_stops(stops.as_slice()).with_extend(Extend::Pad);
            (Brush::Gradient(grad), Affine::IDENTITY)
        }
        GradientKind::Radial => {
            let (rx, ry) = (g.size.0 * w / 2.0, g.size.1 * h / 2.0);
            let (cx, cy) = (g.center.0 * w, g.center.1 * h);
            if rx <= 0.0 || ry <= 0.0 {
                let last = g.stops.last().map_or(Color::TRANSPARENT, |s| s.1);
                return (Brush::Solid(last), Affine::IDENTITY);
            }
            let grad = PGradient::new_radial((0.0, 0.0), 1.0).with_stops(stops.as_slice()).with_extend(Extend::Pad);
            (Brush::Gradient(grad), Affine::translate((cx, cy)) * Affine::scale_non_uniform(rx, ry))
        }
        GradientKind::Angular => {
            // conic-gradient(from -rotation deg): 0deg points up, clockwise.
            let (cx, cy) = (g.center.0 * w, g.center.1 * h);
            let from = (-g.rotation - 90.0).to_radians();
            let grad = PGradient::new_sweep((0.0, 0.0), 0.0, std::f32::consts::TAU).with_stops(stops.as_slice()).with_extend(Extend::Pad);
            (Brush::Gradient(grad), Affine::translate((cx, cy)) * Affine::rotate(from))
        }
    }
}

fn first_color(paints: &[Paint]) -> Option<Color> {
    paints.iter().find_map(|p| match p {
        Paint::Solid(c) => Some(*c),
        Paint::Gradient(g) => g.stops.first().map(|s| s.1),
        Paint::Image { .. } | Paint::Shader(_) => None,
    })
}

fn cap_of(s: Option<&str>) -> Cap {
    match s {
        Some("round") => Cap::Round,
        Some("square") => Cap::Square,
        _ => Cap::Butt,
    }
}

fn join_of(s: Option<&str>) -> Join {
    match s {
        Some("round") => Join::Round,
        Some("bevel") => Join::Bevel,
        _ => Join::Miter,
    }
}

struct Painter<'a> {
    doc: &'a Doc,
    l: &'a LayoutResult,
    images: &'a ImageStore,
    scene: Scene,
    own_ink: Vec<Rect>,
    sub_ink: Vec<Rect>,
    used_images: Vec<String>,
    image_need: HashMap<String, f64>,
    image_places: HashMap<String, Vec<ImagePlace>>,
    debug_boxes: bool,
    reuse: Option<&'a [EffectJob]>,
    jobs: Vec<EffectJob>,
    /// Layers pushed and not yet popped on `scene` (a backdrop snapshot closes them).
    open: usize,
    /// The node whose layer blur is being rendered into a job (paints it without the blur).
    unblurred: Option<usize>,
    fills: Vec<FillUse>,
    /// Factor on every job's resolution (below 1 when the board's jobs would not fit `JOB_ATLAS_PX`).
    job_scale: f64,
    /// Sub-scenes being painted (a blur's content, a shadow's silhouette): 0 while painting the board's own scene.
    sub_depth: usize,
    /// The board scene's items (cull.rs): what each stretch of the encoding covers, so a render copies only
    /// what meets it.
    index: crate::cull::Builder,
    /// The node whose own content is being encoded into the board's scene.
    owner: usize,
}

fn union(a: Rect, b: Rect) -> Rect {
    if a.is_zero_area() && a.x0 == 0.0 && a.y0 == 0.0 && a.x1 == 0.0 { b } else { a.union(b) }
}

/// One icon shape ready to draw: outline, fill colour, stroke colour + style, fill rule.
type IconPaint = (BezPath, Option<Color>, Option<(Color, Stroke)>, Fill);

pub fn simple_ellipse(n: &Node) -> bool {
    n.kind == Kind::Ellipse && n.inner_radius == 0.0 && n.sweep_angle.is_none_or(|s| s.abs() >= 360.0)
}

fn is_boxy(n: &Node) -> bool {
    matches!(n.kind, Kind::Frame | Kind::Rectangle) || simple_ellipse(n)
}

/// Outward reach of a node's stroke beyond its box.
fn stroke_reach(n: &Node) -> f64 {
    if n.strokes.is_empty() {
        return 0.0;
    }
    let w = match n.stroke_width {
        Some(StrokeWidth::Uniform(w)) => w,
        Some(StrokeWidth::Sides(s)) => s.iter().copied().fold(0.0, f64::max),
        None => return 0.0,
    };
    if !is_boxy(n) {
        return w * 2.0; // miters on vector strokes
    }
    match n.stroke_align {
        StrokeAlign::Inner => 0.0,
        StrokeAlign::Center => w / 2.0,
        StrokeAlign::Outer => w,
    }
}

fn effect_reach(n: &Node) -> f64 {
    let mut r: f64 = 0.0;
    for e in &n.effects {
        match *e {
            // The offset's length, not its larger component: on a rotated node it lands along another axis.
            Effect::Shadow { inner: false, x, y, blur, spread, .. } => r = r.max(x.hypot(y) + spread.max(0.0) + blur * 1.5),
            Effect::Blur { radius } => r = r.max(radius * 1.5),
            _ => {}
        }
    }
    r
}

/// σ of a node's `filter: blur()` when it is rendered as a job (anything but the plain-box fast path).
fn layer_blur_sigma(n: &Node) -> Option<f64> {
    n.effects.iter().find_map(|e| if let Effect::Blur { radius } = e { Some(*radius / 2.0) } else { None }).filter(|s| *s > 0.0 && !blurred_rect_fast_path(n))
}

impl Painter<'_> {
    /// Where node `i`'s subtree draws, its layer blur's halo included (the blur spreads 3σ past everything in it).
    fn out_ink(&self, i: usize) -> Rect {
        let r = self.sub_ink[i];
        match layer_blur_sigma(&self.doc.nodes[i]) {
            Some(s) => r.inflate(s * 3.0, s * 3.0),
            None => r,
        }
    }

    fn size(&self, i: usize) -> (f64, f64) {
        (self.l.boxes[i].w, self.l.boxes[i].h)
    }

    fn vector_path(&self, i: usize) -> Option<(BezPath, bool)> {
        let n = &self.doc.nodes[i];
        let (w, h) = self.size(i);
        let (path, vb, even_odd) = match n.kind {
            Kind::Path => {
                let p = parse_svg_path(n.geometry.as_deref()?);
                let vb = match n.view_box {
                    Some(v) => Rect::new(v[0], v[1], v[0] + v[2], v[1] + v[3]),
                    None => {
                        let b = p.bounding_box();
                        Rect::new(b.x0, b.y0, b.x0 + if b.width() > 0.0 { b.width() } else { 1.0 }, b.y0 + if b.height() > 0.0 { b.height() } else { 1.0 })
                    }
                };
                (p, vb, n.even_odd)
            }
            Kind::Polygon => {
                let (vw, vh) = (n.num_w.unwrap_or(100.0), n.num_h.unwrap_or(100.0));
                (polygon_path(n.polygon_count, vw, vh), Rect::new(0.0, 0.0, vw, vh), false)
            }
            Kind::Ellipse => {
                let (vw, vh) = (n.num_w.unwrap_or(100.0), n.num_h.unwrap_or(100.0));
                (parse_svg_path(&ellipse_path(vw, vh, n.inner_radius, n.start_angle, n.sweep_angle)), Rect::new(0.0, 0.0, vw, vh), true)
            }
            _ => return None,
        };
        if vb.width() <= 0.0 || vb.height() <= 0.0 {
            return None;
        }
        // preserveAspectRatio="none": the viewBox stretches onto the box.
        let t = Affine::scale_non_uniform(w / vb.width(), h / vb.height()) * Affine::translate((-vb.x0, -vb.y0));
        let mut p = path;
        p.apply_affine(t);
        Some((p, even_odd))
    }

    /// Own ink of a node in board space.
    fn compute_own_ink(&mut self, i: usize) -> Rect {
        let n = &self.doc.nodes[i];
        let xf = self.l.world[i];
        let mut r = self.l.aabb[i];
        if (matches!(n.kind, Kind::Path | Kind::Polygon) || (n.kind == Kind::Ellipse && !simple_ellipse(n)))
            && let Some((p, _)) = self.vector_path(i) {
                r = union(r, xf.transform_rect_bbox(p.bounding_box()));
            }
        if let Some(tb) = self.l.texts.get(i).and_then(Option::as_ref)
            && let Some(lay) = tb.layout.as_ref()
        {
            let (ox, oy) = self.l.text_origin[i];
            let size = n.text.as_ref().map_or(16.0, |t| f64::from(t.size));
            // Hanging quotes and hanging list markers draw left of the box (min_x below 0).
            let tr = Rect::new(ox + f64::from(tb.min_x()), oy, ox + f64::from(lay.full_width()), oy + f64::from(tb.height())).inflate(size * 0.35, size * 0.35);
            r = union(r, xf.transform_rect_bbox(tr));
        }
        // Strokes and shadows reach out in the node's own space: the box grows before it is rotated. Growing the
        // rotated box's bounds by the same amount left a square corner at 45 degrees 1.41x short (a shadow's tip
        // was cut flat at a tile edge).
        let reach = stroke_reach(n).max(effect_reach(n));
        if reach > 0.0 {
            let (w, h) = self.size(i);
            union(r.inflate(reach, reach), xf.transform_rect_bbox(Rect::new(0.0, 0.0, w, h).inflate(reach, reach)))
        } else {
            r
        }
    }

    fn push_layer(&mut self, blend: impl Into<BlendMode>, alpha: f32, xf: Affine, clip: &impl Shape) {
        self.cut();
        self.scene.push_layer(Fill::NonZero, blend, alpha, xf, clip);
        self.open += 1;
        if self.sub_depth == 0 {
            self.index.pushed(&mut self.scene, xf.transform_rect_bbox(clip.bounding_box()));
        }
    }

    fn push_clip(&mut self, rule: Fill, xf: Affine, clip: &impl Shape) {
        self.cut();
        self.scene.push_clip_layer(rule, xf, clip);
        self.open += 1;
        if self.sub_depth == 0 {
            self.index.pushed(&mut self.scene, xf.transform_rect_bbox(clip.bounding_box()));
        }
    }

    fn pop(&mut self) {
        self.cut();
        self.scene.pop_layer();
        self.open -= 1;
        if self.sub_depth == 0 {
            self.index.popped(&mut self.scene);
        }
    }

    /// Scene index: what the board's scene encoded since the last cut is the current node's own content.
    fn cut(&mut self) {
        if self.sub_depth == 0 {
            let b = self.item_bounds(self.owner);
            self.index.cut(&mut self.scene, b);
        }
    }

    /// Where node `i`'s own content draws (board space), for the scene index: its ink with slack (an icon's
    /// overhang, the debug outline), or everything under it when a layer blur draws the subtree as one image.
    fn item_bounds(&self, i: usize) -> Rect {
        if layer_blur_sigma(&self.doc.nodes[i]).is_some() {
            return self.out_ink(i).inflate(2.0, 2.0);
        }
        // An icon's outline may reach past its box (its ink is the box).
        let pad = if self.doc.nodes[i].kind == Kind::Icon { let (w, h) = self.size(i); 2.0 + 0.35 * w.max(h) } else { 2.0 };
        self.own_ink[i].inflate(pad, pad)
    }

    /// Paint node `i` and its subtree, as items of the scene index when this is the board's own scene.
    fn paint(&mut self, i: usize) {
        if self.sub_depth > 0 {
            return self.paint_node(i);
        }
        self.cut();
        let prev = std::mem::replace(&mut self.owner, i);
        // A subtree is skipped in one step by renders it does not meet.
        let group = self.doc.nodes[i].children.len() >= 4;
        if group {
            self.index.open_group(&mut self.scene);
        }
        self.paint_node(i);
        self.cut();
        if group {
            self.index.close_group();
        }
        self.owner = prev;
    }

    /// Paint `f` into a fresh scene and give it back (the main scene is restored).
    fn sub_scene(&mut self, f: impl FnOnce(&mut Self)) -> Scene {
        let main = std::mem::replace(&mut self.scene, Scene::new());
        let open = std::mem::replace(&mut self.open, 0);
        self.sub_depth += 1;
        f(self);
        while self.open > 0 {
            self.pop();
        }
        self.sub_depth -= 1;
        self.open = open;
        std::mem::replace(&mut self.scene, main)
    }

    /// Register a blur job over `bounds` (board space) and return its placeholder image and the
    /// transform that draws it there.
    fn job(&mut self, scene: JobScene, bounds: Rect, sigma: f64, kind: JobKind) -> (ImageData, Affine) {
        let bounds = Rect::new(bounds.x0.floor(), bounds.y0.floor(), bounds.x1.ceil(), bounds.y1.ceil());
        let q = (job_resolution(bounds, sigma) * self.job_scale).max(1e-3);
        let (w, h) = (((bounds.width() * q).ceil() as u32).max(1), ((bounds.height() * q).ceil() as u32).max(1));
        let has_image = match &scene {
            JobScene::Own(s) => s.encoding().resources.patches.iter().any(|p| matches!(p, vello::low_level::vello_encoding::Patch::Image { .. })),
            JobScene::Behind(_) => true,
        };
        // Painted again for other image levels only (`PaintOptions::reuse`): the same job, when no image is in
        // it, keeps its placeholder, and with it the texture already blurred for it.
        let kept = self.reuse.and_then(|r| r.get(self.jobs.len())).filter(|o| !has_image && !o.has_image && o.bounds == bounds && (o.w, o.h) == (w, h) && o.sigma == sigma && o.kind == kind);
        let image = kept.map_or_else(|| gpu_image(w, h, ImageAlphaType::AlphaPremultiplied), |o| o.image.clone());
        let at = Affine::translate((bounds.x0, bounds.y0)) * Affine::scale_non_uniform(bounds.width() / f64::from(w), bounds.height() / f64::from(h));
        self.jobs.push(EffectJob { scene, bounds, drawn: Rect::new(bounds.x0, bounds.y0, bounds.x0, bounds.y0), sigma, kind, w, h, image: image.clone(), has_image });
        (image, at)
    }

    fn draw_job(&mut self, image: &ImageData, at: Affine) {
        let r = at.transform_rect_bbox(Rect::new(0.0, 0.0, f64::from(image.width), f64::from(image.height)));
        if let Some(j) = self.jobs.iter_mut().rev().find(|j| j.image.data.id() == image.data.id()) {
            j.drawn = if j.drawn.area() > 0.0 { j.drawn.union(r) } else { r };
        }
        self.scene.draw_image(&ImageBrush::new(image.clone()).with_quality(ImageQuality::Medium), at);
    }

    /// A layer at opacity 0 draws nothing, but its pictures stay wanted at the size they would draw: a drag lifts
    /// its layers out of the board at opacity 0, and a picture given back while it was lifted came back as nothing
    /// for a frame or two at the drop (a phone frame's screen flashed black).
    fn keep_images(&mut self, i: usize) {
        let n = self.doc.nodes.len();
        let mut inside = vec![false; n];
        inside[i] = true;
        let mut j = i;
        while j < n && (j == i || self.doc.nodes[j].parent.is_some_and(|q| inside[q])) {
            inside[j] = true;
            for f in &self.doc.nodes[j].fills {
                if let Paint::Image { url, .. } = f
                    && self.images.contains_key(url)
                {
                    let r = self.l.aabb[j];
                    let need = self.image_need.entry(url.clone()).or_insert(0.0);
                    *need = need.max(r.width().max(r.height()));
                    if !self.used_images.contains(url) {
                        self.used_images.push(url.clone());
                    }
                }
            }
            j += 1;
        }
    }

    fn paint_node(&mut self, i: usize) {
        let n = &self.doc.nodes[i];
        let opacity = n.opacity.map(|o| o.clamp(0.0, 1.0));
        if opacity == Some(0.0) {
            self.keep_images(i);
            return;
        }
        // Painting the node's own content into its blur job: its opacity wraps the blurred result instead, once.
        let blended = n.blend != Blend::Normal && self.unblurred != Some(i);
        let layered = (opacity.is_some_and(|o| o < 1.0) || blended) && self.unblurred != Some(i);
        if layered {
            let bounds = self.out_ink(i);
            self.push_layer(mix_of(n.blend), opacity.unwrap_or(1.0) as f32, Affine::IDENTITY, &bounds);
        }
        // `filter: blur()` on anything but the plain-box fast path: blur the rendered subtree.
        if let Some(sigma) = layer_blur_sigma(n).filter(|_| self.unblurred != Some(i)) {
            let prev = self.unblurred.replace(i);
            let sub = self.sub_scene(|p| p.paint(i));
            self.unblurred = prev;
            let bounds = self.out_ink(i);
            let (img, at) = self.job(JobScene::Own(sub), bounds, sigma, JobKind::Layer);
            self.draw_job(&img, at);
            if layered {
                self.pop();
            }
            return;
        }
        match n.kind {
            Kind::Frame | Kind::Rectangle => self.paint_box(i, false),
            Kind::Ellipse if simple_ellipse(n) => self.paint_box(i, true),
            Kind::Group => {
                let kids = n.children.clone();
                self.paint_kids(kids);
            }
            Kind::Ellipse | Kind::Polygon | Kind::Path => self.paint_vector(i),
            Kind::Text | Kind::Note | Kind::Prompt | Kind::Context => self.paint_text(i),
            Kind::Icon => self.paint_icon(i),
            Kind::Other => {
                let (w, h) = self.size(i);
                self.scene.fill(Fill::NonZero, self.l.world[i], PLACEHOLDER, None, &Rect::new(0.0, 0.0, w, h));
            }
        }
        if self.debug_boxes {
            let (w, h) = self.size(i);
            self.scene.stroke(&Stroke::new(1.0), self.l.world[i], Color::from_rgba8(255, 0, 170, 160), None, &Rect::new(0.0, 0.0, w, h));
        }
        if layered {
            self.pop();
        }
    }

    /// A parent's children in paint order. A child with `mask` (Use as mask) is not drawn itself: the
    /// siblings above it draw in a layer clipped to its ink, and its own picture cuts that layer by its alpha
    /// (DestIn). Several masks nest.
    fn paint_kids(&mut self, kids: Vec<usize>) {
        let mut masks: Vec<usize> = Vec::new();
        for c in kids {
            if self.doc.nodes[c].mask {
                let b = self.out_ink(c);
                self.push_layer(Mix::Normal, 1.0, Affine::IDENTITY, &b);
                masks.push(c);
                continue;
            }
            self.paint(c);
        }
        for m in masks.into_iter().rev() {
            let b = self.out_ink(m);
            self.push_layer(BlendMode::new(Mix::Normal, Compose::DestIn), 1.0, Affine::IDENTITY, &b);
            self.paint(m);
            self.pop();
            self.pop();
        }
    }

    fn paint_box(&mut self, i: usize, ellipse: bool) {
        let n = &self.doc.nodes[i];
        let xf = self.l.world[i];
        let (w, h) = self.size(i);
        let shape = BoxShape::new(w, h, n.corner, ellipse).smoothed(n.smoothing);
        let path = shape.path();

        // `backdrop-filter: blur()`: what is behind, before this box's own shadows.
        let backdrop = n.effects.iter().find_map(|e| if let Effect::BackgroundBlur { radius } = e { Some(*radius / 2.0) } else { None }).filter(|s| *s > 0.0);
        let behind = backdrop.map(|sigma| {
            let snap = if self.sub_depth == 0 {
                // The prefix ends on an item of the scene index, so the job can render only what meets it.
                self.cut();
                let mut pre = ScenePrefix::of(&self.scene, self.open);
                pre.items = self.index.mark();
                JobScene::Behind(pre)
            } else {
                // Inside a sub-scene (a blurred group): that scene is not the board's, so it is copied.
                let mut snap = self.scene.clone();
                for _ in 0..self.open {
                    snap.pop_layer();
                }
                JobScene::Own(snap)
            };
            (snap, sigma)
        });
        // Outer shadows: the first listed paints on top, so draw in reverse.
        for e in n.effects.iter().rev() {
            if let Effect::Shadow { inner: false, x, y, blur, spread, color } = *e {
                self.outer_shadow(xf, &shape, &path, x, y, blur, spread, color);
            }
        }
        if let Some((snap, sigma)) = behind {
            let bounds = xf.transform_rect_bbox(shape.rect).inflate(sigma * 3.0, sigma * 3.0);
            let (img, at) = self.job(snap, bounds, sigma, JobKind::Layer);
            self.push_clip(Fill::NonZero, xf, &path);
            self.draw_job(&img, at);
            self.pop();
        }
        // `filter: blur()` on a childless box with plain fills and one radius: vello's blurred rounded rect.
        let blur = n.effects.iter().find_map(|e| if let Effect::Blur { radius } = e { Some(*radius) } else { None }).filter(|r| *r > 0.0);
        let blur_fill = blur.filter(|_| blurred_rect_fast_path(n) && self.unblurred != Some(i));
        let fills = n.fills.clone();
        let blends = n.fill_blends.clone();
        let blend_at = |k: usize| blends.get(k).copied().unwrap_or_default();
        for (k, f) in fills.iter().enumerate() {
            if matches!(f, Paint::Image { .. } | Paint::Shader(_)) {
                continue;
            }
            // A paint's blend mode mixes it with what is drawn under it (CSS mix-blend-mode on its own layer).
            let mixed = blend_at(k) != Blend::Normal;
            if mixed {
                self.push_layer(mix_of(blend_at(k)), 1.0, xf, &path);
            }
            match f {
                Paint::Solid(c) => match blur_fill {
                    Some(r) => self.scene.draw_blurred_rounded_rect(xf, shape.rect, *c, shape.radii[0], r / 2.0),
                    None => self.scene.fill(Fill::NonZero, xf, *c, None, &path),
                },
                Paint::Gradient(g) => {
                    let (b, bt) = gradient_brush(g, w, h);
                    self.scene.fill(Fill::NonZero, xf, &b, Some(bt), &path);
                }
                Paint::Image { .. } | Paint::Shader(_) => {}
            }
            if mixed {
                self.pop();
            }
        }
        for e in &n.effects {
            if let Effect::Shadow { inner: true, x, y, blur, spread, color } = *e {
                self.inner_shadow(xf, &shape, &path, x, y, blur, spread, color);
            }
        }
        // Images and shader fills in list order, over the colours (html.ts draws both as layers above the background).
        for (k, f) in fills.iter().enumerate() {
            let mixed = blend_at(k) != Blend::Normal && matches!(f, Paint::Image { .. } | Paint::Shader(_));
            if mixed {
                self.push_layer(mix_of(blend_at(k)), 1.0, xf, &path);
            }
            match f {
                Paint::Image { url, fit, opacity, rot } => self.image(xf, &shape, &path, url, *fit, *opacity, *rot),
                Paint::Shader(sp) => self.shader_fill(i, xf, &shape, &path, sp),
                _ => {}
            }
            if mixed {
                self.pop();
            }
        }
        // Chrome paints a positioned element's own outline before its positioned children (every
        // html.ts node is positioned), so children cover a uniform stroke; it is not clipped.
        self.stroke_outline(i, &shape);
        let clip = n.clip && n.kind == Kind::Frame;
        if clip {
            self.push_clip(Fill::NonZero, xf, &path);
        }
        // Canvas stacking "First on top" reverses an auto layout frame's flow children.
        let kids = self.doc.paint_children(i);
        self.paint_kids(kids);
        self.stroke_overlay(i, &shape);
        if clip {
            self.pop();
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn outer_shadow(&mut self, xf: Affine, shape: &BoxShape, path: &BezPath, x: f64, y: f64, blur: f64, spread: f64, color: Color) {
        let s = shape.inflate(spread);
        let sigma = blur / 2.0;
        let reach = sigma * 3.0 + spread.abs() + x.abs().max(y.abs()) + 2.0;
        // A box-shadow never shows under its own box.
        let mut outside = shape.rect.inflate(reach, reach).to_path(0.1);
        outside.extend(path.iter());
        self.push_clip(Fill::EvenOdd, xf, &outside);
        let at = xf * Affine::translate((x, y));
        if sigma <= 0.0 {
            self.scene.fill(Fill::NonZero, at, color, None, &s.path());
        } else if s.analytic() {
            self.scene.draw_blurred_rounded_rect(at, s.rect, color, s.radii[0], sigma);
        } else {
            // Per-corner radii or an ellipse: blur the exact shape.
            let p = s.path();
            let sub = self.sub_scene(|q| q.scene.fill(Fill::NonZero, at, Color::BLACK, None, &p));
            let bounds = at.transform_rect_bbox(s.rect).inflate(sigma * 3.0, sigma * 3.0);
            let (img, ja) = self.job(JobScene::Own(sub), bounds, sigma * xf_scale(xf), JobKind::Tint(color));
            self.draw_job(&img, ja);
        }
        self.pop();
    }

    #[allow(clippy::too_many_arguments)]
    fn inner_shadow(&mut self, xf: Affine, shape: &BoxShape, path: &BezPath, x: f64, y: f64, blur: f64, spread: f64, color: Color) {
        let hole = shape.inflate(-spread);
        let sigma = blur / 2.0;
        let at = xf * Affine::translate((x, y));
        if sigma > 0.0 && !hole.analytic() {
            // Colour everywhere but the (offset) hole, blurred, inside the box.
            let big = shape.rect.inflate(sigma * 3.0 + x.abs().max(y.abs()) + 2.0, sigma * 3.0 + x.abs().max(y.abs()) + 2.0);
            let mut ring = big.to_path(0.1);
            ring.extend((Affine::translate((x, y)) * hole.path()).iter());
            let sub = self.sub_scene(|q| q.scene.fill(Fill::EvenOdd, xf, Color::BLACK, None, &ring));
            let bounds = xf.transform_rect_bbox(shape.rect).inflate(sigma * 3.0, sigma * 3.0);
            let (img, ja) = self.job(JobScene::Own(sub), bounds, sigma * xf_scale(xf), JobKind::Tint(color));
            self.push_clip(Fill::NonZero, xf, path);
            self.draw_job(&img, ja);
            self.pop();
            return;
        }
        self.push_layer(Mix::Normal, 1.0, xf, path);
        self.scene.fill(Fill::NonZero, xf, color, None, &shape.rect);
        let big = shape.rect.inflate(sigma * 3.0 + x.abs().max(y.abs()) + 2.0, sigma * 3.0 + x.abs().max(y.abs()) + 2.0);
        self.push_layer(BlendMode::new(Mix::Normal, Compose::DestOut), 1.0, xf, &big);
        if sigma > 0.0 {
            self.scene.draw_blurred_rounded_rect(at, hole.rect, Color::BLACK, hole.radii[0], sigma);
        } else {
            self.scene.fill(Fill::NonZero, at, Color::BLACK, None, &hole.path());
        }
        self.pop();
        self.pop();
    }

    /// A shader fill: its placeholder image stretched over the box, clipped to the shape. One shader per node renders
    /// (a second one in the same list draws the first one's frame): stacking two only paid for one that is covered.
    fn shader_fill(&mut self, i: usize, xf: Affine, shape: &BoxShape, path: &BezPath, sp: &std::rc::Rc<ShaderPaint>) {
        let (w, h) = (shape.rect.width(), shape.rect.height());
        if w <= 0.0 || h <= 0.0 || sp.opacity <= 0.0 {
            return;
        }
        let image = match self.fills.iter().find(|f| f.node == i) {
            Some(f) => f.image.clone(),
            None => {
                let (tw, th) = fill_tex_size(w, h);
                let image = gpu_image(tw, th, ImageAlphaType::AlphaPremultiplied);
                let rect = xf.transform_rect_bbox(shape.rect);
                let top = self.doc.nodes[i].fills.iter().rev().find_map(|f| if let Paint::Shader(s) = f { Some(s.clone()) } else { None }).unwrap_or_else(|| sp.clone());
                self.fills.push(FillUse { node: i, id: self.doc.nodes[i].id.clone(), image: image.clone(), w, h, rect, shader: top });
                image
            }
        };
        let fit = Affine::scale_non_uniform(w / f64::from(image.width), h / f64::from(image.height));
        let brush = ImageBrush::new(image).with_alpha(sp.opacity).with_quality(ImageQuality::Medium);
        self.scene.fill(Fill::NonZero, xf, &brush, Some(Affine::translate((shape.rect.x0, shape.rect.y0)) * fit), path);
    }

    #[allow(clippy::too_many_arguments)]
    fn image(&mut self, xf: Affine, shape: &BoxShape, path: &BezPath, url: &str, fit: ImageFit, opacity: f32, rot: u8) {
        if !self.used_images.iter().any(|u| u == url) {
            self.used_images.push(url.to_string());
        }
        let Some(bi) = self.images.get(url) else { return };
        let (w, h) = (shape.rect.width(), shape.rect.height());
        let (iw, ih) = (f64::from(bi.w), f64::from(bi.h));
        if iw <= 0.0 || ih <= 0.0 || w <= 0.0 || h <= 0.0 {
            return;
        }
        let places = image_places(fit, rot, w, h, iw, ih);
        let n = places.len();
        // Tile copies past the first share one clip and one opacity layer: drawn as one image each.
        if n > 1 {
            let square = shape.rect.to_path(0.1);
            self.push_layer(Mix::Normal, opacity.clamp(0.0, 1.0), xf, if shape.rounded() { path } else { &square });
            for at in places {
                self.image_at(xf, shape, path, url, at, 1.0);
            }
            self.pop();
            return;
        }
        if let Some(at) = places.into_iter().next() {
            self.image_at(xf, shape, path, url, at, opacity);
        }
    }

    /// One copy of an image: `at` maps the image's own px into the layer's box.
    fn image_at(&mut self, xf: Affine, shape: &BoxShape, path: &BezPath, url: &str, at: Affine, opacity: f32) {
        let Some(bi) = self.images.get(url) else { return };
        let (iw, ih) = (f64::from(bi.w), f64::from(bi.h));
        // The drawn long side in board units: × the tile scale it is the texel density needed.
        let drawn = at.transform_rect_bbox(Rect::new(0.0, 0.0, iw, ih));
        let shown = drawn.width().max(drawn.height()) * xf_scale(xf);
        let need = self.image_need.entry(url.to_string()).or_insert(0.0);
        *need = need.max(shown);
        // The image's own px to board space.
        let to_img = xf * at;
        let places = self.image_places.entry(url.to_string()).or_default();
        let pick = bi.picks.get(places.len()).and_then(Option::as_ref);
        places.push(ImagePlace { to_board: to_img, clip: xf.transform_rect_bbox(shape.rect), shown, tileable: self.sub_depth == 0 });
        let square = shape.rect.to_path(0.1);
        // Bilinear (Medium): exact at 1:1, where vello's High (a Mitchell filter, which does not pass through
        // its samples) turned each pixel into 1/18 + 16/18 + 1/18 of its neighbours and softened every screenshot
        // shown at its own resolution. Minified, the mip level is never more than 2x the drawn size.
        let opacity = opacity.clamp(0.0, 1.0);
        let tiles = bi.tiles.as_ref().filter(|t| pick.is_none() && self.sub_depth == 0 && t.data.iter().all(Option::is_some) && t.data.len() as u64 == t.cells.count());
        let whole = pick.or(bi.data.as_ref());
        if tiles.is_none() && whole.is_none() {
            return;
        }
        // Tiles overlap each other and the whole level by a level px. With the fill's opacity on every piece the
        // overlaps blended twice: a grid of darker lines every 512 level px on a translucent photo. The pieces
        // are assembled opaque inside one layer, and the layer carries the opacity once.
        let grouped = tiles.is_some() && opacity < 1.0;
        let brush_of = |img: &ImageData| ImageBrush::new(img.clone()).with_alpha(if grouped { 1.0 } else { opacity }).with_quality(ImageQuality::Medium);
        if grouped {
            self.push_layer(Mix::Normal, opacity, xf, if shape.rounded() { path } else { &square });
        } else {
            self.push_clip(Fill::NonZero, xf, if shape.rounded() { path } else { &square });
        }
        if let Some(t) = tiles {
            // Tiles of a larger level over part of the image, the whole level around them. Neighbours overlap
            // by a level px (at least half a device px at the scale the level was picked for): two edges that
            // only meet let what is underneath through where they cross a pixel.
            let (kx, ky) = (iw / f64::from(t.lw), ih / f64::from(t.lh));
            let c = t.cells;
            let (bx0, by0, _, _) = cell_rect(t.lw, t.lh, c.x0, c.y0);
            let (lx, ly, lcw, lch) = cell_rect(t.lw, t.lh, c.x1 - 1, c.y1 - 1);
            let (bx1, by1) = (lx + lcw, ly + lch);
            let all = (bx0, by0, bx1, by1) == (0, 0, t.lw, t.lh);
            if let (Some(base), false) = (whole, all) {
                // The whole level, with a hole where the tiles are (a level px smaller on the sides that have a neighbour).
                let inset = |v: u32, edge: u32, d: f64| if v == edge { f64::from(v) } else { f64::from(v) + d };
                let hole = Rect::new(inset(bx0, 0, 1.0) * kx, inset(by0, 0, 1.0) * ky, inset(bx1, t.lw, -1.0) * kx, inset(by1, t.lh, -1.0) * ky);
                let mut around = Rect::new(0.0, 0.0, iw, ih).to_path(0.1);
                around.extend(hole.to_path(0.1));
                let fit = Affine::scale_non_uniform(iw / f64::from(base.width), ih / f64::from(base.height));
                self.scene.fill(Fill::EvenOdd, to_img, &brush_of(base), Some(fit), &around);
            }
            for ((tx, ty), img) in c.iter().zip(&t.data) {
                let Some(img) = img else { continue };
                let (x, y, w, h) = cell_rect(t.lw, t.lh, tx, ty);
                let (sx0, sy0, _, _) = cell_src(t.lw, t.lh, tx, ty);
                // One level px past its own rectangle (the texture holds APRON of them), never past the image.
                let grow = f64::from(APRON) - 1.0;
                let r = Rect::new((f64::from(x) - grow).max(0.0) * kx, (f64::from(y) - grow).max(0.0) * ky, (f64::from(x + w) + grow).min(f64::from(t.lw)) * kx, (f64::from(y + h) + grow).min(f64::from(t.lh)) * ky);
                let at = Affine::translate((f64::from(sx0) * kx, f64::from(sy0) * ky)) * Affine::scale_non_uniform(kx, ky);
                self.scene.fill(Fill::NonZero, to_img, &brush_of(img), Some(at), &r);
            }
        } else if let Some(img) = whole {
            self.scene.draw_image(&brush_of(img), to_img * Affine::scale_non_uniform(iw / f64::from(img.width), ih / f64::from(img.height)));
        }
        self.pop();
    }

    /// Gradient strokes and per-side widths: html.ts draws a masked overlay div.
    fn stroke_overlay(&mut self, i: usize, shape: &BoxShape) {
        let n = &self.doc.nodes[i];
        let Some(sw) = n.stroke_width else { return };
        let Some(first) = n.strokes.first() else { return };
        let solid = matches!(first, Paint::Solid(_));
        let uniform = matches!(sw, StrokeWidth::Uniform(_));
        if uniform && solid {
            return;
        }
        let side = |k: usize| match sw {
            StrokeWidth::Uniform(w) => w,
            StrokeWidth::Sides(s) => s[k],
        };
        let out = |k: usize| match n.stroke_align {
            StrokeAlign::Inner => 0.0,
            StrokeAlign::Center => side(k) / 2.0,
            StrokeAlign::Outer => side(k),
        };
        // top, right, bottom, left
        let r = shape.rect;
        let outer = Rect::new(r.x0 - out(3), r.y0 - out(0), r.x1 + out(1), r.y1 + out(2));
        let inner = Rect::new(outer.x0 + side(3), outer.y0 + side(0), outer.x1 - side(1), outer.y1 - side(2));
        let o = BoxShape { rect: outer, radii: if shape.ellipse { [0.0; 4] } else { css_radii(shape.radii, outer.width(), outer.height()) }, ellipse: shape.ellipse, smooth: shape.smooth };
        let mut p = o.path();
        if inner.width() > 0.0 && inner.height() > 0.0 {
            // The mask's content box keeps CSS inner radii: each corner's radius minus the larger
            // of its two adjacent widths (exact for uniform widths, circular otherwise).
            let [tl, tr, br, bl] = o.radii;
            let ir = [(tl - side(0).max(side(3))).max(0.0), (tr - side(0).max(side(1))).max(0.0), (br - side(2).max(side(1))).max(0.0), (bl - side(2).max(side(3))).max(0.0)];
            let hole = BoxShape { rect: inner, radii: if o.ellipse { [0.0; 4] } else { css_radii(ir, inner.width(), inner.height()) }, ellipse: o.ellipse, smooth: o.smooth };
            p.extend(hole.path().iter());
        }
        let xf = self.l.world[i];
        match first {
            Paint::Gradient(g) => {
                let (b, bt) = gradient_brush(g, outer.width(), outer.height());
                self.scene.fill(Fill::EvenOdd, xf, &b, Some(Affine::translate((outer.x0, outer.y0)) * bt), &p);
            }
            _ => {
                if let Some(c) = first_color(&n.strokes) {
                    self.scene.fill(Fill::EvenOdd, xf, c, None, &p);
                }
            }
        }
    }

    /// Uniform solid strokes: CSS `outline` with `outline-offset` -w (inner), -w/2 (center), 0 (outer).
    fn stroke_outline(&mut self, i: usize, shape: &BoxShape) {
        let n = &self.doc.nodes[i];
        let Some(StrokeWidth::Uniform(w)) = n.stroke_width else { return };
        if w <= 0.0 {
            return;
        }
        let Some(Paint::Solid(c)) = n.strokes.first() else { return };
        let offset = match n.stroke_align {
            StrokeAlign::Inner => -w,
            StrokeAlign::Center => -w / 2.0,
            StrokeAlign::Outer => 0.0,
        };
        let centre = shape.inflate(offset + w / 2.0);
        self.scene.stroke(&Stroke::new(w), self.l.world[i], *c, None, &centre.path());
    }

    /// `filter: drop-shadow(x y blur/2 colour)` on text, paths and icons: σ = blur / 2 (the
    /// filter's argument is the standard deviation; at blur / 4 these shadows were half as soft as Chrome's). `draw`
    /// paints the node's silhouette with a transform (board ← node) and a colour.
    fn drop_shadows(&mut self, i: usize, draw: &mut dyn FnMut(&mut Scene, Affine, Color)) {
        let n = &self.doc.nodes[i];
        let xf = self.l.world[i];
        let own = self.own_ink[i];
        let effects = n.effects.clone();
        let mut mask: Option<(ImageData, Affine, f64)> = None;
        for e in effects.iter().rev() {
            let Effect::Shadow { inner: false, x, y, blur, color, .. } = *e else { continue };
            let off = Affine::translate(xf.transform_vector_bbox((x, y)));
            let sigma = blur / 2.0 * xf_scale(xf);
            if sigma <= 0.0 {
                draw(&mut self.scene, off * xf, color);
                continue;
            }
            // One mask per sigma, tinted per shadow.
            if mask.as_ref().is_none_or(|m| (m.2 - sigma).abs() > 1e-9) {
                let sub = self.sub_scene(|p| draw(&mut p.scene, xf, Color::BLACK));
                let (img, at) = self.job(JobScene::Own(sub), own.inflate(sigma * 3.0, sigma * 3.0), sigma, JobKind::Layer);
                mask = Some((img, at, sigma));
            }
            let (img, at, _) = mask.clone().expect("set above");
            // Colour × mask alpha: the mask layer, then the colour composited `SrcIn`.
            let b = (off * at).transform_rect_bbox(Rect::new(0.0, 0.0, f64::from(img.width), f64::from(img.height)));
            self.push_layer(Mix::Normal, 1.0, Affine::IDENTITY, &b);
            self.draw_job(&img, off * at);
            self.push_layer(BlendMode::new(Mix::Normal, Compose::SrcIn), 1.0, Affine::IDENTITY, &b);
            self.scene.fill(Fill::NonZero, Affine::IDENTITY, color, None, &b);
            self.pop();
            self.pop();
        }
    }

    fn paint_vector(&mut self, i: usize) {
        let n = &self.doc.nodes[i];
        let Some((path, even_odd)) = self.vector_path(i) else { return };
        let fill = first_color(&n.fills);
        let stroke = match (first_color(&n.strokes), n.stroke_width) {
            (Some(c), Some(StrokeWidth::Uniform(w))) if w > 0.0 => Some((c, Stroke::new(w).with_caps(cap_of(n.cap.as_deref())).with_join(join_of(n.join.as_deref())).with_miter_limit(4.0))),
            _ => None,
        };
        let rule = if even_odd { Fill::EvenOdd } else { Fill::NonZero };
        let xf = self.l.world[i];
        if n.effects.iter().any(|e| matches!(e, Effect::Shadow { inner: false, .. })) {
            let (p2, st) = (path.clone(), stroke.clone());
            self.drop_shadows(i, &mut |s, at, col| {
                if fill.is_some() {
                    s.fill(rule, at, col, None, &p2);
                }
                if let Some((_, st)) = &st {
                    s.stroke(st, at, col, None, &p2);
                }
            });
        }
        if let Some(c) = fill {
            self.scene.fill(rule, xf, c, None, &path);
        }
        if let Some((c, st)) = stroke {
            self.scene.stroke(&st, xf, c, None, &path);
        }
    }

    fn paint_icon(&mut self, i: usize) {
        let n = &self.doc.nodes[i];
        let Some(icon) = n.icon.as_ref() else { return };
        let (w, h) = self.size(i);
        let color = first_color(&n.fills).unwrap_or(Color::BLACK);
        // viewBox 0 0 size size, preserveAspectRatio xMidYMid meet (and mask-size: contain).
        let s = if icon.size > 0.0 { (w / icon.size).min(h / icon.size) } else { 1.0 };
        let t = self.l.world[i] * Affine::translate(((w - icon.size * s) / 2.0, (h - icon.size * s) / 2.0)) * Affine::scale(s);
        let shapes: Vec<IconPaint> = icon
            .shapes
            .iter()
            .map(|sh| {
                let p = parse_svg_path(&sh.d);
                let pick = |p: Option<Option<Color>>| p.map(|c| if icon.mask { color } else { c.unwrap_or(color) });
                let fill = pick(sh.fill);
                let stroke = pick(sh.stroke).map(|c| (c, Stroke::new(sh.stroke_width).with_caps(cap_of(sh.cap.as_deref())).with_join(join_of(sh.join.as_deref())).with_miter_limit(4.0)));
                (p, fill, stroke, if sh.even_odd { Fill::EvenOdd } else { Fill::NonZero })
            })
            .collect();
        if n.effects.iter().any(|e| matches!(e, Effect::Shadow { inner: false, .. })) {
            let rel = self.l.world[i].inverse() * t;
            self.drop_shadows(i, &mut |sc, at, col| {
                for (p, f, st, rule) in &shapes {
                    if f.is_some() {
                        sc.fill(*rule, at * rel, col, None, p);
                    }
                    if let Some((_, st)) = st {
                        sc.stroke(st, at * rel, col, None, p);
                    }
                }
            });
        }
        for (p, f, st, rule) in &shapes {
            if let Some(c) = f {
                self.scene.fill(*rule, t, *c, None, p);
            }
            if let Some((c, st)) = st {
                self.scene.stroke(st, t, *c, None, p);
            }
        }
    }

    fn paint_text(&mut self, i: usize) {
        let n = &self.doc.nodes[i];
        let xf = self.l.world[i];
        let (w, h) = self.size(i);
        let texty_bg = match n.kind {
            Kind::Note => Some(NOTE_BG),
            Kind::Prompt | Kind::Context => Some(PROMPT_BG),
            _ => None,
        };
        if let Some(bg) = texty_bg {
            self.scene.fill(Fill::NonZero, xf, bg, None, &Rect::new(0.0, 0.0, w, h));
        }
        let Some(tb) = self.l.texts.get(i).and_then(Option::as_ref) else { return };
        let Some(layout) = tb.layout.as_ref() else { return };
        let (ox, oy) = self.l.text_origin[i];
        // Text colour: a gradient fill clips the gradient (over the box) to the glyphs.
        let (brush, brush_xf): (Brush, Option<Affine>) = if texty_bg.is_some() {
            (Brush::Solid(NOTE_FG), None)
        } else if let Some(Paint::Gradient(g)) = n.fills.iter().find(|p| matches!(p, Paint::Gradient(_))) {
            let (b, bt) = gradient_brush(g, w, h);
            (b, Some(Affine::translate((-ox, -oy)) * bt))
        } else {
            (Brush::Solid(first_color(&n.fills).unwrap_or(Color::BLACK)), None)
        };
        let stroke = match (n.kind, first_color(&n.strokes), n.stroke_width) {
            (Kind::Text, Some(c), Some(StrokeWidth::Uniform(sw))) if sw > 0.0 => Some((c, sw)),
            _ => None,
        };
        // Underline and strikethrough are in each run's style (the layer's, or a styled range's own).
        let style = RunStyle { stroke, own_ink: true };
        // List markers (bullets, numbers) beside their items' first lines, in the layer's colour.
        let marks = tb.marks();
        if n.effects.iter().any(|e| matches!(e, Effect::Shadow { inner: false, .. })) {
            let shadow = RunStyle { stroke, own_ink: false };
            self.drop_shadows(i, &mut |sc, t, col| {
                draw_runs(sc, layout, t * Affine::translate((ox, oy)), &Brush::Solid(col), None, &shadow);
                for (ml, mx, my) in &marks {
                    draw_runs(sc, ml, t * Affine::translate((ox + mx, oy + my)), &Brush::Solid(col), None, &shadow);
                }
            });
        }
        draw_runs(&mut self.scene, layout, xf * Affine::translate((ox, oy)), &brush, brush_xf, &style);
        for (ml, mx, my) in &marks {
            let bxf = brush_xf.map(|b| Affine::translate((-mx, -my)) * b);
            draw_runs(&mut self.scene, ml, xf * Affine::translate((ox + mx, oy + my)), &brush, bxf, &style);
        }
    }
}

struct RunStyle {
    stroke: Option<(Color, f64)>,
    /// A styled range's own colour wins over `brush` (false for a shadow: every run in the shadow's colour).
    own_ink: bool,
}

/// Every glyph run of a laid-out text at `at` (board ← text origin), with decorations.
fn draw_runs(scene: &mut Scene, layout: &parley::Layout<Ink>, at: Affine, layer_brush: &Brush, layer_xf: Option<Affine>, st: &RunStyle) {
    for line in layout.lines() {
        for item in line.items() {
            let parley::PositionedLayoutItem::GlyphRun(gr) = item else { continue };
            let rs = gr.style();
            let own = if st.own_ink { rs.brush.0.map(|c| Brush::Solid(Color::new(c))) } else { None };
            let (brush, brush_xf) = match &own {
                Some(b) => (b, None),
                None => (layer_brush, layer_xf),
            };
            let (underline_on, strike_on) = (rs.underline.is_some(), rs.strikethrough.is_some());
            let run = gr.run();
            let font = run.font();
            let size = run.font_size();
            let coords: Vec<i16> = run.normalized_coords().iter().map(|c| c.to_bits()).collect();
            let synth = run.synthesis();
            let skew = synth.skew().map(|deg| Affine::skew(f64::from(deg).to_radians().tan(), 0.0));
            // Synthetic bold (size / 48 a side, like Chrome's FreeType-style emboldening). The macOS smoothing
            // dilation is a device-px amount: each render adds it (`smooth_glyphs`).
            let grow = if synth.embolden() { f64::from(size) / 48.0 } else { 0.0 };
            let embolden = (grow > 0.0).then(|| FontEmbolden::new(kurbo::Diagonal2::new(grow, grow)));
            let glyphs: Vec<Glyph> = gr.positioned_glyphs().map(|g| Glyph { id: g.id, x: g.x, y: g.y }).collect();
            let draw = |scene: &mut Scene, brush: &Brush, bxf: Option<Affine>, style: Option<&Stroke>| {
                let mut d = scene.draw_glyphs(font).font_size(size).transform(at).normalized_coords(&coords).hint(false).brush(brush).glyph_transform(skew).brush_transform(bxf);
                if let Some(e) = embolden {
                    d = d.font_embolden(e);
                }
                match style {
                    Some(s) => d.draw(s, glyphs.iter().copied()),
                    None => d.draw(Fill::NonZero, glyphs.iter().copied()),
                }
            };
            draw(scene, brush, brush_xf, None);
            if let Some((c, sw)) = st.stroke {
                draw(scene, &Brush::Solid(c), None, Some(&Stroke::new(sw)));
            }
            if underline_on || strike_on {
                let m = run.font_metrics();
                let x0 = f64::from(gr.offset());
                let x1 = x0 + f64::from(gr.advance());
                let base = f64::from(gr.baseline());
                let (under, strike, thick) = decoration_lines(f64::from(size), f64::from(m.ascent));
                for (on, top) in [(underline_on, under), (strike_on, strike)] {
                    if on {
                        scene.fill(Fill::NonZero, at, brush, brush_xf, &Rect::new(x0, base + top, x1, base + top + thick));
                    }
                }
            }
        }
    }
}

/// Where Chrome draws `text-decoration` lines for a font of `size` px with `ascent` px above the baseline:
/// the top of the underline and of the line-through, relative to the baseline (down is positive), and their
/// thickness. Blink ignores the font's own underline metrics for `auto`: thickness is a tenth of the font
/// size (at least 1 px, whole px), the underline sits a gap of half the thickness (rounded up, at least 1 px)
/// below the baseline, and the line-through is centred a third of the ascent above it. The font's metrics
/// put Inter's underline 1.9 px lower and a quarter thinner (golden text-decoration).
pub fn decoration_lines(size: f64, ascent: f64) -> (f64, f64, f64) {
    let auto = (size / 10.0).max(1.0);
    let thick = auto.round().max(1.0);
    let gap = (auto / 2.0).ceil().max(1.0);
    (gap, -(ascent.round() / 3.0) - thick / 2.0, thick)
}

/// Uniform scale of an affine's linear part (sqrt |det|).
fn xf_scale(a: Affine) -> f64 {
    let c = a.as_coeffs();
    (c[0] * c[3] - c[1] * c[2]).abs().sqrt()
}

/// `filter: blur()` that vello's analytic blurred rounded rect draws exactly: a childless box with
/// plain colour fills and one corner radius.
fn blurred_rect_fast_path(n: &Node) -> bool {
    // Off: the analytic blurred rectangle is an approximation that is weakest at the corners, which a layer
    // blur shows (golden blur-layer: corners squarer than Chrome's). Such boxes go through a blur job like
    // everything else. Box shadows keep the analytic path: the box covers their corners.
    const ANALYTIC_LAYER_BLUR: bool = false;
    ANALYTIC_LAYER_BLUR
        && matches!(n.kind, Kind::Frame | Kind::Rectangle)
        && n.children.is_empty()
        && n.fills.iter().all(|f| matches!(f, Paint::Solid(_)))
        && n.strokes.is_empty()
        && n.effects.iter().all(|e| matches!(e, Effect::Blur { .. }))
        && n.corner.is_none_or(|c| c.iter().all(|r| (r - c[0]).abs() < 1e-9))
}

trait VecBBox {
    fn transform_vector_bbox(&self, v: (f64, f64)) -> kurbo::Vec2;
}

impl VecBBox for Affine {
    /// A shadow offset is in the node's local px; map it through the linear part only.
    fn transform_vector_bbox(&self, v: (f64, f64)) -> kurbo::Vec2 {
        let c = self.as_coeffs();
        kurbo::Vec2::new(c[0] * v.0 + c[2] * v.1, c[1] * v.0 + c[3] * v.1)
    }
}

/// Atlas pixels one board's effect textures may take together. vello allocates every image a scene draws
/// in its atlas (8192 x 8192 at most) for each tile, the effect placeholders too, and silently leaves out
/// what does not fit: with `images::ATLAS_PX` for the board's images this keeps one render within the atlas.
pub const JOB_ATLAS_PX: u64 = 16_000_000;

/// Atlas pixels of a board's effect textures.
pub fn job_px(jobs: &[EffectJob]) -> u64 {
    jobs.iter().map(|j| u64::from(j.w) * u64::from(j.h)).sum()
}

/// Encode one board. Effect textures are drawn at a lower resolution when together they would not fit
/// `JOB_ATLAS_PX` (a softer blur rather than missing shadows).
pub fn paint_board(doc: &Doc, l: &LayoutResult, o: &PaintOptions) -> Painted {
    let mut scale = 1.0;
    let mut p = paint_board_at(doc, l, o, scale);
    for _ in 0..4 {
        let px = job_px(&p.jobs);
        if px <= JOB_ATLAS_PX {
            break;
        }
        scale *= (JOB_ATLAS_PX as f64 / px as f64).sqrt() * 0.95;
        p = paint_board_at(doc, l, o, scale);
    }
    p
}

fn paint_board_at(doc: &Doc, l: &LayoutResult, o: &PaintOptions, job_scale: f64) -> Painted {
    let n = doc.nodes.len();
    let mut p = Painter {
        doc,
        l,
        images: o.images,
        scene: Scene::new(),
        own_ink: vec![Rect::ZERO; n],
        sub_ink: vec![Rect::ZERO; n],
        used_images: Vec::new(),
        image_need: HashMap::new(),
        image_places: HashMap::new(),
        debug_boxes: o.debug_boxes,
        reuse: o.reuse,
        jobs: Vec::new(),
        open: 0,
        unblurred: None,
        fills: Vec::new(),
        job_scale,
        sub_depth: 0,
        index: crate::cull::Builder::new(),
        owner: 0,
    };
    for i in 0..n {
        p.own_ink[i] = p.compute_own_ink(i);
        p.sub_ink[i] = p.own_ink[i];
    }
    // Children come after their parent in pre-order, so a reverse sweep folds subtrees upward (each subtree
    // complete, so its layer blur's halo goes around all of it).
    for i in (1..n).rev() {
        if let Some(par) = doc.nodes[i].parent {
            let mut child = p.out_ink(i);
            if doc.nodes[par].clip && doc.nodes[par].kind == Kind::Frame {
                child = child.intersect(l.aabb[par]);
                if child.width() <= 0.0 || child.height() <= 0.0 {
                    continue;
                }
            }
            p.sub_ink[par] = union(p.sub_ink[par], child);
        }
    }
    if n > 0 {
        p.paint(0);
    }
    let ink = if n > 0 { p.out_ink(0) } else { Rect::ZERO };
    let node_ink: Vec<Rect> = (0..n).map(|i| union(p.out_ink(i), p.item_bounds(i))).collect();
    let mut scene = p.scene;
    shrink(&mut scene);
    let mut jobs = p.jobs;
    for j in &mut jobs {
        if let JobScene::Own(s) = &mut j.scene {
            shrink(s);
        }
    }
    let index = p.index.finish(&scene);
    Painted { scene, ink, images: p.used_images, image_need: p.image_need, image_places: p.image_places, jobs, index, node_ink, fills: p.fills }
}

/// Encodings grow by doubling; a board keeps its scene for its lifetime, so give the slack back.
pub fn shrink(scene: &mut Scene) {
    let e = scene.encoding_mut();
    e.path_tags.shrink_to_fit();
    e.path_data.shrink_to_fit();
    e.draw_tags.shrink_to_fit();
    e.draw_data.shrink_to_fit();
    e.transforms.shrink_to_fit();
    e.styles.shrink_to_fit();
    e.resources.patches.shrink_to_fit();
    e.resources.color_stops.shrink_to_fit();
    e.resources.glyphs.shrink_to_fit();
    e.resources.glyph_runs.shrink_to_fit();
    e.resources.normalized_coords.shrink_to_fit();
}

/// Bytes a scene's encoding holds (its vectors' capacities).
pub fn scene_bytes(scene: &Scene) -> usize {
    use std::mem::size_of_val;
    let e = scene.encoding();
    let cap = |n: usize, one: usize| n * one;
    cap(e.path_tags.capacity(), e.path_tags.first().map_or(1, size_of_val))
        + e.path_data.capacity() * 4
        + cap(e.draw_tags.capacity(), e.draw_tags.first().map_or(4, size_of_val))
        + e.draw_data.capacity() * 4
        + cap(e.transforms.capacity(), e.transforms.first().map_or(24, size_of_val))
        + cap(e.styles.capacity(), e.styles.first().map_or(8, size_of_val))
        + cap(e.resources.patches.capacity(), e.resources.patches.first().map_or(64, size_of_val))
        + cap(e.resources.color_stops.capacity(), e.resources.color_stops.first().map_or(20, size_of_val))
        + cap(e.resources.glyphs.capacity(), e.resources.glyphs.first().map_or(12, size_of_val))
        + cap(e.resources.glyph_runs.capacity(), e.resources.glyph_runs.first().map_or(160, size_of_val))
        + e.resources.normalized_coords.capacity() * 2
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::layout_doc;
    use crate::text::TextSystem;
    use serde_json::json;

    #[test]
    fn css_radius_clamping_scales_all_corners_together() {
        assert_eq!(css_radii([50.0, 50.0, 0.0, 0.0], 60.0, 200.0), [30.0, 30.0, 0.0, 0.0]);
        assert_eq!(css_radii([4.0; 4], 100.0, 100.0), [4.0; 4]);
    }

    #[test]
    fn linear_gradient_angle_follows_css() {
        let g = Gradient { kind: GradientKind::Linear, stops: vec![(0.0, Color::BLACK), (1.0, Color::WHITE)], center: (0.5, 0.5), size: (1.0, 1.0), rotation: 0.0 };
        let (Brush::Gradient(b), _) = gradient_brush(&g, 100.0, 50.0) else { panic!() };
        let peniko::GradientKind::Linear(pos) = b.kind else { panic!() };
        // 0deg: bottom to top across the full height.
        assert_eq!((pos.start, pos.end), (Point::new(50.0, 50.0), Point::new(50.0, 0.0)));
        let g90 = Gradient { rotation: -90.0, ..g };
        let (Brush::Gradient(b), _) = gradient_brush(&g90, 100.0, 50.0) else { panic!() };
        let peniko::GradientKind::Linear(pos) = b.kind else { panic!() };
        assert!((pos.start.x - 0.0).abs() < 1e-9 && (pos.end.x - 100.0).abs() < 1e-9, "90deg runs left to right");
    }

    #[test]
    fn ink_covers_shadows_and_outer_strokes_and_clip_trims_children() {
        let doc = Doc::from_value(&json!({ "type": "frame", "id": "r", "width": 100, "height": 100, "layout": "none", "clip": true,
            "stroke": "#000000", "strokeWidth": 4, "strokeAlignment": "outer",
            "effect": { "type": "shadow", "offset": { "x": 0, "y": 10 }, "blur": 20 },
            "children": [{ "type": "rectangle", "id": "big", "x": -50, "y": -50, "width": 400, "height": 400, "fill": "#FF0000" }] }))
        .unwrap();
        let l = layout_doc(&doc, &mut TextSystem::new());
        let p = paint_board(&doc, &l, &PaintOptions { images: &ImageStore::new(), debug_boxes: false, reuse: None });
        assert!(p.ink.x0 <= -40.0 && p.ink.y1 >= 140.0, "{:?}", p.ink);
        assert!(p.ink.x1 < 200.0, "clipped child does not widen the ink: {:?}", p.ink);
    }

    /// Codex hunt 2 follow-up: a shadow mask drawn at its offset records where it lands, so the tile there
    /// renders it (the mask's own rect can lie in another tile).
    #[test]
    fn shadow_jobs_know_where_they_are_drawn() {
        let doc = Doc::from_value(&json!({ "type": "frame", "id": "f", "width": 400, "height": 600, "layout": "none", "children": [
            { "type": "path", "id": "p", "x": 0, "y": 0, "width": 50, "height": 50, "geometry": "M0 0 L50 0 L50 50 Z", "fill": "#000000",
              "effect": { "type": "shadow", "offset": { "x": 0, "y": 300 }, "blur": 8 } }] }))
        .unwrap();
        let l = layout_doc(&doc, &mut TextSystem::new());
        let p = paint_board(&doc, &l, &PaintOptions { images: &ImageStore::new(), debug_boxes: false, reuse: None });
        assert!(!p.jobs.is_empty(), "the path shadow is a blur job");
        let j = &p.jobs[0];
        assert!((j.drawn.y0 - j.bounds.y0 - 300.0).abs() < 1e-6, "drawn 300 below: {:?} {:?}", j.bounds, j.drawn);
        // A tile below the mask's own rect, where the shadow lands.
        let tile = Rect::new(0.0, j.bounds.y1 + 10.0, 400.0, j.bounds.y1 + 200.0);
        assert_eq!(crate::cache::jobs_needed(&[(j.drawn, j.bounds)], tile), vec![0]);
    }

    /// Codex hunt 3 (engine 1): vello places every effect texture of a board in its atlas for each tile and
    /// silently drops what does not fit, so a board's effect textures together stay within `JOB_ATLAS_PX`.
    #[test]
    fn many_large_shadows_fit_the_atlas_together() {
        let paths: Vec<_> = (0..12).map(|i| json!({ "type": "path", "id": format!("p{i}"), "x": (i % 4) * 1100, "y": (i / 4) * 1100, "width": 1000, "height": 1000,
            "geometry": "M0 0 L1000 0 L1000 1000 Z", "fill": "#000000", "effect": { "type": "shadow", "offset": { "x": 0, "y": 4 }, "blur": 2 } })).collect();
        let doc = Doc::from_value(&json!({ "type": "frame", "id": "f", "width": 4400, "height": 3300, "layout": "none", "children": paths })).unwrap();
        let l = layout_doc(&doc, &mut TextSystem::new());
        let p = paint_board(&doc, &l, &PaintOptions { images: &ImageStore::new(), debug_boxes: false, reuse: None });
        assert_eq!(p.jobs.len(), 12);
        let unscaled: u64 = p.jobs.iter().map(|j| { let q = job_resolution(j.bounds, j.sigma); ((j.bounds.width() * q).ceil() * (j.bounds.height() * q).ceil()) as u64 }).sum();
        assert!(unscaled > JOB_ATLAS_PX, "the case needs more than the budget at full resolution: {unscaled}");
        assert!(job_px(&p.jobs) <= JOB_ATLAS_PX, "{} > {JOB_ATLAS_PX}", job_px(&p.jobs));
        assert!(job_px(&p.jobs) > JOB_ATLAS_PX / 2, "not lowered further than needed: {}", job_px(&p.jobs));
        // A board well within the budget keeps full resolution.
        let one = Doc::from_value(&json!({ "type": "frame", "id": "g", "width": 1200, "height": 1200, "layout": "none", "children": [
            { "type": "path", "id": "q", "x": 0, "y": 0, "width": 1000, "height": 1000, "geometry": "M0 0 L1000 0 L1000 1000 Z", "fill": "#000000",
              "effect": { "type": "shadow", "offset": { "x": 0, "y": 4 }, "blur": 2 } }] })).unwrap();
        let l1 = layout_doc(&one, &mut TextSystem::new());
        let p1 = paint_board(&one, &l1, &PaintOptions { images: &ImageStore::new(), debug_boxes: false, reuse: None });
        let j = &p1.jobs[0];
        let q = job_resolution(j.bounds, j.sigma);
        assert_eq!((j.w, j.h), ((j.bounds.width() * q).ceil() as u32, (j.bounds.height() * q).ceil() as u32));
    }

    fn painted(v: serde_json::Value) -> (Doc, LayoutResult, Painted) {
        let doc = Doc::from_value(&v).unwrap();
        let l = layout_doc(&doc, &mut TextSystem::new());
        let p = paint_board(&doc, &l, &PaintOptions { images: &ImageStore::new(), debug_boxes: false, reuse: None });
        (doc, l, p)
    }

    /// Layers (and clips) a scene opens.
    fn layers(s: &Scene) -> usize {
        s.encoding().draw_tags.iter().filter(|t| **t == vello::low_level::vello_encoding::DrawTag::BEGIN_CLIP).count()
    }

    /// Hunt 5 (both reviewers): a 50% group with a layer blur was 25% inside: its opacity went into the blurred
    /// content and around the blurred result too.
    #[test]
    fn layer_blur_applies_opacity_once() {
        let (_, _, p) = painted(json!({ "type": "frame", "id": "f", "width": 300, "height": 300, "layout": "none", "children": [
            { "type": "group", "id": "g", "opacity": 0.5, "effect": { "type": "blur", "radius": 8 }, "children": [
                { "type": "rectangle", "id": "r", "x": 50, "y": 50, "width": 100, "height": 100, "fill": "#000000" }] }] }));
        assert_eq!(p.jobs.len(), 1);
        let JobScene::Own(content) = &p.jobs[0].scene else { panic!("a layer blur owns its content") };
        assert_eq!(layers(content), 0, "the blurred content carries no opacity layer");
        assert_eq!(layers(&p.scene), 1, "the opacity wraps the blurred image, once");
    }

    /// Codex hunt 5, engine 3: an unclipped frame's child far outside it, the frame blurred: the halo around the
    /// child is in the board's ink (tiles cover it), and the opacity layer does not cut it either.
    #[test]
    fn layer_blur_halo_surrounds_overflowing_children() {
        let (_, _, p) = painted(json!({ "type": "frame", "id": "root", "width": 1000, "height": 400, "layout": "none", "children": [
            { "type": "frame", "id": "f", "x": 0, "y": 0, "width": 100, "height": 100, "layout": "none", "opacity": 0.9, "effect": { "type": "blur", "radius": 40 }, "children": [
                { "type": "rectangle", "id": "far", "x": 500, "y": 0, "width": 100, "height": 100, "fill": "#FF0000" }] }] }));
        assert!(p.ink.x1 >= 660.0, "600 + 3 sigma (sigma 20): {:?}", p.ink);
        assert!(p.jobs[0].bounds.x1 >= 660.0);
    }

    /// Codex hunt 5, engine 4: a 45° rectangle with a shadow offset (100, 100): the offset lands 141 units along
    /// one board axis, and the ink covers all of it.
    #[test]
    fn rotated_shadow_offsets_stay_inside_the_ink() {
        let (doc, l, p) = painted(json!({ "type": "frame", "id": "root", "width": 1000, "height": 1000, "layout": "none", "children": [
            { "type": "rectangle", "id": "r", "x": 400, "y": 400, "width": 100, "height": 100, "rotation": 45, "fill": "#000000",
              "effect": { "type": "shadow", "offset": { "x": 100, "y": 100 }, "blur": 0 } }] }));
        let i = doc.index_of("r").unwrap();
        let shadow = (l.world[i] * Affine::translate((100.0, 100.0))).transform_rect_bbox(Rect::new(0.0, 0.0, 100.0, 100.0));
        let ink = p.ink;
        assert!(ink.x0 <= shadow.x0 && ink.y0 <= shadow.y0 && ink.x1 >= shadow.x1 && ink.y1 >= shadow.y1, "shadow {shadow:?} outside ink {ink:?}");
    }

    /// Hunt 5, engine 7: backdrop blurs keep a prefix of the board's scene, not a copy each (40 blurred boxes kept
    /// the scene 40 times); the prefix materializes to exactly what a copy would have been.
    #[test]
    fn backdrop_blurs_keep_prefixes_not_copies() {
        let kids: Vec<_> = (0..40).map(|i| json!({ "type": "rectangle", "id": format!("b{i}"), "x": (i % 8) * 60, "y": (i / 8) * 60, "width": 50, "height": 50,
            "fill": "#FFFFFF80", "effect": { "type": "background_blur", "radius": 10 } })).collect();
        let (_, _, p) = painted(json!({ "type": "frame", "id": "root", "width": 480, "height": 300, "layout": "none", "clip": true, "fill": "#336699", "children": kids }));
        assert_eq!(p.jobs.len(), 40);
        assert!(p.jobs.iter().all(|j| matches!(j.scene, JobScene::Behind(_)) && j.scene.bytes() == 0));
        // The last box sees the 39 before it: its materialized scene holds their fills, under the root clip, closed.
        let last = p.jobs[39].scene.scene(&p.scene);
        assert_eq!(last.encoding().n_open_clips, 0);
        assert!(last.encoding().draw_tags.len() < p.scene.encoding().draw_tags.len());

        let mut s = Scene::new();
        s.fill(Fill::NonZero, Affine::IDENTITY, Color::BLACK, None, &Rect::new(0.0, 0.0, 10.0, 10.0));
        s.push_clip_layer(Fill::NonZero, Affine::translate((1.0, 2.0)), &Rect::new(0.0, 0.0, 50.0, 50.0));
        s.fill(Fill::NonZero, Affine::scale(2.0), Color::WHITE, None, &kurbo::Circle::new((5.0, 5.0), 3.0));
        let mut copy = s.clone();
        copy.pop_layer();
        let pre = ScenePrefix::of(&s, 1);
        s.fill(Fill::NonZero, Affine::IDENTITY, Color::BLACK, None, &Rect::new(20.0, 0.0, 30.0, 10.0));
        s.pop_layer();
        let m = pre.materialize(&s);
        let (a, b) = (m.encoding(), copy.encoding());
        assert!(a.path_tags == b.path_tags && a.path_data == b.path_data && a.draw_tags == b.draw_tags && a.draw_data == b.draw_data && a.transforms == b.transforms && a.styles == b.styles);
        assert_eq!((a.n_paths, a.n_path_segments, a.n_clips, a.n_open_clips), (b.n_paths, b.n_path_segments, b.n_clips, b.n_open_clips));
    }

    /// Hunt 5, engine 10: the smoothing dilation is sized per render for the device px the glyphs land at, like
    /// Chrome: linear in ppem, capped at 0.3 device px, none above 72 ppem. The board's scene keeps none.
    #[test]
    fn text_dilation_follows_the_render_scale() {
        let Ok(bytes) = std::fs::read("/System/Library/Fonts/Supplemental/Arial.ttf") else { return };
        let font = peniko::FontData::new(Blob::new(Arc::new(bytes)), 0);
        let mut board = Scene::new();
        board.draw_glyphs(&font).font_size(16.0).draw(Fill::NonZero, [Glyph { id: 36, x: 0.0, y: 16.0 }].into_iter());
        let dev_px = |s: f64| {
            let mut r = Scene::new();
            r.append(&board, Some(Affine::scale(s)));
            smooth_glyphs(&mut r, 0, true);
            r.encoding().resources.glyph_runs[0].font_embolden.amount.xx * s
        };
        assert!((dev_px(2.0) - 16.0 * 2.0 * STEM_FACTOR).abs() < 1e-6, "100% on 2x: {}", dev_px(2.0));
        assert!((dev_px(4.0) - STEM_MAX).abs() < 1e-6, "200%: capped at {STEM_MAX} device px, not doubled: {}", dev_px(4.0));
        assert_eq!(dev_px(8.0), 0.0, "well above {STEM_MAX_PPEM} ppem Chrome does not dilate");
        // The run's baseline lands on a whole device px of the render, whatever the scale.
        for s in [1.0, 1.37, 2.0, 0.83] {
            let mut r = Scene::new();
            r.append(&board, Some(Affine::translate((3.0, 0.3)) * Affine::scale(s)));
            smooth_glyphs(&mut r, 0, true);
            let e = r.encoding();
            let run = &e.resources.glyph_runs[0];
            let y = run.transform.matrix[3] * e.resources.glyphs[run.glyphs.start].y + run.transform.translation[1];
            assert!((y - y.round()).abs() < 1e-3, "baseline at {y} device px at scale {s}");
        }
        // Audit finding 13: no step anywhere. Per 0.02 ppem the offset moves by less than a thousandth of a px.
        let mut p = 1.0;
        while p < 130.0 {
            let d = (stem_darkening(p + 0.02) - stem_darkening(p)).abs();
            assert!(d < 1e-3, "{d} px between {p} and {} ppem", p + 0.02);
            p += 0.02;
        }
        assert_eq!(stem_darkening(64.0), STEM_MAX, "full up to 64 ppem");
        assert!((stem_darkening(76.0) - STEM_MAX / 2.0).abs() < 1e-9);
        assert_eq!(stem_darkening(88.0), 0.0);
        assert_eq!(board.encoding().resources.glyph_runs[0].font_embolden.amount.xx, 0.0, "the board's scene is not touched");
    }

    /// Golden G5, measured on Chrome's pixels: Inter 22 px (ascent 21.3) has a 2 px underline starting 2 px
    /// under the baseline and a line-through over rows -8 and -7; 13 px text has 1 px lines.
    #[test]
    fn decoration_lines_sit_where_chrome_draws_them() {
        assert_eq!(decoration_lines(22.0, 21.3), (2.0, -8.0, 2.0));
        let (u, s, t) = decoration_lines(13.0, 12.6);
        assert_eq!((u, t), (1.0, 1.0));
        assert!((s - (-13.0 / 3.0 - 0.5)).abs() < 1e-9);
        assert_eq!(decoration_lines(6.0, 5.8).2, 1.0, "never thinner than a px");
        assert_eq!(decoration_lines(44.0, 42.6), (3.0, -(43.0 / 3.0) - 2.0, 4.0));
    }

    /// Golden G3: `cornerRadius: [80, 80, 0, 0]` on a 110 x 80 box is two 55 px arcs in CSS (a full arch).
    /// kurbo clamped them to 40 px (half the short side): a flat top, and hit testing off by the same.
    #[test]
    fn radii_above_half_the_short_side_follow_css() {
        let s = BoxShape::new(110.0, 80.0, Some([80.0, 80.0, 0.0, 0.0]), false);
        assert_eq!(s.radii, [55.0, 55.0, 0.0, 0.0]);
        let path = s.path();
        let b = path.bounding_box();
        assert!((b.x0, b.y0, b.x1, b.y1) == (0.0, 0.0, 110.0, 80.0), "{b:?}");
        for (q, inside) in [((12.0, 12.0), false), ((55.0, 0.5), true), ((98.0, 12.0), false), ((17.0, 17.0), true), ((1.0, 79.0), true), ((109.0, 79.0), true), ((55.0, 40.0), true)] {
            let q = Point::new(q.0, q.1);
            assert_eq!(path.contains(q), inside, "path at {q:?}");
            assert_eq!(rounded_contains(s.rect, s.radii, q), inside, "hit test at {q:?}");
        }
        // Radii within half the short side are kurbo's path, as before.
        let u = BoxShape::new(100.0, 60.0, Some([10.0; 4]), false);
        assert_eq!(u.path().elements().len(), RoundedRect::from_rect(u.rect, 10.0).to_path(0.1).elements().len());
        assert!(!rounded_contains(u.rect, u.radii, Point::new(1.0, 1.0)) && rounded_contains(u.rect, u.radii, Point::new(4.0, 4.0)));
    }

    /// Audit finding 3 / golden G2: images are drawn with vello's bilinear filter (exact at 1:1, what Chrome does
    /// scaling up), not its Mitchell bicubic. And a tiled image draws the whole level around its tiles.
    #[test]
    fn images_are_bilinear_and_tiles_draw_over_the_whole_level() {
        use crate::images::{Cells, cell_src, level_dims};
        let doc = Doc::from_value(&json!({ "type": "rectangle", "id": "r", "width": 600, "height": 4000, "fill": { "type": "image", "url": "u", "mode": "stretch" } })).unwrap();
        let l = layout_doc(&doc, &mut TextSystem::new());
        let whole = BoardImage { w: 1200, h: 8000, data: Some(gpu_image(614, 4096, ImageAlphaType::Alpha)), tiles: None, picks: Vec::new() };
        // Image draws of a paint; each must carry quality Medium (bilinear) in its draw data.
        let quality = |p: &Painted| {
            let e = p.scene.encoding();
            let at: Vec<usize> = e.resources.patches.iter().filter_map(|pt| if let vello::low_level::vello_encoding::Patch::Image { draw_data_offset, .. } = pt { Some(*draw_data_offset) } else { None }).collect();
            assert!(at.iter().all(|o| (e.draw_data[o + 2] >> 12) & 3 == 1), "every image draw is bilinear");
            at.len()
        };
        let p = paint_board(&doc, &l, &PaintOptions { images: &ImageStore::from([("u".to_string(), whole.clone())]), debug_boxes: false, reuse: None });
        assert_eq!(quality(&p), 1);
        assert_eq!(p.image_places["u"].len(), 1);
        let part = image_part_in(&p.image_places["u"], 1200, 8000, Rect::new(-50.0, 1000.0, 700.0, 1500.0)).unwrap();
        assert_eq!(part, [0.0, 0.25, 1.0, 0.375], "the view's part of the image, clipped to it");
        assert!(image_part_in(&p.image_places["u"], 1200, 8000, Rect::new(700.0, 0.0, 900.0, 100.0)).is_none());
        // Tiles 0..3 x 4..6 of the original's pixels: six tile draws and the whole level around them.
        let cells = Cells { x0: 0, y0: 4, x1: 3, y1: 6 };
        let (lw, lh) = level_dims(1200, 8000, 8000);
        let data = cells.iter().map(|(x, y)| { let (_, _, w, h) = cell_src(lw, lh, x, y); Some(gpu_image(w, h, ImageAlphaType::Alpha)) }).collect();
        let tiled = BoardImage { tiles: Some(ImageTiles { lw, lh, cells, data }), ..whole.clone() };
        let p = paint_board(&doc, &l, &PaintOptions { images: &ImageStore::from([("u".to_string(), tiled.clone())]), debug_boxes: false, reuse: None });
        assert_eq!(quality(&p), 7);
        // A tile without its texture: the image is drawn whole.
        // A use with a smaller level of its own draws that one, whole.
        let small = gpu_image(150, 1000, ImageAlphaType::Alpha);
        let picked = BoardImage { picks: vec![Some(small.clone())], ..tiled.clone() };
        let p = paint_board(&doc, &l, &PaintOptions { images: &ImageStore::from([("u".to_string(), picked)]), debug_boxes: false, reuse: None });
        assert_eq!(quality(&p), 1);
        assert!(p.scene.encoding().resources.patches.iter().any(|pt| matches!(pt, vello::low_level::vello_encoding::Patch::Image { image, .. } if image.data.id() == small.data.id())));
        assert_eq!((p.image_places["u"][0].shown, p.image_places["u"][0].tileable), (4000.0, true));
        let mut broken = tiled;
        broken.tiles.as_mut().unwrap().data[2] = None;
        let p = paint_board(&doc, &l, &PaintOptions { images: &ImageStore::from([("u".to_string(), broken)]), debug_boxes: false, reuse: None });
        assert_eq!(quality(&p), 1);
    }

    /// Review round 6, Fable 5 / Codex 3: a tiled image with fill opacity below 1. Tiles overlap by a level px,
    /// so the opacity goes on one layer around them, never on each piece (the overlaps blended twice: a grid).
    #[test]
    fn a_translucent_tiled_image_takes_its_opacity_once() {
        use crate::images::{Cells, cell_src, level_dims};
        let doc = Doc::from_value(&json!({ "type": "rectangle", "id": "r", "width": 1500, "height": 1500, "fill": { "type": "image", "url": "u", "mode": "stretch", "opacity": 0.5 } })).unwrap();
        let l = layout_doc(&doc, &mut TextSystem::new());
        let cells = Cells { x0: 0, y0: 0, x1: 3, y1: 2 };
        let (lw, lh) = level_dims(3000, 3000, 3000);
        let data = cells.iter().map(|(x, y)| { let (_, _, w, h) = cell_src(lw, lh, x, y); Some(gpu_image(w, h, ImageAlphaType::Alpha)) }).collect();
        let whole = BoardImage { w: 3000, h: 3000, data: Some(gpu_image(2048, 2048, ImageAlphaType::Alpha)), tiles: None, picks: Vec::new() };
        let tiled = BoardImage { tiles: Some(ImageTiles { lw, lh, cells, data }), ..whole.clone() };
        // Every image draw's alpha (the brush's, in its draw data), and the layers the paint opened.
        let alphas = |bi: &BoardImage| {
            let p = paint_board(&doc, &l, &PaintOptions { images: &ImageStore::from([("u".to_string(), bi.clone())]), debug_boxes: false, reuse: None });
            let e = p.scene.encoding();
            let a: Vec<u32> = e.resources.patches.iter().filter_map(|pt| if let vello::low_level::vello_encoding::Patch::Image { draw_data_offset, .. } = pt { Some(e.draw_data[draw_data_offset + 2] & 0xff) } else { None }).collect();
            (a, e.n_clips)
        };
        let (a, _) = alphas(&tiled);
        assert_eq!(a.len(), 7, "six tiles and the whole level around them");
        assert!(a.iter().all(|x| *x == 255), "each piece is drawn opaque inside the layer: {a:?}");
        // Untiled, the one draw carries the opacity itself, as before.
        let (a, _) = alphas(&whole);
        assert_eq!(a, vec![128]);
        // The layer is there: the scene holds a blend layer with alpha 0.5 (its end-clip draw data).
        let p = paint_board(&doc, &l, &PaintOptions { images: &ImageStore::from([("u".to_string(), tiled)]), debug_boxes: false, reuse: None });
        let e = p.scene.encoding();
        assert!(e.draw_data.iter().any(|w| f32::from_bits(*w) == 0.5), "a layer with alpha 0.5");
    }

    /// Review round 6, Fable 10: strokes and shadows reach out in the node's own space. A 200 x 200 square at 45
    /// degrees with a 30 px shadow spread has its shadow's tip 1.41 x 30 past the square's own tip.
    #[test]
    fn the_ink_of_a_rotated_node_holds_its_shadow_and_stroke() {
        for (extra, reach) in [(r##""effect":{"type":"shadow","shadowType":"outer","offset":{"x":0,"y":0},"blur":0,"spread":30,"color":"#000000"}"##, 30.0), (r##""stroke":"#000000","strokeWidth":24,"strokeAlignment":"outer""##, 24.0)] {
            let doc = Doc::from_value(&serde_json::from_str(&format!(r##"{{"type":"frame","id":"b","width":10,"height":10,"layout":"none","children":[{{"type":"rectangle","id":"r","x":300,"y":300,"width":200,"height":200,"rotation":45,"fill":"#FF0000",{extra}}}]}}"##)).unwrap()).unwrap();
            let l = layout_doc(&doc, &mut TextSystem::new());
            let p = paint_board(&doc, &l, &PaintOptions { images: &ImageStore::new(), debug_boxes: false, reuse: None });
            let c = l.aabb[1].center();
            let tip = (100.0 + reach) * std::f64::consts::SQRT_2;
            assert!(p.ink.x1 >= c.x + tip - 1e-6 && p.ink.x0 <= c.x - tip + 1e-6 && p.ink.y1 >= c.y + tip - 1e-6 && p.ink.y0 <= c.y - tip + 1e-6, "ink {:?} must reach {tip} from {c:?}", p.ink);
        }
    }

    /// Review round 6, Fable 11: a shape shrunk past nothing has no radii left (an inner shadow's hole with a
    /// spread larger than the box drew a 20 x 10 lens).
    #[test]
    fn a_collapsed_inflated_shape_is_empty() {
        let s = BoxShape::new(110.0, 80.0, Some([55.0, 55.0, 0.0, 0.0]), false).inflate(-45.0);
        assert_eq!(s.radii, [0.0; 4]);
        assert_eq!(s.path().area(), 0.0);
        // A shape that still has room keeps CSS's spread radii.
        let s = BoxShape::new(110.0, 80.0, Some([20.0; 4]), false);
        assert_eq!(s.inflate(-5.0).radii, [15.0; 4]);
        assert_eq!(s.inflate(10.0).radii, [30.0; 4]);
    }

    /// Review round 6, Fable 9: effect renders do not snap baselines (their texels are board units wide).
    #[test]
    fn effect_renders_leave_baselines_where_they_are() {
        let Ok(bytes) = std::fs::read("/System/Library/Fonts/Supplemental/Arial.ttf") else { return };
        let font = peniko::FontData::new(Blob::new(Arc::new(bytes)), 0);
        let mut board = Scene::new();
        board.draw_glyphs(&font).font_size(16.0).draw(Fill::NonZero, [Glyph { id: 36, x: 0.0, y: 16.0 }].into_iter());
        // A text shadow with blur 24 renders at about 0.21 texels per board unit.
        let y_of = |snap: bool| {
            let mut r = Scene::new();
            r.append(&board, Some(Affine::translate((0.0, 0.3)) * Affine::scale(0.21)));
            smooth_glyphs(&mut r, 0, snap);
            let e = r.encoding();
            let run = &e.resources.glyph_runs[0];
            f64::from(run.transform.matrix[3] * e.resources.glyphs[run.glyphs.start].y + run.transform.translation[1])
        };
        assert!((y_of(false) - (16.0 * 0.21 + 0.3)).abs() < 1e-5, "not moved: {}", y_of(false));
        assert!((y_of(true) - 4.0).abs() < 1e-5, "a tile render snaps: {}", y_of(true));
    }

    /// Review round 6, Fable 7: a repaint for new image levels keeps the placeholder of every effect job whose
    /// content holds no image, so its blurred texture is not thrown away and rendered again.
    #[test]
    fn a_repaint_keeps_the_jobs_that_draw_no_image() {
        let doc = Doc::from_value(&json!({ "type": "frame", "id": "b", "width": 800, "height": 800, "layout": "none", "children": [
            { "type": "ellipse", "id": "e", "x": 20, "y": 20, "width": 100, "height": 100, "fill": "#FF0000", "effect": { "type": "shadow", "shadowType": "outer", "offset": { "x": 0, "y": 4 }, "blur": 12, "color": "#00000080" } },
            { "type": "frame", "id": "g", "x": 200, "y": 200, "width": 300, "height": 300, "layout": "none", "effect": { "type": "blur", "radius": 8 }, "children": [
                { "type": "rectangle", "id": "i", "x": 0, "y": 0, "width": 300, "height": 300, "cornerRadius": 20, "fill": { "type": "image", "url": "u", "mode": "stretch" } } ] } ] })).unwrap();
        let l = layout_doc(&doc, &mut TextSystem::new());
        let image = |px: u32| ImageStore::from([("u".to_string(), BoardImage { w: 1000, h: 1000, data: Some(gpu_image(px, px, ImageAlphaType::Alpha)), tiles: None, picks: Vec::new() })]);
        let first = paint_board(&doc, &l, &PaintOptions { images: &image(250), debug_boxes: false, reuse: None });
        assert_eq!(first.jobs.len(), 2, "the ellipse's shadow and the blurred group");
        let ids = |p: &Painted| p.jobs.iter().map(|j| j.image.data.id()).collect::<Vec<_>>();
        // Painted again for another image level, with the old jobs to reuse.
        let again = paint_board(&doc, &l, &PaintOptions { images: &image(500), debug_boxes: false, reuse: Some(&first.jobs) });
        assert_eq!(ids(&again)[0], ids(&first)[0], "the shadow holds no image: same placeholder, its texture stays");
        assert_ne!(ids(&again)[1], ids(&first)[1], "the blurred group holds the image: rendered again");
        // The scene draws the placeholder it kept.
        assert!(again.scene.encoding().resources.patches.iter().any(|pt| matches!(pt, vello::low_level::vello_encoding::Patch::Image { image, .. } if image.data.id() == ids(&first)[0])));
        // Without the old jobs every placeholder is new.
        let fresh = paint_board(&doc, &l, &PaintOptions { images: &image(500), debug_boxes: false, reuse: None });
        assert_ne!(ids(&fresh)[0], ids(&first)[0]);
    }

    #[test]
    fn image_urls_are_reported_even_before_they_load() {
        let doc = Doc::from_value(&json!({ "type": "rectangle", "id": "r", "width": 10, "height": 10, "fill": { "type": "image", "url": "/asset?p=x.png" } })).unwrap();
        let l = layout_doc(&doc, &mut TextSystem::new());
        let p = paint_board(&doc, &l, &PaintOptions { images: &ImageStore::new(), debug_boxes: false, reuse: None });
        assert_eq!(p.images, vec!["/asset?p=x.png".to_string()]);
    }

    fn near(a: Point, b: (f64, f64)) -> bool {
        (a.x - b.0).abs() < 1e-6 && (a.y - b.1).abs() < 1e-6
    }

    /// Image fill modes: Fill covers, Fit fits, Crop keeps its fractions of the box, Tile repeats.
    #[test]
    fn image_fill_modes_place_the_image() {
        // A 200 x 100 image in a 100 x 100 box.
        let fill = image_places(ImageFit::Cover, 0, 100.0, 100.0, 200.0, 100.0);
        assert_eq!(fill.len(), 1);
        assert!(near(fill[0] * Point::new(0.0, 0.0), (-50.0, 0.0)) && near(fill[0] * Point::new(200.0, 100.0), (150.0, 100.0)), "Fill covers, centred");
        let fit = image_places(ImageFit::Contain, 0, 100.0, 100.0, 200.0, 100.0);
        assert!(near(fit[0] * Point::new(0.0, 0.0), (0.0, 25.0)) && near(fit[0] * Point::new(200.0, 100.0), (100.0, 75.0)), "Fit fits, centred");
        let crop = image_places(ImageFit::Crop([-0.5, -0.25, 2.0, 1.5]), 0, 100.0, 100.0, 200.0, 100.0);
        assert!(near(crop[0] * Point::new(0.0, 0.0), (-50.0, -25.0)) && near(crop[0] * Point::new(200.0, 100.0), (150.0, 125.0)), "Crop: fractions of the box");
        // Crop holds when the layer is resized: the same fractions of a 200 x 50 box.
        let wide = image_places(ImageFit::Crop([-0.5, -0.25, 2.0, 1.5]), 0, 200.0, 50.0, 200.0, 100.0);
        assert!(near(wide[0] * Point::new(200.0, 100.0), (300.0, 62.5)));
        let tile = image_places(ImageFit::Tile(0.5), 0, 100.0, 100.0, 200.0, 100.0);
        assert_eq!(tile.len(), 2, "two 100 x 50 copies down a 100 px box");
        assert!(near(tile[1] * Point::new(0.0, 0.0), (0.0, 50.0)));
        // A tiny tile in a big box is capped.
        assert!(image_places(ImageFit::Tile(0.01), 0, 5000.0, 5000.0, 10.0, 10.0).len() as f64 <= MAX_TILES);
    }

    /// Rotate 90° turns the image inside the layer: a tall image fills a wide box after a turn without cropping.
    #[test]
    fn rotating_an_image_fill_turns_it_in_the_box() {
        let r = image_places(ImageFit::Stretch, 1, 200.0, 100.0, 100.0, 200.0);
        // The image's top left goes to the box's top right (clockwise).
        assert!(near(r[0] * Point::new(0.0, 0.0), (200.0, 0.0)), "{:?}", r[0] * Point::new(0.0, 0.0));
        assert!(near(r[0] * Point::new(100.0, 200.0), (0.0, 100.0)));
        let half = image_places(ImageFit::Stretch, 2, 100.0, 100.0, 100.0, 100.0);
        assert!(near(half[0] * Point::new(0.0, 0.0), (100.0, 100.0)));
    }

    #[test]
    fn image_fill_mode_and_rotation_parse() {
        let doc = Doc::from_value(&json!({ "type": "rectangle", "id": "r", "width": 10, "height": 10, "fill": [
            { "type": "image", "url": "a", "mode": "crop", "crop": { "x": 0.1, "y": 0.2, "width": 2, "height": 3 }, "rotation": 270 },
            { "type": "image", "url": "b", "mode": "tile", "scale": 0.25 },
            { "type": "image", "url": "c", "mode": "fit" },
            { "type": "image", "url": "d", "mode": "fill", "rotation": -90 } ] })).unwrap();
        let f = &doc.nodes[0].fills;
        assert_eq!(f[0], Paint::Image { url: "a".into(), fit: ImageFit::Crop([0.1, 0.2, 2.0, 3.0]), opacity: 1.0, rot: 3 });
        assert_eq!(f[1], Paint::Image { url: "b".into(), fit: ImageFit::Tile(0.25), opacity: 1.0, rot: 0 });
        assert_eq!(f[2], Paint::Image { url: "c".into(), fit: ImageFit::Contain, opacity: 1.0, rot: 0 });
        assert_eq!(f[3], Paint::Image { url: "d".into(), fit: ImageFit::Cover, opacity: 1.0, rot: 3 });
    }

    /// A blend mode per paint and per layer: each opens its own layer with that mix.
    #[test]
    fn blend_modes_open_a_mixed_layer() {
        let (doc, _, p) = painted(json!({ "type": "rectangle", "id": "r", "width": 100, "height": 100, "fill": ["#FACC15", { "type": "color", "color": "#2563EB", "blendMode": "multiply" }] }));
        assert_eq!(doc.nodes[0].fill_blends, vec![Blend::Normal, Blend::Multiply]);
        assert_eq!(layers(&p.scene), 1, "the multiplied paint is drawn in its own layer");
        let (doc, _, p) = painted(json!({ "type": "rectangle", "id": "r", "width": 100, "height": 100, "fill": "#FACC15", "blendMode": "screen" }));
        assert_eq!(doc.nodes[0].blend, Blend::Screen);
        assert_eq!(layers(&p.scene), 1, "the layer's blend wraps it");
        let (_, _, p) = painted(json!({ "type": "rectangle", "id": "r", "width": 100, "height": 100, "fill": "#FACC15" }));
        assert_eq!(layers(&p.scene), 0, "normal blends open nothing");
        assert_eq!(mix_of(Blend::parse(Some(&json!("colorDodge")))), Mix::ColorDodge);
        assert_eq!(mix_of(Blend::parse(Some(&json!("light")))), Mix::Lighten);
    }

    /// Use as mask: the siblings above the mask draw in a layer clipped to its ink, cut by its alpha (DestIn);
    /// the siblings under it are not masked.
    #[test]
    fn a_mask_cuts_the_layers_above_it() {
        let (doc, _, p) = painted(json!({ "type": "frame", "id": "f", "width": 200, "height": 200, "layout": "none", "children": [
            { "type": "rectangle", "id": "under", "x": 0, "y": 0, "width": 200, "height": 200, "fill": "#00FF00" },
            { "type": "ellipse", "id": "m", "x": 50, "y": 50, "width": 100, "height": 100, "fill": "#000000", "mask": true },
            { "type": "rectangle", "id": "over", "x": 0, "y": 0, "width": 200, "height": 200, "fill": "#FF0000" } ] }));
        assert!(doc.nodes[2].mask && !doc.nodes[1].mask);
        let enc = p.scene.encoding();
        assert_eq!(layers(&p.scene), 2, "a layer for the masked content and one for the mask");
        // The DestIn layer carries the mask: it is the last opened.
        assert!(enc.draw_tags.iter().filter(|t| **t == vello::low_level::vello_encoding::DrawTag::BEGIN_CLIP).count() == 2);
        let (_, _, plain) = painted(json!({ "type": "frame", "id": "f", "width": 200, "height": 200, "layout": "none", "children": [
            { "type": "ellipse", "id": "m", "x": 50, "y": 50, "width": 100, "height": 100, "fill": "#000000" },
            { "type": "rectangle", "id": "over", "x": 0, "y": 0, "width": 200, "height": 200, "fill": "#FF0000" } ] }));
        assert_eq!(layers(&plain.scene), 0, "without mask nothing is layered");
    }

    /// Corner smoothing: 0 is the circular corner; more smoothing starts the curve further along the side
    /// and keeps it within half the shorter side.
    #[test]
    fn corner_smoothing_draws_a_squircle() {
        let r = Rect::new(0.0, 0.0, 200.0, 100.0);
        let plain = BoxShape::new(200.0, 100.0, Some([20.0; 4]), false).path();
        let zero = smooth_path(r, [20.0; 4], 0.0);
        // Smoothing 0 matches the circle at the corner's middle.
        let mid = |p: &BezPath| p.segments().map(|s| kurbo::ParamCurve::eval(&s, 0.5)).filter(|q| q.x > 150.0 && q.y < 50.0 && q.y > 0.1 && q.x < 199.9).map(|q| (q.x, q.y)).collect::<Vec<_>>();
        let circle = (180.0 + 20.0 * std::f64::consts::FRAC_1_SQRT_2, 20.0 - 20.0 * std::f64::consts::FRAC_1_SQRT_2);
        assert!(mid(&zero).iter().any(|q| (q.0 - circle.0).abs() < 0.05 && (q.1 - circle.1).abs() < 0.05), "{:?}", mid(&zero));
        assert!(mid(&plain).iter().any(|q| (q.0 - circle.0).abs() < 0.05 && (q.1 - circle.1).abs() < 0.05));
        // iOS (60%): the top edge leaves the straight line 32 px before the corner (1.6 x 20).
        let ios = smooth_path(r, [20.0; 4], 0.6);
        let first = ios.elements().iter().find_map(|e| if let kurbo::PathEl::LineTo(p) = e { Some(*p) } else { None }).unwrap();
        assert!((first.x - 168.0).abs() < 1e-6 && first.y.abs() < 1e-9, "{first:?}");
        // Same area as a box, smaller than the box, bigger than the circular one (the squircle is fuller at the middle... but the curve starts earlier).
        let a = ios.area().abs();
        assert!(a < 200.0 * 100.0 && a > 0.95 * plain.area().abs(), "area {a}");
        // Clamped by the shorter side: 50 px radius on a 100 px tall box cannot smooth.
        let pill = smooth_path(r, [50.0; 4], 0.6);
        assert!(pill.bounding_box().height() <= 100.0 + 1e-6);
        let doc = Doc::from_value(&json!({ "type": "rectangle", "id": "r", "width": 10, "height": 10, "cornerRadius": 4, "cornerSmoothing": 0.6 })).unwrap();
        assert_eq!(doc.nodes[0].smoothing, 0.6);
        assert!(!BoxShape::new(10.0, 10.0, Some([4.0; 4]), false).smoothed(0.6).analytic(), "a smoothed box blurs its exact shape");
    }
}
