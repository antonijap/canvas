//! Layout: document sizing and auto-layout mapped onto taffy flexbox exactly the way html.ts maps it
//! onto CSS, so the browser's result is what this reproduces.
//!
//! The mapping (html.ts `sizeCss`, `nodeHtml`):
//! - Every node is `box-sizing: border-box; flex-shrink: 0`.
//! - Frames lay out with `layout` horizontal (the default) or vertical as a flex row/column with
//!   `gap`, `padding`, `justify-content`, `align-items` (default flex-start, never stretch).
//! - Children of a `layout: none` frame or a group, and children with `layoutPosition: absolute`,
//!   are absolutely positioned at their x/y. They never depend on their parent's size, so each is
//!   laid out on its own ("an island") and positioned afterwards.
//! - A number is a fixed size (and the flex-basis on the main axis). `fill_container` inside a
//!   flex parent grows on the main axis (`flex: 1 0 0`, min-size 0) and stretches on the cross axis.
//!   Everywhere else (and for `fit_content`) the fallback number applies when there is nothing to
//!   fit, otherwise width is max-content and height auto.
//! - A `layout: none` frame with a non-fixed size, and every group, is sized to its children's
//!   transformed bounds after layout (html.ts `FIT_SCRIPT`), measured from its own origin.
//! - Rotation and flips are transforms about the node's top-left corner and never affect layout.
//! - Text measures through parley (see text.rs); notes carry 12px padding.

use kurbo::{Affine, Rect};
use taffy::prelude::*;
use taffy::{AlignContent, AlignItems, AlignSelf, FlexWrap, JustifyContent, Overflow, Point as TPoint};

use crate::scene::{Align, Doc, FlexLayout, GapMode, Growth, Justify, Kind, Node, Sizing, StrokeAlign, StrokeWidth, VAlign};
use crate::text::{Avail, TextBlock, TextSystem};

/// A node's box relative to its parent's box (before its own transform).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BoxGeom {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

pub struct LayoutResult {
    pub boxes: Vec<BoxGeom>,
    /// parent box space ← node box space
    pub local: Vec<Affine>,
    /// board space ← node box space
    pub world: Vec<Affine>,
    /// world AABB of each node's box (what getBoundingClientRect reports, in board units)
    pub aabb: Vec<Rect>,
    /// Text layouts, between `restore_texts` and `drop_texts` (a board keeps them only while it
    /// paints: the scene has the glyphs, and thousands of parley layouts are tens of MB).
    pub texts: Vec<Option<Box<TextBlock>>>,
    /// Where the text's first line box starts inside the node box (padding, vertical alignment).
    pub text_origin: Vec<(f64, f64)>,
}

impl LayoutResult {
    pub fn rect(&self, i: usize) -> Rect {
        Rect::new(0.0, 0.0, self.boxes[i].w, self.boxes[i].h)
    }
}

const NOTE_PADDING: f32 = 12.0;

fn is_none_container(n: &Node) -> bool {
    n.kind == Kind::Group || (n.kind == Kind::Frame && n.layout == FlexLayout::None)
}

/// The width/height a node is sized by (html.ts passes `n.width ?? 0` for plain boxes, 24 for icons).
fn axis_sizing(n: &Node, horizontal: bool) -> Sizing {
    let s = if horizontal { n.width } else { n.height };
    let given = if horizontal { n.num_w.is_some() || !matches!(s, Sizing::Fit(None)) } else { n.num_h.is_some() || !matches!(s, Sizing::Fit(None)) };
    match n.kind {
        Kind::Frame | Kind::Group => s,
        Kind::Text | Kind::Note | Kind::Prompt | Kind::Context => s,
        Kind::Icon if !given => Sizing::Fixed(24.0),
        _ if !given => Sizing::Fixed(0.0),
        _ => s,
    }
}

/// Which axes a text node sizes itself on (html.ts only sets width for fixed growth modes).
fn text_sets(n: &Node) -> (bool, bool) {
    match n.text.as_ref().map(|t| t.growth) {
        Some(Growth::Auto) => (false, false),
        Some(Growth::FixedWidth) => (true, false),
        _ => (true, true),
    }
}

fn len(v: f64) -> Dimension {
    Dimension::length(v as f32)
}

struct Builder<'a> {
    doc: &'a Doc,
    ts: &'a mut TextSystem,
    boxes: Vec<BoxGeom>,
    texts: Vec<Option<TextBlock>>,
    /// Some frame aligns its children on their text baseline: text leaves report their first baseline.
    baselines: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Parent {
    /// The node is laid out on its own: the board root or an absolutely positioned child.
    Island,
    Flex(FlexLayout),
    /// A flex parent that hugs its content on the main axis: a Fill child there has no free space to
    /// share, so it takes its content size (current edits turn that parent Fixed; old files can still hold it).
    FlexHug(FlexLayout),
}

impl Parent {
    fn flex(self) -> Option<FlexLayout> {
        match self {
            Parent::Island => None,
            Parent::Flex(l) | Parent::FlexHug(l) => Some(l),
        }
    }
}

impl Builder<'_> {
    /// Size of a node laid out on its own, plus the layout of everything under it.
    fn island(&mut self, idx: usize) {
        let n = &self.doc.nodes[idx];
        if is_none_container(n) {
            let (ew, eh) = self.none_children(idx);
            let w = self.none_size(idx, true, ew, Parent::Island);
            let h = self.none_size(idx, false, eh, Parent::Island);
            let cl = n.cl;
            self.boxes[idx].w = clamp(w.unwrap_or(ew), cl.min_w, cl.max_w);
            self.boxes[idx].h = clamp(h.unwrap_or(eh), cl.min_h, cl.max_h);
            return;
        }
        let mut tree: TaffyTree<usize> = TaffyTree::new();
        tree.disable_rounding();
        let mut map: Vec<(NodeId, usize)> = Vec::new();
        let root = self.build(&mut tree, idx, Parent::Island, &mut map);
        let texts = &mut self.texts;
        let (doc, baselines) = (self.doc, self.baselines);
        let _ = tree.compute_layout_with_measure(root, Size::MAX_CONTENT, |inputs, _id, ctx, style| {
            let text = ctx.as_deref().copied();
            let mut out = taffy::compute_leaf_layout(inputs, style, |_, _| 0.0, |known, avail| {
                let Some(i) = text else { return Size::ZERO };
                let Some(tb) = texts[i].as_mut() else { return Size::ZERO };
                let a = match (known.width, avail.width) {
                    (Some(w), _) => Avail::Definite(w),
                    (None, AvailableSpace::Definite(w)) => Avail::Definite(w),
                    (None, AvailableSpace::MinContent) => Avail::MinContent,
                    (None, AvailableSpace::MaxContent) => Avail::MaxContent,
                };
                let (w, h) = tb.measure(a);
                Size { width: known.width.unwrap_or(w), height: known.height.unwrap_or(h) }
            });
            if baselines && let Some(i) = text {
                out.baselines.first = texts[i].as_mut().and_then(|tb| first_baseline(tb, out.size.width - 2.0 * text_pad(&doc.nodes[i]) as f32)).map(|b| b + text_pad(&doc.nodes[i]) as f32);
            }
            out
        });
        for (tid, i) in map {
            let l = tree.layout(tid).copied().unwrap_or_default();
            let b = &mut self.boxes[i];
            b.w = f64::from(l.size.width);
            b.h = f64::from(l.size.height);
            if i != idx {
                b.x = f64::from(l.location.x);
                b.y = f64::from(l.location.y);
            }
        }
    }

    /// Lay out the children of a layout-none frame or group (all absolute). Returns their extents.
    fn none_children(&mut self, idx: usize) -> (f64, f64) {
        let kids = self.doc.nodes[idx].children.clone();
        let (mut ew, mut eh) = (0f64, 0f64);
        for c in kids {
            self.island(c);
            let cn = &self.doc.nodes[c];
            self.boxes[c].x = cn.x;
            self.boxes[c].y = cn.y;
            let r = local_transform(cn, &self.boxes[c]).transform_rect_bbox(Rect::new(0.0, 0.0, self.boxes[c].w, self.boxes[c].h));
            ew = ew.max(r.x1);
            eh = eh.max(r.y1);
        }
        (ew, eh)
    }

    /// The size a layout-none frame takes on one axis when it is not sized by its children's
    /// extents (None: the extents decide). Groups always fit.
    fn none_size(&self, idx: usize, horizontal: bool, _extent: f64, parent: Parent) -> Option<f64> {
        let n = &self.doc.nodes[idx];
        if n.kind == Kind::Group {
            return None;
        }
        match axis_sizing(n, horizontal) {
            Sizing::Fixed(v) => Some(v),
            // fill_container in a flex parent: grows/stretches (handled by the caller's style).
            Sizing::Fill(_) if matches!(parent.flex(), Some(l) if l != FlexLayout::None) => None,
            _ => None,
        }
    }

    fn build(&mut self, tree: &mut TaffyTree<usize>, idx: usize, parent: Parent, map: &mut Vec<(NodeId, usize)>) -> NodeId {
        let n = &self.doc.nodes[idx];
        let mut style = Style { flex_shrink: 0.0, ..Default::default() };
        
        let id = if is_none_container(n) {
            // Sized by its children after their own layout; a leaf here.
            let (ew, eh) = self.none_children(idx);
            let n = &self.doc.nodes[idx];
            for horizontal in [true, false] {
                let fixed = self.none_size(idx, horizontal, 0.0, parent);
                let extent = if horizontal { ew } else { eh };
                let s = if n.kind == Kind::Group { Sizing::Fixed(extent) } else { axis_sizing(n, horizontal) };
                match s {
                    Sizing::Fixed(_) => apply_axis(&mut style, Sizing::Fixed(fixed.unwrap_or(extent)), horizontal, parent, false),
                    // (In a hugging parent there is nothing to fill: it keeps its extent.)
                    Sizing::Fill(_) if is_main(parent, horizontal) && !matches!(parent, Parent::FlexHug(_)) => apply_axis(&mut style, s, horizontal, parent, false),
                    // FIT_SCRIPT writes an explicit size, which also beats cross-axis stretch.
                    _ => apply_axis(&mut style, Sizing::Fixed(extent), horizontal, parent, false),
                }
            }
            apply_limits(&mut style, n);
            tree.new_leaf(style).expect("taffy leaf")
        } else if n.kind == Kind::Frame {
            let cl = n.cl;
            let row = n.layout != FlexLayout::Vertical;
            style.display = Display::Flex;
            style.flex_direction = if row { FlexDirection::Row } else { FlexDirection::Column };
            style.justify_content = match (n.justify, cl.gap_mode) {
                (Justify::Start, _) => JustifyContent::FLEX_START,
                (Justify::Center, _) => JustifyContent::CENTER,
                (Justify::End, _) => JustifyContent::FLEX_END,
                // Auto gap: the mode in canvasLayout picks how the free space spreads (Evenly has no native key).
                (Justify::SpaceBetween | Justify::SpaceAround, Some(GapMode::Evenly)) => JustifyContent::SPACE_EVENLY,
                (Justify::SpaceBetween | Justify::SpaceAround, Some(GapMode::Between)) => JustifyContent::SPACE_BETWEEN,
                (Justify::SpaceBetween | Justify::SpaceAround, Some(GapMode::Around)) => JustifyContent::SPACE_AROUND,
                (Justify::SpaceBetween, None) => JustifyContent::SPACE_BETWEEN,
                (Justify::SpaceAround, None) => JustifyContent::SPACE_AROUND,
            };
            style.align_items = match n.align {
                // Baseline alignment is a horizontal-flow setting (offered only there).
                _ if cl.baseline && row => AlignItems::BASELINE,
                Align::Start => AlignItems::FLEX_START,
                Align::Center => AlignItems::CENTER,
                Align::End => AlignItems::FLEX_END,
            };
            if cl.wrap {
                // Main-axis gap within a line, crossGap between lines.
                style.flex_wrap = FlexWrap::Wrap;
                style.align_content = if cl.cross_auto { AlignContent::SPACE_BETWEEN } else { AlignContent::FLEX_START };
                let (main, cross) = (LengthPercentage::length(n.gap as f32), LengthPercentage::length(cl.cross_gap as f32));
                style.gap = if row { Size { width: main, height: cross } } else { Size { width: cross, height: main } };
            } else if n.gap != 0.0 {
                style.gap = Size { width: LengthPercentage::length(n.gap as f32), height: LengthPercentage::length(n.gap as f32) };
            }
            style.padding = padding_rect(add_sides(n.padding, included_stroke(n)));
            if n.clip {
                style.overflow = TPoint { x: Overflow::Hidden, y: Overflow::Hidden };
            }
            let has_children = !n.children.is_empty();
            apply_axis(&mut style, axis_sizing(n, true), true, parent, has_children);
            apply_axis(&mut style, axis_sizing(n, false), false, parent, has_children);
            apply_limits(&mut style, n);
            let kids = n.children.clone();
            // Does this frame hug on its main axis (in its own context)? Then a Fill child there has no space to fill.
            let main_sizing = axis_sizing(n, row);
            let hugs_main = match main_sizing {
                Sizing::Fixed(_) => false,
                Sizing::Fit(Some(_)) => has_children,
                Sizing::Fit(None) => true,
                // In a flex parent Fill grows or stretches; on its own it falls back to its number, else hugs.
                Sizing::Fill(v) => parent.flex().is_none() && v.is_none(),
            };
            let ctx = if hugs_main { Parent::FlexHug(n.layout) } else { Parent::Flex(n.layout) };
            let mut ids = Vec::with_capacity(kids.len());
            for c in kids {
                if self.doc.nodes[c].absolute {
                    self.island(c);
                    self.boxes[c].x = self.doc.nodes[c].x;
                    self.boxes[c].y = self.doc.nodes[c].y;
                } else {
                    ids.push(self.build(tree, c, ctx, map));
                }
            }
            tree.new_with_children(style, &ids).expect("taffy node")
        } else if n.kind.is_texty() {
            let (sets_w, sets_h) = text_sets(n);
            if sets_w {
                apply_axis(&mut style, axis_sizing(n, true), true, parent, false);
            }
            if sets_h {
                apply_axis(&mut style, axis_sizing(n, false), false, parent, false);
            }
            if n.kind != Kind::Text {
                style.padding = padding_rect([f64::from(NOTE_PADDING); 4]);
            }
            apply_limits(&mut style, n);
            let tb = n.text.as_ref().map(|t| self.ts.build(t));
            self.texts[idx] = tb;
            tree.new_leaf_with_context(style, idx).expect("taffy text leaf")
        } else {
            apply_axis(&mut style, axis_sizing(n, true), true, parent, false);
            apply_axis(&mut style, axis_sizing(n, false), false, parent, false);
            apply_limits(&mut style, n);
            tree.new_leaf(style).expect("taffy leaf")
        };
        map.push((id, idx));
        id
    }
}

fn is_main(parent: Parent, horizontal: bool) -> bool {
    matches!(parent.flex(), Some(FlexLayout::Horizontal)) && horizontal || matches!(parent.flex(), Some(FlexLayout::Vertical)) && !horizontal
}

fn clamp(v: f64, min: Option<f64>, max: Option<f64>) -> f64 {
    // CSS: min wins over max.
    let v = max.map_or(v, |m| v.min(m));
    min.map_or(v, |m| v.max(m))
}

/// canvasLayout min/max width and height (on Hug, Fill and Fixed alike; Fill keeps its min 0 when no min is set).
fn apply_limits(style: &mut Style, n: &Node) {
    let cl = n.cl;
    if let Some(v) = cl.min_w {
        style.min_size.width = LengthPercentageAuto::length(v as f32);
    }
    if let Some(v) = cl.min_h {
        style.min_size.height = LengthPercentageAuto::length(v as f32);
    }
    if let Some(v) = cl.max_w {
        style.max_size.width = LengthPercentageAuto::length(v as f32);
    }
    if let Some(v) = cl.max_h {
        style.max_size.height = LengthPercentageAuto::length(v as f32);
    }
}

/// The inner stroke a frame keeps room for (`layoutIncludeStroke`), per side: top, right, bottom, left.
/// Outside and centre strokes never take space; nor does a stroke with no paint.
fn included_stroke(n: &Node) -> [f64; 4] {
    if !n.layout_include_stroke || n.stroke_align != StrokeAlign::Inner || n.strokes.is_empty() {
        return [0.0; 4];
    }
    match n.stroke_width {
        Some(StrokeWidth::Uniform(w)) => [w.max(0.0); 4],
        Some(StrokeWidth::Sides(s)) => s.map(|w| w.max(0.0)),
        None => [0.0; 4],
    }
}

fn add_sides(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]]
}

/// The first line's baseline from the top of the text, at the width the text is laid out at.
fn first_baseline(tb: &mut TextBlock, width: f32) -> Option<f32> {
    tb.layout.as_ref()?;
    tb.measure(Avail::Definite(width.max(0.0) + 0.01));
    tb.layout.as_ref()?.lines().next().map(|l| l.metrics().baseline)
}

fn padding_rect(p: [f64; 4]) -> taffy::Rect<LengthPercentage> {
    let l = |v: f64| LengthPercentage::length(v as f32);
    taffy::Rect { top: l(p[0]), right: l(p[1]), bottom: l(p[2]), left: l(p[3]) }
}

/// html.ts `sizeCss` for one axis.
fn apply_axis(style: &mut Style, s: Sizing, horizontal: bool, parent: Parent, has_children: bool) {
    let in_layout = matches!(parent.flex(), Some(l) if l != FlexLayout::None);
    let main = is_main(parent, horizontal);
    // Fill on the main axis of a hugging parent: there is no free space to share, so it hugs its content.
    let s = match s {
        Sizing::Fill(_) if main && matches!(parent, Parent::FlexHug(_)) => Sizing::Fit(None),
        s => s,
    };
    let set = |style: &mut Style, d: Dimension| {
        if horizontal {
            style.size.width = d;
        } else {
            style.size.height = d;
        }
    };
    match s {
        Sizing::Fixed(v) => {
            set(style, len(v));
            if main {
                style.flex_basis = len(v);
            }
        }
        Sizing::Fill(_) if in_layout => {
            if main {
                style.flex_grow = 1.0;
                style.flex_basis = Dimension::length(0.0);
                if horizontal {
                    style.min_size.width = LengthPercentageAuto::length(0.0);
                } else {
                    style.min_size.height = LengthPercentageAuto::length(0.0);
                }
            } else {
                style.align_self = Some(AlignSelf::STRETCH);
            }
        }
        Sizing::Fill(Some(v)) => set(style, len(v)),
        Sizing::Fit(Some(v)) if !has_children => set(style, len(v)),
        _ => {
            if horizontal && parent != Parent::Island {
                set(style, Dimension::max_content());
            } else {
                set(style, Dimension::auto());
            }
        }
    }
}

/// parent box space ← node box space: position, then `rotate(-r) scaleX(±1) scaleY(±1)` about the
/// top-left corner (CSS `transform-origin: 0 0`).
pub fn local_transform(n: &Node, b: &BoxGeom) -> Affine {
    let mut t = Affine::translate((b.x, b.y));
    if n.rotation != 0.0 {
        t *= Affine::rotate(-n.rotation.to_radians());
    }
    if n.flip_x || n.flip_y {
        t *= Affine::scale_non_uniform(if n.flip_x { -1.0 } else { 1.0 }, if n.flip_y { -1.0 } else { 1.0 });
    }
    t
}

pub fn text_pad(node: &crate::scene::Node) -> f64 {
    if node.kind == Kind::Text { 0.0 } else { f64::from(NOTE_PADDING) }
}

/// Shape every text again at the widths layout settled on (after `drop_texts`).
pub fn restore_texts(doc: &Doc, l: &mut LayoutResult, ts: &mut TextSystem) {
    l.texts = doc
        .nodes
        .iter()
        .enumerate()
        .map(|(i, node)| {
            let t = node.text.as_ref()?;
            let mut tb = ts.build(t);
            let pad = text_pad(node);
            ts.finish_text(&mut tb, t, (l.boxes[i].w - 2.0 * pad) as f32, Some((l.boxes[i].h - 2.0 * pad) as f32));
            Some(Box::new(tb))
        })
        .collect();
}

/// Free the text layouts (boxes, transforms and text origins stay).
pub fn drop_texts(l: &mut LayoutResult) {
    l.texts = Vec::new();
}

/// Does any frame align its children on their text baseline (text leaves then report their first baseline)?
pub fn uses_baselines(nodes: &[Node]) -> bool {
    nodes.iter().any(|x| x.cl.baseline && x.kind == Kind::Frame && x.layout == FlexLayout::Horizontal)
}

/// Lay out the subtree of node `i` (the nodes `i..end`, pre-order) again, in place, as `layout_doc` would: for a
/// node whose parent places it freely and does not take its size from it, nothing outside the subtree moves. The
/// caller checks that (Board::update_node). Text layouts are left dropped (a repaint restores them).
pub fn relayout_subtree(doc: &Doc, l: &mut LayoutResult, ts: &mut TextSystem, i: usize, end: usize) {
    let n = doc.nodes.len();
    let baselines = uses_baselines(&doc.nodes);
    let mut b = Builder { doc, ts, boxes: std::mem::take(&mut l.boxes), texts: (0..n).map(|_| None).collect(), baselines };
    b.island(i);
    b.boxes[i].x = doc.nodes[i].x;
    b.boxes[i].y = doc.nodes[i].y;
    let Builder { boxes, mut texts, .. } = b;
    l.boxes = boxes;
    for j in i..end {
        let node = &doc.nodes[j];
        l.local[j] = local_transform(node, &l.boxes[j]);
        l.world[j] = match node.parent {
            Some(p) => l.world[p] * l.local[j],
            None => l.local[j],
        };
        l.aabb[j] = l.world[j].transform_rect_bbox(Rect::new(0.0, 0.0, l.boxes[j].w, l.boxes[j].h));
        l.text_origin[j] = (0.0, 0.0);
        if let (Some(tb), Some(t)) = (texts[j].as_mut(), node.text.as_ref()) {
            let pad = text_pad(node);
            let cw = l.boxes[j].w - 2.0 * pad;
            let ch = l.boxes[j].h - 2.0 * pad;
            ts.finish_text(tb, t, cw as f32, Some(ch as f32));
            let th = f64::from(tb.height());
            let dy = if t.growth == Growth::FixedWidthHeight {
                match t.valign {
                    VAlign::Top => 0.0,
                    VAlign::Middle => (ch - th) / 2.0,
                    VAlign::Bottom => ch - th,
                }
            } else {
                0.0
            };
            l.text_origin[j] = (pad, pad + dy);
        }
    }
    let mut fitted = vec![false; n];
    for j in (i + 1..end).rev() {
        let Some(par) = doc.nodes[j].parent else { continue };
        if doc.nodes[par].kind != Kind::Group {
            continue;
        }
        let r = l.aabb[j];
        l.aabb[par] = if fitted[par] { l.aabb[par].union(r) } else { r };
        fitted[par] = true;
    }
    l.texts = Vec::new();
}

/// Lay out a whole board. The root sits at the board origin.
pub fn layout_doc(doc: &Doc, ts: &mut TextSystem) -> LayoutResult {
    let n = doc.nodes.len();
    let baselines = uses_baselines(&doc.nodes);
    let mut b = Builder { doc, ts: &mut *ts, boxes: vec![BoxGeom::default(); n], texts: (0..n).map(|_| None).collect(), baselines };
    if n > 0 {
        b.island(0);
        b.boxes[0].x = 0.0;
        b.boxes[0].y = 0.0;
    }
    let Builder { boxes, texts, .. } = b;
    let mut texts: Vec<Option<Box<TextBlock>>> = texts.into_iter().map(|t| t.map(Box::new)).collect();
    let mut local = vec![Affine::IDENTITY; n];
    let mut world = vec![Affine::IDENTITY; n];
    let mut aabb = vec![Rect::ZERO; n];
    let mut text_origin = vec![(0.0, 0.0); n];
    for i in 0..n {
        let node = &doc.nodes[i];
        local[i] = local_transform(node, &boxes[i]);
        world[i] = match node.parent {
            Some(p) => world[p] * local[i],
            None => local[i],
        };
        aabb[i] = world[i].transform_rect_bbox(Rect::new(0.0, 0.0, boxes[i].w, boxes[i].h));
        if let (Some(tb), Some(t)) = (texts[i].as_mut(), node.text.as_ref()) {
            let pad = text_pad(node);
            let cw = boxes[i].w - 2.0 * pad;
            let ch = boxes[i].h - 2.0 * pad;
            ts.finish_text(tb, t, cw as f32, Some(ch as f32));
            let th = f64::from(tb.height());
            let dy = if t.growth == Growth::FixedWidthHeight {
                match t.valign {
                    VAlign::Top => 0.0,
                    VAlign::Middle => (ch - th) / 2.0,
                    VAlign::Bottom => ch - th,
                }
            } else {
                0.0
            };
            text_origin[i] = (pad, pad + dy);
        }
    }
    // A group's box is where its layers are drawn. Its own box starts at its x/y, so a layer that reaches above or
    // left of that corner (turned 45 degrees at 0,0, or a negative x) would stick out of the selection box and the
    // handles. Children follow their parent in pre-order: a reverse sweep fits nested groups first.
    let mut fitted = vec![false; n];
    for i in (1..n).rev() {
        let Some(par) = doc.nodes[i].parent else { continue };
        if doc.nodes[par].kind != Kind::Group {
            continue;
        }
        let r = aabb[i];
        aabb[par] = if fitted[par] { aabb[par].union(r) } else { r };
        fitted[par] = true;
    }
    LayoutResult { boxes, local, world, aabb, texts, text_origin }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::Doc;
    use crate::text::tests::system;
    use serde_json::{Value, json};

    fn lay(v: Value) -> (Doc, LayoutResult) {
        let doc = Doc::from_value(&v).unwrap();
        let mut ts = system().unwrap_or_default();
        let l = layout_doc(&doc, &mut ts);
        (doc, l)
    }

    /// (x, y, w, h) relative to the parent box.
    fn rect_of(d: &Doc, l: &LayoutResult, id: &str) -> (f64, f64, f64, f64) {
        let i = d.index_of(id).unwrap_or_else(|| panic!("no {id}"));
        let b = l.boxes[i];
        ((b.x * 100.0).round() / 100.0, (b.y * 100.0).round() / 100.0, (b.w * 100.0).round() / 100.0, (b.h * 100.0).round() / 100.0)
    }

    fn rect(id: &str, w: Value, h: Value) -> Value {
        json!({ "type": "rectangle", "id": id, "width": w, "height": h })
    }

    #[test]
    fn a_group_box_covers_a_turned_layer_above_its_corner() {
        // QA round 4, 2a: a 100x60 layer turned 45 degrees at the group's 0,0 reaches 70.71 above it.
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "width": 600, "height": 600, "layout": "none", "children": [
            { "type": "group", "id": "g", "x": 100, "y": 150, "children": [
                { "type": "rectangle", "id": "t", "x": 0, "y": 0, "width": 100, "height": 60, "rotation": 45 },
                { "type": "rectangle", "id": "p", "x": 140, "y": 0, "width": 80, "height": 80 } ] },
            { "type": "group", "id": "o", "x": 10, "y": 10, "children": [
                { "type": "group", "id": "i", "x": 0, "y": 0, "children": [ rect("q", json!(20), json!(20)) ] } ] } ] }));
        let g = l.aabb[d.index_of("g").unwrap()];
        let t = l.aabb[d.index_of("t").unwrap()];
        let p = l.aabb[d.index_of("p").unwrap()];
        let r2 = |v: f64| (v * 100.0).round() / 100.0;
        assert_eq!((r2(g.x0), r2(g.y0)), (r2(t.x0.min(p.x0)), r2(t.y0)), "the box starts at the turned layer's top");
        assert!(g.y0 < 150.0 - 70.0, "it reaches above the group's own y ({})", g.y0);
        assert_eq!((r2(g.x1), r2(g.y1)), (r2(t.x1.max(p.x1)), r2(t.y1.max(p.y1))));
        let o = l.aabb[d.index_of("o").unwrap()];
        assert_eq!((o.x0, o.y0, o.x1, o.y1), (10.0, 10.0, 30.0, 30.0), "nested groups fit too");
    }

    #[test]
    fn horizontal_gap_padding_and_cross_start() {
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "width": 300, "height": 100, "gap": 10, "padding": [5, 20],
            "children": [rect("a", json!(50), json!(30)), rect("b", json!(60), json!(40))] }));
        assert_eq!(rect_of(&d, &l, "r"), (0.0, 0.0, 300.0, 100.0));
        assert_eq!(rect_of(&d, &l, "a"), (20.0, 5.0, 50.0, 30.0));
        assert_eq!(rect_of(&d, &l, "b"), (80.0, 5.0, 60.0, 40.0), "align-items defaults to flex-start, not stretch");
    }

    #[test]
    fn vertical_fit_content_frame_wraps_its_children() {
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "layout": "vertical", "gap": 4, "padding": 8,
            "children": [rect("a", json!(50), json!(30)), rect("b", json!(80), json!(10))] }));
        assert_eq!(rect_of(&d, &l, "r"), (0.0, 0.0, 96.0, 60.0));
        assert_eq!(rect_of(&d, &l, "b"), (8.0, 42.0, 80.0, 10.0));
    }

    #[test]
    fn fill_container_grows_on_main_and_stretches_on_cross() {
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "width": 300, "height": 100, "padding": 10, "gap": 10,
            "children": [rect("a", json!(50), json!("fill_container")), rect("b", json!("fill_container"), json!(20)), rect("c", json!("fill_container"), json!(20))] }));
        assert_eq!(rect_of(&d, &l, "a"), (10.0, 10.0, 50.0, 80.0));
        assert_eq!(rect_of(&d, &l, "b"), (70.0, 10.0, 105.0, 20.0));
        assert_eq!(rect_of(&d, &l, "c"), (185.0, 10.0, 105.0, 20.0));
    }

    #[test]
    fn justify_and_align() {
        for (j, a, ax, ay) in [("center", "center", 125.0, 35.0), ("end", "end", 250.0, 70.0), ("start", "start", 0.0, 0.0)] {
            let (d, l) = lay(json!({ "type": "frame", "id": "r", "width": 300, "height": 100, "justifyContent": j, "alignItems": a,
                "children": [rect("a", json!(50), json!(30))] }));
            assert_eq!(rect_of(&d, &l, "a"), (ax, ay, 50.0, 30.0), "{j}/{a}");
        }
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "width": 300, "height": 100, "justifyContent": "space_between",
            "children": [rect("a", json!(50), json!(30)), rect("b", json!(50), json!(30)), rect("c", json!(50), json!(30))] }));
        assert_eq!(rect_of(&d, &l, "b").0, 125.0);
        assert_eq!(rect_of(&d, &l, "c").0, 250.0);
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "width": 300, "height": 100, "justifyContent": "space_around",
            "children": [rect("a", json!(50), json!(30)), rect("b", json!(50), json!(30))] }));
        assert_eq!(rect_of(&d, &l, "a").0, 50.0);
        assert_eq!(rect_of(&d, &l, "b").0, 200.0);
    }

    #[test]
    fn layout_none_children_sit_at_xy_and_fit_frame_takes_their_extent() {
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "layout": "none",
            "children": [
                { "type": "rectangle", "id": "a", "x": 10, "y": 20, "width": 50, "height": 30 },
                { "type": "rectangle", "id": "b", "x": 100, "y": 5, "width": 20, "height": 20 }
            ] }));
        assert_eq!(rect_of(&d, &l, "a"), (10.0, 20.0, 50.0, 30.0));
        assert_eq!(rect_of(&d, &l, "r"), (0.0, 0.0, 120.0, 50.0));
    }

    #[test]
    fn group_in_flex_is_a_fixed_box_of_its_extent_and_rotation_counts() {
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "layout": "vertical", "gap": 10,
            "children": [
                { "type": "group", "id": "g", "children": [{ "type": "rectangle", "id": "a", "x": 0, "y": 0, "width": 100, "height": 20, "rotation": -90 }] },
                rect("b", json!(10), json!(10))
            ] }));
        // rotate(90deg) about the top-left: the 100x20 bar now spans x -20..0, y 0..100.
        assert_eq!(rect_of(&d, &l, "g"), (0.0, 0.0, 0.0, 100.0));
        assert_eq!(rect_of(&d, &l, "b"), (0.0, 110.0, 10.0, 10.0));
        let a = d.index_of("a").unwrap();
        let bb = l.aabb[a];
        assert!((bb.x0 + 20.0).abs() < 1e-9 && (bb.y1 - 100.0).abs() < 1e-9, "{bb:?}");
    }

    #[test]
    fn absolute_child_in_flex_is_out_of_flow() {
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "width": 200, "height": 100, "gap": 10,
            "children": [
                rect("a", json!(50), json!(30)),
                { "type": "rectangle", "id": "abs", "layoutPosition": "absolute", "x": 150, "y": 60, "width": "fill_container(40)", "height": 10 },
                rect("b", json!(50), json!(30))
            ] }));
        assert_eq!(rect_of(&d, &l, "b"), (60.0, 0.0, 50.0, 30.0));
        assert_eq!(rect_of(&d, &l, "abs"), (150.0, 60.0, 40.0, 10.0), "fill_container falls back to its number when absolute");
    }

    #[test]
    fn fit_fallback_only_without_children() {
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "width": "fit_content(77)", "height": "fit_content(33)", "children": [] }));
        assert_eq!(rect_of(&d, &l, "r"), (0.0, 0.0, 77.0, 33.0));
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "width": "fit_content(77)", "children": [rect("a", json!(10), json!(10))] }));
        assert_eq!(rect_of(&d, &l, "r"), (0.0, 0.0, 10.0, 10.0));
    }

    #[test]
    fn fit_child_overflows_a_narrow_column_like_max_content() {
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "width": 50, "layout": "vertical",
            "children": [{ "type": "frame", "id": "f", "children": [rect("a", json!(120), json!(10))] }] }));
        assert_eq!(rect_of(&d, &l, "f"), (0.0, 0.0, 120.0, 10.0));
    }

    #[test]
    fn fill_in_layout_none_frame_uses_fallback() {
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "layout": "none", "width": 300, "height": 300,
            "children": [{ "type": "frame", "id": "f", "x": 0, "y": 0, "width": "fill_container", "height": "fill_container(50)", "children": [rect("a", json!(30), json!(10))] }] }));
        assert_eq!(rect_of(&d, &l, "f"), (0.0, 0.0, 30.0, 50.0));
    }

    #[test]
    fn text_fixed_width_wraps_and_fills() {
        if system().is_none() {
            return;
        }
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "width": 100, "layout": "vertical",
            "children": [
                { "type": "text", "id": "t", "content": "one two three four five", "fontFamily": "Arial", "fontSize": 16, "textGrowth": "fixed-width", "width": "fill_container" },
                { "type": "text", "id": "u", "content": "auto", "fontFamily": "Arial", "fontSize": 16 }
            ] }));
        let t = rect_of(&d, &l, "t");
        assert_eq!(t.2, 100.0, "stretches across the column");
        assert!(t.3 >= 36.0, "wraps to at least two 18px lines: {t:?}");
        let u = rect_of(&d, &l, "u");
        assert_eq!(u.3, 18.0);
        assert_eq!(u.1, t.3);
    }

    #[test]
    fn text_valign_offsets_content() {
        if system().is_none() {
            return;
        }
        let (d, l) = lay(json!({ "type": "text", "id": "t", "content": "x", "fontFamily": "Arial", "fontSize": 16, "textGrowth": "fixed-width-height", "width": 50, "height": 58, "textAlignVertical": "middle" }));
        let i = d.index_of("t").unwrap();
        assert_eq!(l.text_origin[i], (0.0, 20.0));
    }

    fn cl_frame(extra: Value, cl: Value, kids: Vec<Value>) -> Value {
        let mut f = json!({ "type": "frame", "id": "r", "canvasLayout": cl, "children": kids });
        for (k, v) in extra.as_object().unwrap() {
            f[k] = v.clone();
        }
        f
    }

    #[test]
    fn min_and_max_sizes() {
        let (d, l) = lay(cl_frame(json!({}), json!({ "minWidth": 200 }), vec![rect("a", json!(50), json!(20))]));
        assert_eq!(rect_of(&d, &l, "r"), (0.0, 0.0, 200.0, 20.0), "a hug frame grows to its min width");
        let mut a = rect("a", json!("fill_container"), json!(20));
        a["canvasLayout"] = json!({ "maxWidth": 100 });
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "width": 300, "height": 50, "children": [a, rect("b", json!("fill_container"), json!(20))] }));
        assert_eq!(rect_of(&d, &l, "a"), (0.0, 0.0, 100.0, 20.0), "a fill child stops at its max");
        assert_eq!(rect_of(&d, &l, "b"), (100.0, 0.0, 200.0, 20.0), "the other fill sibling takes the rest");
        // max on a hug frame, min on a fixed child, both axes.
        let mut c = rect("c", json!(10), json!(10));
        c["canvasLayout"] = json!({ "minWidth": 30, "minHeight": 40 });
        let (d, l) = lay(cl_frame(json!({ "layout": "vertical" }), json!({ "maxHeight": 25 }), vec![c]));
        assert_eq!(rect_of(&d, &l, "c"), (0.0, 0.0, 30.0, 40.0));
        assert_eq!(rect_of(&d, &l, "r"), (0.0, 0.0, 30.0, 25.0));
        // A max below the min: the min wins (CSS).
        let (d, l) = lay(cl_frame(json!({ "layout": "none", "width": 10, "height": 10 }), json!({ "minWidth": 50, "maxWidth": 20 }), vec![]));
        assert_eq!(rect_of(&d, &l, "r").2, 50.0);
    }

    #[test]
    fn wrap_breaks_lines_with_a_cross_gap() {
        let kids: Vec<Value> = (0..6).map(|i| rect(&format!("i{i}"), json!(100), json!(40))).collect();
        let (d, l) = lay(cl_frame(json!({ "width": 330, "gap": 10 }), json!({ "wrap": true, "crossGap": 20 }), kids));
        assert_eq!(rect_of(&d, &l, "i0"), (0.0, 0.0, 100.0, 40.0));
        assert_eq!(rect_of(&d, &l, "i2"), (220.0, 0.0, 100.0, 40.0));
        assert_eq!(rect_of(&d, &l, "i3"), (0.0, 60.0, 100.0, 40.0), "line 2 at line 1 height + crossGap");
        assert_eq!(rect_of(&d, &l, "i5"), (220.0, 60.0, 100.0, 40.0));
        assert_eq!(rect_of(&d, &l, "r"), (0.0, 0.0, 330.0, 100.0), "hug height covers both lines");
        // crossAuto spreads the lines over a fixed cross size.
        let kids: Vec<Value> = (0..4).map(|i| rect(&format!("i{i}"), json!(100), json!(40))).collect();
        let (d, l) = lay(cl_frame(json!({ "width": 220, "height": 200, "gap": 10 }), json!({ "wrap": true, "crossGap": 20, "crossAuto": true }), kids));
        assert_eq!(rect_of(&d, &l, "i2").1, 160.0);
        // Vertical wrap: columns.
        let kids: Vec<Value> = (0..3).map(|i| rect(&format!("i{i}"), json!(30), json!(50))).collect();
        let (d, l) = lay(cl_frame(json!({ "layout": "vertical", "height": 110, "gap": 5 }), json!({ "wrap": true, "crossGap": 8 }), kids));
        assert_eq!(rect_of(&d, &l, "i1"), (0.0, 55.0, 30.0, 50.0));
        assert_eq!(rect_of(&d, &l, "i2"), (38.0, 0.0, 30.0, 50.0));
        // Without wrap the same row is one long line (and canvasLayout absent changes nothing).
        let kids: Vec<Value> = (0..3).map(|i| rect(&format!("i{i}"), json!(100), json!(40))).collect();
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "width": 200, "gap": 10, "children": kids }));
        assert_eq!(rect_of(&d, &l, "i2").0, 220.0);
    }

    #[test]
    fn auto_gap_evenly_and_its_fallback() {
        let kids = || vec![rect("a", json!(50), json!(10)), rect("b", json!(50), json!(10))];
        let (d, l) = lay(cl_frame(json!({ "width": 300, "justifyContent": "space_around" }), json!({ "gapMode": "evenly" }), kids()));
        assert_eq!(rect_of(&d, &l, "a").0, 66.67);
        assert_eq!(rect_of(&d, &l, "b").0, 183.33);
        // The native fallback alone (what a reader without canvasLayout draws): space_around.
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "width": 300, "justifyContent": "space_around", "children": kids() }));
        assert_eq!(rect_of(&d, &l, "a").0, 50.0);
        // gapMode only applies while the gap is Auto.
        let (d, l) = lay(cl_frame(json!({ "width": 300, "justifyContent": "center" }), json!({ "gapMode": "evenly" }), kids()));
        assert_eq!(rect_of(&d, &l, "a").0, 100.0);
        // Too big for the frame: items sit flush from the start, never overlap.
        let big = vec![rect("a", json!(200), json!(10)), rect("b", json!(200), json!(10))];
        let (d, l) = lay(cl_frame(json!({ "width": 300, "justifyContent": "space_between" }), json!({ "gapMode": "between" }), big));
        assert_eq!((rect_of(&d, &l, "a").0, rect_of(&d, &l, "b").0), (0.0, 200.0));
    }

    #[test]
    fn baseline_alignment_shares_the_first_baseline() {
        let Some(mut ts) = system() else { return };
        let t = |id: &str, size: f64| json!({ "type": "text", "id": id, "content": "Hxg", "fontFamily": "Arial", "fontSize": size });
        let v = cl_frame(json!({ "alignItems": "start" }), json!({ "baseline": true }), vec![t("s", 12.0), t("b", 32.0), rect("box", json!(10), json!(10))]);
        let d = Doc::from_value(&v).unwrap();
        let l = layout_doc(&d, &mut ts);
        let base = |id: &str| {
            let i = d.index_of(id).unwrap();
            let tb = l.texts[i].as_ref().unwrap();
            l.boxes[i].y + f64::from(tb.layout.as_ref().unwrap().lines().next().unwrap().metrics().baseline)
        };
        let (s, b) = (base("s"), base("b"));
        assert!((s - b).abs() < 0.5, "12px baseline {s} vs 32px baseline {b}");
        assert!(l.boxes[d.index_of("s").unwrap()].y > 5.0, "the small text moved down to the shared baseline");
        // A box without text sits on the baseline with its bottom edge (CSS).
        let bx = l.boxes[d.index_of("box").unwrap()];
        assert!((bx.y + bx.h - b).abs() < 0.5, "{bx:?} vs {b}");
        // Vertical flow ignores it.
        let v = cl_frame(json!({ "layout": "vertical" }), json!({ "baseline": true }), vec![t("s", 12.0), t("b", 32.0)]);
        let d = Doc::from_value(&v).unwrap();
        let l = layout_doc(&d, &mut ts);
        assert_eq!(l.boxes[d.index_of("s").unwrap()].x, 0.0);
    }

    #[test]
    fn negative_gap_overlaps() {
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "gap": -20, "children": [rect("a", json!(50), json!(10)), rect("b", json!(50), json!(10)), rect("c", json!(50), json!(10))] }));
        assert_eq!(rect_of(&d, &l, "b").0, 30.0, "starts 20 px before a ends");
        assert_eq!(rect_of(&d, &l, "c").0, 60.0);
        assert_eq!(rect_of(&d, &l, "r").2, 110.0, "the hug width counts the overlap");
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "layout": "vertical", "width": 100, "height": 200, "gap": -5, "justifyContent": "end", "children": [rect("a", json!(50), json!(30)), rect("b", json!(50), json!(30))] }));
        assert_eq!((rect_of(&d, &l, "a").1, rect_of(&d, &l, "b").1), (145.0, 170.0));
    }

    #[test]
    fn included_inner_stroke_takes_space() {
        let f = |include: bool, align: &str| {
            json!({ "type": "frame", "id": "r", "width": 200, "height": 100, "padding": 10, "layoutIncludeStroke": include,
                "stroke": "#000000", "strokeWidth": 4, "strokeAlignment": align, "children": [rect("a", json!(20), json!(20))] })
        };
        let (d, l) = lay(f(true, "inner"));
        assert_eq!(rect_of(&d, &l, "a"), (14.0, 14.0, 20.0, 20.0));
        let (d, l) = lay(f(false, "inner"));
        assert_eq!(rect_of(&d, &l, "a"), (10.0, 10.0, 20.0, 20.0));
        let (d, l) = lay(f(true, "outer"));
        assert_eq!(rect_of(&d, &l, "a"), (10.0, 10.0, 20.0, 20.0), "outside strokes never take space");
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "padding": 10, "layoutIncludeStroke": true, "stroke": "#000000",
            "strokeWidth": { "top": 1, "right": 2, "bottom": 3, "left": 4 }, "children": [rect("a", json!(20), json!(20))] }));
        assert_eq!(rect_of(&d, &l, "a"), (14.0, 11.0, 20.0, 20.0));
        assert_eq!(rect_of(&d, &l, "r"), (0.0, 0.0, 46.0, 44.0), "a hug frame grows by the stroke");
    }

    #[test]
    fn hug_frame_with_a_fill_child_lays_it_out_at_content_size() {
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "gap": 10, "children": [
            { "type": "frame", "id": "f", "width": "fill_container", "height": "fill_container", "children": [rect("x", json!(80), json!(30))] },
            rect("b", json!(40), json!(50))
        ] }));
        assert_eq!(rect_of(&d, &l, "f"), (0.0, 0.0, 80.0, 50.0), "content width on the hugging main axis, still stretches on the cross axis");
        assert_eq!(rect_of(&d, &l, "b").0, 90.0);
        assert_eq!(rect_of(&d, &l, "r"), (0.0, 0.0, 130.0, 50.0));
        // A layout-none frame or a text that fills a hugging row keeps its own size.
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "children": [
            { "type": "frame", "id": "n", "layout": "none", "width": "fill_container", "height": 20, "children": [{ "type": "rectangle", "id": "x", "x": 5, "y": 0, "width": 40, "height": 10 }] },
            rect("b", json!(10), json!(10))
        ] }));
        assert_eq!(rect_of(&d, &l, "n").2, 45.0);
        assert_eq!(rect_of(&d, &l, "b").0, 45.0);
        // Under a fixed parent Fill still shares the free space.
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "width": 300, "children": [
            { "type": "frame", "id": "f", "width": "fill_container", "children": [rect("x", json!(80), json!(30))] }
        ] }));
        assert_eq!(rect_of(&d, &l, "f").2, 300.0);
    }

    #[test]
    fn first_on_top_reverses_paint_and_hits_but_not_layout() {
        let v = cl_frame(json!({ "gap": -20 }), json!({ "stacking": "first" }), vec![rect("a", json!(50), json!(50)), rect("b", json!(50), json!(50))]);
        let (d, l) = lay(v);
        assert_eq!(rect_of(&d, &l, "b").0, 30.0, "layout order is the layer order");
        let h = crate::hit::HitIndex::build(&d, &l);
        let at = |x: f64| h.hit(kurbo::Point::new(x, 25.0)).map(|i| d.nodes[i].id.clone());
        assert_eq!(at(40.0).as_deref(), Some("a"), "the first draws on top and wins the hit test");
        assert_eq!(at(60.0).as_deref(), Some("b"));
        let v = cl_frame(json!({ "gap": -20 }), json!({}), vec![rect("a", json!(50), json!(50)), rect("b", json!(50), json!(50))]);
        let (d, l) = lay(v);
        let h = crate::hit::HitIndex::build(&d, &l);
        assert_eq!(h.hit(kurbo::Point::new(40.0, 25.0)).map(|i| d.nodes[i].id.as_str()), Some("b"), "last on top by default");
    }

    #[test]
    fn icon_defaults_to_24() {
        let (d, l) = lay(json!({ "type": "frame", "id": "r", "children": [{ "type": "icon", "id": "i", "icon": "x" }] }));
        assert_eq!(rect_of(&d, &l, "i"), (0.0, 0.0, 24.0, 24.0));
    }
}
