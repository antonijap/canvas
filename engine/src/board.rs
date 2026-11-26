//! A board as the engine holds it: parsed tree, layout, encoded vello scene, ink bounds and hit
//! index, plus a generation counter that bumps whenever what it draws changes (which is what
//! invalidates its cached textures).

use std::collections::{HashSet, VecDeque};

use kurbo::{Point, Rect};
use vello::Scene;

use crate::hit::HitIndex;
use crate::layout::{LayoutResult, drop_texts, layout_doc, local_transform, relayout_subtree, restore_texts, uses_baselines};
use std::collections::HashMap;

use crate::paint::{EffectJob, ImageStore, PaintOptions, paint_board};
use crate::scene::{Doc, FlexLayout, FontRef, Kind, SceneBoard, Sizing};
use crate::text::TextSystem;

pub struct Sprite {
    pub owner: String,
    pub clip: Option<Rect>,
    /// The owner's ink before the promoted layers were hidden.
    pub rest_ink: Rect,
}

pub struct Board {
    pub id: String,
    /// stable number for texture keys
    pub uid: u64,
    pub x: f64,
    pub y: f64,
    pub doc: Doc,
    pub layout: LayoutResult,
    pub scene: Scene,
    /// `scene` as items with bounds (cull.rs): a tile renders only the ones that meet it.
    pub index: crate::cull::SceneIndex,
    /// board-local ink bounds
    pub ink: Rect,
    pub hit: HitIndex,
    pub generation: u64,
    /// Counts every paint: a tile rendered in parts over several frames starts again when its board was painted
    /// in between (the parts already rendered drew the scene before, with other image levels).
    pub paint_rev: u64,
    pub fonts: Vec<FontRef>,
    pub families: HashSet<String>,
    pub images: Vec<String>,
    /// Largest drawn long side per image, in board units (see `Painted::image_need`).
    pub image_need: HashMap<String, f64>,
    /// The mip level (long side px) each image is encoded at; empty = no pixels attached.
    pub image_levels: HashMap<String, u32>,
    /// Tiles of a larger level it holds over the part of an image in view: the level and which tiles.
    pub image_tiles: HashMap<String, (u32, crate::images::Cells)>,
    /// Per use of an image (the order of `image_places`), the smaller level that use draws, 0 for the image's
    /// own level or tiles.
    pub image_picks: HashMap<String, Vec<u32>>,
    /// Where it draws each image (see `Painted::image_places`).
    pub image_places: HashMap<String, Vec<crate::paint::ImagePlace>>,
    /// Images the last paint used but had no pixels for (not attached yet): drawn as nothing there. When they
    /// attach, the tiles over them draw again (`redraw`); a paint with them alone does not touch the tiles.
    pub drawn_without: Vec<String>,
    /// Blur jobs the scene draws (their textures must exist before a tile renders).
    pub jobs: Vec<EffectJob>,
    /// Images arrived (or went): paint again before the next tile.
    pub stale_paint: bool,
    /// Its image levels were given back while it was out of view: the scene still draws them, so it is painted
    /// again before its next render (lazily: giving back levels never repaints a board in the frame that does it).
    pub levels_released: bool,
    /// Last frame the board was in or near the view.
    pub seen_frame: u64,
    pub layout_ms: f64,
    pub paint_ms: f64,
    /// Parked (a page not shown): kept laid out, with whatever textures the caches still hold, but not drawn,
    /// hit-tested or listed in view, so going back to its page needs no layout, decode or render.
    pub hidden: bool,
    /// Transient sprite boards paint above their owner and are ignored by hit testing.
    pub sprite: Option<Sprite>,
    pub transform: Option<([f64; 6], f32)>,
    /// Per node (board space): what it and its subtree draw (`Painted::node_ink`).
    pub node_ink: Vec<Rect>,
    /// What each recent generation changed (board space), newest last: None when it may have changed anything.
    /// A texture of an older generation is brought up to date by rendering only the union since (`dirty_since`).
    pub dirty_log: VecDeque<(u64, Option<Rect>)>,
    /// Shader fills the scene draws (placeholders the engine attaches shader textures to).
    pub fills: Vec<crate::paint::FillUse>,
    /// Generations that were only a shader fill's new frame (`job_stamp`).
    pub fill_gens: u64,
    /// Draw this board's current content whole in the next frame that shows it, whatever the tile budget, and
    /// never a placeholder for it (`Engine::draw_now`): a gesture's own layers, and the boards that hand them over
    /// when it begins and ends. Cleared once every slot of it in view is fresh.
    pub urgent: bool,
}

/// Generations `Board::dirty_log` remembers: a texture older than that renders whole.
pub const DIRTY_LOG: usize = 32;

pub struct BuildOptions<'a> {
    pub images: &'a ImageStore,
    pub debug_boxes: bool,
    pub now: &'a dyn Fn() -> f64,
    /// Only image levels changed since the last paint: effect jobs without an image keep their textures.
    pub keep_jobs: bool,
}

impl BuildOptions<'_> {
    fn paint(&self) -> PaintOptions<'_> {
        PaintOptions { images: self.images, debug_boxes: self.debug_boxes, reuse: None }
    }
}

impl Board {
    pub fn new(uid: u64, id: &str, x: f64, y: f64, scene: SceneBoard, ts: &mut TextSystem, o: &BuildOptions) -> Board {
        let families = scene.doc.nodes.iter().filter_map(|n| n.text.as_ref().map(|t| t.family.to_ascii_lowercase())).collect();
        let t0 = (o.now)();
        let layout = layout_doc(&scene.doc, ts);
        let t1 = (o.now)();
        let mut layout = layout;
        let painted = paint_board(&scene.doc, &layout, &o.paint());
        let drawn_without = painted.images.iter().filter(|u| o.images.get(*u).is_none_or(|i| i.data.is_none() && i.tiles.is_none())).cloned().collect();
        drop_texts(&mut layout);
        let t2 = (o.now)();
        let hit = HitIndex::build(&scene.doc, &layout);
        Board {
            id: id.to_string(),
            uid,
            x,
            y,
            doc: scene.doc,
            layout,
            scene: painted.scene,
            index: painted.index,
            ink: painted.ink,
            hit,
            generation: 1,
            paint_rev: 0,
            fonts: scene.fonts,
            families,
            images: painted.images,
            image_need: painted.image_need,
            drawn_without,
            image_levels: HashMap::new(),
            image_tiles: HashMap::new(),
            image_picks: HashMap::new(),
            image_places: painted.image_places,
            jobs: painted.jobs,
            stale_paint: false,
            levels_released: false,
            seen_frame: 0,
            layout_ms: t1 - t0,
            paint_ms: t2 - t1,
            hidden: false,
            sprite: None,
            transform: None,
            node_ink: painted.node_ink,
            dirty_log: VecDeque::new(),
            fills: painted.fills,
            fill_gens: 0,
            urgent: false,
        }
    }

    /// Fonts changed: lay out and paint again.
    pub fn relayout(&mut self, ts: &mut TextSystem, o: &BuildOptions) {
        let t0 = (o.now)();
        self.layout = layout_doc(&self.doc, ts);
        let t1 = (o.now)();
        self.hit = HitIndex::build(&self.doc, &self.layout);
        self.layout_ms = t1 - t0;
        self.repaint(ts, o);
    }

    /// What it draws changed (fonts, images arriving, debug flags): paint again; cached textures
    /// go stale.
    pub fn repaint(&mut self, ts: &mut TextSystem, o: &BuildOptions) {
        self.repaint_same(ts, o);
        self.bump(None);
    }

    /// A new generation that changed what `dirty` says (None: anything).
    fn bump(&mut self, dirty: Option<Rect>) {
        self.generation += 1;
        self.log_generation(dirty);
    }

    /// Tiles over `rect` (board space) draw again, all of them when an effect job reaches it (it depends on it).
    pub fn redraw(&mut self, rect: Rect) {
        let r = rect.inflate(1.0, 1.0);
        let touches_job = self.jobs.iter().any(|j| j.bounds.inflate(j.sigma * 3.0 + 2.0, j.sigma * 3.0 + 2.0).overlaps(r) || j.drawn.overlaps(r));
        self.bump(if touches_job { None } else { Some(r) });
    }

    /// A shader fill drew a new frame over `rect` (board space): its tiles draw that part again. An effect job that
    /// reaches it (a blur of what is behind, a blurred layer) depends on it, so then anything changed.
    pub fn fill_frame(&mut self, rect: Rect) {
        let r = rect.inflate(1.0, 1.0);
        let touches_job = self.jobs.iter().any(|j| j.bounds.inflate(j.sigma * 3.0 + 2.0, j.sigma * 3.0 + 2.0).overlaps(r) || j.drawn.overlaps(r));
        self.bump(if touches_job { None } else { Some(r) });
        self.fill_gens += 1;
    }

    /// Note what the current generation changed (a board that replaced another one with the next generation).
    pub fn log_generation(&mut self, dirty: Option<Rect>) {
        if self.dirty_log.len() >= DIRTY_LOG {
            self.dirty_log.pop_front();
        }
        self.dirty_log.push_back((self.generation, dirty));
    }

    /// Everything the generations after `generation` changed, board space (empty: nothing). None when that is not
    /// known: a change that may reach anywhere (a whole paint, new fonts), or one older than the log remembers.
    pub fn dirty_since(&self, generation: u64) -> Option<Rect> {
        if generation >= self.generation {
            return Some(Rect::ZERO);
        }
        // Every generation since must be in the log: a bump made elsewhere without saying where leaves a gap.
        let mut want = generation + 1;
        let mut out: Option<Rect> = None;
        for (g, d) in &self.dirty_log {
            if *g < want {
                continue;
            }
            if *g != want {
                return None;
            }
            let d = (*d)?;
            out = Some(match out { Some(r) => r.union(d), None => d });
            want += 1;
        }
        if want != self.generation + 1 {
            return None;
        }
        Some(out.unwrap_or(Rect::ZERO))
    }

    /// What the subtree of node `i` (nodes `i..end`) draws, board space.
    fn subtree_ink(&self, i: usize, end: usize) -> Option<Rect> {
        let mut r: Option<Rect> = None;
        for j in i..end.min(self.node_ink.len()) {
            let k = self.node_ink[j];
            if k.width() <= 0.0 && k.height() <= 0.0 {
                continue;
            }
            r = Some(match r { Some(x) => x.union(k), None => k });
        }
        r
    }

    /// Paint again after an edit of the subtree `i..end` whose ink was `before`: the new generation changed only
    /// the union of what the subtree drew before and draws now, unless an effect job (a blur of what is behind,
    /// a blurred layer) reaches into it: its picture depends on everything under it, so then anything changed.
    fn repaint_subtree(&mut self, ts: &mut TextSystem, o: &BuildOptions, i: usize, end: usize, before: Option<Rect>) {
        self.repaint_same(ts, o);
        let after = self.subtree_ink(i, end);
        let dirty = match (before, after) {
            (Some(a), Some(b)) => Some(a.union(b)),
            (a, b) => a.or(b).or(Some(Rect::ZERO)),
        };
        let dirty = dirty.filter(|d| !self.jobs.iter().any(|j| j.bounds.inflate(j.sigma * 3.0 + 2.0, j.sigma * 3.0 + 2.0).overlaps(*d) || j.drawn.overlaps(*d)));
        self.bump(dirty);
    }

    /// Paint again without invalidating textures: only the resolution of image pixels changes,
    /// and textures already drawn at other scales stay right for those scales. Text is shaped
    /// again for the paint and its layouts freed after.
    pub fn repaint_same(&mut self, ts: &mut TextSystem, o: &BuildOptions) {
        let t0 = (o.now)();
        if self.layout.texts.is_empty() && self.has_text() {
            restore_texts(&self.doc, &mut self.layout, ts);
        }
        let p = paint_board(&self.doc, &self.layout, &PaintOptions { reuse: o.keep_jobs.then_some(self.jobs.as_slice()), ..o.paint() });
        self.drawn_without = p.images.iter().filter(|u| o.images.get(*u).is_none_or(|i| i.data.is_none() && i.tiles.is_none())).cloned().collect();
        drop_texts(&mut self.layout);
        self.paint_ms = (o.now)() - t0;
        self.paint_rev += 1;
        self.scene = p.scene;
        self.index = p.index;
        self.ink = p.ink;
        self.images = p.images;
        self.image_need = p.image_need;
        self.image_places = p.image_places;
        self.jobs = p.jobs;
        self.node_ink = p.node_ink;
        self.fills = p.fills;
        self.stale_paint = false;
        self.levels_released = false;
    }

    /// What a render of it in parts must find unchanged to go on next frame: its content and this paint of it.
    pub fn job_stamp(&self) -> (u64, u64) {
        // A shader fill's new frame changes no part of the scene: a dense tile rendered over several frames goes on
        // (its fill area draws again after), or a playing fill would restart it every frame.
        (self.generation - self.fill_gens, self.paint_rev)
    }

    pub fn uses_family(&self, family: &str) -> bool {
        let base = crate::text::split_family(family).0;
        self.families.contains(&base.to_ascii_lowercase()) || base.eq_ignore_ascii_case(crate::text::FALLBACK_FAMILY)
    }

    /// What rendering one tile of it costs beyond the tile's pixels (see `cache::scene_mpx`).
    pub fn render_mpx(&self) -> f64 {
        let e = self.scene.encoding();
        crate::cache::scene_mpx(e.n_path_segments, e.resources.glyphs.len())
    }

    /// What rendering the part `rect` (board space) of it costs beyond the pixels: a render draws only the items
    /// that meet it (cull.rs), so about that part's share of the scene.
    pub fn part_mpx(&self, rect: Rect) -> f64 {
        let part = rect.intersect(self.ink);
        let all = self.ink.area();
        let share = if all > 0.0 { (part.width().max(0.0) * part.height().max(0.0) / all).min(1.0) } else { 1.0 };
        self.render_mpx() * share
    }

    pub fn has_text(&self) -> bool {
        !self.families.is_empty()
    }

    /// Ink bounds in world space.
    pub fn world_ink(&self) -> Rect {
        self.ink + kurbo::Vec2::new(self.x, self.y)
    }

    /// The root node's box in world space (the board's frame).
    pub fn world_root(&self) -> Rect {
        self.layout.aabb.first().copied().unwrap_or(Rect::ZERO) + kurbo::Vec2::new(self.x, self.y)
    }

    /// Put node `id` at (x, y) in its parent without laying the board out again: only when nothing else can move
    /// with it, i.e. its parent is a frame that places its children freely (layout none) and has a fixed width and
    /// height (its size does not follow its children). The node's subtree is moved, the hit index rebuilt and the
    /// board painted again (texts come from the shaping cache). False when the move needs a layout: the caller
    /// sets the whole board instead. A drag of one layer on a 1,300-node board cost a whole `setBoard` (8 to 12 ms)
    /// every frame; this is the paint alone.
    pub fn move_node(&mut self, id: &str, x: f64, y: f64, ts: &mut TextSystem, o: &BuildOptions) -> bool {
        let Some(i) = self.doc.index_of(id) else { return false };
        let Some(p) = self.doc.nodes[i].parent else { return false };
        let par = &self.doc.nodes[p];
        if par.kind != Kind::Frame || par.layout != FlexLayout::None || !matches!(par.width, Sizing::Fixed(_)) || !matches!(par.height, Sizing::Fixed(_)) {
            return false;
        }
        if !(x.is_finite() && y.is_finite()) {
            return false;
        }
        let n = self.doc.nodes.len();
        if self.layout.boxes.len() != n || self.layout.local.len() != n {
            return false;
        }
        if self.doc.nodes[i].x == x && self.doc.nodes[i].y == y {
            return true;
        }
        let end0 = {
            let mut inside = vec![false; n];
            inside[i] = true;
            let mut e = i + 1;
            while e < n && self.doc.nodes[e].parent.is_some_and(|q| inside[q]) {
                inside[e] = true;
                e += 1;
            }
            e
        };
        let before = self.subtree_ink(i, end0);
        self.doc.nodes[i].x = x;
        self.doc.nodes[i].y = y;
        self.layout.boxes[i].x = x;
        self.layout.boxes[i].y = y;
        // The subtree: nodes are in pre-order, so it is the run after i whose parents are in it.
        let mut inside = vec![false; n];
        inside[i] = true;
        let mut end = i + 1;
        while end < n && self.doc.nodes[end].parent.is_some_and(|q| inside[q]) {
            inside[end] = true;
            end += 1;
        }
        let l = &mut self.layout;
        for j in i..end {
            let node = &self.doc.nodes[j];
            l.local[j] = local_transform(node, &l.boxes[j]);
            l.world[j] = match node.parent {
                Some(q) => l.world[q] * l.local[j],
                None => l.local[j],
            };
            l.aabb[j] = l.world[j].transform_rect_bbox(Rect::new(0.0, 0.0, l.boxes[j].w, l.boxes[j].h));
        }
        // Groups in the subtree are where their layers are drawn (as layout_doc fits them).
        let mut fitted = vec![false; n];
        for j in (i + 1..end).rev() {
            let Some(q) = self.doc.nodes[j].parent else { continue };
            if self.doc.nodes[q].kind != Kind::Group {
                continue;
            }
            let r = l.aabb[j];
            l.aabb[q] = if fitted[q] { l.aabb[q].union(r) } else { r };
            fitted[q] = true;
        }
        self.hit = HitIndex::build(&self.doc, &self.layout);
        let was = ts.caching;
        ts.caching = true;
        self.repaint_subtree(ts, o, i, end, before);
        ts.caching = was;
        true
    }

    /// Replace node `id` and its subtree with `subtree` (the same node as the scene has it now, with its children:
    /// the same ids in the same order) and lay out that subtree alone, when nothing outside it can change: its
    /// parent places it freely and has a fixed size (as `move_node`). A resize, a padding drag or a text being
    /// typed on a large board then costs the subtree's layout and a paint, not the whole board's parse and layout.
    /// False (nothing changed) when the edit needs the whole board: the caller sets the board instead.
    pub fn update_node(&mut self, id: &str, subtree: &Doc, ts: &mut TextSystem, o: &BuildOptions) -> bool {
        let Some(i) = self.doc.index_of(id) else { return false };
        let Some(p) = self.doc.nodes[i].parent else { return false };
        let par = &self.doc.nodes[p];
        if par.kind != Kind::Frame || par.layout != FlexLayout::None || !matches!(par.width, Sizing::Fixed(_)) || !matches!(par.height, Sizing::Fixed(_)) {
            return false;
        }
        let n = self.doc.nodes.len();
        if self.layout.boxes.len() != n || self.layout.local.len() != n {
            return false;
        }
        let mut inside = vec![false; n];
        inside[i] = true;
        let mut end = i + 1;
        while end < n && self.doc.nodes[end].parent.is_some_and(|q| inside[q]) {
            inside[end] = true;
            end += 1;
        }
        // The same nodes, in the same order: an added, removed or hidden layer changes the indices (whole board).
        if subtree.nodes.len() != end - i || subtree.nodes.iter().zip(&self.doc.nodes[i..end]).any(|(a, b)| a.id != b.id || a.kind != b.kind) {
            return false;
        }
        // A layer that starts or stops being a mask changes what its siblings show outside its own ink.
        if subtree.nodes.iter().zip(&self.doc.nodes[i..end]).any(|(a, b)| a.mask != b.mask) {
            return false;
        }
        // Baseline alignment anywhere decides how every text leaf is measured: a change there is a whole layout.
        let was = uses_baselines(&self.doc.nodes);
        let now = uses_baselines(&self.doc.nodes[..i]) || uses_baselines(&subtree.nodes) || uses_baselines(&self.doc.nodes[end..]);
        if was != now {
            return false;
        }
        let before = self.subtree_ink(i, end);
        for (k, src) in subtree.nodes.iter().enumerate() {
            let j = i + k;
            let mut node = src.clone();
            node.parent = if k == 0 { Some(p) } else { src.parent.map(|q| q + i) };
            node.children = src.children.iter().map(|c| c + i).collect();
            self.doc.nodes[j] = node;
        }
        self.families = self.doc.nodes.iter().filter_map(|n| n.text.as_ref().map(|t| t.family.to_ascii_lowercase())).collect();
        let was_caching = ts.caching;
        ts.caching = true;
        relayout_subtree(&self.doc, &mut self.layout, ts, i, end);
        self.hit = HitIndex::build(&self.doc, &self.layout);
        self.repaint_subtree(ts, o, i, end, before);
        ts.caching = was_caching;
        true
    }

    /// A node's bounding box in world space (getBoundingClientRect divided by zoom).
    pub fn node_rect(&self, id: &str) -> Option<Rect> {
        let i = self.doc.index_of(id)?;
        Some(self.layout.aabb[i] + kurbo::Vec2::new(self.x, self.y))
    }

    pub fn hit(&self, world: Point) -> Option<&str> {
        let i = self.hit.hit(world - kurbo::Vec2::new(self.x, self.y))?;
        Some(self.doc.nodes[i].id.as_str())
    }

    /// Every node under a world point, topmost first.
    pub fn hit_all(&self, world: Point) -> Vec<&str> {
        self.hit.hit_all(world - kurbo::Vec2::new(self.x, self.y)).into_iter().map(|i| self.doc.nodes[i].id.as_str()).collect()
    }
}

/// What a board `new` that replaces `old` (a scene from the server: an inspector edit, an agent's, a nudge, an
/// undo) changed, board space: the union of what every layer whose properties, place or ink differ drew before and
/// draws now. None (anything) when the layers are not the same ones in the same order, or an effect job (a blur of
/// what is behind, a blurred layer) reaches into the change.
pub fn replaced_dirty(old: &Board, new: &Board) -> Option<Rect> {
    let n = new.doc.nodes.len();
    if old.doc.nodes.len() != n || old.node_ink.len() != n || new.node_ink.len() != n || old.layout.aabb.len() != n || new.layout.aabb.len() != n || old.layout.world.len() != n || new.layout.world.len() != n {
        return None;
    }
    let mut out: Option<Rect> = None;
    for j in 0..n {
        let (a, b) = (&old.doc.nodes[j], &new.doc.nodes[j]);
        if a.id != b.id || a.kind != b.kind || a.parent != b.parent {
            return None;
        }
        if a == b && old.layout.aabb[j] == new.layout.aabb[j] && old.layout.world[j] == new.layout.world[j] && old.node_ink[j] == new.node_ink[j] {
            continue;
        }
        // The root changing (its fill, its size) is the whole board; so is a layer starting or stopping being a
        // mask (its siblings above it show or hide outside its own ink).
        if j == 0 || a.mask != b.mask {
            return None;
        }
        let r = old.node_ink[j].union(new.node_ink[j]);
        out = Some(match out { Some(x) => x.union(r), None => r });
    }
    let d = out.unwrap_or(Rect::ZERO);
    if d.width() > 0.0 || d.height() > 0.0 {
        for j in old.jobs.iter().chain(&new.jobs) {
            if j.bounds.inflate(j.sigma * 3.0 + 2.0, j.sigma * 3.0 + 2.0).overlaps(d) || j.drawn.overlaps(d) {
                return None;
            }
        }
    }
    Some(d)
}

/// Move the boards named in `ids` to the top of the paint order (the end of `boards`), in that order, and keep
/// everything else (textures, layout, scene): restacking is only an order. Returns how many moved.
pub fn raise<T>(boards: &mut Vec<T>, ids: &[String], id_of: impl Fn(&T) -> &str) -> usize {
    let mut moved = 0;
    for id in ids {
        if let Some(p) = boards.iter().position(|b| id_of(b) == id.as_str()) {
            let b = boards.remove(p);
            boards.push(b);
            moved += 1;
        }
    }
    moved
}

#[cfg(test)]
mod tests {
    use super::*;

    fn board(json: &str) -> Board {
        let s = SceneBoard::parse(json).unwrap();
        let images = ImageStore::new();
        let o = BuildOptions { images: &images, debug_boxes: false, now: &|| 0.0, keep_jobs: false };
        Board::new(1, "b", 100.0, 50.0, s, &mut TextSystem::new(), &o)
    }

    #[test]
    fn move_node_matches_a_fresh_layout_and_refuses_what_needs_one() {
        let json = |x: f64| format!(r##"{{"id":"b","x":0,"y":0,"root":{{"type":"frame","id":"b","width":400,"height":300,"layout":"none","children":[
            {{"type":"frame","id":"f","x":{x},"y":20,"width":120,"height":80,"layout":"none","children":[{{"type":"rectangle","id":"r","x":5,"y":6,"width":10,"height":10,"fill":"#FF0000"}},
              {{"type":"group","id":"g","x":30,"y":30,"children":[{{"type":"rectangle","id":"gr","x":2,"y":3,"width":8,"height":8,"fill":"#00FF00"}}]}}]}},
            {{"type":"frame","id":"hug","x":200,"y":10,"layout":"none","children":[{{"type":"rectangle","id":"h1","x":0,"y":0,"width":10,"height":10,"fill":"#0000FF"}}]}},
            {{"type":"frame","id":"row","x":200,"y":150,"width":100,"height":40,"layout":"horizontal","children":[{{"type":"rectangle","id":"k","width":10,"height":10,"fill":"#0000FF"}}]}}]}}}}"##);
        let mut ts = TextSystem::new();
        let images = ImageStore::new();
        let o = BuildOptions { images: &images, debug_boxes: false, now: &|| 0.0, keep_jobs: false };
        let mut a = Board::new(1, "b", 100.0, 50.0, SceneBoard::parse(&json(10.0)).unwrap(), &mut ts, &o);
        let fresh = Board::new(1, "b", 100.0, 50.0, SceneBoard::parse(&json(47.0)).unwrap(), &mut ts, &o);
        let g0 = a.generation;
        assert!(a.move_node("f", 47.0, 20.0, &mut ts, &o));
        assert!(a.generation > g0, "a move repaints");
        for id in ["b", "f", "r", "g", "gr", "hug", "h1", "row", "k"] {
            assert_eq!(a.node_rect(id), fresh.node_rect(id), "{id}");
        }
        assert_eq!(a.ink, fresh.ink);
        assert_eq!(a.hit(Point::new(100.0 + 47.0 + 7.0, 50.0 + 20.0 + 8.0)), Some("r"), "the hit index follows");
        assert!(!a.move_node("h1", 5.0, 5.0, &mut ts, &o), "a parent that hugs its children needs a layout");
        assert!(!a.move_node("k", 5.0, 5.0, &mut ts, &o), "a flow child needs a layout");
        assert!(!a.move_node("gr", 5.0, 5.0, &mut ts, &o), "a group's box follows its layers");
        assert!(!a.move_node("b", 5.0, 5.0, &mut ts, &o), "the board itself moves with moveBoard");
        assert!(!a.move_node("nope", 5.0, 5.0, &mut ts, &o));
    }

    #[test]
    fn an_edit_of_a_subtree_says_where_it_changed() {
        let json = r##"{"id":"b","x":0,"y":0,"root":{"type":"frame","id":"b","width":800,"height":600,"layout":"none","children":[
            {"type":"rectangle","id":"r","x":10,"y":20,"width":40,"height":30,"fill":"#FF0000"},
            {"type":"rectangle","id":"far","x":600,"y":500,"width":40,"height":30,"fill":"#00FF00"}]}}"##;
        let mut ts = TextSystem::new();
        let images = ImageStore::new();
        let o = BuildOptions { images: &images, debug_boxes: false, now: &|| 0.0, keep_jobs: false };
        let mut a = Board::new(1, "b", 0.0, 0.0, SceneBoard::parse(json).unwrap(), &mut ts, &o);
        let g0 = a.generation;
        assert_eq!(a.dirty_since(g0), Some(Rect::ZERO), "nothing since the current generation");
        assert_eq!(a.dirty_since(g0 - 1), None, "before what the log remembers: unknown");
        assert!(a.move_node("r", 100.0, 120.0, &mut ts, &o));
        let d = a.dirty_since(g0).expect("a move knows where it changed");
        for p in [(10.0, 20.0), (49.0, 49.0), (100.0, 120.0), (139.0, 149.0)] {
            assert!(d.contains(Point::new(p.0, p.1)), "{p:?} in {d:?}: the old place and the new");
        }
        assert!(!d.contains(Point::new(610.0, 510.0)), "the layer far away is not dirty: {d:?}");
        assert!(d.x1 < 160.0 && d.y1 < 170.0, "only a few px of slack: {d:?}");
        let g1 = a.generation;
        assert!(a.move_node("r", 200.0, 120.0, &mut ts, &o));
        let d2 = a.dirty_since(g0).unwrap();
        assert!(d2.contains(Point::new(15.0, 25.0)) && d2.contains(Point::new(230.0, 140.0)), "since g0: both moves");
        assert!(!a.dirty_since(g1).unwrap().contains(Point::new(15.0, 25.0)), "since g1: only the second");
        a.repaint(&mut ts, &o);
        assert_eq!(a.dirty_since(g0), None, "a whole repaint may change anything");
        for _ in 0..DIRTY_LOG + 2 {
            let x = a.doc.nodes[a.doc.index_of("r").unwrap()].x + 1.0;
            assert!(a.move_node("r", x, 120.0, &mut ts, &o));
        }
        let g = a.generation;
        assert!(a.dirty_since(g - 3).is_some());
        assert_eq!(a.dirty_since(g - DIRTY_LOG as u64 - 1), None, "older than the log");
        a.generation += 1; // a bump that says nothing (as set_debug makes)
        assert_eq!(a.dirty_since(g - 1), None, "a gap in the log: unknown");
    }

    #[test]
    fn a_replaced_board_says_which_layers_changed() {
        let json = |fill: &str, w: f64, extra: &str| format!(r##"{{"id":"b","x":0,"y":0,"root":{{"type":"frame","id":"b","width":800,"height":600,"layout":"none","children":[
            {{"type":"rectangle","id":"r","x":10,"y":20,"width":{w},"height":30,"fill":"{fill}"}},
            {{"type":"frame","id":"col","x":300,"y":300,"layout":"vertical","gap":4,"children":[{{"type":"rectangle","id":"c1","width":20,"height":20,"fill":"#000000"}}]}},
            {{"type":"rectangle","id":"far","x":600,"y":500,"width":40,"height":30,"fill":"#00FF00"}}{extra}]}}}}"##);
        let mut ts = TextSystem::new();
        let images = ImageStore::new();
        let o = BuildOptions { images: &images, debug_boxes: false, now: &|| 0.0, keep_jobs: false };
        let make = |j: &str, ts: &mut TextSystem| Board::new(1, "b", 0.0, 0.0, SceneBoard::parse(j).unwrap(), ts, &o);
        let a = make(&json("#FF0000", 40.0, ""), &mut ts);
        assert_eq!(replaced_dirty(&a, &make(&json("#FF0000", 40.0, ""), &mut ts)), Some(Rect::ZERO), "the same scene changes nothing");
        let d = replaced_dirty(&a, &make(&json("#0000FF", 40.0, ""), &mut ts)).expect("a fill");
        assert!(d.contains(Point::new(30.0, 35.0)) && !d.contains(Point::new(610.0, 510.0)), "{d:?}");
        let d = replaced_dirty(&a, &make(&json("#FF0000", 90.0, ""), &mut ts)).expect("a resize");
        assert!(d.contains(Point::new(95.0, 35.0)), "the new size: {d:?}");
        assert_eq!(replaced_dirty(&a, &make(&json("#FF0000", 40.0, r##",{"type":"rectangle","id":"new","x":1,"y":1,"width":5,"height":5}"##), &mut ts)), None, "a layer added: unknown");
    }

    #[test]
    fn a_change_under_a_blur_is_not_a_region() {
        let json = r##"{"id":"b","x":0,"y":0,"root":{"type":"frame","id":"b","width":800,"height":600,"layout":"none","children":[
            {"type":"rectangle","id":"r","x":10,"y":20,"width":40,"height":30,"fill":"#FF0000"},
            {"type":"rectangle","id":"glass","x":0,"y":0,"width":300,"height":300,"fill":"#FFFFFF80","effect":[{"type":"background_blur","radius":20}]}]}}"##;
        let mut ts = TextSystem::new();
        let images = ImageStore::new();
        let o = BuildOptions { images: &images, debug_boxes: false, now: &|| 0.0, keep_jobs: false };
        let mut a = Board::new(1, "b", 0.0, 0.0, SceneBoard::parse(json).unwrap(), &mut ts, &o);
        assert!(!a.jobs.is_empty(), "the glass blurs what is behind it");
        let g0 = a.generation;
        assert!(a.move_node("r", 30.0, 40.0, &mut ts, &o));
        assert_eq!(a.dirty_since(g0), None, "the blur behind the glass depends on it");
    }

    #[test]
    fn update_node_matches_a_fresh_layout() {
        let Some(arial) = crate::text::tests::arial() else { return };
        let json = |w: f64, pad: f64, text: &str| format!(r##"{{"id":"b","x":0,"y":0,"root":{{"type":"frame","id":"b","width":600,"height":400,"layout":"none","children":[
            {{"type":"frame","id":"col","x":20,"y":30,"width":{w},"layout":"vertical","gap":6,"padding":{pad},"children":[
              {{"type":"text","id":"t","content":"{text}","fontFamily":"Arial","fontSize":14}},
              {{"type":"rectangle","id":"r","width":"fill_container","height":20,"fill":"#FF0000"}}]}},
            {{"type":"text","id":"free","x":300,"y":40,"content":"{text}","fontFamily":"Arial","fontSize":16}},
            {{"type":"frame","id":"g","x":300,"y":200,"width":80,"height":50,"fill":"#00FF00"}}]}}}}"##);
        let mut ts = TextSystem::new();
        ts.register_font("Arial", None, None, arial).unwrap();
        let images = ImageStore::new();
        let o = BuildOptions { images: &images, debug_boxes: false, now: &|| 0.0, keep_jobs: false };
        let mut a = Board::new(1, "b", 10.0, 5.0, SceneBoard::parse(&json(200.0, 12.0, "Hello")).unwrap(), &mut ts, &o);
        let target = json(260.0, 20.0, "Hello there");
        let fresh = Board::new(1, "b", 10.0, 5.0, SceneBoard::parse(&target).unwrap(), &mut ts, &o);
        let v: serde_json::Value = serde_json::from_str(&target).unwrap();
        let sub = |id: &str| Doc::from_value(v["root"]["children"].as_array().unwrap().iter().find(|c| c["id"] == id).unwrap()).unwrap();
        assert!(a.update_node("col", &sub("col"), &mut ts, &o), "a frame in a free, fixed board: its subtree alone");
        assert!(a.update_node("free", &sub("free"), &mut ts, &o), "a text in a free, fixed board");
        for id in ["b", "col", "t", "r", "free", "g"] {
            assert_eq!(a.node_rect(id), fresh.node_rect(id), "{id}");
        }
        assert_eq!(a.ink, fresh.ink);
        assert_eq!(a.layout.text_origin, fresh.layout.text_origin);
        // A subtree with another shape (a layer more or less) or inside a flow needs the whole board.
        let fewer = Doc::from_value(&serde_json::json!({"type": "frame", "id": "col", "layout": "vertical", "children": []})).unwrap();
        assert!(!a.update_node("col", &fewer, &mut ts, &o));
        let t = Doc::from_value(&v["root"]["children"][0]["children"][0]).unwrap();
        assert!(!a.update_node("t", &t, &mut ts, &o), "a flow child moves its siblings");
        for id in ["col", "t", "r"] {
            assert_eq!(a.node_rect(id), fresh.node_rect(id), "a refused update changes nothing: {id}");
        }
    }

    /// A layer made a mask changes what its siblings show outside its own ink: the whole board paints again.
    #[test]
    fn a_mask_toggle_is_a_whole_board_update() {
        let images = ImageStore::new();
        let o = BuildOptions { images: &images, debug_boxes: false, now: &|| 0.0, keep_jobs: false };
        let mut ts = TextSystem::new();
        let scene = |mask: bool| format!(r##"{{"id":"b","x":0,"y":0,"root":{{"type":"frame","id":"b","width":200,"height":100,"layout":"none","children":[
            {{"type":"ellipse","id":"m","x":10,"y":10,"width":40,"height":40,"fill":"#000000","mask":{mask}}},
            {{"type":"rectangle","id":"r","x":0,"y":0,"width":200,"height":100,"fill":"#FF0000"}}]}}}}"##);
        let mut a = Board::new(1, "b", 0.0, 0.0, SceneBoard::parse(&scene(false)).unwrap(), &mut ts, &o);
        let v: serde_json::Value = serde_json::from_str(&scene(true)).unwrap();
        let m = Doc::from_value(&v["root"]["children"][0]).unwrap();
        assert!(!a.update_node("m", &m, &mut ts, &o), "the mask toggle needs the whole board");
        let same = Doc::from_value(&serde_json::from_str::<serde_json::Value>(&scene(false)).unwrap()["root"]["children"][0]).unwrap();
        assert!(a.update_node("m", &same, &mut ts, &o), "an edit that keeps it a plain layer stays local");
        let b = Board::new(1, "b", 0.0, 0.0, SceneBoard::parse(&scene(true)).unwrap(), &mut ts, &o);
        assert_eq!(replaced_dirty(&a, &b), None, "a new scene that makes it a mask redraws everything");
    }

    #[test]
    fn world_rects_and_hits_include_the_board_position() {
        let b = board(r##"{"id":"b","x":0,"y":0,"root":{"type":"frame","id":"b","width":200,"height":100,"layout":"none","children":[{"type":"rectangle","id":"r","x":10,"y":20,"width":30,"height":40,"fill":"#FF0000"}]}}"##);
        assert_eq!(b.node_rect("r"), Some(Rect::new(110.0, 70.0, 140.0, 110.0)));
        assert_eq!(b.world_root(), Rect::new(100.0, 50.0, 300.0, 150.0));
        assert_eq!(b.hit(Point::new(120.0, 80.0)), Some("r"));
        assert_eq!(b.hit(Point::new(5.0, 5.0)), None);
    }

    #[test]
    fn repaint_bumps_the_generation() {
        let mut b = board(r#"{"id":"b","root":{"type":"rectangle","id":"r","width":10,"height":10}}"#);
        let g = b.generation;
        let images = ImageStore::new();
        b.repaint(&mut TextSystem::new(), &BuildOptions { images: &images, debug_boxes: true, now: &|| 0.0, keep_jobs: false });
        assert_eq!(b.generation, g + 1);
    }

    /// Review round 6, Fable 8 / Codex 2: a repaint that keeps the generation (new image levels) still changes
    /// what a render in parts resumes against. Generation and encoding lengths alone did not.
    #[test]
    fn a_repaint_for_image_levels_restarts_a_render_in_parts() {
        let mut b = board(r##"{"id":"b","root":{"type":"rectangle","id":"r","width":10,"height":10,"fill":"#FF0000"}}"##);
        let (stamp, generation, len) = (b.job_stamp(), b.generation, b.scene.encoding().path_tags.len());
        let images = ImageStore::new();
        b.repaint_same(&mut TextSystem::new(), &BuildOptions { images: &images, debug_boxes: false, now: &|| 0.0, keep_jobs: true });
        assert_eq!((b.generation, b.scene.encoding().path_tags.len()), (generation, len), "same generation, same encoding lengths");
        assert_ne!(b.job_stamp(), stamp, "but another paint: the job starts again");
    }

    #[test]
    fn raising_boards_keeps_them_and_only_changes_the_order() {
        let mut v: Vec<Board> = ["a", "b", "c", "d"].iter().map(|id| {
            let mut b = board(&format!(r#"{{"id":"{id}","root":{{"type":"rectangle","id":"{id}","width":10,"height":10}}}}"#));
            b.id = (*id).to_string();
            b.uid = u64::from(id.as_bytes()[0]);
            b
        }).collect();
        let gens: Vec<(u64, u64)> = v.iter().map(|b| (b.uid, b.generation)).collect();
        assert_eq!(raise(&mut v, &["b".into(), "nope".into(), "a".into()], |b| b.id.as_str()), 2);
        assert_eq!(v.iter().map(|b| b.id.as_str()).collect::<Vec<_>>(), ["c", "d", "b", "a"], "raised in the order given, on top");
        for b in &v {
            assert!(gens.contains(&(b.uid, b.generation)), "same uid and generation: its textures still stand");
        }
    }

    fn stripes(w: u32, h: u32) -> Board {
        let kids: Vec<String> = (0..w / 2).map(|i| format!(r##"{{"type":"rectangle","id":"r{i}","x":{},"y":0,"width":1,"height":{h},"fill":"#000000"}}"##, i * 2)).collect();
        board(&format!(r##"{{"id":"b","x":0,"y":0,"root":{{"type":"frame","id":"b","width":{w},"height":{h},"layout":"none","fill":"#FFFFFF","children":[{}]}}}}"##, kids.join(",")))
    }

    #[test]
    fn an_ordinary_tile_is_one_render_of_what_it_shows() {
        use crate::cull::{Target, plan};
        let b = stripes(12000, 3000);
        // One 1024 px tile (and its gutter) at 100% on a 2x display.
        let t = Target { origin: (1024.0, 512.0), scale: (2.0, 2.0) };
        let e = b.index.estimate(b.index.len(), &t, [0, 0, 1028, 1028]);
        assert_eq!(plan(&b.index, b.index.len(), &t, 1028, 1028).unwrap().len(), 1, "{e:?}");
        let mut out = vello::Scene::new();
        b.index.build(&b.scene, b.index.len(), &t, [0, 0, 1028, 1028], &mut out);
        let (part, all) = (out.encoding().n_paths, b.scene.encoding().n_paths);
        assert!(part >= 257 && part < all / 10, "{part} of {all} paths");
        // The whole board in its base texture: every stripe, still one render.
        let base = Target { origin: (0.0, 0.0), scale: (1.0 / 32.0, 1.0 / 32.0) };
        assert_eq!(plan(&b.index, b.index.len(), &base, 375, 94).unwrap().len(), 1);
        // Its share of the scene's cost, not all of it.
        assert!(b.part_mpx(Rect::new(1024.0, 512.0, 1536.0, 1024.0)) < b.render_mpx() / 20.0);
    }

    #[test]
    fn the_index_covers_the_whole_scene() {
        use crate::cull::Target;
        let b = board(r##"{"id":"b","x":0,"y":0,"root":{"type":"frame","id":"b","width":800,"height":600,"layout":"none","clip":true,"fill":"#FFFFFF","children":[
            {"type":"frame","id":"card","x":20,"y":20,"width":300,"height":200,"clip":true,"cornerRadius":12,"opacity":0.5,"fill":"#EEEEEE","effect":{"type":"shadow","shadowType":"outer","offset":{"x":0,"y":4},"blur":12,"color":"#00000055"},"children":[
                {"type":"ellipse","id":"e","x":250,"y":150,"width":100,"height":100,"fill":"#FF0000"},
                {"type":"rectangle","id":"g","x":10,"y":10,"width":50,"height":50,"fill":"#00000040","effect":{"type":"background_blur","radius":8}}]},
            {"type":"rectangle","id":"far","x":700,"y":500,"width":50,"height":50,"fill":"#0000FF","stroke":{"thickness":2,"fill":"#000000"}}]}}"##);
        let all = b.scene.encoding();
        let t = Target { origin: (-100.0, -100.0), scale: (1.0, 1.0) };
        let mut out = vello::Scene::new();
        // A target over everything: the scene again, stream for stream.
        b.index.build(&b.scene, b.index.len(), &t, [0, 0, 1100, 900], &mut out);
        let e = out.encoding();
        assert_eq!((e.n_paths, e.n_path_segments, e.n_clips, e.n_open_clips), (all.n_paths, all.n_path_segments, all.n_clips, 0));
        assert_eq!((e.path_tags.len(), e.path_data.len(), e.draw_tags.len(), e.draw_data.len(), e.transforms.len(), e.styles.len()), (all.path_tags.len(), all.path_data.len(), all.draw_tags.len(), all.draw_data.len(), all.transforms.len(), all.styles.len()));
        assert_eq!(e.resources.patches.len(), all.resources.patches.len());
        // Over the far square only: the root's fill and clip, the square, and nothing of the card.
        let far = Target { origin: (690.0, 490.0), scale: (1.0, 1.0) };
        b.index.build(&b.scene, b.index.len(), &far, [0, 0, 64, 64], &mut out);
        let e = out.encoding();
        assert_eq!((e.n_clips, e.n_open_clips), (2, 0), "the root's clip, opened and closed");
        assert!(e.n_paths < all.n_paths && e.resources.patches.is_empty(), "no shadow or blur image comes along");
        // The backdrop blur's prefix ends on an item: what is behind it, with its layers closed.
        let job = b.jobs.iter().find(|j| matches!(j.scene, crate::paint::JobScene::Behind(_))).expect("a backdrop job");
        let crate::paint::JobScene::Behind(pre) = &job.scene else { unreachable!() };
        assert!(pre.items > 0 && pre.items < b.index.len());
        b.index.build(&b.scene, pre.items, &t, [0, 0, 1100, 900], &mut out);
        let whole = pre.materialize(&b.scene);
        let (e, w) = (out.encoding(), whole.encoding());
        assert_eq!((e.n_paths, e.n_path_segments, e.n_clips, e.n_open_clips, e.draw_tags.len()), (w.n_paths, w.n_path_segments, w.n_clips, 0, w.draw_tags.len()));
    }

    #[test]
    fn error_payloads_are_rejected() {
        assert!(SceneBoard::parse(r#"{"error":"no board"}"#).is_err());
        assert!(SceneBoard::parse("nope").is_err());
    }

    const SHADER: &str = "fn shade(p: vec2<f32>) -> vec4<f32> { return vec4<f32>(1.0, 0.0, 0.0, 1.0); }";

    fn shader_board(fill: &str) -> Board {
        board(&format!(r##"{{"id":"b","x":0,"y":0,"root":{{"type":"frame","id":"b","width":400,"height":300,"layout":"none","fill":"#FFFFFF","children":[
            {{"type":"frame","id":"card","x":40,"y":30,"width":200,"height":100,"cornerRadius":16,"layout":"none","fill":{fill},"children":[
              {{"type":"rectangle","id":"dot","x":10,"y":10,"width":20,"height":20,"fill":"#000000"}}]}}]}}}}"##))
    }

    #[test]
    fn a_shader_fill_paints_a_placeholder_over_the_node_and_under_its_children() {
        let fill = serde_json::json!(["#00FF00", { "type": "shader", "source": SHADER, "uniforms": [0.5, 2.0], "play": false, "opacity": 0.5 }]).to_string();
        let b = shader_board(&fill);
        assert_eq!(b.fills.len(), 1);
        let f = &b.fills[0];
        assert_eq!(f.id, "card");
        assert_eq!((f.w, f.h), (200.0, 100.0));
        // 2 texels per unit, fixed whatever the zoom.
        assert_eq!((f.image.width, f.image.height), (400, 200));
        assert_eq!(f.rect, Rect::new(40.0, 30.0, 240.0, 130.0));
        assert_eq!(f.shader.params, vec![0.5, 2.0]);
        assert!(!f.shader.play);
        assert!((f.shader.opacity - 0.5).abs() < 1e-6);
        // The scene draws the placeholder (an image patch) before the child's rectangle.
        let patches = &b.scene.encoding().resources.patches;
        assert!(patches.iter().any(|p| matches!(p, vello::low_level::vello_encoding::Patch::Image { image, .. } if image.data.id() == f.image.data.id())));
    }

    #[test]
    fn no_shader_fill_without_a_source_and_a_big_node_is_capped() {
        let b = shader_board(r#"{"type":"shader","shader":"mesh-gradient"}"#);
        assert!(b.fills.is_empty());
        assert_eq!(crate::paint::fill_tex_size(2000.0, 500.0), (1024, 256));
        assert_eq!(crate::paint::fill_tex_size(0.0, 0.0), (2, 2));
    }

    #[test]
    fn a_fill_frame_dirties_only_the_node_and_keeps_a_tile_job_going() {
        let fill = serde_json::json!({ "type": "shader", "source": SHADER }).to_string();
        let mut b = shader_board(&fill);
        let (g0, stamp0) = (b.generation, b.job_stamp());
        b.fill_frame(b.fills[0].rect);
        assert_eq!(b.generation, g0 + 1);
        assert_eq!(b.job_stamp(), stamp0);
        assert_eq!(b.dirty_since(g0), Some(Rect::new(39.0, 29.0, 241.0, 131.0)));
    }
}
