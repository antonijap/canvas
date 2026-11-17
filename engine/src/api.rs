//! The JS-facing `Engine` (wasm-bindgen). Documented in engine/API.md.

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use kurbo::{Affine, Point, Rect};
use peniko::ImageData;
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

use crate::board::{Board, BuildOptions};
use crate::cache::{BATCH_TILE_PX, Batch, Cover, Fit, Redraw, TileRect, redraw_area, FrameClock, fit_board, fit_tiles, gesture_stretch, gpu_limit, keep_pending, PREFETCH_HEADROOM, ScaleKey, TileBudget, TileKey, base_px_for, base_scale_at, frame_budgets, interior_uv, jobs_needed, prefetch_ring, scissor_px, tile_budget_for, tile_bytes, tiles_in_view, wants_more};
use crate::gpu::{GPU_BASE_MS, GPU_DONE_MS, GPU_MS_PER_MPX, Gpu, Quad, Source, to_device};
use crate::images::{ATLAS_PX, Cells, DEFAULT_IMAGE_BUDGET, MipCache, Plan, Want, ahead_short, cell_src, fit_plans, gives_back_levels, grid, keep_cells, level_dims, level_for, plan_px, slot};
use crate::paint::{BoardImage, ImageStore, ImageTiles, image_part_in};
use crate::scene::{SceneBoard, parse_color};
use crate::shade::{Card, ShaderGpu, Staging, Status, VideoGpu, VideoSrc, new_tex, read_back, work_done};
use crate::shaders::{self as sh, Cand, SrcError};
use crate::text::TextSystem;
use vello::wgpu;

type Mips = MipCache<(wgpu::Texture, ImageData)>;

/// What one board draws its images with: every registered image it uses, with the levels and tiles it holds.
fn store_for(sources: &HashMap<String, (u32, u32, JsValue)>, mips: &Mips, urls: &[String], levels: &HashMap<String, u32>, tiles: &HashMap<String, (u32, Cells)>, picks: &HashMap<String, Vec<u32>>) -> ImageStore {
    urls.iter()
        .filter_map(|u| {
            let (w, h, _) = sources.get(u)?;
            let data = levels.get(u).and_then(|l| mips.get(u, u64::from(*l))).map(|m| m.tex.1.clone());
            let tiles = tiles.get(u).map(|(l, cells)| {
                let (lw, lh) = level_dims(*w, *h, *l);
                ImageTiles { lw, lh, cells: *cells, data: cells.iter().map(|c| mips.get(u, slot(*l, Some(c))).map(|m| m.tex.1.clone())).collect() }
            });
            let picks = picks.get(u).map_or_else(Vec::new, |v| v.iter().map(|l| if *l == 0 { None } else { mips.get(u, u64::from(*l)).map(|m| m.tex.1.clone()) }).collect());
            Some((u.clone(), BoardImage { w: *w, h: *h, data, tiles, picks }))
        })
        .collect()
}

/// The images a partial paint (`move_node`, `update_node`) may draw: those of the board's last paint and every one
/// it still holds a level or tiles of. A layer hidden for a drag left its images out of the last paint while their
/// levels stayed attached; shown again with only the last paint's list, it drew no picture, and the image plan saw
/// nothing to change, so it never painted again (a phone frame's screen stayed black after the drop).
fn held_urls(b: &Board) -> Vec<String> {
    let mut urls = b.images.clone();
    for u in b.image_levels.keys().chain(b.image_tiles.keys()) {
        if !urls.contains(u) {
            urls.push(u.clone());
        }
    }
    urls
}

/// A board gives back every image level and tile it holds (they stay cached, unreferenced).
fn release_images(b: &mut Board, mips: &mut Mips, frame: u64) {
    for (url, lvl) in std::mem::take(&mut b.image_levels) {
        mips.release(&url, u64::from(lvl), frame);
    }
    for (url, (lvl, cells)) in std::mem::take(&mut b.image_tiles) {
        for c in cells.iter() {
            mips.release(&url, slot(lvl, Some(c)), frame);
        }
    }
    for (url, picks) in std::mem::take(&mut b.image_picks) {
        for lvl in pick_levels(&picks) {
            mips.release(&url, u64::from(lvl), frame);
        }
    }
}

/// The distinct smaller levels a board's uses of one image draw.
fn pick_levels(picks: &[u32]) -> Vec<u32> {
    let mut v: Vec<u32> = picks.iter().copied().filter(|l| *l != 0).collect();
    v.sort_unstable();
    v.dedup();
    v
}

/// Image levels and tiles are decoded for about this long in one frame (the decode that crosses it finishes).
const TILE_DECODE_MS: f64 = 8.0;
/// The camera must be still this long before the crisp exact-scale render.
const SETTLE_MS: f64 = 150.0;
/// Exact tiles that are ready wait at most this long (after the settle) for the rest of the view.
const REVEAL_MAX_MS: f64 = 250.0;
/// Default GPU budget for effect (blur) textures.
const EFFECT_BUDGET: u64 = 128 * 1024 * 1024;

/// A board this many frames out of the near view gives its image levels back.
const IMAGE_GRACE_FRAMES: u64 = 120;

pub const DEBUG_TILES: u32 = 1;
pub const DEBUG_LAYOUT: u32 = 2;
/// Render every tile from its board's whole scene, as before per-tile culling (to compare against).
pub const DEBUG_NO_CULL: u32 = 4;
/// Render every changed texture whole, as before an edit's dirty region was rendered alone (to compare against).
pub const DEBUG_NO_PARTIAL: u32 = 8;
/// A busy GPU, for tests: the tile budget admits one render a frame, as the cost model does when other apps keep
/// the GPU busy (an `urgent` board's tiles still all render).
pub const DEBUG_ONE_TILE: u32 = 32;
/// Render every small tile on its own, as before batch renders (to compare against).
pub const DEBUG_NO_BATCH: u32 = 16;
/// Base textures wait this long after the last board was added.
const BASE_WAIT_MS: f64 = 400.0;

pub fn now() -> f64 {
    web_sys::window().and_then(|w| w.performance()).map_or(0.0, |p| p.now())
}

fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| web_sys::console::error_1(&JsValue::from_str(&format!("canvas engine panic: {info}")))));
}

#[derive(Default, Clone, Copy)]
struct FrameStats {
    cpu_ms: f64,
    tile_ms: f64,
    tiles_rendered: u32,
    quads: u32,
    visible_boards: u32,
    missing: u32,
    /// Slots that showed the grey placeholder somewhere (no texture of any scale covered them).
    blank: u32,
    fallbacks: u32,
    /// vello renders the tiles took (more than `tiles_rendered`: dense tiles were rendered in parts).
    parts: u32,
    /// Tiles rendered ahead of the view (the prefetch ring), among `tiles_rendered`.
    ahead: u32,
    /// Slots in view too dense to draw at this scale (an error says which board): they show their stand-in.
    failed: u32,
    scale: f64,
    exact: bool,
    tile_mpx: f64,
    /// Why the frame's batch stopped taking tiles (stats: batchStop): 1 to 5 `Batch::refused`, 6 CPU budget,
    /// 7 no estimate, 8 the GPU cost model; 0 nothing stopped it.
    batch_stop: u8,
}


#[wasm_bindgen]
pub struct Engine {
    gpu: Gpu,
    /// Since the engine started: tiles rendered whole, tiles brought up to date in place, px rendered.
    whole_tiles: u64,
    partial_tiles: u64,
    /// Of `whole_tiles`, rendered together in a batch (`Gpu::render_batch`).
    batched_tiles: u64,
    /// The long side base textures are made at now (`cache::base_px_for`).
    base_px: f64,
    /// When a board was last added (base textures wait until boards stop arriving).
    last_added: f64,
    rendered_px: f64,
    canvas: web_sys::HtmlCanvasElement,
    text: TextSystem,
    fonts_seen: HashSet<(String, u32, bool, u64)>,
    font_bytes: usize,
    /// Registered images: original size and the JS-side source (an ImageBitmap or ImageData).
    sources: HashMap<String, (u32, u32, JsValue)>,
    /// Decoded levels on the GPU.
    mips: Mips,
    /// Per registered image, once asked: has it no transparency (only those are drawn from tiles).
    opaque: HashMap<String, bool>,
    /// Images being read for transparency, a step a frame: the next row to read (see `ensure_images`).
    scans: HashMap<String, u32>,
    /// Image tile decoding this frame: the frame, and the ms spent (`TILE_DECODE_MS` at most).
    tile_decode: (u64, f64),
    boards: Vec<Board>,
    /// Where each board is in `boards`, by id (`pos_of`): with the generation of `boards_gen` it was built for.
    /// A board looked up by a scan of every board cost an open of 5,000 boards a second (`nodeRectIn` per image of
    /// each board, `setBoard` once per board: n² string compares).
    board_ix: std::cell::RefCell<(u64, crate::cache::FastMap<String, usize>)>,
    /// Bumped when boards are removed or reordered (`board_ix` is built again when next asked).
    boards_gen: u64,
    next_uid: u64,
    cam: (f64, f64, f64),
    dpr: f64,
    css: (f64, f64),
    last_cam: f64,
    last_zoom: f64,
    dirty: bool,
    more: bool,
    /// Some board was painted again: drop effect textures nothing draws.
    jobs_dirty: bool,
    /// GPU bytes for blurred effect textures (least recently used go first; tiles keep their pixels).
    effect_budget: u64,
    /// `setTextureBudget` was called: the tile budget no longer follows the drawing buffer's size.
    texture_budget_set: bool,
    debug: u32,
    frame_no: u64,
    last: FrameStats,
    /// Debug: where the last frame drew the grey placeholder (board id, the uncovered world rect, the slot's cover).
    last_blank: Vec<serde_json::Value>,
    /// The display's frame period, measured from the frames themselves: the tile budgets are shares of it.
    clock: FrameClock,
    /// Where the view's centre was last frame (and the zoom), and how far it moves per frame (world units,
    /// smoothed): tiles are rendered ahead of a pan.
    last_center: Option<(Point, f64)>,
    pan: kurbo::Vec2,
    /// Tiles that could not be drawn (too dense for the renderer even in parts), with the generation that
    /// failed: not tried again until the board changes, and shown as their stand-in.
    failed: crate::cache::FastMap<TileKey, u64>,
    /// A tile being rendered in parts over several frames (a dense one, see cull.rs): its key, what its board's
    /// scene was when it was planned, the job, and the last frame that worked on it.
    pending: Option<(TileKey, (u64, u64), crate::gpu::BoardJob, u64)>,
    /// The last `frame()` asked for another: the next one comes a display frame later (what the clock measures).
    chained: bool,
    /// How far this zoom gesture may stretch textures (`cache::gesture_stretch`), decided when it starts.
    stretch: f64,
    was_zooming: bool,
    frames: u64,
    errors: Vec<String>,
    // ---- shader cards (outside the tile cache; see shaders.rs / shade.rs)
    shader_gpu: Option<ShaderGpu>,
    cards: Vec<Card>,
    /// The window is hidden: nothing plays, not even on hover.
    shaders_hidden: bool,
    /// Autoplay allowed (off under Reduce Motion: only the hovered card plays).
    shaders_autoplay: bool,
    /// Snapshot mode: every card shows its frame at t = 2 s.
    shader_snapshot: bool,
    shader_bytes: u64,
    shader_frame: ShaderFrame,
    /// The shared 30 fps deadline: every card that is not hovered renders on the same tick, so two
    /// cards never split into two composites per period.
    shader_phase: f64,
    // ---- video cards (the same list and admission as shader cards; see shaders.rs)
    video_gpu: Option<VideoGpu>,
    /// Decoded-frame staging textures by size (dropped when no video of that size drew for 2 s).
    staging: Vec<Staging>,
    /// Measured GPU ms per decoded megapixel for a copy + filter (0: not measured, use the default).
    video_k: Rc<Cell<f64>>,
    video_uploads: u64,
    // ---- shader fills (cards with a `fill` link: their frames go into board tiles, see `sync_fills`)
    /// Texture tokens for `Gpu::attach_fill`.
    fill_token: u64,
    fill_bytes: u64,
    /// A fill drew a frame this frame: its board's tiles draw that part next frame.
    fill_redraw: bool,
}

#[derive(Default, Clone, Copy)]
struct ShaderFrame {
    rendered: u32,
    posters: u32,
    playing: u32,
    visible: u32,
    predicted_ms: f64,
    deferred: u32,
}

/// The card id of node `node`'s shader fill on board `uid` (a leading U+0001: no widget id has one).
fn fill_card_id(uid: u64, node: &str) -> String {
    format!("\u{1}fill:{uid}:{node}")
}

fn json<T: serde::Serialize>(v: &T) -> JsValue {
    serde_json::to_string(v).ok().and_then(|s| js_sys::JSON::parse(&s).ok()).unwrap_or(JsValue::NULL)
}

fn rect_json(r: Rect) -> serde_json::Value {
    serde_json::json!({ "x": r.x0, "y": r.y0, "w": r.width(), "h": r.height() })
}

#[wasm_bindgen]
impl Engine {
    /// Set up WebGPU on `canvas`. Sizes the drawing buffer from the canvas's CSS size and
    /// `devicePixelRatio`; call `resize` whenever either changes.
    pub async fn create(canvas: web_sys::HtmlCanvasElement) -> Result<Engine, JsValue> {
        install_panic_hook();
        let dpr = web_sys::window().map_or(1.0, |w| w.device_pixel_ratio());
        let css = (f64::from(canvas.client_width().max(1)), f64::from(canvas.client_height().max(1)));
        canvas.set_width((css.0 * dpr).round() as u32);
        canvas.set_height((css.1 * dpr).round() as u32);
        let mut gpu = Gpu::new(canvas.clone()).await.map_err(|e| JsValue::from_str(&e))?;
        gpu.tiles.budget = tile_budget_for(canvas.width(), canvas.height());
        Ok(Engine {
            gpu,
            whole_tiles: 0,
            partial_tiles: 0,
            batched_tiles: 0,
            base_px: crate::cache::BASE_PX,
            last_added: f64::NEG_INFINITY,
            rendered_px: 0.0,
            canvas,
            text: TextSystem::new(),
            fonts_seen: HashSet::new(),
            font_bytes: 0,
            sources: HashMap::new(),
            mips: MipCache::new(DEFAULT_IMAGE_BUDGET),
            opaque: HashMap::new(),
            scans: HashMap::new(),
            tile_decode: (0, 0.0),
            boards: Vec::new(),
            board_ix: Default::default(),
            boards_gen: 1,
            next_uid: 1,
            cam: (0.0, 0.0, 1.0),
            dpr,
            css,
            last_cam: -1e9,
            last_zoom: -1e9,
            dirty: true,
            more: true,
            jobs_dirty: false,
            effect_budget: EFFECT_BUDGET,
            texture_budget_set: false,
            debug: 0,
            frame_no: 0,
            last: FrameStats::default(),
            last_blank: Vec::new(),
            clock: FrameClock::default(),
            last_center: None,
            pan: kurbo::Vec2::ZERO,
            failed: Default::default(),
            pending: None,
            chained: false,
            stretch: crate::cache::STRETCH_UNSEEN,
            was_zooming: false,
            frames: 0,
            errors: Vec::new(),
            shader_gpu: None,
            cards: Vec::new(),
            shaders_hidden: false,
            shaders_autoplay: true,
            shader_snapshot: false,
            shader_bytes: 0,
            shader_frame: ShaderFrame::default(),
            shader_phase: 0.0,
            video_gpu: None,
            staging: Vec::new(),
            video_k: Rc::new(Cell::new(0.0)),
            video_uploads: 0,
            fill_token: 0,
            fill_bytes: 0,
            fill_redraw: false,
        })
    }

    /// Register one font face's bytes (TTF/OTF; the server unpacks WOFF/WOFF2) under `family`,
    /// with the face's weight and style (`/api/fonts/file` reports them in `x-font-weight` and
    /// `x-font-style`; pass 0 / "" to use the file's own). Boards whose text uses the family are
    /// laid out again. Returns the number of faces added (0 when already registered).
    #[wasm_bindgen(js_name = registerFont)]
    pub fn register_font(&mut self, family: &str, weight: f32, style: &str, bytes: Vec<u8>) -> Result<u32, JsValue> {
        // Same family and descriptors but other bytes (faces registered with weight 0 use their
        // own) is another face: the key includes a fingerprint of the data.
        let key = (family.to_ascii_lowercase(), weight as u32, style.eq_ignore_ascii_case("italic"), fingerprint(&bytes));
        if self.fonts_seen.contains(&key) {
            return Ok(0);
        }
        let italic = match style.to_ascii_lowercase().as_str() {
            "italic" | "oblique" => Some(true),
            "normal" => Some(false),
            _ => None,
        };
        self.font_bytes += bytes.len();
        let n = self.text.register_font(family, (weight > 0.0).then_some(weight), italic, bytes).map_err(|e| JsValue::from_str(&e))?;
        self.fonts_seen.insert(key);
        for b in &mut self.boards {
            if b.has_text() && b.uses_family(family) {
                let st = store_for(&self.sources, &self.mips, &b.images, &b.image_levels, &b.image_tiles, &b.image_picks);
                let o = BuildOptions { images: &st, debug_boxes: self.debug & DEBUG_LAYOUT != 0, now: &now, keep_jobs: false };
                b.relayout(&mut self.text, &o);
                // New job ids: the old effect textures are no longer drawn.
                self.jobs_dirty = true;
            }
        }
        self.dirty = true;
        Ok(n as u32)
    }

    /// Register a decoded image for `url` (the exact string in the scene's image fills). `data` is
    /// an `ImageBitmap` (kept, not copied: do not close it while the engine may draw it), or RGBA8
    /// pixels (straight alpha) as a `Uint8Array` / `Uint8ClampedArray` of `width * height * 4`
    /// bytes, which are kept on the JS side. Nothing is decoded into WASM memory: each board draws
    /// the image at a mip level for its on-screen size, decoded into a GPU texture when a tile
    /// first needs it. Boards drawing it are repainted. `opaque`: whether the image has no transparency, when the
    /// caller knows (a JPEG; every pixel checked off the main thread); left out, the engine reads the pixels
    /// itself the first time the image is large enough on screen to be drawn from tiles.
    #[wasm_bindgen(js_name = registerImage)]
    pub fn register_image(&mut self, url: &str, data: JsValue, width: u32, height: u32, opaque: Option<bool>) -> Result<(), JsValue> {
        let (src, w, h) = if let Some(bm) = data.dyn_ref::<web_sys::ImageBitmap>() {
            (data.clone(), bm.width(), bm.height())
        } else {
            let px = js_sys::Uint8ClampedArray::new(&data);
            if width == 0 || height == 0 || px.length() as usize != (width as usize) * (height as usize) * 4 {
                return Err(JsValue::from_str("registerImage: pixel data does not match width × height × 4"));
            }
            let id = web_sys::ImageData::new_with_js_u8_clamped_array(&px, width)?;
            (id.into(), width, height)
        };
        if w == 0 || h == 0 {
            return Err(JsValue::from_str("registerImage: empty image"));
        }
        self.opaque.remove(url);
        self.scans.remove(url);
        if let Some(o) = opaque {
            self.opaque.insert(url.to_string(), o);
        }
        // A new picture for the same URL: every board gives up the old levels first.
        if self.sources.insert(url.to_string(), (w, h, src)).is_some() {
            for b in &mut self.boards {
                b.image_levels.remove(url);
                b.image_tiles.remove(url);
                b.image_picks.remove(url);
            }
            for (tex, img) in self.mips.remove_url(url) {
                self.gpu.forget_image(&img);
                tex.destroy();
            }
        }
        for b in &mut self.boards {
            if b.images.iter().any(|u| u == url) {
                b.stale_paint = true;
                b.generation += 1;
            }
        }
        self.dirty = true;
        Ok(())
    }

    /// Forget a registered image: every board gives up its levels, the GPU textures are freed, and the
    /// JS-side source (the `ImageBitmap` or pixels passed to `registerImage`) is released, so the caller
    /// may `close()` the bitmap afterwards. Boards still drawing the URL show the not-yet-loaded placeholder
    /// until it is registered again. Returns `false` when the URL was not registered.
    #[wasm_bindgen(js_name = unregisterImage)]
    pub fn unregister_image(&mut self, url: &str) -> bool {
        if self.sources.remove(url).is_none() {
            return false;
        }
        self.opaque.remove(url);
        self.scans.remove(url);
        for b in &mut self.boards {
            b.image_levels.remove(url);
            b.image_tiles.remove(url);
            b.image_picks.remove(url);
            if b.images.iter().any(|u| u == url) {
                b.stale_paint = true;
                b.generation += 1;
            }
        }
        for (tex, img) in self.mips.remove_url(url) {
            self.gpu.forget_image(&img);
            tex.destroy();
        }
        self.dirty = true;
        true
    }

    /// The atlas pixels a board's renders take (its image levels, tiles and effect textures: vello places all of
    /// them for every render of the board's content) and the placeholders of its images.
    /// Where board `id` is in `boards` (see `board_ix`).
    fn pos_of(&self, id: &str) -> Option<usize> {
        let mut ix = self.board_ix.borrow_mut();
        if ix.0 != self.boards_gen || ix.1.len() != self.boards.len() {
            ix.1 = self.boards.iter().enumerate().map(|(i, b)| (b.id.clone(), i)).collect();
            ix.0 = self.boards_gen;
        }
        match ix.1.get(id) {
            Some(&i) if self.boards.get(i).is_some_and(|b| b.id == id) => Some(i),
            // Out of step after all (a change that did not bump the generation): the scan, as before.
            Some(_) => self.boards.iter().position(|b| b.id == id),
            None => None,
        }
    }

    fn board_atlas(&self, b: &Board) -> (u64, Vec<ImageData>) {
        let mut px = crate::paint::job_px(&b.jobs);
        let mut imgs = Vec::new();
        for (u, l) in &b.image_levels {
            let Some((w, h, _)) = self.sources.get(u) else { continue };
            let plan = Plan { whole: *l, tiles: b.image_tiles.get(u).copied() };
            px += plan_px(*w, *h, &plan);
            imgs.extend(self.mips.get(u, u64::from(*l)).map(|m| m.tex.1.clone()));
            if let Some((tl, cells)) = plan.tiles {
                imgs.extend(cells.iter().filter_map(|c| self.mips.get(u, slot(tl, Some(c))).map(|m| m.tex.1.clone())));
            }
            for pl in b.image_picks.get(u).map(|p| pick_levels(p)).unwrap_or_default() {
                let (pw, ph) = level_dims(*w, *h, pl);
                px += u64::from(pw) * u64::from(ph);
                imgs.extend(self.mips.get(u, u64::from(pl)).map(|m| m.tex.1.clone()));
            }
        }
        // Shader fills: copied into the atlas again for every render (their frames change).
        for f in &b.fills {
            px += u64::from(f.image.width) * u64::from(f.image.height);
            imgs.push(f.image.clone());
        }
        (px, imgs)
    }

    /// Bring `bi`'s image levels in line with drawing it at scale `s` (device px per world unit):
    /// decode what is missing, give back what it no longer needs, paint again when that changed
    /// anything. Textures drawn earlier stay valid (only pixel resolution changes). Returns true when an
    /// image stays below what `s` needs (kept mid-gesture): a tile drawn now is drawn again once
    /// the camera settles. `tile`: the world rectangle about to be rendered (None: a base texture, which
    /// takes what the board holds). `reach`: the view and every tile of the board in view this frame (world):
    /// images too big for one texture get their tiles for that. One block per frame: planned per tile, two
    /// edge tiles on opposite sides of the view wanted different blocks, and each flip painted the board again.
    /// `ahead`: the tile is rendered ahead of the view, from what the view holds.
    fn ensure_images(&mut self, bi: usize, s: f64, moving: bool, tile: Option<Rect>, reach: Rect, ahead: bool) -> bool {
        let frame = self.frame_no;
        if self.boards[bi].stale_paint {
            // Images arrived: paint once with their sizes so the levels they need are known.
            let b = &mut self.boards[bi];
            let st = store_for(&self.sources, &self.mips, &b.images, &b.image_levels, &b.image_tiles, &b.image_picks);
            // Effect jobs that draw no image keep their textures (a shadow is the same shadow).
            let o = BuildOptions { images: &st, debug_boxes: self.debug & DEBUG_LAYOUT != 0, now: &now, keep_jobs: true };
            b.repaint_same(&mut self.text, &o);
            self.jobs_dirty = true;
        }
        let b = &self.boards[bi];
        // What is in or next to the view, in board space: what is in it may be drawn from tiles. A tile rendered
        // ahead of the view does not widen it (every such tile would hold its own block of image tiles); it is
        // drawn from what the view holds and drawn again when it comes into view (`short`).
        let off = kurbo::Vec2::new(b.x, b.y);
        let near = reach - off;
        // Images in view that need more than one texture are tiled only when they have no transparency: asked
        // once per image (a readback), and only for those (twelve photos asked at once took 100 ms).
        let big: Vec<String> = b
            .image_need
            .iter()
            .filter(|(u, n)| {
                !self.opaque.contains_key(*u)
                    && self.sources.get(*u).is_some_and(|(w, h, _)| {
                        let l = level_for(**n * s, (*w).max(*h));
                        crate::images::whole_level(*w, *h, l, crate::images::WHOLE_PX) < l && b.image_places.get(*u).is_some_and(|p| image_part_in(p, *w, *h, near).is_some())
                    })
            })
            .map(|(u, _)| u.clone())
            .collect();
        // One per frame: the first touch of a big bitmap costs tens of ms (four at once: 110 ms). The rest wait
        // a frame, drawn whole until then (`short`).
        if self.tile_decode.0 != frame {
            self.tile_decode = (frame, 0.0);
        }
        let mut unasked = false;
        for u in big {
            if self.tile_decode.1 > 0.0 {
                unasked = true;
                continue;
            }
            let t_dec = now();
            let (w, h, src) = &self.sources[&u];
            let (w, h) = (*w, *h);
            // Point samples first (cheap, and most images with transparency show it there), then every pixel,
            // about two megapixels a step for as long as the frame's decode box lasts; the rest next frame. Tiles
            // overlap by a level px, so one translucent hairline the samples miss blends twice along a tile edge.
            let mut row = self.scans.get(&u).copied().unwrap_or(0);
            let mut found = row == 0 && !self.gpu.image_opaque(src, w, h);
            // (At least one step a frame: the first touch of a big bitmap can take the whole box by itself.)
            while !found && row < h {
                let rows = crate::images::scan_rows(w, h, row);
                found = self.gpu.image_rows_transparent(src, w, row, rows).unwrap_or(true);
                row += rows;
                if now() - t_dec > TILE_DECODE_MS {
                    break;
                }
            }
            if found || row >= h {
                self.scans.remove(&u);
                self.opaque.insert(u, !found);
            } else {
                self.scans.insert(u, row);
                unasked = true;
            }
            self.tile_decode.1 += (now() - t_dec).max(0.01);
        }
        let b = &self.boards[bi];
        // What the scale needs, every image of the board together fitting vello's atlas; the ones out of view
        // give way first.
        let mut urls: Vec<&String> = b.image_need.keys().filter(|u| self.sources.contains_key(*u)).collect();
        urls.sort();
        let dims = |u: &String| self.sources.get(u).map_or((1, 1), |(w, h, _)| (*w, *h));
        let mut wants: Vec<Want> = urls
            .iter()
            .map(|u| {
                let (w, h) = dims(u);
                Want { w, h, level: level_for(b.image_need[*u] * s, w.max(h)), vis: b.image_places.get(*u).and_then(|p| image_part_in(p, w, h, near)), opaque: self.opaque.get(*u).copied().unwrap_or(false) }
            })
            .collect();
        // (A quarter of the atlas budget is left for the smaller levels single uses draw: a third more at most.)
        let need = fit_plans(&mut wants, ATLAS_PX * 3 / 4);
        let held = |u: &String| b.image_levels.get(u).map(|&whole| Plan { whole, tiles: b.image_tiles.get(u).copied() });
        let block = |q: &Want, cur: Option<Cells>, (l, c): (u32, Cells)| {
            let (lw, lh) = level_dims(q.w, q.h, l);
            let (cols, rows) = grid(lw, lh);
            (l, keep_cells(cur, c, cols, rows))
        };
        let mut target: Vec<Plan> = urls
            .iter()
            .zip(need.iter().zip(&wants))
            .map(|(u, (n, q))| match held(u) {
                // During a gesture what is attached is kept (decoding mid-gesture costs frames; the settled
                // render picks the right level). Only the tiles of a level it already draws follow a pan.
                Some(c) if moving => match (c.tiles, n.tiles) {
                    (Some((cl, cc)), Some((nl, nc))) if cl == nl => Plan { whole: c.whole, tiles: Some(block(q, Some(cc), (nl, nc))) },
                    _ => c,
                },
                // At rest exactly the level the scale needs: a larger one kept from a deeper zoom is minified
                // more than the bilinear tap filters (it shimmered at overview zoom).
                c => Plan { whole: n.whole, tiles: n.tiles.map(|t| block(q, c.and_then(|c| c.tiles).filter(|ct| ct.0 == t.0).map(|ct| ct.1), t)) },
            })
            .collect();
        // Kept levels and the extra tile around a block may add up to more than the atlas holds: never more.
        if target.iter().zip(&wants).map(|(p, q)| plan_px(q.w, q.h, p)).sum::<u64>() > ATLAS_PX * 3 / 4 {
            target = need.clone();
        }
        let covers = |t: &Plan, n: &Plan| match (t.tiles, n.tiles) {
            (_, None) => t.sharpest() >= n.whole,
            (Some((tl, tc)), Some((nl, nc))) => tl == nl && tc.contains(&nc),
            (None, Some((nl, _))) => t.whole >= nl,
        };
        let mut short = unasked || target.iter().zip(&need).any(|(t, n)| !covers(t, n));
        // A tile past what the board's image tiles were planned for (one rendered ahead of the view): does it
        // show an image below the level the scale needs (`ahead_short`)?
        if let Some(t) = tile.filter(|t| !short && (ahead || !reach.contains_rect(*t))) {
            short = urls.iter().zip(target.iter().zip(&wants)).any(|(u, (p, q))| ahead_short(q, self.opaque.get(*u).copied(), p, b.image_places.get(*u).and_then(|pl| image_part_in(pl, q.w, q.h, t - off))));
        }
        let mut want: HashMap<String, u32> = urls.iter().zip(&target).map(|(u, t)| ((*u).clone(), t.whole)).collect();
        let mut want_tiles: HashMap<String, (u32, Cells)> = urls.iter().zip(&target).filter_map(|(u, t)| t.tiles.map(|c| ((*u).clone(), c))).collect();
        // Each use of an image draws the level its own size needs: a smaller one than the image's, where there is
        // one (0: the image's level or tiles). Kept as they are during a gesture.
        let mut want_picks: HashMap<String, Vec<u32>> = urls
            .iter()
            .zip(target.iter().zip(&wants))
            .filter_map(|(u, (p, q))| {
                let places = b.image_places.get(*u)?;
                let picks: Vec<u32> = match b.image_picks.get(*u) {
                    Some(cur) if moving && cur.len() == places.len() && b.image_levels.get(*u) == Some(&p.whole) => cur.clone(),
                    _ if moving => vec![0; places.len()],
                    _ => places.iter().map(|pl| { let l = level_for(pl.shown * s, q.w.max(q.h)); if l < p.whole { l } else { 0 } }).collect(),
                };
                picks.iter().any(|l| *l != 0).then(|| ((*u).clone(), picks))
            })
            .collect();
        if want == b.image_levels && want_tiles == b.image_tiles && want_picks == b.image_picks {
            if b.levels_released {
                // Its levels went while it was out of view and none came back: paint without them now.
                let b = &mut self.boards[bi];
                let st = store_for(&self.sources, &self.mips, &b.images, &b.image_levels, &b.image_tiles, &b.image_picks);
                let o = BuildOptions { images: &st, debug_boxes: self.debug & DEBUG_LAYOUT != 0, now: &now, keep_jobs: true };
                b.repaint_same(&mut self.text, &o);
                self.jobs_dirty = true;
            }
            return short;
        }
        // Acquire what it wants (decoding what the cache lacks) before giving back what it held.
        for (url, lvl) in want.clone() {
            if self.mips.acquire(&url, u64::from(lvl), frame) {
                continue;
            }
            // Decoding is boxed per frame (twelve photos changing level together took 190 ms in one): past
            // the box an image keeps the level it has, and the tile drawn now is drawn again (`short`).
            if let Some(&old) = self.boards[bi].image_levels.get(&url).filter(|_| self.tile_decode.1 > TILE_DECODE_MS)
                && self.mips.acquire(&url, u64::from(old), frame)
            {
                want.insert(url.clone(), old);
                want_tiles.remove(&url);
                short = true;
                continue;
            }
            let t_dec = now();
            let (w, h, src) = self.sources.get(&url).expect("checked above");
            let (lw, lh) = level_dims(*w, *h, lvl);
            match self.gpu.upload_image(src, *w, *h, None, lw, lh) {
                Ok((tex, img)) => {
                    self.mips.insert(&url, u64::from(lvl), (tex, img), lw, lh, frame);
                    self.mips.acquire(&url, u64::from(lvl), frame);
                    self.tile_decode.1 += now() - t_dec;
                }
                Err(e) => {
                    want.remove(&url);
                    want_tiles.remove(&url);
                    if self.errors.len() < 20 {
                        self.errors.push(e);
                    }
                }
            }
        }
        for (url, (lvl, cells)) in want_tiles.clone() {
            let (w, h, src) = self.sources.get(&url).expect("checked above");
            let (lw, lh) = level_dims(*w, *h, lvl);
            let (kx, ky) = (f64::from(*w) / f64::from(lw), f64::from(*h) / f64::from(lh));
            let mut got: Vec<(u32, u32)> = Vec::new();
            let mut failed = None;
            for c in cells.iter() {
                let key = slot(lvl, Some(c));
                if !self.mips.acquire(&url, key, frame) {
                    // Decoding is boxed per call: a view of new tiles of several big images took 180 ms in one
                    // frame. What is decoded stays cached; the tile drawn now is drawn again (`short`).
                    if self.tile_decode.1 > TILE_DECODE_MS {
                        failed = Some(String::new());
                        break;
                    }
                    let t_dec = now();
                    let (x, y, tw, th) = cell_src(lw, lh, c.0, c.1);
                    let crop = [f64::from(x) * kx, f64::from(y) * ky, f64::from(tw) * kx, f64::from(th) * ky];
                    match self.gpu.upload_image(src, *w, *h, Some(crop), tw, th) {
                        Ok((tex, img)) => {
                            self.mips.insert(&url, key, (tex, img), tw, th, frame);
                            self.mips.acquire(&url, key, frame);
                            self.tile_decode.1 += now() - t_dec;
                        }
                        Err(e) => {
                            failed = Some(e);
                            break;
                        }
                    }
                }
                got.push(c);
            }
            if let Some(e) = failed {
                // Without every tile the image is drawn whole: give back the ones just taken.
                for c in got {
                    self.mips.release(&url, slot(lvl, Some(c)), frame);
                }
                want_tiles.remove(&url);
                short = true;
                if !e.is_empty() && self.errors.len() < 20 {
                    self.errors.push(e);
                }
            }
        }
        // The smaller levels single uses draw, inside the frame's decode box like every other level: each is
        // halved down from the source, tens of ms from a 32 Mpx one. Past the box (and when one fails) the use
        // is drawn from the image's level, and the tile drawn now is drawn again (`short`).
        want_picks.retain(|url, _| want.contains_key(url));
        for (url, picks) in &mut want_picks {
            let (w, h, src) = self.sources.get(url).expect("checked above");
            for lvl in pick_levels(picks) {
                if self.mips.acquire(url, u64::from(lvl), frame) {
                    continue;
                }
                if self.tile_decode.1 > TILE_DECODE_MS {
                    picks.iter_mut().filter(|l| **l == lvl).for_each(|l| *l = 0);
                    short = true;
                    continue;
                }
                let t_dec = now();
                let (lw, lh) = level_dims(*w, *h, lvl);
                match self.gpu.upload_image(src, *w, *h, None, lw, lh) {
                    Ok((tex, img)) => {
                        self.mips.insert(url, u64::from(lvl), (tex, img), lw, lh, frame);
                        self.mips.acquire(url, u64::from(lvl), frame);
                        self.tile_decode.1 += now() - t_dec;
                    }
                    Err(e) => {
                        picks.iter_mut().filter(|l| **l == lvl).for_each(|l| *l = 0);
                        if self.errors.len() < 20 {
                            self.errors.push(e);
                        }
                    }
                }
            }
        }
        // A use whose smaller level did not come has no entry of its own left when none of them did.
        want_picks.retain(|_, picks| picks.iter().any(|l| *l != 0));
        let b = &mut self.boards[bi];
        release_images(b, &mut self.mips, frame);
        b.image_levels = want;
        b.image_tiles = want_tiles;
        b.image_picks = want_picks;
        let st = store_for(&self.sources, &self.mips, &b.images, &b.image_levels, &b.image_tiles, &b.image_picks);
        let o = BuildOptions { images: &st, debug_boxes: self.debug & DEBUG_LAYOUT != 0, now: &now, keep_jobs: true };
        let without = std::mem::take(&mut b.drawn_without);
        b.repaint_same(&mut self.text, &o);
        // Images the tiles were drawn without (a layer shown again after a drag, its picture attached only now):
        // a paint at another resolution keeps the tiles, a picture that was not there at all draws them again.
        let came: Option<Rect> = without
            .iter()
            .filter(|u| !b.drawn_without.contains(u))
            .filter_map(|u| b.image_places.get(u))
            .flatten()
            .map(|p| p.clip)
            .reduce(|a, c| a.union(c));
        if let Some(r) = came {
            b.redraw(r);
        }
        self.jobs_dirty = true;
        short
    }

    /// Boards long out of view, and parked boards while the image cache is over budget, give their image levels
    /// back (their textures stay valid, cached unreferenced under the image budget). Nothing is painted here: a
    /// board that gave levels back is painted again before its next render (`ensure_images`, inside the frame's
    /// tile budget). Painting every such board at once cost a page switch over budget up to 50 ms in one frame.
    fn drop_far_images(&mut self) {
        let frame = self.frame_no;
        let over = self.mips.over_budget();
        for b in &mut self.boards {
            if b.image_levels.is_empty() || !gives_back_levels(b.hidden, over, b.seen_frame, frame, IMAGE_GRACE_FRAMES) {
                continue;
            }
            release_images(b, &mut self.mips, frame);
            b.levels_released = true;
        }
        // Detached from vello first (it copies from these), then destroyed (see gpu.rs GpuTile).
        for (tex, img) in self.mips.evict() {
            self.gpu.forget_image(&img);
            tex.destroy();
        }
    }

    /// Add or replace a board from a `/api/scene` payload, placed at world (x, y). Lays it out
    /// and encodes it now; textures follow in `frame()`. Returns a summary
    /// `{ id, nodes, root: {x,y,w,h}, ink: {x,y,w,h}, layoutMs, paintMs, images, fonts, warnings }`.
    #[wasm_bindgen(js_name = setBoard)]
    pub fn set_board(&mut self, id: &str, x: f64, y: f64, scene_json: &str) -> Result<JsValue, JsValue> {
        let scene = SceneBoard::parse(scene_json).map_err(|e| JsValue::from_str(&e))?;
        // A board set again draws with the image levels it already holds: painted without them, its textures (kept
        // as stand-ins, re-rendered only where the layers changed) lost pictures nothing redrew (a phone frame's
        // screen stayed black after a drag).
        let empty = (HashMap::new(), HashMap::new(), HashMap::new());
        let (lv, tl, pk) = match self.pos_of(id) {
            Some(p) => (&self.boards[p].image_levels, &self.boards[p].image_tiles, &self.boards[p].image_picks),
            None => (&empty.0, &empty.1, &empty.2),
        };
        let st = store_for(&self.sources, &self.mips, &scene.images, lv, tl, pk);
        let o = BuildOptions { images: &st, debug_boxes: self.debug & DEBUG_LAYOUT != 0, now: &now, keep_jobs: false };
        let pos = self.pos_of(id);
        let uid = pos.map_or_else(
            || {
                self.next_uid += 1;
                self.next_uid
            },
            |p| self.boards[p].uid,
        );
        // A board laid out again (a live edit, its write's answer): its texts were shaped last time, and most are
        // unchanged. A board's first layout shapes everything once and keeps nothing.
        self.text.caching = pos.is_some();
        let mut board = Board::new(uid, id, x, y, scene, &mut self.text, &o);
        self.text.caching = false;
        board.seen_frame = self.frame_no;
        if let Some(p) = pos {
            // Keep the old textures as stand-ins: a newer generation marks them stale. When the new scene has the
            // same layers, what changed is known (`replaced_dirty`), and the textures render only that part again.
            board.generation = self.boards[p].generation + 1;
            board.urgent = self.boards[p].urgent;
            board.dirty_log = std::mem::take(&mut self.boards[p].dirty_log);
            let dirty = crate::board::replaced_dirty(&self.boards[p], &board);
            board.log_generation(dirty);
            // The levels it painted with go to the new board (still acquired); the next frame plans from there.
            let old = &mut self.boards[p];
            board.image_levels = std::mem::take(&mut old.image_levels);
            board.image_tiles = std::mem::take(&mut old.image_tiles);
            board.image_picks = std::mem::take(&mut old.image_picks);
            let frame = self.frame_no;
            let gone: Vec<String> = board.image_levels.keys().chain(board.image_tiles.keys()).chain(board.image_picks.keys()).filter(|u| !board.images.contains(*u)).cloned().collect();
            for u in gone {
                if let Some(l) = board.image_levels.remove(&u) {
                    self.mips.release(&u, u64::from(l), frame);
                }
                if let Some((l, cells)) = board.image_tiles.remove(&u) {
                    for c in cells.iter() {
                        self.mips.release(&u, slot(l, Some(c)), frame);
                    }
                }
                if let Some(picks) = board.image_picks.remove(&u) {
                    for l in pick_levels(&picks) {
                        self.mips.release(&u, u64::from(l), frame);
                    }
                }
            }
            release_images(&mut self.boards[p], &mut self.mips, frame);
            self.boards[p] = board;
        } else {
            self.boards.push(board);
            self.last_added = now();
            let mut ix = self.board_ix.borrow_mut();
            if ix.0 == self.boards_gen && ix.1.len() + 1 == self.boards.len() {
                ix.1.insert(id.to_string(), self.boards.len() - 1);
            } else {
                drop(ix);
                self.boards_gen += 1;
            }
        }
        self.jobs_dirty = true;
        self.dirty = true;
        let b = &self.boards[pos.unwrap_or(self.boards.len() - 1)];
        let missing: Vec<&str> = b.fonts.iter().filter(|f| !self.text.has_family(&f.family)).map(|f| f.family.as_str()).collect();
        Ok(json(&serde_json::json!({
            "id": b.id, "nodes": b.doc.nodes.len(), "root": rect_json(b.world_root()), "ink": rect_json(b.world_ink()),
            "layoutMs": b.layout_ms, "paintMs": b.paint_ms, "images": b.images, "missingFonts": missing, "warnings": b.doc.warnings,
        })))
    }

    /// Put a layer at (x, y) in its parent without laying its board out again (see `Board::move_node`): the drag
    /// of a layer in a frame that places its children freely. False when the move needs a layout (the caller
    /// sets the board).
    #[wasm_bindgen(js_name = moveNode)]
    pub fn move_node(&mut self, board: &str, id: &str, x: f64, y: f64) -> bool {
        let Some(p) = self.pos_of(board) else { return false };
        let b = &mut self.boards[p];
        // Painted with the image levels it holds (they stay: the same images at the same sizes).
        let urls = held_urls(b);
        let st = store_for(&self.sources, &self.mips, &urls, &b.image_levels, &b.image_tiles, &b.image_picks);
        let o = BuildOptions { images: &st, debug_boxes: self.debug & DEBUG_LAYOUT != 0, now: &now, keep_jobs: false };
        if !b.move_node(id, x, y, &mut self.text, &o) {
            return false;
        }
        self.jobs_dirty = true;
        self.dirty = true;
        true
    }

    /// Replace a layer and its subtree (`node_json`: the node object as the board's scene has it, children
    /// included) and lay out only that subtree (see `Board::update_node`). False when the edit needs the whole
    /// board (the caller sets the board); nothing changed then.
    #[wasm_bindgen(js_name = updateNode)]
    pub fn update_node(&mut self, board: &str, id: &str, node_json: &str) -> bool {
        let Some(p) = self.pos_of(board) else { return false };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(node_json) else { return false };
        let Ok(sub) = crate::scene::Doc::from_value(&v) else { return false };
        let b = &mut self.boards[p];
        let urls = held_urls(b);
        let st = store_for(&self.sources, &self.mips, &urls, &b.image_levels, &b.image_tiles, &b.image_picks);
        let o = BuildOptions { images: &st, debug_boxes: self.debug & DEBUG_LAYOUT != 0, now: &now, keep_jobs: false };
        if !b.update_node(id, &sub, &mut self.text, &o) {
            return false;
        }
        self.jobs_dirty = true;
        self.dirty = true;
        true
    }

    /// Move a board without laying it out again.
    #[wasm_bindgen(js_name = moveBoard)]
    pub fn move_board(&mut self, id: &str, x: f64, y: f64) -> bool {
        let Some(p) = self.pos_of(id) else { return false };
        let b = &mut self.boards[p];
        if (b.x, b.y) != (x, y) {
            // Tiles are cut and keyed in board space: the board's textures stay as they are, and only where the
            // compositor draws them changes. A drag renders nothing.
            b.x = x;
            b.y = y;
            self.dirty = true;
        }
        true
    }

    /// Move boards to the top of the paint order (and hit testing), in the order given, keeping their layout,
    /// scene and textures: restacking costs no layout and shows no placeholder. Unknown ids are skipped. Returns
    /// how many moved.
    #[wasm_bindgen(js_name = raiseBoards)]
    pub fn raise_boards(&mut self, ids: Vec<String>) -> u32 {
        let n = crate::board::raise(&mut self.boards, &ids, |b| b.id.as_str());
        if n > 0 {
            self.dirty = true;
            self.boards_gen += 1;
        }
        n as u32
    }

    /// Park a board (`hidden`: kept laid out and its textures left to the caches' budgets, not drawn, hit-tested
    /// or listed in view) or show it again. Page switches park the boards of the page left, so coming back costs
    /// no layout, no image decode and, while the tile cache still holds them, no render. `setBoard` shows it.
    /// Draw board `id` whole in the next frame that shows it, whatever the tile budget, and never with a
    /// placeholder: for a gesture whose layers move from one board to another (an auto layout drag's overlay and
    /// the board it lifts them from), where a slot left to a later frame showed them twice, nowhere, or under a
    /// grey veil. It holds through `setBoard` until the board is drawn. Returns false for an unknown board.
    #[wasm_bindgen(js_name = drawNow)]
    pub fn draw_now(&mut self, id: &str) -> bool {
        let Some(p) = self.pos_of(id) else { return false };
        let b = &mut self.boards[p];
        b.urgent = true;
        self.dirty = true;
        true
    }

    #[wasm_bindgen(js_name = setBoardHidden)]
    pub fn set_board_hidden(&mut self, id: &str, hidden: bool) -> bool {
        let Some(p) = self.pos_of(id) else { return false };
        let b = &mut self.boards[p];
        if b.hidden != hidden {
            b.hidden = hidden;
            self.dirty = true;
        }
        true
    }

    #[wasm_bindgen(js_name = removeBoard)]
    pub fn remove_board(&mut self, id: &str) -> bool {
        let Some(p) = self.pos_of(id) else { return false };
        let mut b = self.boards.remove(p);
        self.boards_gen += 1;
        self.gpu.tiles.remove_board(b.uid);
        self.failed.retain(|k, _| k.board != b.uid);
        if self.pending.as_ref().is_some_and(|p| p.0.board == b.uid) {
            self.pending = None;
        }
        release_images(&mut b, &mut self.mips, self.frame_no);
        self.jobs_dirty = true;
        self.dirty = true;
        true
    }

    /// Camera: screen CSS px = world × z + (x, y). The same convention as the page's `cam`.
    #[wasm_bindgen(js_name = setCamera)]
    pub fn set_camera(&mut self, x: f64, y: f64, z: f64) {
        let z = z.clamp(0.001, 256.0);
        if (x, y, z) == self.cam {
            return;
        }
        let t = now();
        if z != self.cam.2 {
            self.last_zoom = t;
        }
        self.last_cam = t;
        self.cam = (x, y, z);
        self.dirty = true;
    }

    /// The canvas's CSS size and devicePixelRatio (from a ResizeObserver).
    pub fn resize(&mut self, css_width: f64, css_height: f64, dpr: f64) {
        let dpr = if dpr > 0.0 { dpr } else { 1.0 };
        self.css = (css_width.max(1.0), css_height.max(1.0));
        let (w, h) = ((self.css.0 * dpr).round() as u32, (self.css.1 * dpr).round() as u32);
        // A new ratio is a new scale: nothing is painted again (text dilation is sized per render, see
        // paint::smooth_glyphs); tiles of the new scale render as a zoom's do. Repainting every board here,
        // parked ones too, took 95 ms on an 18 MB file.
        if dpr != self.dpr {
            self.last_zoom = now();
        }
        self.dpr = dpr;
        self.canvas.set_width(w);
        self.canvas.set_height(h);
        self.gpu.resize(w, h);
        if !self.texture_budget_set {
            self.gpu.tiles.budget = tile_budget_for(w, h);
        }
        self.dirty = true;
    }

    /// Draw if anything changed. Call from requestAnimationFrame; returns true while more frames
    /// are needed (a gesture is settling, tiles are still being rendered).
    pub fn frame(&mut self) -> bool {
        let more = self.draw(true);
        self.chained = more;
        more
    }

    /// Draw now, outside requestAnimationFrame (right after `resize`, in the ResizeObserver's own task: a canvas
    /// that changed size is cleared, and the next display frame must not show it empty). Composites what is
    /// cached and renders no tile: the display frame this lands in already spent its tile budget, and a frame
    /// that is not a display frame is kept out of the frame clock. Returns what `frame()` does; call `frame()`
    /// from the next requestAnimationFrame when true.
    pub fn redraw(&mut self) -> bool {
        self.draw(false)
    }

    fn draw(&mut self, raf: bool) -> bool {
        let t0 = now();
        // The display's frame period, from display frames only (`FrameClock::tick`).
        let period = if raf { self.clock.tick(t0, self.chained) } else { self.clock.period() };
        let shaders_due = self.shaders_due(t0);
        if !self.dirty && !self.more && !shaders_due {
            // Compiles and cost probes in flight resolve on their own; keep the loop alive without drawing.
            return self.shaders_waiting();
        }
        if !self.gpu.ready() {
            // vello's pipelines are still being built: show the background, come back next frame.
            let _ = self.gpu.composite(&[], t0, 0.0, 0.0);
            self.more = true;
            return true;
        }
        self.frame_no += 1;
        let frame = self.frame_no;
        // Shader fills the boards draw get their textures before any tile renders.
        self.sync_fills();
        let (cx, cy, z) = self.cam;
        let dpr = self.dpr;
        let zooming = t0 - self.last_zoom < SETTLE_MS;
        let moving = t0 - self.last_cam < SETTLE_MS;
        let s_exact = z * dpr;
        let (budget, gpu_share) = frame_budgets(period, moving);
        if zooming && !self.was_zooming {
            // A gesture begins: may it render the sharper level as it goes, or must it stretch what it has?
            let view_mpx = self.css.0 * self.css.1 * dpr * dpr / 1e6;
            self.stretch = gesture_stretch(view_mpx, GPU_MS_PER_MPX.with(std::cell::Cell::get), frame_budgets(period, true).1, period, self.gpu.tiles.budget);
        }
        self.was_zooming = zooming;
        let stretch = self.stretch;
        let desired = if zooming { ScaleKey::gesture(s_exact, stretch) } else { ScaleKey::exact(s_exact) };
        let s = desired.scale();
        // The wanted scale over the one on screen (1 unless a gesture draws power-of-two textures).
        let shown = s / s_exact;
        let view = Rect::new(-cx / z, -cy / z, (self.css.0 - cx) / z, (self.css.1 - cy) / z);
        let center = view.center();
        let gpu_budget = gpu_limit(period, gpu_share, GPU_BASE_MS.with(std::cell::Cell::get));
        // At rest every board is fitted to whole device pixels (shared edges stay shared: `cache::fit_board`);
        // a zoom draws them where the world puts them.
        let fits: Vec<Fit> = self.boards.iter().map(|b| if zooming { Fit::none((b.x, b.y), s_exact) } else { let f = b.layout.aabb.first().copied().unwrap_or(Rect::ZERO); fit_board((b.x, b.y), (f.x1, f.y1), b.ink, s) }).collect();
        // Per board: the view and every tile of it in view, in the world: what its image tiles are planned for
        // (`ensure_images`), once for the frame.
        let mut reach: Vec<Rect> = vec![view; self.boards.len()];
        // A device pixel of slack: a fitted board sits up to half a pixel from where the world puts it.
        let px = 1.0 / s;
        // How the view moves per frame while it pans (a zoom moves every edge at once: nothing to lead).
        self.pan = match self.last_center {
            // Speeding up counts at once (a flick outruns half a tile of ring in two frames), slowing down eases.
            Some((c, pz)) if moving && !zooming && pz == z => {
                let (d, ease) = (center - c, self.pan * 0.5 + (center - c) * 0.5);
                kurbo::Vec2::new(if d.x.abs() > ease.x.abs() { d.x } else { ease.x }, if d.y.abs() > ease.y.abs() { d.y } else { ease.y })
            }
            _ => kurbo::Vec2::ZERO,
        };
        self.last_center = Some((center, z));
        let ring = prefetch_ring(view, s, self.pan);
        let mut st = FrameStats { scale: s, exact: !zooming, ..Default::default() };
        self.gpu.no_cull = self.debug & DEBUG_NO_CULL != 0;

        // 1. Which slots are needed, which are missing (and what stands in for them), which boards near
        //    the view lack their base texture.
        let near = view.inflate(view.width() * 0.5, view.height() * 0.5);
        let mut near_ink: Vec<Rect> = Vec::new();
        for b in &mut self.boards {
            if !b.hidden && b.world_ink().overlaps(near) {
                b.seen_frame = frame;
                near_ink.push(b.ink);
            }
        }
        // Base textures of every board near the view take at most a share of the tile budget: an overview of 2,000
        // boards at 512 px each wanted 1 GB of a 256 MB cache, so they evicted each other and rendered for ever.
        self.base_px = base_px_for(&near_ink, self.base_px, self.gpu.tiles.budget);
        let base_px = self.base_px;
        let mut slots: Vec<SlotDraw> = Vec::new();
        // (class, distance to the view centre, what): class 0 = nothing (or too little) shows there,
        // 1 = a stand-in up to 2x too coarse, 2 = good enough mid-gesture, 3 = base textures, 4 = tiles ahead of
        // the view (the prefetch ring).
        let mut work: Vec<(u8, f64, Work)> = Vec::new();
        let mut bases_waiting = false;
        // Tiles and their cache slots are in board space (a board that moves keeps them): the view goes there.
        for (bi, b) in self.boards.iter().enumerate() {
            let wink = b.world_ink();
            if b.hidden || !wink.overlaps(near) {
                continue;
            }
            let pos = kurbo::Vec2::new(b.x, b.y);
            let failed = |k: &TileKey| self.failed.get(k) == Some(&b.generation);
            let base = base_scale_at(b.ink, base_px);
            let base_key = TileKey { board: b.uid, scale: base, tx: 0, ty: 0 };
            let fit = &fits[bi];
            // Where the board is drawn (its fitted origin): the view and the ring are tested against that.
            let org = fit.world_origin(s_exact);
            // The board's own key at this scale: a fitted board's pixels are its own.
            let desired = if zooming { desired } else { ScaleKey::fitted(s, fit.code) };
            let tiles = fit_tiles(b.ink, s, fit.k, (view - org).inflate(px, px));
            for t in &tiles {
                reach[bi] = reach[bi].union(t.rect + pos);
            }
            // Not while boards are still arriving (an open, a page switch): how many boards are near the view decides
            // how big base textures are (`base_px_for`), and each step down rendered every one of them again.
            if t0 - self.last_added < BASE_WAIT_MS {
                bases_waiting = true;
            } else if !(base == desired && !tiles.is_empty()) && !self.gpu.tiles.fresh(&base_key, b.generation) && !failed(&base_key) {
                let has_any = self.gpu.tiles.get(&base_key).is_some();
                let d = wink.center().distance(center) + if has_any { 1e9 } else { 0.0 };
                work.push((3, d, Work::Base(bi)));
            }
            let is_ok = |key: &TileKey| if moving { self.gpu.tiles.fresh(key, b.generation) } else { self.gpu.tiles.sharp(key, b.generation) };
            // Ahead of the view: what a pan shows next, and half a tile around a view at rest. Not during a zoom
            // (its textures are for the gesture only), and never drawn, so never counted as missing.
            if !zooming && wink.overlaps(ring) {
                for t in fit_tiles(b.ink, s, fit.k, ring - org) {
                    let seen = fit.world(t.rect, s_exact).intersect(view.inflate(px, px));
                    let key = TileKey { board: b.uid, scale: desired, tx: t.tx, ty: t.ty };
                    // Done once it holds the board's current content, sharp or not: out of view nothing shows
                    // it, and when it comes into view the slot's own test (`is_ok`) draws a low-resolution one
                    // again. Asked to be sharp here, a tile over an image tiled only in view (always low
                    // resolution ahead of it) rendered again every frame, for as long as the camera stood still.
                    if (seen.width() > 0.0 && seen.height() > 0.0) || self.gpu.tiles.fresh(&key, b.generation) || failed(&key) {
                        continue;
                    }
                    work.push((4, (t.rect + pos).center().distance(center), Work::Ahead(bi, t, key)));
                }
            }
            if tiles.is_empty() {
                continue;
            }
            st.visible_boards += 1;
            for t in tiles {
                let key = TileKey { board: b.uid, scale: desired, tx: t.tx, ty: t.ty };
                let cover = if is_ok(&key) { None } else { Some(self.gpu.tiles.cover(b.uid, b.generation, s, t.rect, None)) };
                if failed(&key) {
                    st.failed += 1;
                } else if let Some(cv) = &cover {
                    let class = if moving && !b.urgent { cv.class(shown, stretch) } else { 0 };
                    // An urgent board's slots go before everything else.
                    let d = if b.urgent { -1.0 } else { (t.rect + pos).center().distance(center) };
                    work.push((class, d, Work::Slot(slots.len())));
                }
                slots.push(SlotDraw { bi, t, key, cover });
            }
        }
        // 2. Render: slots with nothing to show first, then nearest the centre, within the CPU budget and
        // the GPU time the cost model predicts. Effect jobs a tile shows render first, under the same
        // admission (one per attempt), so a board full of blurs spreads over frames.
        work.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));
        let mut rendered = 0u32;
        let mut deferred = 0u32;
        // Tiles ahead of the view the budget put off: they keep frames coming (bounded by the ring and the cache's headroom).
        let mut ahead_left = 0u32;
        // Bytes of the tiles ahead of the view that found the cache above the prefetch headroom.
        let mut starved = 0u64;
        let mut admit = TileBudget::new(budget, gpu_budget, GPU_BASE_MS.with(std::cell::Cell::get), GPU_MS_PER_MPX.with(std::cell::Cell::get));
        // A draw outside requestAnimationFrame (a resize) renders nothing: everything waits for the next frame.
        let mut blocked = !raf;
        // Small tiles (an overview's boards, base textures) go into one vello render together (`Gpu::render_batch`),
        // packed into cells of a scratch atlas. The GPU cost model admits the batch's first tile like any render;
        // the rest join it under the CPU budget alone, since the render they add to is the one already admitted.
        let mut batch = Batch::default();
        for (class, _, what) in &work {
            let is_ahead = matches!(what, Work::Ahead(..));
            if blocked {
                if is_ahead { ahead_left += 1 } else { deferred += 1 }
                continue;
            }
            if moving && *class == 2 {
                continue;
            }
            // An urgent board's slot renders in this frame whatever the budget says (it comes first in `work`).
            let force = matches!(what, Work::Slot(si) if self.boards[slots[*si].bi].urgent);
            let (bi, t, key, ts) = match *what {
                Work::Slot(si) => (slots[si].bi, slots[si].t, slots[si].key, s),
                Work::Ahead(bi, t, key) => (bi, t, key, s),
                Work::Base(bi) => {
                    let b = &self.boards[bi];
                    let base = base_scale_at(b.ink, base_px);
                    let Some(t) = tiles_in_view(b.ink, base.scale(), b.ink).into_iter().next() else { continue };
                    (bi, t, TileKey { board: b.uid, scale: base, tx: 0, ty: 0 }, base.scale())
                }
            };
            // Ahead of the view only while the cache has room: past that they would evict what the view shows.
            if is_ahead && (self.gpu.tiles.bytes + tile_bytes((t.w, t.h))) as f64 > self.gpu.tiles.budget as f64 * PREFETCH_HEADROOM {
                starved += tile_bytes((t.w, t.h));
                continue;
            }
            // A stale base texture (the board changed) waits for a frame that rendered nothing else: a
            // live edit repaints the board every frame, and its slot comes first.
            if matches!(what, Work::Base(_)) && rendered + batch.len() > 0 && self.gpu.tiles.get(&key).is_some() {
                continue;
            }
            // Over budget already: stop before the decode and repaint that prepare this tile, not after.
            // A tile costs its pixels and its part of the scene (a render draws only the items that meet it).
            let t_mpx = f64::from(t.w) * f64::from(t.h) / 1e6 + self.boards[bi].part_mpx(t.rect);
            let small = !force && self.debug & (DEBUG_NO_BATCH | DEBUG_NO_CULL) == 0 && u64::from(t.w) * u64::from(t.h) <= BATCH_TILE_PX && self.pending.as_ref().is_none_or(|p| p.0 != key);
            let joining = small && batch.len() > 0;
            // A busy GPU (DEBUG_ONE_TILE): one render a frame, the first.
            let one_tile = self.debug & DEBUG_ONE_TILE != 0 && admit.attempts > 0;
            if force {
            } else if one_tile {
                if is_ahead { ahead_left += 1 } else { deferred += 1 }
                blocked = true;
                continue;
            } else if joining {
                if now() - t0 > budget {
                    st.batch_stop = 6;
                    if is_ahead { ahead_left += 1 } else { deferred += 1 }
                    blocked = true;
                    continue;
                }
            } else if !admit.fits(t_mpx, now() - t0) {
                st.batch_stop = 8;
                if is_ahead { ahead_left += 1 } else { deferred += 1 }
                blocked = true;
                continue;
            }
            let t1 = now();
            // Base textures keep whatever image levels the board holds (no decode or repaint for them).
            let short = self.ensure_images(bi, ts, moving || matches!(what, Work::Base(_)), (!matches!(what, Work::Base(_))).then_some(t.rect + kurbo::Vec2::new(self.boards[bi].x, self.boards[bi].y)), reach[bi], is_ahead);
            let b = &self.boards[bi];
            if let Err(e) = self.gpu.prepare_jobs(&b.jobs) {
                self.push_error(e);
                continue;
            }
            let b = &self.boards[bi];
            // Its image levels and its effect textures: vello places both in the atlas for every render of the
            // board's content, its tiles and its effect jobs alike.
            let (atlas_px, imgs) = self.board_atlas(b);
            // The tile and its gutter.
            let g = f64::from(crate::cache::GUTTER) / ts;
            let local = t.rect.inflate(g, g);
            let bounds: Vec<(Rect, Rect)> = b.jobs.iter().map(|j| (j.drawn, j.bounds)).collect();
            let mut jobs_ok = true;
            for ji in jobs_needed(&bounds, local) {
                let job = &b.jobs[ji];
                let id = job.image.data.id();
                if self.gpu.has_job(id) {
                    self.gpu.touch_job(id, frame);
                    continue;
                }
                if !admit.admit(f64::from(job.w) * f64::from(job.h) * 3.0 / 1e6 + b.part_mpx(job.bounds), now() - t0) && !force {
                    jobs_ok = false;
                    break;
                }
                if let Err(e) = self.gpu.render_effect(b, job, frame, atlas_px, &imgs)
                    && self.errors.len() < 20
                {
                    self.errors.push(e);
                }
            }
            if !jobs_ok {
                if is_ahead { ahead_left += 1 } else { deferred += 1 }
                blocked = true;
                continue;
            }
            if !joining && !admit.admit(t_mpx, now() - t0) && !force {
                if is_ahead { ahead_left += 1 } else { deferred += 1 }
                blocked = true;
                continue;
            }
            let b = &self.boards[bi];
            // An edit since this texture was drawn (a resize, typing, a property) changed only part of it: render
            // that part again into the texture, in place, instead of the whole tile. Exact tiles of the view (not a
            // gesture's) whose images are all at their level, and base textures (a stand-in keeps whatever image
            // levels the board holds anyway); same size and rect, not being rendered in parts.
            let is_base = matches!(what, Work::Base(_));
            if !joining && self.debug & DEBUG_NO_PARTIAL == 0 && ((!short && !zooming && matches!(what, Work::Slot(_))) || is_base) && self.pending.as_ref().is_none_or(|p| p.0 != key) {
                let sc = if is_base { (ts, ts) } else { (ts * fits[bi].k.0, ts * fits[bi].k.1) };
                let redo = self.gpu.tiles.get(&key).filter(|sl| sl.generation != b.generation && !sl.lowres && sl.px == (t.w, t.h) && sl.rect == t.rect).map(|sl| redraw_area(b.dirty_since(sl.generation), t.rect, (t.w, t.h), sc));
                match redo {
                    Some(Redraw::Unchanged) => {
                        self.gpu.tiles.restamp(&key, b.generation, frame);
                        self.partial_tiles += 1;
                        st.tile_ms += now() - t1;
                        continue;
                    }
                    Some(Redraw::Area(area)) => {
                        let tex = self.gpu.tiles.get(&key).and_then(|sl| sl.tex.texture().cloned());
                        if let Some(tex) = tex
                            && let Ok(px) = self.gpu.render_into(&tex, b, &t, sc, area, atlas_px, &imgs)
                        {
                            self.gpu.tiles.restamp(&key, b.generation, frame);
                            self.partial_tiles += 1;
                            self.rendered_px += px as f64;
                            rendered += 1;
                            st.tile_ms += now() - t1;
                            continue;
                        }
                    }
                    _ => {}
                }
            }
            // A small tile joins the frame's batch render when it renders in one part and the batch has room
            // (atlas space, vello's buffers, the image atlas). One that joined skipped the GPU admission: if it
            // does not fit, it waits for the next frame rather than rendering on its own.
            if small {
                let sc = if is_base { (ts, ts) } else { (ts * fits[bi].k.0, ts * fits[bi].k.1) };
                let est = self.gpu.small_tile_estimate(b, &t, sc);
                if let Some(e) = est
                    && batch.add(bi, t, key, sc, is_base, short, e, atlas_px)
                {
                    st.tile_ms += now() - t1;
                    continue;
                }
                if joining {
                    st.batch_stop = if est.is_none() { 7 } else { batch.refused };
                    if is_ahead { ahead_left += 1 } else { deferred += 1 }
                    blocked = true;
                    continue;
                }
            }
            let b = &self.boards[bi];
            // A dense tile renders in parts (cull.rs), as many a frame as the budget admits: the job carries over
            // to the next frames and the slot keeps its stand-in until the last part is in. All its parts in one
            // frame took 38 ms for 520,000 shapes at 10%.
            // It goes on only against the paint it started with: a repaint for other image levels keeps the
            // generation (and often every encoding length), and the parts already rendered drew the old levels.
            let stamp = b.job_stamp();
            let scale = if matches!(what, Work::Base(_)) { (ts, ts) } else { (ts * fits[bi].k.0, ts * fits[bi].k.1) };
            let (job, other) = match self.pending.take() {
                Some((k, st0, job, _)) if k == key && st0 == stamp => (Ok(job), None),
                other => (self.gpu.begin_tile(b, &t, scale), other),
            };
            let mut keep = other;
            let outcome = job.and_then(|mut job| {
                job.short |= short;
                let mut slowest = 0.0f64;
                loop {
                    let p0 = now();
                    let done = self.gpu.step_job(&mut job, b, atlas_px, &imgs)?;
                    st.parts += 1;
                    if done {
                        return Ok((job, true));
                    }
                    // The next part only if the frame has time for one half again as slow as the slowest so far
                    // (parts differ: one holds the dense corner, the next an empty one).
                    slowest = slowest.max(now() - p0);
                    if !admit.admit(job.next_mpx(), now() - t0 + slowest * 1.5) && !force {
                        return Ok((job, false));
                    }
                }
            });
            match outcome {
                Ok((job, true)) => {
                    let short = job.short;
                    let (tex, _) = self.gpu.finish_tile(job);
                    let slot = self.gpu.tiles.insert(key, tex, b.generation, tile_bytes((t.w, t.h)), frame, t.rect);
                    slot.px = (t.w, t.h);
                    self.whole_tiles += 1;
                    self.rendered_px += f64::from(t.w + 2 * crate::cache::GUTTER) * f64::from(t.h + 2 * crate::cache::GUTTER);
                    slot.lowres = short && !matches!(what, Work::Base(_));
                    rendered += 1;
                    st.ahead += u32::from(is_ahead);
                }
                Ok((job, false)) => {
                    // More parts than this frame has time for: go on next frame (whatever was pending for
                    // another tile gives way: one at a time).
                    keep = Some((key, stamp, job, frame));
                    if is_ahead { ahead_left += 1 } else { deferred += 1 }
                    blocked = true;
                }
                Err(e) => {
                    // Too dense to draw even in parts: say so once, keep the stand-in, and do not try again until
                    // the board changes (an empty texture cached as fresh was a blank board with no error).
                    if e.contains("too dense") {
                        self.failed.insert(key, b.generation);
                        st.failed += u32::from(matches!(what, Work::Slot(_)));
                    }
                    if !self.errors.contains(&e) {
                        self.push_error(e);
                    }
                }
            }
            self.pending = keep;
            st.tile_ms += now() - t1;
        }
        // The batch of small tiles: one render, then each cell into a texture of its own.
        if batch.len() > 0 {
            let t1 = now();
            let mut images: Vec<ImageData> = Vec::new();
            let mut seen = HashSet::new();
            for c in &batch.cells {
                if seen.insert(c.bi) {
                    images.extend(self.board_atlas(&self.boards[c.bi]).1);
                }
            }
            let boards = &self.boards;
            let jobs: Vec<&crate::paint::EffectJob> = seen.iter().flat_map(|bi| boards[*bi].jobs.iter()).collect();
            let items: Vec<(&Board, TileRect, (f64, f64), (u32, u32))> = batch.cells.iter().map(|c| (&boards[c.bi], c.t, c.scale, c.at)).collect();
            let (aw, ah) = batch.size();
            match self.gpu.render_batch(&items, aw, ah, batch.atlas_px, &images, &jobs) {
                Ok(texs) => {
                    for (c, tex) in batch.cells.iter().zip(texs) {
                        let generation = self.boards[c.bi].generation;
                        let slot = self.gpu.tiles.insert(c.key, tex, generation, tile_bytes((c.t.w, c.t.h)), frame, c.t.rect);
                        slot.px = (c.t.w, c.t.h);
                        slot.lowres = c.short && !c.base;
                        rendered += 1;
                        self.whole_tiles += 1;
                        self.batched_tiles += 1;
                        self.rendered_px += f64::from(c.t.w + 2 * crate::cache::GUTTER) * f64::from(c.t.h + 2 * crate::cache::GUTTER);
                    }
                    st.parts += 1;
                }
                Err(e) => self.push_error(e),
            }
            st.tile_ms += now() - t1;
        }
        // A tile rendered in parts is given up the frame its tile is no longer wanted (it left the view), or
        // when nobody worked on it for a second: its texture goes now, not when some other tile next renders.
        if let Some(k) = self.pending.as_ref().map(|p| p.0) {
            let wanted = work.iter().any(|(_, _, w)| match w {
                Work::Slot(si) => slots[*si].key == k,
                Work::Ahead(_, _, key) => *key == k,
                Work::Base(bi) => k.board == self.boards[*bi].uid && k.scale == base_scale_at(self.boards[*bi].ink, base_px),
            });
            self.pending = self.pending.take().filter(|p| keep_pending(p.3, frame, wanted));
        }
        st.tiles_rendered = rendered;
        let mpx = admit.mpx;

        // 2b. Shader cards: their own textures, never the tiles'. Missing tiles go first.
        // Only when this frame did render tiles and more are missing: a frame blocked by the tile budget
        // still lets the cards move.
        let tiles_pending = rendered > 0 && deferred > 0;
        self.fill_redraw = false;
        let shader_ms = self.run_shaders(t0, view, moving, tiles_pending);

        // 3. Quads: fresh tiles, else the stand-in pieces scissored to their part of the slot, else a
        // placeholder. At the exact scale every texture of a board lands on whole device px, shifted
        // together, so tiles meet without a seam. Once the zoom settles, exact tiles replacing current
        // stand-ins are revealed together when the last one is ready (at most `REVEAL_MAX_MS` later),
        // not one by one: the view sharpens in one step instead of popping tile by tile.
        let mut quads: Vec<(Source, Quad)> = Vec::new();
        let white = [1.0, 1.0, 1.0, 1.0];
        let (dw, dh) = self.gpu.size();
        let mut unfresh = 0u32;
        let is_fresh = |c: &crate::cache::TileCache<crate::gpu::GpuTile>, k: &TileKey, g: u64| if moving { c.fresh(k, g) } else { c.sharp(k, g) };
        let holding = !zooming && !moving && t0 < self.last_zoom + SETTLE_MS + REVEAL_MAX_MS && slots.iter().any(|sd| !is_fresh(&self.gpu.tiles, &sd.key, self.boards[sd.bi].generation) && sd.cover.as_ref().is_some_and(|cv| cv.covered && !cv.stale));
        let mut blank_dbg: Vec<serde_json::Value> = Vec::new();
        // Urgent boards with a slot in view that is not fresh after this frame (they stay urgent).
        let mut still_urgent: Vec<bool> = vec![false; self.boards.len()];
        for sd in &slots {
            let b = &self.boards[sd.bi];
            // Board space to device px: the board's place in the world (fitted to whole pixels at rest) and the
            // camera, on whole pixels too then, the same for every board.
            let fit = &fits[sd.bi];
            let cam_dev = if zooming { (cx * dpr, cy * dpr) } else { ((cx * dpr).round(), (cy * dpr).round()) };
            let dev = |r: Rect| fit.device(r, s_exact, cam_dev);
            let slot_dev = dev(sd.t.rect);
            let mut fresh_now = is_fresh(&self.gpu.tiles, &sd.key, b.generation);
            // A lowres texture at rest is still the best picture of its slot while it renders again.
            let cover = if fresh_now {
                // Held back: the current stand-ins stay until every exact tile is ready.
                let held = holding.then(|| self.gpu.tiles.cover(b.uid, b.generation, s, sd.t.rect, Some(sd.key))).filter(|cv| cv.covered && !cv.stale);
                if held.is_some() {
                    fresh_now = false;
                    // Held back, but drawn soon: this frame uses it, so eviction must not take it (on a 5K or
                    // 6K display the view's exact tiles were evicted while held, rendered again, evicted again).
                    self.gpu.tiles.touch(&sd.key, frame);
                }
                held
            } else {
                // A slot that cannot be drawn keeps its stand-in and asks for no more frames.
                unfresh += u32::from(self.failed.get(&sd.key) != Some(&b.generation));
                // A tile rendered this frame may have replaced a texture this cover clipped: ask again then, or
                // a sliver could stay empty for a frame.
                Some(match &sd.cover {
                    Some(cv) if rendered == 0 => cv.clone(),
                    _ => self.gpu.tiles.cover(b.uid, b.generation, s, sd.t.rect, None),
                })
            };
            if !fresh_now && b.urgent {
                still_urgent[sd.bi] = true;
            }
            if let Some(cv) = &cover {
                for (k, clip) in &cv.pieces {
                    let Some(slot) = self.gpu.tiles.get(k) else { continue };
                    let Some(sc) = scissor_px(dev(*clip), dw, dh) else { continue };
                    let d = dev(slot.rect);
                    let uv = interior_uv(slot.px);
                    self.gpu.tiles.touch(k, frame);
                    st.fallbacks += 1;
                    quads.push((Source::Tile(*k), Quad { rect: r32(d), uv, tint: white, scissor: Some(sc), extra: [0.0; 4] }));
                    if self.debug & DEBUG_TILES != 0 {
                        outline(&mut quads, d, [0.9, 0.6, 0.0, 0.9]);
                    }
                }
                // No placeholder on an urgent board: it is a gesture's layer, and a grey veil over it flashed.
                if !cv.covered && !fresh_now && !b.urgent {
                    let root = b.layout.aabb.first().copied().unwrap_or(Rect::ZERO).intersect(sd.t.rect);
                    let mut grey = false;
                    for r in &cv.left {
                        let r = r.intersect(root);
                        if r.width() > 0.0 && r.height() > 0.0 {
                            grey = true;
                            quads.push((Source::White, Quad { rect: r32(dev(r)), uv: [0.0, 0.0, 1.0, 1.0], tint: [0.4, 0.4, 0.4, 0.4], scissor: None, extra: [0.0; 4] }));
                        }
                    }
                    if grey {
                        st.blank += 1;
                        if blank_dbg.len() < 4 {
                            blank_dbg.push(serde_json::json!({ "board": b.id, "slot": [sd.t.rect.x0 + b.x, sd.t.rect.y0 + b.y, sd.t.rect.x1 + b.x, sd.t.rect.y1 + b.y], "left": cv.left.iter().map(|r| [r.x0, r.y0, r.x1, r.y1]).collect::<Vec<_>>(), "pieces": cv.pieces.len(), "scale": s }));
                        }
                    }
                }
            }
            if fresh_now {
                self.gpu.tiles.touch(&sd.key, frame);
                let px = self.gpu.tiles.get(&sd.key).map_or((sd.t.w, sd.t.h), |sl| sl.px);
                let mut d = slot_dev;
                if !zooming {
                    // Exact scale: one texel per device pixel.
                    let (x0, y0) = (d.x0.round(), d.y0.round());
                    d = Rect::new(x0, y0, x0 + f64::from(px.0), y0 + f64::from(px.1));
                }
                quads.push((Source::Tile(sd.key), Quad { rect: r32(d), uv: interior_uv(px), tint: white, scissor: None, extra: [0.0; 4] }));
                if self.debug & DEBUG_TILES != 0 {
                    outline(&mut quads, d, if zooming { [0.0, 0.3, 0.9, 0.9] } else { [0.9, 0.1, 0.1, 0.9] });
                }
            }
        }
        // An urgent board is done once every slot of it in view shows its current content (one out of view is
        // drawn when it comes into view, under the budget like any other).
        for (b, still) in self.boards.iter_mut().zip(&still_urgent) {
            if b.urgent && !still {
                b.urgent = false;
            }
        }
        // Shader cards above every board, in widget order, premultiplied and with rounded corners.
        self.shader_quads(&mut quads, view);
        st.missing = unfresh;
        self.last_blank = blank_dbg;
        st.quads = quads.len() as u32;
        st.tile_mpx = mpx;
        if let Err(e) = self.gpu.composite(&quads, t0, mpx, shader_ms) {
            self.push_error(e);
        }
        // 4. Stay under the texture budgets.
        let info: HashMap<u64, (u64, ScaleKey)> = self.boards.iter().map(|b| (b.uid, (b.generation, base_scale_at(b.world_ink(), base_px)))).collect();
        let _ = self.gpu.tiles.evict(frame, desired, |u| info.get(&u).copied());
        self.gpu.trim_atlas();
        // Tiles ahead of the view that found no room: textures of other scales and older generations make way,
        // and the next frame renders them. Only when something went: room that cannot come is not waited for.
        let mut room_made = false;
        if starved > 0 {
            let target = ((self.gpu.tiles.budget as f64 * PREFETCH_HEADROOM) as u64).saturating_sub(starved);
            room_made = !self.gpu.tiles.evict_for_prefetch(frame, desired, |u| info.get(&u).copied(), target).is_empty();
        }
        self.drop_far_images();
        if std::mem::take(&mut self.jobs_dirty) {
            let live: HashSet<u64> = self.boards.iter().flat_map(|b| b.jobs.iter().map(|j| j.image.data.id())).collect();
            self.gpu.retain_jobs(&live);
        }
        self.gpu.evict_jobs(self.effect_budget, frame);

        st.cpu_ms = now() - t0;
        self.last = st;
        self.frames += 1;
        self.dirty = false;
        // Base textures still missing near the view keep frames coming too (bounded: one per board).
        let bases_left = work.iter().any(|(_, _, w)| matches!(w, Work::Base(bi) if !self.gpu.tiles.fresh(&TileKey { board: self.boards[*bi].uid, scale: base_scale_at(self.boards[*bi].world_ink(), base_px), tx: 0, ty: 0 }, self.boards[*bi].generation)));
        self.more = wants_more(moving || holding, unfresh) || bases_left || bases_waiting || ahead_left > 0 || room_made || self.shader_frame.deferred > 0 || self.shader_first_frames_left(view, moving) || self.fill_redraw;
        self.more || self.shaders_waiting()
    }

    fn push_error(&mut self, e: String) {
        if self.errors.len() < 20 {
            self.errors.push(e);
        }
    }

    // ------------------------------------------------------------------ shader cards

    fn shader_gpu(&mut self) -> &ShaderGpu {
        if self.shader_gpu.is_none() {
            self.shader_gpu = Some(ShaderGpu::new(self.gpu.device(), self.gpu.queue()));
        }
        self.shader_gpu.as_ref().expect("set above")
    }

    fn card_index(&self, id: &str) -> Option<usize> {
        self.cards.iter().position(|c| c.id == id)
    }

    /// Add or move a shader card: world rect, paint order among cards (the widget list's order),
    /// whether it plays on its own (`play`: config autoplay; a hovered card plays either way) and its
    /// corner radius in world units. Never touches a board.
    #[wasm_bindgen(js_name = setShaderCard)]
    #[allow(clippy::too_many_arguments)]
    pub fn set_shader_card(&mut self, id: &str, x: f64, y: f64, w: f64, h: f64, order: f64, play: bool, radius: f64) {
        let i = match self.card_index(id) {
            Some(i) => i,
            None => {
                self.shader_gpu();
                let card = self.shader_gpu.as_ref().expect("built above").card(self.gpu.device(), id);
                self.cards.push(card);
                self.cards.len() - 1
            }
        };
        let c = &mut self.cards[i];
        (c.x, c.y, c.w, c.h, c.order, c.radius) = (x, y, w.max(1.0), h.max(1.0), order, radius.max(0.0));
        if c.play != play {
            c.play = play;
            if !play {
                c.clock.stop();
            }
        }
        self.cards.sort_by(|a, b| a.order.total_cmp(&b.order));
        self.dirty = true;
    }

    /// Add or move a video card: like `setShaderCard`, in the same list and admission (at most four
    /// shader and video cards play at once, largest on screen first, inside one GPU budget). `play`:
    /// it plays on its own (config autoplay). Frames come from the element given to `setVideoElement`.
    #[wasm_bindgen(js_name = setVideoCard)]
    #[allow(clippy::too_many_arguments)]
    pub fn set_video_card(&mut self, id: &str, x: f64, y: f64, w: f64, h: f64, order: f64, play: bool, radius: f64) {
        self.set_shader_card(id, x, y, w, h, order, play, radius);
        if let Some(i) = self.card_index(id)
            && self.cards[i].video.is_none()
        {
            self.cards[i].video = Some(VideoSrc { el: None, last_time: -1.0, forced: false, want: false, told_play: false, seen_ready: false });
        }
    }

    /// The `<video>` element a video card draws from (the page sets src, loop and muted; null detaches
    /// it). The engine calls play() and pause() on it as the card is admitted or not, and copies a
    /// frame only when its time moved.
    #[wasm_bindgen(js_name = setVideoElement)]
    pub fn set_video_element(&mut self, id: &str, el: Option<web_sys::HtmlVideoElement>) -> bool {
        let Some(i) = self.card_index(id) else { return false };
        let Some(v) = &mut self.cards[i].video else { return false };
        if v.el == el {
            return true;
        }
        v.set_playing(false);
        v.el = el;
        v.told_play = false;
        // The old clip's frame no longer stands for the card: the new one's first frame is wanted.
        let (has_frame, want, last) = sh::on_new_video_source();
        (v.want, v.last_time) = (want, last);
        self.cards[i].has_frame = has_frame;
        self.cards[i].shows = "";
        self.dirty = true;
        true
    }

    /// The person pressed play (true) or pause (false) in the card's controls. A forced card plays like
    /// a hovered one (first in line, outside the budget up to its ceiling) while it is on screen.
    #[wasm_bindgen(js_name = setVideoForced)]
    pub fn set_video_forced(&mut self, id: &str, on: bool) -> bool {
        let Some(i) = self.card_index(id) else { return false };
        let Some(v) = &mut self.cards[i].video else { return false };
        v.forced = on;
        self.cards[i].next_due = 0.0;
        self.dirty = true;
        true
    }

    /// Draw the element's current frame on a still card at the next frame (after a seek or scrub).
    #[wasm_bindgen(js_name = wantVideoFrame)]
    pub fn want_video_frame(&mut self, id: &str) -> bool {
        let Some(i) = self.card_index(id) else { return false };
        let Some(v) = &mut self.cards[i].video else { return false };
        v.want = true;
        self.dirty = true;
        true
    }

    /// Set a card's WGSL (`fn shade(p: vec2<f32>) -> vec4<f32>`, see shaders.rs). Resolves to
    /// `{ ok, errors: [{line, col, message}], stale?, unchanged? }`. A source that fails our checks
    /// never reaches the GPU. While it compiles (and if it fails) the last good one keeps running. A
    /// compile overtaken by a newer source resolves with `stale: true` and is dropped.
    #[wasm_bindgen(js_name = setShaderSource)]
    pub fn set_shader_source(&mut self, id: &str, source: &str) -> js_sys::Promise {
        let resolved = |v: serde_json::Value| js_sys::Promise::resolve(&json(&v));
        let Some(i) = self.card_index(id).filter(|&i| !self.cards[i].is_video()) else {
            return resolved(serde_json::json!({ "ok": false, "errors": [{ "line": 0, "col": 0, "message": format!("no shader card \"{id}\"") }] }));
        };
        let hash = sh::source_hash(source);
        {
            let c = &self.cards[i];
            if c.hash == hash && c.sgen > 0 {
                let b = c.compiled.borrow();
                let errors: &[SrcError] = match &b.status {
                    Status::Failed(e) => e,
                    _ => &[],
                };
                return resolved(serde_json::json!({ "ok": !matches!(b.status, Status::Failed(_)), "errors": errors, "unchanged": true, "compiling": matches!(b.status, Status::Compiling) }));
            }
        }
        if let Err(errors) = sh::check_source(source) {
            let c = &mut self.cards[i];
            c.hash = hash;
            c.sgen += 1;
            let mut b = c.compiled.borrow_mut();
            b.sgen = c.sgen;
            b.status = Status::Failed(errors.clone());
            b.pending = None;
            return resolved(serde_json::json!({ "ok": false, "errors": errors }));
        }
        self.shader_gpu();
        let device = self.gpu.device().clone();
        let sg = self.shader_gpu.as_ref().expect("built above");
        let c = &mut self.cards[i];
        c.hash = hash;
        c.sgen += 1;
        c.lines = sh::user_lines(source);
        let sgen = c.sgen;
        {
            let mut b = c.compiled.borrow_mut();
            b.sgen = sgen;
            b.status = Status::Compiling;
        }
        let fut = sg.compile(&device, c, source);
        let compiled = c.compiled.clone();
        self.dirty = true;
        wasm_bindgen_futures::future_to_promise(async move {
            let errors = fut.await;
            let mut b = compiled.borrow_mut();
            if b.sgen != sgen {
                return Ok(json(&serde_json::json!({ "ok": false, "stale": true, "errors": [] })));
            }
            b.status = if errors.is_empty() { Status::Ready } else { Status::Failed(errors.clone()) };
            if !errors.is_empty() {
                b.pending = None;
            }
            b.fresh = true;
            Ok(json(&serde_json::json!({ "ok": errors.is_empty(), "errors": errors })))
        })
    }

    /// Set a card's `u.params` (up to 128 floats; missing and non-finite ones are 0). Paper Shaders cards
    /// keep their uniforms there (src/paper.ts), so a slider changes the next frame without a compile. A
    /// card that is not playing draws a new still (the old one shows until then).
    #[wasm_bindgen(js_name = setShaderParams)]
    pub fn set_shader_params(&mut self, id: &str, params: &[f32]) -> bool {
        let Some(i) = self.card_index(id).filter(|&i| !self.cards[i].is_video()) else { return false };
        let p = sh::params_from(params);
        let c = &mut self.cards[i];
        if c.params == p {
            return true;
        }
        c.params = p;
        c.snapped = false;
        if let Some(t) = &mut c.tex {
            // Drawn for no size: the still is stale, and the picture in it stays until the new one is drawn.
            t.want = Some((0, 0));
        }
        self.dirty = true;
        true
    }

    #[wasm_bindgen(js_name = removeShader)]
    pub fn remove_shader(&mut self, id: &str) -> bool {
        let Some(i) = self.card_index(id).filter(|&i| self.cards[i].fill.is_none()) else { return false };
        let mut c = self.cards.remove(i);
        if let Some(v) = &mut c.video {
            v.set_playing(false);
        }
        if let Some(t) = &c.tex {
            self.shader_bytes -= t.bytes();
        }
        self.dirty = true;
        true
    }

    /// The pointer is over card `id` at (x, y) card px (pressed: a button is down). An empty id
    /// clears hover. A hovered card plays at 60 fps, even with autoplay off, within a hard ceiling.
    #[wasm_bindgen(js_name = setShaderHover)]
    pub fn set_shader_hover(&mut self, id: &str, x: f64, y: f64, pressed: bool) {
        for c in &mut self.cards {
            let m = (c.id == id).then_some([x as f32, y as f32, 1.0, if pressed { 1.0 } else { 0.0 }]);
            if m.is_some() != c.mouse.is_some() {
                c.next_due = 0.0;
            }
            c.mouse = m;
        }
        self.dirty = true;
    }

    /// `visible`: the window shows (false pauses every card). `autoplay`: cards play on their own
    /// (false under Reduce Motion: only a hovered card plays).
    #[wasm_bindgen(js_name = setShadersRunning)]
    pub fn set_shaders_running(&mut self, visible: bool, autoplay: bool) {
        self.shaders_hidden = !visible;
        self.shaders_autoplay = autoplay;
        self.dirty = true;
    }

    /// Snapshot mode (freeze): every visible card shows its frame at t = 2 s, rendered once.
    #[wasm_bindgen(js_name = setShaderSnapshot)]
    pub fn set_shader_snapshot(&mut self, on: bool) {
        self.shader_snapshot = on;
        for c in &mut self.cards {
            c.snapped = false;
        }
        self.dirty = true;
    }

    /// Show a cached poster (a PNG decoded to an ImageBitmap, straight alpha) on card `id` until it
    /// plays. The copy premultiplies, so the compositor treats it like a live frame.
    #[wasm_bindgen(js_name = setShaderPoster)]
    pub fn set_shader_poster(&mut self, id: &str, bitmap: web_sys::ImageBitmap) -> bool {
        let Some(i) = self.card_index(id) else { return false };
        let full = (bitmap.width(), bitmap.height());
        if full.0 == 0 || full.1 == 0 {
            return false;
        }
        // A video card shows its poster like its frames: cropped to the card (object-fit: cover).
        let crop = if self.cards[i].is_video() { sh::cover_crop(full, self.cards[i].w / self.cards[i].h) } else { [0.0, 0.0, 1.0, 1.0] };
        let size = sh::crop_px(full, crop);
        let origin = wgpu::Origin2d { x: ((f64::from(full.0) * f64::from(crop[0])).round() as u32).min(full.0 - size.0), y: ((f64::from(full.1) * f64::from(crop[1])).round() as u32).min(full.1 - size.1) };
        self.card_tex(i, size);
        let c = &mut self.cards[i];
        let Some(t) = &c.tex else { return false };
        if t.size != size {
            return false; // the texture budget gave it less room than the bitmap needs
        }
        self.gpu.queue().copy_external_image_to_texture(
            &wgpu::CopyExternalImageSourceInfo { source: wgpu::ExternalImageSource::ImageBitmap(bitmap), origin, flip_y: false },
            wgpu::CopyExternalImageDestInfo { texture: &t.tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All, color_space: wgpu::PredefinedColorSpace::Srgb, premultiplied_alpha: true },
            wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
        );
        c.has_frame = true;
        c.shows = "bitmap";
        // A cached poster stands for the card at any size until the card draws a frame of its own.
        if let Some(t) = &mut c.tex {
            t.want = None;
        }
        self.dirty = true;
        true
    }

    /// Render card `id` offscreen at time `t` (s), its long side at most `max_side` px, three times,
    /// and measure it. Resolves to `{ width, height, msPerFrame, msPerMpx, pixels? }` (`pixels`:
    /// straight-alpha RGBA8 rows, when `read`). The GPU time is the gap between two
    /// onSubmittedWorkDone callbacks around the work: a latency estimate, not a timestamp query
    /// (the device vello creates has no timestamp-query feature). Also updates the card's cost.
    #[wasm_bindgen(js_name = renderShaderFrame)]
    pub fn render_shader_frame(&mut self, id: &str, t: f64, max_side: f64, read: bool) -> js_sys::Promise {
        let Some(i) = self.card_index(id) else { return js_sys::Promise::reject(&JsValue::from_str(&format!("no shader card \"{id}\""))) };
        if self.cards[i].is_video() {
            return js_sys::Promise::reject(&JsValue::from_str("a video card has no shader"));
        }
        if self.cards[i].take_compiled() {
            self.cards[i].new_pipeline();
            self.dirty = true;
        }
        if !self.cards[i].ready() {
            return js_sys::Promise::reject(&JsValue::from_str("the shader has not compiled"));
        }
        let c = &self.cards[i];
        let k = (max_side.clamp(16.0, 2048.0) / c.w.max(c.h)).min(4.0);
        let size = ((c.w * k).round().max(1.0) as u32, (c.h * k).round().max(1.0) as u32);
        let (device, queue) = (self.gpu.device().clone(), self.gpu.queue().clone());
        let tex = new_tex(&device, size, "shader frame");
        const RUNS: u32 = 3;
        let before = work_done(&queue);
        for _ in 0..RUNS {
            c.draw(&device, &queue, &tex, size, t, 0.0, (t * 60.0) as u64, false);
        }
        let after = work_done(&queue);
        let pixels = read.then(|| read_back(&device, &queue, &tex, size));
        let (cost, compiled, sgen) = (c.cost.clone(), c.compiled.clone(), c.sgen);
        let mpx = f64::from(size.0) * f64::from(size.1) / 1e6;
        wasm_bindgen_futures::future_to_promise(async move {
            let (t1, t2) = (before.await, after.await);
            // Its draws and the read-back copy are submitted: wgpu's WebGPU backend leaves a dropped texture to
            // the JS garbage collector (see gpu.rs GpuTile), so it is destroyed here.
            tex.destroy();
            let per = ((t2 - t1) / f64::from(RUNS)).max(0.0);
            let k = ((per - 0.05).max(0.0) / mpx).max(0.1);
            // The source may have been replaced while this ran: its measurement is not the new one's cost.
            let now_gen = compiled.borrow().sgen;
            cost.set(sh::apply_cost(cost.get(), k, sgen, now_gen, false));
            let v = json(&serde_json::json!({ "width": size.0, "height": size.1, "msPerFrame": per, "msPerMpx": k, "timing": "onSubmittedWorkDone latency estimate" }));
            if let Some(p) = pixels {
                let px = p.await.map_err(|e| JsValue::from_str(&e))?;
                let arr = js_sys::Uint8Array::from(px.as_slice());
                let _ = js_sys::Reflect::set(&v, &"pixels".into(), &arr);
            }
            Ok(v)
        })
    }

    /// Milliseconds until the next playing card's frame is due (the page sleeps until then instead of
    /// drawing every display frame), or -1 when nothing plays.
    #[wasm_bindgen(js_name = shaderWakeMs)]
    pub fn shader_wake_ms(&self) -> f64 {
        let t = now();
        self.cards.iter().filter(|c| c.admitted).map(|c| (c.next_due - sh::SLACK_MS - t).max(0.0)).fold(-1.0, |a: f64, b| if a < 0.0 { b } else { a.min(b) })
    }

    /// Per-card state and the last frame's shader work.
    #[wasm_bindgen(js_name = shaderStats)]
    pub fn shader_stats(&self) -> JsValue {
        let f = self.shader_frame;
        let cards: Vec<serde_json::Value> = self
            .cards
            .iter()
            .map(|c| {
                let b = c.compiled.borrow();
                let (status, errors): (&str, &[SrcError]) = match &b.status {
                    Status::Empty => ("empty", &[]),
                    Status::Compiling => ("compiling", &[]),
                    Status::Ready => ("ready", &[]),
                    Status::Failed(e) => ("error", e),
                };
                serde_json::json!({
                    "id": c.id, "status": status, "errors": errors, "running": c.ready(), "playing": c.admitted, "hovered": c.mouse.is_some(),
                    "msPerMpx": c.cost.get(), "texture": c.tex.as_ref().map(|t| [t.size.0, t.size.1]), "shows": c.shows,
                    "time": c.video.as_ref().map_or(c.clock.t, VideoSrc::time), "renders": c.renders, "lastRenderAt": c.last_render,
                    "kind": if c.is_video() { "video" } else if c.fill.is_some() { "fill" } else { "shader" },
                    "node": c.fill.as_ref().map(|l| l.node.clone()),
                    "native": c.video.as_ref().map(|v| { let n = v.native(); [n.0, n.1] }),
                })
            })
            .collect();
        json(&serde_json::json!({
            "cards": cards, "rendered": f.rendered, "posters": f.posters, "playing": f.playing, "visible": f.visible, "deferred": f.deferred,
            "predictedMs": f.predicted_ms, "budgetMs": sh::GPU_BUDGET_MS, "maxPlaying": sh::MAX_PLAYING, "textureBytes": self.shader_bytes, "textureBudget": sh::TEXTURE_BUDGET,
            "hidden": self.shaders_hidden, "autoplay": self.shaders_autoplay, "snapshot": self.shader_snapshot,
            "timestampQuery": self.gpu.device().features().contains(wgpu::Features::TIMESTAMP_QUERY),
            "videoCopyMsPerMpx": self.video_copy_k(), "videoCopyMeasured": self.video_k.get(), "stagingBytes": self.staging.iter().map(Staging::bytes).sum::<u64>(), "videoUploads": self.video_uploads,
        }))
    }

    /// Give card `i` a texture of `size` (keeping the one it has when the size matches), within the
    /// shader texture budget: cards long out of view give theirs up first; if it still does not fit,
    /// the card gets a smaller texture in what is left (its quad scales), or none.
    fn card_tex(&mut self, i: usize, size: (u32, u32)) {
        // A shader fill's texture is its placeholder's size, made by `sync_fills`.
        if self.cards[i].fill.is_some() {
            return;
        }
        let asked = size;
        let bytes = |s: (u32, u32)| u64::from(s.0) * u64::from(s.1) * 4;
        let own = self.cards[i].tex.as_ref().map_or(0, |t| t.bytes());
        let mut free = sh::TEXTURE_BUDGET.saturating_sub(self.shader_bytes - own);
        if bytes(size) > free {
            let frame = self.frame_no;
            let mut far: Vec<usize> = (0..self.cards.len()).filter(|&k| k != i && self.cards[k].fill.is_none() && self.cards[k].tex.is_some() && self.cards[k].seen_frame + 2 < frame).collect();
            far.sort_by_key(|&k| self.cards[k].seen_frame);
            for k in far {
                if bytes(size) <= free {
                    break;
                }
                if let Some(t) = self.cards[k].tex.take() {
                    self.shader_bytes -= t.bytes();
                    free += t.bytes();
                    self.cards[k].has_frame = false;
                }
            }
        }
        let mut size = size;
        if bytes(size) > free {
            let k = (free as f64 / bytes(size) as f64).sqrt();
            size = ((f64::from(size.0) * k).floor() as u32, (f64::from(size.1) * k).floor() as u32);
        }
        if let Some(t) = &mut self.cards[i].tex
            && t.size == size
        {
            t.want = Some(asked);
            return;
        }
        if let Some(old) = self.cards[i].tex.take() {
            self.shader_bytes -= old.bytes();
        }
        self.cards[i].has_frame = false;
        if !sh::renderable(size) {
            // No room (or too small): nothing to draw into this frame, so no frame is waited for.
            self.cards[i].denied_at = self.frame_no;
            return;
        }
        let tex = new_tex(self.gpu.device(), size, "shader card");
        let bind = self.gpu.bind_texture(&tex);
        self.shader_bytes += bytes(size);
        self.cards[i].tex = Some(crate::shade::CardTex { tex, bind, size, want: Some(asked) });
    }

    /// The texture size card `c` shows at now (its current texture's when that is close enough), or
    /// `None` when it is too small to draw.
    fn card_size(&self, c: &Card, moving: bool) -> Option<(u32, u32)> {
        if c.fill.is_some() {
            return c.tex.as_ref().map(|t| t.size);
        }
        let cap = sh::card_cap(moving, c.video.as_ref().map(|v| v.native()), c.cost.get(), c.w / c.h);
        let want = sh::tex_size(c.w, c.h, self.cam.2, self.dpr, cap)?;
        Some(match &c.tex {
            Some(t) if sh::keep_size(t.size, want, moving) => t.size,
            _ => want,
        })
    }

    /// A card that is not playing needs a new still picture at `size` (none yet, or drawn for another size).
    fn still_stale(c: &Card, size: (u32, u32)) -> bool {
        sh::needs_still(c.has_frame, c.tex.as_ref().and_then(|t| t.want), size)
    }

    /// Is any card's frame due, or is there shader work for this frame?
    fn shaders_due(&mut self, t: f64) -> bool {
        let mut due = false;
        for c in &mut self.cards {
            if let Some(v) = &mut c.video {
                // Metadata arrived (or the element went): admission changes.
                let ready = v.has_metadata();
                if ready != v.seen_ready {
                    v.seen_ready = ready;
                    due = true;
                }
                if c.admitted && v.ended() {
                    // Played to its end: the frame gives its slot back (rescheduling every 8 ms for a new frame that
                    // never comes kept it, and the page awake, for good), and its last frame is drawn as the still
                    // (it may have arrived between two copies).
                    v.want = true;
                    due = true;
                    continue;
                }
                let reached = c.admitted && t >= c.next_due - sh::SLACK_MS;
                if sh::video_needs_frame(c.admitted, reached, v.has_frame(), c.has_frame, v.want, v.time(), v.last_time) && (c.admitted || c.seen_frame == self.frame_no) {
                    due = true;
                } else if reached {
                    // Due, but the video has no new frame: look again in half a display frame.
                    c.next_due = t + 8.0;
                }
                continue;
            }
            if c.take_compiled() {
                c.new_pipeline();
                due = true;
            }
            if c.admitted && t >= c.next_due - sh::SLACK_MS {
                due = true;
            }
            if !c.probe_seen && !c.probing.get() {
                // A cost probe finished: the card may play now.
                c.probe_seen = true;
                due = true;
            }
        }
        due
    }

    /// Compiles or cost probes in flight: the page should keep calling frame().
    fn shaders_waiting(&self) -> bool {
        self.cards.iter().any(|c| c.compiling() || c.probing.get())
    }

    /// Visible cards that still need a still picture (posters render one per frame). The same tests as
    /// `run_shaders` applies, so a card it would skip never keeps frames coming.
    fn shader_first_frames_left(&self, view: Rect, moving: bool) -> bool {
        self.cards.iter().any(|c| {
            if c.denied_at == self.frame_no || !c.world().overlaps(view) || c.admitted {
                return false;
            }
            let Some(size) = self.card_size(c, moving) else { return false };
            if let Some(v) = &c.video {
                return (Self::still_stale(c, size) || v.want) && v.has_frame();
            }
            let need = if self.shader_snapshot { !c.snapped } else { Self::still_stale(c, size) };
            let cost = c.cost.get();
            need && c.ready() && cost > 0.0 && sh::predict_ms(cost, size) <= sh::HOVER_CEIL_MS * 2.0
        })
    }

    /// Start a cost probe for card `i`: the gap between two onSubmittedWorkDone callbacks around three
    /// frames at 256 px. That callback resolves a few ms late, which swamps a light shader at that size,
    /// so a probe that comes back under 1 ms per frame measures again with four frames at 768 px (a
    /// heavy shader never gets the big round).
    fn probe(&mut self, i: usize) {
        let (device, queue) = (self.gpu.device().clone(), self.gpu.queue().clone());
        let c = &self.cards[i];
        let Some(off) = c.offscreen() else { return };
        let fit = |side: f64| {
            let k = side / c.w.max(c.h);
            ((c.w * k).round().max(1.0) as u32, (c.h * k).round().max(1.0) as u32)
        };
        let (small, big) = (fit(256.0), fit(768.0));
        let (cost, probing, compiled, sgen) = (c.cost.clone(), c.probing.clone(), c.compiled.clone(), c.sgen);
        probing.set(true);
        self.cards[i].probe_seen = false;
        let round = move |device: &wgpu::Device, queue: &wgpu::Queue, size: (u32, u32), n: u32| {
            let tex = new_tex(device, size, "shader probe");
            let before = work_done(queue);
            for k in 0..n {
                off.draw(device, queue, &tex, size, sh::POSTER_T + f64::from(k) * 0.033, u64::from(k));
            }
            let after = work_done(queue);
            let mpx = f64::from(size.0) * f64::from(size.1) / 1e6 * f64::from(n);
            async move {
                let (t1, t2) = (before.await, after.await);
                tex.destroy();
                ((t2 - t1).max(0.0), mpx)
            }
        };
        let first = round(&device, &queue, small, 3);
        wasm_bindgen_futures::spawn_local(async move {
            let (ms, mpx) = first.await;
            let mut k = ((ms - 3.0 * 0.05).max(0.0) / mpx).max(0.1);
            if ms / 3.0 < 1.0 && compiled.borrow().sgen == sgen {
                let (ms2, mpx2) = round(&device, &queue, big, 4).await;
                k = ((ms2 - 4.0 * 0.05).max(0.0) / mpx2).max(0.1);
            }
            // A probe of a pipeline that has since been replaced measures nothing useful.
            let now_gen = compiled.borrow().sgen;
            cost.set(sh::apply_cost(cost.get(), k, sgen, now_gen, true));
            probing.set(false);
        });
    }

    /// Admit, size and render the shader cards for this frame. Returns the predicted GPU ms submitted.
    fn run_shaders(&mut self, t0: f64, view: Rect, moving: bool, tiles_pending: bool) -> f64 {
        self.shader_frame = ShaderFrame::default();
        if self.cards.is_empty() {
            self.drop_staging(t0);
            return 0.0;
        }
        let (cx, cy, z) = self.cam;
        let dpr = self.dpr;
        let frame = self.frame_no;
        let (dw, dh) = self.gpu.size();
        let screen = Rect::new(0.0, 0.0, f64::from(dw), f64::from(dh));
        // Measure new pipelines first (a card is not eligible to play until its cost is known): visible
        // cards only, one start per frame, a bounded number in flight.
        let probes: Vec<sh::ProbeCand> = self
            .cards
            .iter()
            .map(|c| {
                let again = c.cost.get() > 5.0 && c.probes < 4 && t0 - c.last_probe > 1000.0;
                let on = to_device(c.world(), (cx, cy, z), dpr).intersect(screen);
                sh::ProbeCand { wants: !c.is_video() && c.ready() && !c.probing.get() && (c.cost.get() == 0.0 || again), visible: !self.shaders_hidden && c.world().overlaps(view), area: on.width().max(0.0) * on.height().max(0.0) }
            })
            .collect();
        let in_flight = self.cards.iter().filter(|c| c.probing.get()).count();
        if let Some(i) = sh::pick_probe(&probes, in_flight) {
            self.cards[i].probes += 1;
            self.cards[i].last_probe = t0;
            self.probe(i);
        }
        let copy_k = self.video_copy_k();
        let mut sizes: Vec<Option<(u32, u32)>> = Vec::with_capacity(self.cards.len());
        let mut cands: Vec<Cand> = Vec::with_capacity(self.cards.len());
        for c in &mut self.cards {
            let world = c.world();
            let visible = world.overlaps(view);
            if visible {
                c.seen_frame = frame;
                self.shader_frame.visible += 1;
            }
            let size = if c.fill.is_some() {
                // A fill renders at its placeholder's size, whatever the zoom (`paint::fill_tex_size`).
                c.tex.as_ref().map(|t| t.size).filter(|_| visible)
            } else {
                let cap = sh::card_cap(moving, c.video.as_ref().map(|v| v.native()), c.cost.get(), c.w / c.h);
                let want = if visible { sh::tex_size(c.w, c.h, z, dpr, cap) } else { None };
                match (&c.tex, want) {
                    (Some(t), Some(w)) if sh::keep_size(t.size, w, moving) => Some(t.size),
                    (_, w) => w,
                }
            };
            let on = to_device(world, (cx, cy, z), dpr).intersect(screen);
            let area = on.width().max(0.0) * on.height().max(0.0);
            // The pointer on it, or (a video) the person pressed play: first in line.
            let hovered = c.mouse.is_some() || c.video.as_ref().is_some_and(|v| v.forced);
            // Autoplay (the card's and the page's: Reduce Motion turns it off) or the pointer on it.
            let allowed = !self.shaders_hidden && !self.shader_snapshot && ((c.play && self.shaders_autoplay) || hovered);
            let (cost, measured) = match &c.video {
                Some(v) => (size.map_or(f64::INFINITY, |s| sh::video_ms(copy_k, v.native(), s)), true),
                None => (size.map_or(f64::INFINITY, |s| sh::predict_ms(c.cost.get(), s)), c.cost.get() > 0.0),
            };
            // A video played to its end holds no slot until the page seeks it back (its play button does).
            let ended = c.video.as_ref().is_some_and(VideoSrc::ended);
            cands.push(Cand { area, cost, hovered, eligible: visible && c.ready() && measured && size.is_some() && allowed && !ended });
            sizes.push(size);
        }
        let admitted = sh::admit(&cands, sh::GPU_BUDGET_MS, sh::MAX_PLAYING);
        let mut spent = 0.0;
        let mut fill_frames: Vec<usize> = Vec::new();
        let mut first_frame_done = false;
        for i in 0..self.cards.len() {
            let Some(size) = sizes[i] else {
                self.unadmit(i);
                continue;
            };
            if admitted[i] {
                self.shader_frame.playing += 1;
                let c = &mut self.cards[i];
                if !c.admitted {
                    c.admitted = true;
                    c.next_due = 0.0;
                }
                if let Some(v) = &mut c.video {
                    v.set_playing(true);
                }
                if t0 < c.next_due - sh::SLACK_MS {
                    continue;
                }
                // Missing tiles go first: a card's frame waits (it stays due) unless it is hovered.
                if tiles_pending && !cands[i].hovered && c.has_frame {
                    self.shader_frame.deferred += 1;
                    continue;
                }
                let drew = if let Some(v) = &c.video {
                    // A frame only when the video's time moved (a 24 fps video at the 30 fps deadline skips some).
                    if sh::video_needs_frame(true, true, v.has_frame(), c.has_frame, v.want, v.time(), v.last_time) {
                        self.upload_video(i, size, t0)
                    } else {
                        self.cards[i].next_due = t0 + 8.0;
                        continue;
                    }
                } else {
                    self.card_tex(i, size);
                    let (device, queue) = (self.gpu.device().clone(), self.gpu.queue().clone());
                    let c = &mut self.cards[i];
                    let dt = c.clock.tick(t0);
                    let Some(t) = &c.tex else { continue };
                    c.draw(&device, &queue, &t.tex, t.size, c.clock.t, dt, c.clock.frame, true);
                    true
                };
                if !drew {
                    continue;
                }
                let c = &mut self.cards[i];
                if c.fill.is_some() {
                    fill_frames.push(i);
                }
                c.has_frame = true;
                c.shows = "live";
                c.renders += 1;
                c.last_render = t0;
                c.next_due = if cands[i].hovered {
                    t0 + sh::PERIOD_HOVER_MS
                } else {
                    if self.shader_phase <= t0 + sh::SLACK_MS {
                        self.shader_phase = t0 + sh::PERIOD_MS;
                    }
                    self.shader_phase
                };
                spent += cands[i].cost;
                self.shader_frame.rendered += 1;
                continue;
            }
            self.unadmit(i);
            let c = &self.cards[i];
            let visible = c.seen_frame == frame;
            if let Some(v) = &c.video {
                // Still: its first picture (when no poster came), or the frame after a seek. One per frame.
                let want = v.want || Self::still_stale(c, size);
                if visible && !first_frame_done && sh::video_needs_frame(false, false, v.has_frame(), c.has_frame, want, v.time(), v.last_time) && self.upload_video(i, size, t0) {
                    first_frame_done = true;
                    let c = &mut self.cards[i];
                    c.has_frame = true;
                    c.shows = "frame";
                    c.renders += 1;
                    spent += cands[i].cost;
                    self.shader_frame.posters += 1;
                }
                continue;
            }
            // Not playing: show a frame at t = 2 s (a poster, or the snapshot frame). One per frame,
            // and not for a card too heavy to draw once inside a frame.
            let need = if self.shader_snapshot { !c.snapped } else { Self::still_stale(c, size) };
            let affordable = c.cost.get() > 0.0 && sh::predict_ms(c.cost.get(), size) <= sh::HOVER_CEIL_MS * 2.0;
            if !(visible && c.ready() && need && affordable) || (first_frame_done && !self.shader_snapshot) {
                continue;
            }
            first_frame_done = true;
            self.card_tex(i, size);
            let (device, queue) = (self.gpu.device().clone(), self.gpu.queue().clone());
            let c = &mut self.cards[i];
            let Some(t) = &c.tex else { continue };
            c.draw(&device, &queue, &t.tex, t.size, sh::POSTER_T, 0.0, (sh::POSTER_T * 30.0) as u64, false);
            if c.fill.is_some() {
                // Drawn for its size: the still is current (the fill's texture never changes size under it).
                if let Some(t) = &mut c.tex {
                    t.want = Some(t.size);
                }
                fill_frames.push(i);
            }
            c.has_frame = true;
            c.snapped = true;
            c.shows = "poster";
            c.renders += 1;
            spent += cands[i].cost;
            self.shader_frame.posters += 1;
        }
        self.drop_staging(t0);
        self.fill_frames(&fill_frames);
        self.shader_frame.predicted_ms = spent;
        spent
    }

    /// Shader fills that drew a frame: vello copies their textures again, and their boards draw that part again.
    fn fill_frames(&mut self, drawn: &[usize]) {
        for &i in drawn {
            let Some(f) = &self.cards[i].fill else { continue };
            self.gpu.fill_changed(&f.image);
            if let Some(b) = self.boards.iter_mut().find(|b| b.uid == f.board) {
                b.fill_frame(f.rect);
                self.fill_redraw = true;
                self.dirty = true;
            }
        }
    }

    /// Give every shader fill the boards draw a card of its own (compiled, sized, with its params) and its
    /// placeholder that card's texture; fills no board draws any more go, their textures with them.
    fn sync_fills(&mut self) {
        let mut want: Vec<(String, usize, usize)> = Vec::new();
        let mut live: HashSet<u64> = HashSet::new();
        for (bi, b) in self.boards.iter().enumerate() {
            for (fi, f) in b.fills.iter().enumerate() {
                want.push((fill_card_id(b.uid, &f.id), bi, fi));
                live.insert(f.image.data.id());
            }
        }
        if want.is_empty() && !self.cards.iter().any(|c| c.fill.is_some()) {
            return;
        }
        self.gpu.retain_fills(&live);
        let keep: HashSet<&str> = want.iter().map(|w| w.0.as_str()).collect();
        let gone: Vec<String> = self.cards.iter().filter(|c| c.fill.is_some() && !keep.contains(c.id.as_str())).map(|c| c.id.clone()).collect();
        for id in gone {
            self.remove_fill(&id);
        }
        for (cid, bi, fi) in want {
            let i = match self.card_index(&cid) {
                Some(i) => i,
                None => {
                    self.shader_gpu();
                    let mut card = self.shader_gpu.as_ref().expect("built above").card(self.gpu.device(), &cid);
                    let (b, f) = (&self.boards[bi], &self.boards[bi].fills[fi]);
                    card.fill = Some(crate::shade::FillLink { board: b.uid, node: f.id.clone(), image: f.image.clone(), rect: f.rect, token: 0, hash: 0, params: Vec::new() });
                    // Fills come before the cards in the list (a card's order is its widget index, 0 and up).
                    card.order = -1.0;
                    self.cards.push(card);
                    self.cards.sort_by(|a, b| a.order.total_cmp(&b.order));
                    self.card_index(&cid).expect("pushed above")
                }
            };
            let (b, f) = (&self.boards[bi], &self.boards[bi].fills[fi]);
            let (image, rect, sp, uid) = (f.image.clone(), f.rect, f.shader.clone(), b.uid);
            let (bx, by, w, h) = (b.x, b.y, f.w, f.h);
            let size = (image.width, image.height);
            let c = &mut self.cards[i];
            (c.x, c.y, c.w, c.h) = (bx + rect.x0, by + rect.y0, w.max(1.0), h.max(1.0));
            if c.play != sp.play {
                c.play = sp.play;
                if !sp.play {
                    c.clock.stop();
                }
            }
            // A texture of the placeholder's size (a resized node gets a new one; its shader draws it at once).
            let mut fresh = false;
            if c.tex.as_ref().is_none_or(|t| t.size != size) {
                let old = c.fill.as_ref().map_or(0, |l| l.token);
                if old != 0 {
                    self.gpu.detach_fill_texture(old);
                }
                if let Some(t) = self.cards[i].tex.take() {
                    self.fill_bytes -= t.bytes();
                }
                let tex = crate::shade::new_tex(self.gpu.device(), size, "shader fill");
                let bind = self.gpu.bind_texture(&tex);
                self.fill_bytes += u64::from(size.0) * u64::from(size.1) * 4;
                self.fill_token += 1;
                let token = self.fill_token;
                let c = &mut self.cards[i];
                c.tex = Some(crate::shade::CardTex { tex, bind, size, want: None });
                c.has_frame = false;
                c.snapped = false;
                if let Some(l) = &mut c.fill {
                    l.token = token;
                }
                fresh = true;
            }
            let c = &mut self.cards[i];
            let link = c.fill.as_mut().expect("a fill card");
            (link.image, link.rect, link.board) = (image.clone(), rect, uid);
            let new_src = link.hash != sp.hash;
            if link.params != sp.params {
                link.params = sp.params.clone();
                c.params = sh::params_from(&sp.params);
                c.snapped = false;
                if let Some(t) = &mut c.tex {
                    // The still is stale; the picture in it stays until the new one is drawn.
                    t.want = Some((0, 0));
                }
            }
            if new_src {
                link.hash = sp.hash;
                let _ = self.set_shader_source(&cid, &sp.source);
            }
            let token = self.cards[i].fill.as_ref().map_or(0, |l| l.token);
            let tex = self.cards[i].tex.as_ref().map(|t| t.tex.clone());
            if let Err(e) = self.gpu.attach_fill(&image, tex.as_ref().map(|t| (t, token))) {
                self.push_error(e);
            }
            if fresh && self.cards[i].ready() {
                // The new texture is empty: draw its frame now, before a tile copies it.
                let (device, queue) = (self.gpu.device().clone(), self.gpu.queue().clone());
                let c = &mut self.cards[i];
                if let Some(t) = &c.tex {
                    let tt = if c.admitted { c.clock.t } else { sh::POSTER_T };
                    c.draw(&device, &queue, &t.tex, t.size, tt, 0.0, c.clock.frame, false);
                    c.has_frame = true;
                }
            }
        }
    }

    /// A shader fill no board draws any more: its placeholders let go of the texture, then the card goes.
    fn remove_fill(&mut self, id: &str) {
        let Some(i) = self.card_index(id) else { return };
        if let Some(l) = &self.cards[i].fill
            && l.token != 0
        {
            self.gpu.detach_fill_texture(l.token);
        }
        let c = self.cards.remove(i);
        if let Some(t) = &c.tex {
            self.fill_bytes -= t.bytes();
        }
        self.dirty = true;
    }

    /// Card `i` is not playing (any more): its clock stops, a video is paused.
    fn unadmit(&mut self, i: usize) {
        let c = &mut self.cards[i];
        if c.admitted {
            c.admitted = false;
            c.clock.stop();
        }
        if let Some(v) = &mut c.video {
            v.set_playing(false);
        }
    }

    /// GPU ms per decoded megapixel the admission uses for a video copy: the default until a copy is
    /// measured, then the lowest measurement kept inside 1x to 4x the default (the measurement is a
    /// callback latency, which only ever inflates it).
    fn video_copy_k(&self) -> f64 {
        let m = self.video_k.get();
        if m > 0.0 { m.clamp(sh::VIDEO_COPY_MS_PER_MPX, sh::VIDEO_COPY_MS_PER_MPX * 4.0) } else { sh::VIDEO_COPY_MS_PER_MPX }
    }

    /// Copy video card `i`'s current frame into its texture (sized `size`, inside the texture budget).
    /// Every 60th upload is measured. Returns false when nothing could be drawn.
    fn upload_video(&mut self, i: usize, size: (u32, u32), t0: f64) -> bool {
        let Some(el) = self.cards[i].video.as_ref().and_then(|v| v.el.clone()) else { return false };
        if !self.cards[i].video.as_ref().is_some_and(VideoSrc::has_frame) {
            return false;
        }
        // The element's current frame as a VideoFrame: creating it fails (and is caught) when the element has
        // no decoded frame to give, where copying from the element itself would throw inside the copy.
        let Ok(frame) = web_sys::VideoFrame::new_with_html_video_element(&el) else { return false };
        let native = (frame.display_width(), frame.display_height());
        if native.0 == 0 || native.1 == 0 {
            frame.close();
            return false;
        }
        self.card_tex(i, size);
        let Some(tex) = self.cards[i].tex.as_ref().map(|t| (t.tex.clone(), t.size)) else {
            // No texture (the card budget is full): the frame holds a decoder buffer until closed.
            frame.close();
            return false;
        };
        let device = self.gpu.device().clone();
        let queue = self.gpu.queue().clone();
        if self.video_gpu.is_none() {
            self.video_gpu = Some(VideoGpu::new(&device));
        }
        let si = match self.staging.iter().position(|s| s.size == native) {
            Some(k) => k,
            None => {
                let st = self.video_gpu.as_ref().expect("built above").staging(&device, native);
                self.staging.push(st);
                self.staging.len() - 1
            }
        };
        self.staging[si].used = t0;
        let measure = self.video_uploads % 60 == 1;
        let before = measure.then(|| work_done(&queue));
        let crop = sh::cover_crop(native, self.cards[i].w / self.cards[i].h);
        self.video_gpu.as_ref().expect("built above").upload(&device, &queue, &frame, &self.staging[si], &tex.0, tex.1, crop);
        frame.close();
        if let Some(before) = before {
            let after = work_done(&queue);
            let k = self.video_k.clone();
            let mpx = f64::from(native.0) * f64::from(native.1) / 1e6;
            wasm_bindgen_futures::spawn_local(async move {
                let (a, b) = (before.await, after.await);
                let m = ((b - a - 0.05).max(0.0) / mpx).max(0.005);
                k.set(if k.get() > 0.0 { k.get().min(m) } else { m });
            });
        }
        self.video_uploads += 1;
        let v = self.cards[i].video.as_mut().expect("checked above");
        v.last_time = v.time();
        v.want = false;
        self.dirty = true;
        true
    }

    /// Staging textures no video drew from for two seconds go.
    fn drop_staging(&mut self, t0: f64) {
        self.staging.retain(|s| t0 - s.used < 2000.0);
    }

    /// Composite quads for the cards that hold a picture and are in view.
    fn shader_quads(&self, quads: &mut Vec<(Source, Quad)>, view: Rect) {
        let (_, _, z) = self.cam;
        for c in &self.cards {
            let Some(t) = &c.tex else { continue };
            if c.fill.is_some() || !c.has_frame || !c.world().overlaps(view) {
                continue;
            }
            let d = to_device(c.world(), self.cam, self.dpr);
            let r = (c.radius * z * self.dpr) as f32;
            quads.push((Source::Premul(t.bind.clone()), Quad { rect: r32(d), uv: [0.0, 0.0, 1.0, 1.0], tint: [1.0, 1.0, 1.0, 1.0], scissor: None, extra: [d.width() as f32, d.height() as f32, r, 0.0] }));
        }
    }

    /// Topmost node under a canvas-relative CSS point, or null.
    #[wasm_bindgen(js_name = hitTest)]
    pub fn hit_test(&self, screen_x: f64, screen_y: f64) -> Option<String> {
        let (cx, cy, z) = self.cam;
        let p = Point::new((screen_x - cx) / z, (screen_y - cy) / z);
        // At rest boards are fitted to whole device pixels (`cache::fit_board`), each drawn up to a pixel from
        // where the world puts it: the point is taken back through the board's fit, so a click lands on the node
        // whose pixels are under it.
        let s = z * self.dpr;
        let fitted = now() - self.last_zoom >= SETTLE_MS;
        let (dev, cam_dev) = ((screen_x * self.dpr, screen_y * self.dpr), ((cx * self.dpr).round(), (cy * self.dpr).round()));
        self.boards.iter().rev().filter(|b| !b.hidden).find_map(|b| {
            let q = if fitted {
                let f = b.layout.aabb.first().copied().unwrap_or(Rect::ZERO);
                let at = fit_board((b.x, b.y), (f.x1, f.y1), b.ink, s).board_point(dev, s, cam_dev);
                Point::new(at.x + b.x, at.y + b.y)
            } else {
                p
            };
            (b.world_ink().contains(q) || b.world_root().contains(q)).then(|| b.hit(q).map(str::to_string)).flatten()
        })
    }

    /// Every node under a canvas-relative CSS point, topmost first, across the boards there (the topmost board's
    /// first). Right-click > Select layer lists them.
    #[wasm_bindgen(js_name = hitTestAll)]
    pub fn hit_test_all(&self, screen_x: f64, screen_y: f64) -> Vec<String> {
        let (cx, cy, z) = self.cam;
        let p = Point::new((screen_x - cx) / z, (screen_y - cy) / z);
        self.boards
            .iter()
            .rev()
            .filter(|b| !b.hidden && (b.world_ink().contains(p) || b.world_root().contains(p)))
            .flat_map(|b| b.hit_all(p).into_iter().map(str::to_string).collect::<Vec<_>>())
            .collect()
    }

    /// A text node's lines as drawn, in world coordinates: `[{x, top, baseline, bottom}]` (x: where the line's first
    /// letter starts), and its list markers `[{x, baseline}]`; null when it is no text. For QA: the editor's caret
    /// must sit where these say. Unrotated text only (a turned node reports its own axes).
    #[wasm_bindgen(js_name = textLines)]
    pub fn text_lines(&mut self, id: &str) -> JsValue {
        let Some(b) = self.boards.iter().find(|b| !b.hidden && b.doc.index_of(id).is_some()) else { return JsValue::NULL };
        let Some(i) = b.doc.index_of(id) else { return JsValue::NULL };
        let node = &b.doc.nodes[i];
        let Some(t) = node.text.as_ref() else { return JsValue::NULL };
        let pad = crate::layout::text_pad(node);
        let mut tb = self.text.build(t);
        self.text.finish_text(&mut tb, t, (b.layout.boxes[i].w - 2.0 * pad) as f32, Some((b.layout.boxes[i].h - 2.0 * pad) as f32));
        let (ox, oy) = b.layout.text_origin[i];
        let at = Affine::translate((b.x, b.y)) * b.layout.world[i] * Affine::translate((ox, oy));
        let p = |x: f64, y: f64| at * Point::new(x, y);
        let lines: Vec<serde_json::Value> = tb
            .line_boxes()
            .into_iter()
            .map(|[x, top, base, bottom, right]| {
                let (a, c) = (p(f64::from(x), f64::from(top)), p(f64::from(x), f64::from(bottom)));
                serde_json::json!({ "x": a.x, "top": a.y, "baseline": p(f64::from(x), f64::from(base)).y, "bottom": c.y, "right": p(f64::from(right), f64::from(top)).x })
            })
            .collect();
        let marks: Vec<serde_json::Value> = tb
            .marks()
            .into_iter()
            .map(|(l, x, y)| {
                let base = l.lines().next().map_or(0.0, |ln| f64::from(ln.metrics().baseline));
                let q = p(x, y + base);
                serde_json::json!({ "x": q.x, "baseline": q.y })
            })
            .collect();
        json(&serde_json::json!({ "lines": lines, "marks": marks }))
    }

    /// A node's bounding box in world coordinates `{x, y, w, h}`, or null.
    #[wasm_bindgen(js_name = nodeRect)]
    pub fn node_rect(&self, id: &str) -> JsValue {
        self.boards.iter().filter(|b| !b.hidden).find_map(|b| b.node_rect(id)).map_or(JsValue::NULL, |r| json(&rect_json(r)))
    }

    /// `nodeRect` when the caller knows the node's board: one board's index instead of every board's
    /// (a 1,000-board file spent seconds in `nodeRect`). Falls back to every board when it is not there.
    #[wasm_bindgen(js_name = nodeRectIn)]
    pub fn node_rect_in(&self, board: &str, id: &str) -> JsValue {
        self.pos_of(board).and_then(|p| self.boards[p].node_rect(id)).map_or_else(|| self.node_rect(id), |r| json(&rect_json(r)))
    }

    /// Ids of the boards intersecting the viewport.
    #[wasm_bindgen(js_name = boardsInView)]
    pub fn boards_in_view(&self) -> Vec<String> {
        let (cx, cy, z) = self.cam;
        let view = Rect::new(-cx / z, -cy / z, (self.css.0 - cx) / z, (self.css.1 - cy) / z);
        self.boards.iter().filter(|b| !b.hidden && b.world_ink().overlaps(view)).map(|b| b.id.clone()).collect()
    }

    /// What the page's timing poll asks every 16 ms: [tiles missing, slots blank, drawn at the exact scale (0 or 1)]
    /// of the last frame. stats() walks every board for its totals (4 ms with 5,000 boards: 1.5 s of an open).
    #[wasm_bindgen(js_name = pictureState)]
    pub fn picture_state(&self) -> Vec<f64> {
        vec![f64::from(self.last.missing), f64::from(self.last.blank), if self.last.exact { 1.0 } else { 0.0 }]
    }

    /// Timings and cache sizes of the last frame.
    pub fn stats(&self) -> JsValue {
        let s = self.last;
        json(&serde_json::json!({
            "adapter": self.gpu.adapter,
            "frames": self.frames,
            "frameCpuMs": s.cpu_ms,
            "tileRenderMs": s.tile_ms,
            "tilesRendered": s.tiles_rendered,
            "tilesMissing": s.missing,
            "tilesBlank": s.blank,
            "tileWork": { "failed": s.failed, "ahead": s.ahead, "parts": s.parts, "framePeriodMs": self.clock.period(), "panPerFrame": [self.pan.x, self.pan.y] },
            "blankDebug": self.last_blank,
            "standIns": s.fallbacks,
            "quads": s.quads,
            "gpuDoneMs": GPU_DONE_MS.with(|c| c.get()),
            "tileMpx": s.tile_mpx,
            "batchStop": s.batch_stop,
            // Since the engine started: tiles rendered whole, tiles brought up to date in place (only the part an
            // edit changed, or nothing when it changed none of it), and the px all their renders covered.
            "tilesWhole": self.whole_tiles,
            "tilesPartial": self.partial_tiles,
            "tilesBatched": self.batched_tiles,
            "renderedMpx": self.rendered_px / 1e6,
            "gpuModel": { "baseMs": GPU_BASE_MS.with(std::cell::Cell::get), "msPerMpx": GPU_MS_PER_MPX.with(std::cell::Cell::get) },
            "rendererInitMs": self.gpu.init_ms.get(),
            "scale": s.scale,
            "exactScale": s.exact,
            "boards": self.boards.len(),
            "hiddenBoards": self.boards.iter().filter(|b| b.hidden).count(),
            "visibleBoards": s.visible_boards,
            "nodes": self.boards.iter().map(|b| b.doc.nodes.len()).sum::<usize>(),
            "layoutMs": self.boards.iter().map(|b| b.layout_ms).sum::<f64>(),
            "paintMs": self.boards.iter().map(|b| b.paint_ms).sum::<f64>(),
            "tileCount": self.gpu.tiles.len(),
            "tileBytes": self.gpu.tiles.bytes,
            "tileBudget": self.gpu.tiles.budget,
            "tileBytesUsed": self.gpu.tiles.used_bytes(self.frame_no),
            // The small-tile atlas: its layers (each ATLAS_SIDE² x 4 bytes) and the cells in use.
            "atlasLayers": self.gpu.atlas_layers().0,
            "atlasCells": self.gpu.atlas_layers().1,
            "images": self.sources.len(),
            "imageLevels": self.mips.len(),
            "imageBytes": self.mips.bytes,
            "imageBudget": self.mips.budget,
            "effectBytes": self.gpu.job_bytes,
            "effectBudget": self.effect_budget,
            // Images boards near the view draw without pixels (no level attached, or its texture gone).
            "imagesUnattached": self.boards.iter().filter(|b| b.seen_frame == self.frame_no).map(|b| b.image_need.keys().filter(|u| self.sources.contains_key(*u) && b.image_levels.get(*u).and_then(|l| self.mips.get(u, u64::from(*l))).is_none()).count()).sum::<usize>(),
            "wasmBytes": wasm_bindgen::memory().dyn_into::<js_sys::WebAssembly::Memory>().map(|m| m.buffer().dyn_into::<js_sys::ArrayBuffer>().map(|b| b.byte_length()).unwrap_or(0)).unwrap_or(0),
            "fonts": self.fonts_seen.len(),
            "shapedTexts": self.text.shaped_len(),
            "camera": [self.cam.0, self.cam.1, self.cam.2],
            "dpr": self.dpr,
            "errors": self.errors,
        }))
    }

    /// Where WASM memory goes: font bytes, scene encodings, text layouts (glyph counts), nodes.
    #[wasm_bindgen(js_name = memoryReport)]
    pub fn memory_report(&self) -> JsValue {
        let scenes: usize = self.boards.iter().map(|b| crate::paint::scene_bytes(&b.scene) + b.jobs.iter().map(|j| j.scene.bytes()).sum::<usize>()).sum();
        let mut glyphs = 0usize;
        let mut layouts = 0usize;
        for b in &self.boards {
            for l in b.layout.texts.iter().flatten().filter_map(|t| t.layout.as_ref()) {
                layouts += 1;
                for line in l.lines() {
                    for item in line.items() {
                        if let parley::PositionedLayoutItem::GlyphRun(g) = item {
                            glyphs += g.glyphs().count();
                        }
                    }
                }
            }
        }
        json(&serde_json::json!({
            "fontBytes": self.font_bytes,
            "sceneBytes": scenes,
            "textLayouts": layouts,
            "glyphs": glyphs,
            "nodes": self.boards.iter().map(|b| b.doc.nodes.len()).sum::<usize>(),
            "boards": self.boards.len(),
            "hiddenBoards": self.boards.iter().filter(|b| b.hidden).count(),
        }))
    }

    /// Debug overlays: 1 = tile borders (red exact, blue power-of-two, orange stand-in),
    /// 2 = layout boxes of every node.
    #[wasm_bindgen(js_name = setDebug)]
    pub fn set_debug(&mut self, flags: u32) {
        let layout_changed = (flags ^ self.debug) & DEBUG_LAYOUT != 0;
        if (flags ^ self.debug) & DEBUG_NO_CULL != 0 {
            // The other way of rendering: every texture is drawn again.
            for b in &mut self.boards {
                b.generation += 1;
            }
        }
        self.debug = flags;
        if layout_changed {
            for b in &mut self.boards {
                let st = store_for(&self.sources, &self.mips, &b.images, &b.image_levels, &b.image_tiles, &b.image_picks);
                let o = BuildOptions { images: &st, debug_boxes: flags & DEBUG_LAYOUT != 0, now: &now, keep_jobs: false };
                b.repaint(&mut self.text, &o);
            }
            self.jobs_dirty = true;
        }
        self.dirty = true;
    }

    /// Canvas background behind the boards (#RRGGBB or #RRGGBBAA).
    #[wasm_bindgen(js_name = setBackground)]
    pub fn set_background(&mut self, color: &str) -> bool {
        match parse_color(color) {
            Some(c) => {
                self.gpu.bg = c;
                self.dirty = true;
                true
            }
            None => false,
        }
    }

    /// What text without `fontSize` / `lineHeight` inherits from the page (html.ts sets neither,
    /// so the browser uses the host page's values). Default 13 px / 1.45, the Canvas page body.
    /// `line_height` 0 means CSS `normal`. Every board is laid out again.
    #[wasm_bindgen(js_name = setTextDefaults)]
    pub fn set_text_defaults(&mut self, font_size: f32, line_height: f32) {
        self.text.default_size = if font_size > 0.0 { font_size } else { 13.0 };
        self.text.default_line_height = (line_height > 0.0).then_some(line_height);
        for b in &mut self.boards {
            let st = store_for(&self.sources, &self.mips, &b.images, &b.image_levels, &b.image_tiles, &b.image_picks);
            let o = BuildOptions { images: &st, debug_boxes: self.debug & DEBUG_LAYOUT != 0, now: &now, keep_jobs: false };
            b.relayout(&mut self.text, &o);
        }
        self.jobs_dirty = true;
        self.dirty = true;
    }

    /// Text dilation (macOS font smoothing): `factor` device px per ppem, capped at `max` device
    /// px. Defaults match Chrome on macOS; this is for calibration. Every texture is drawn again (each render
    /// applies the dilation; no board is painted again).
    #[wasm_bindgen(js_name = setTextDilation)]
    pub fn set_text_dilation(&mut self, factor: f64, max: f64) {
        crate::paint::set_stem_darkening(factor, max);
        for b in &mut self.boards {
            b.generation += 1;
        }
        // Effect textures hold text too (blurred groups, text shadows): they render again when a tile needs them.
        self.gpu.retain_jobs(&HashSet::new());
        self.dirty = true;
    }

    /// GPU memory budget for decoded image levels in bytes (default 192 MB). Levels boards in
    /// view still draw are never dropped.
    #[wasm_bindgen(js_name = setImageBudget)]
    pub fn set_image_budget(&mut self, bytes: f64) {
        self.mips.budget = bytes.max(8.0 * 1024.0 * 1024.0) as u64;
    }

    /// Texture memory budget in bytes (default 256 MB, or six screenfuls of the drawing buffer when that is more:
    /// a 5K or 6K display). Once set, it no longer follows the canvas size.
    #[wasm_bindgen(js_name = setTextureBudget)]
    pub fn set_texture_budget(&mut self, bytes: f64) {
        self.gpu.tiles.budget = bytes.max(16.0 * 1024.0 * 1024.0) as u64;
        self.texture_budget_set = true;
    }
}

/// FNV-1a over the length and up to 64 KB of each end of the data.
fn fingerprint(b: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325 ^ b.len() as u64;
    let n = b.len().min(65536);
    for &x in b[..n].iter().chain(b[b.len() - n..].iter()) {
        h = (h ^ u64::from(x)).wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// One slot in view this frame: board index, tile, key, and what stands in for it when it is not fresh.
struct SlotDraw {
    bi: usize,
    t: crate::cache::TileRect,
    key: TileKey,
    cover: Option<Cover>,
}

/// Render work: a slot in view, a board's base texture, or a tile of a board ahead of the view.
#[derive(Clone, Copy)]
enum Work {
    Slot(usize),
    Base(usize),
    Ahead(usize, crate::cache::TileRect, TileKey),
}

fn r32(r: Rect) -> [f32; 4] {
    [r.x0 as f32, r.y0 as f32, r.x1 as f32, r.y1 as f32]
}

fn outline(quads: &mut Vec<(Source, Quad)>, d: Rect, c: [f32; 4]) {
    let tint = [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]];
    let full = [0.0, 0.0, 1.0, 1.0];
    for r in [Rect::new(d.x0, d.y0, d.x1, d.y0 + 2.0), Rect::new(d.x0, d.y1 - 2.0, d.x1, d.y1), Rect::new(d.x0, d.y0, d.x0 + 2.0, d.y1), Rect::new(d.x1 - 2.0, d.y0, d.x1, d.y1)] {
        quads.push((Source::White, Quad { rect: r32(r), uv: full, tint, scissor: None, extra: [0.0; 4] }));
    }
}

