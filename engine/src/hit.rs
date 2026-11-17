//! Hit testing, like `document.elementFromPoint(...).closest("[data-id]")` on html.ts output: the
//! topmost node (last in paint order) whose box contains the point, honouring rounded corners,
//! rotation, and every clipping (`overflow: hidden`) ancestor. Candidates come from a bounding
//! volume hierarchy over the nodes' board-space bounds.

use kurbo::{Affine, Point, Rect, Shape};

use crate::layout::LayoutResult;
use crate::paint::{BoxShape, simple_ellipse};
use crate::scene::{Doc, Kind};

const LEAF: usize = 8;

enum Bvh {
    Leaf { bounds: Rect, items: Vec<usize> },
    Split { bounds: Rect, left: Box<Bvh>, right: Box<Bvh> },
}

impl Bvh {
    fn bounds(&self) -> Rect {
        match self {
            Bvh::Leaf { bounds, .. } | Bvh::Split { bounds, .. } => *bounds,
        }
    }

    fn build(mut items: Vec<usize>, aabb: &[Rect]) -> Bvh {
        let bounds = items.iter().map(|&i| aabb[i]).reduce(|a, b| a.union(b)).unwrap_or(Rect::ZERO);
        if items.len() <= LEAF {
            return Bvh::Leaf { bounds, items };
        }
        let wide = bounds.width() >= bounds.height();
        let key = |i: &usize| {
            let c = aabb[*i].center();
            if wide { c.x } else { c.y }
        };
        items.sort_by(|a, b| key(a).total_cmp(&key(b)));
        let right = items.split_off(items.len() / 2);
        Bvh::Split { bounds, left: Box::new(Bvh::build(items, aabb)), right: Box::new(Bvh::build(right, aabb)) }
    }

    fn query(&self, p: Point, out: &mut Vec<usize>) {
        if !contains(self.bounds(), p) {
            return;
        }
        match self {
            Bvh::Leaf { items, .. } => out.extend(items.iter().copied()),
            Bvh::Split { left, right, .. } => {
                left.query(p, out);
                right.query(p, out);
            }
        }
    }
}

fn contains(r: Rect, p: Point) -> bool {
    p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1
}

pub struct HitIndex {
    bvh: Option<Bvh>,
    inv: Vec<Affine>,
    shapes: Vec<BoxShape>,
    /// nearest ancestor that clips its children
    clip_parent: Vec<Option<usize>>,
    /// Position in drawing order (`Doc::paint_rank`): the node index unless a frame stacks first on top.
    rank: Vec<usize>,
}

impl HitIndex {
    pub fn build(doc: &Doc, l: &LayoutResult) -> HitIndex {
        let n = doc.nodes.len();
        let mut clip_parent = vec![None; n];
        for i in 0..n {
            if let Some(p) = doc.nodes[i].parent {
                let pn = &doc.nodes[p];
                clip_parent[i] = if pn.clip && pn.kind == Kind::Frame { Some(p) } else { clip_parent[p] };
            }
        }
        let shapes = (0..n)
            .map(|i| {
                let node = &doc.nodes[i];
                let ellipse = simple_ellipse(node);
                let corner = if matches!(node.kind, Kind::Frame | Kind::Rectangle) { node.corner } else { None };
                BoxShape::new(l.boxes[i].w, l.boxes[i].h, corner, ellipse).smoothed(node.smoothing)
            })
            .collect();
        // A locked layer and everything inside it are not hit (a lock): the point goes to what is under them.
        // Parents come before their children in `nodes`, so one pass carries a parent's lock down.
        let mut locked = vec![false; n];
        for i in 0..n {
            locked[i] = doc.nodes[i].locked || doc.nodes[i].parent.is_some_and(|p| locked[p]);
        }
        let items: Vec<usize> = (0..n).filter(|&i| !locked[i] && l.boxes[i].w > 0.0 && l.boxes[i].h > 0.0).collect();
        let bvh = (!items.is_empty()).then(|| Bvh::build(items, &l.aabb));
        HitIndex { bvh, inv: l.world.iter().map(|a| a.inverse()).collect(), shapes, clip_parent, rank: doc.paint_rank() }
    }

    fn inside(&self, i: usize, p: Point) -> bool {
        let q = self.inv[i] * p;
        let s = &self.shapes[i];
        if !contains(s.rect, q) {
            return false;
        }
        if s.ellipse {
            return kurbo::Ellipse::from_rect(s.rect).contains(q);
        }
        if s.rounded() {
            return crate::paint::rounded_contains(s.rect, s.radii, q);
        }
        true
    }

    /// Topmost node at a board-space point.
    pub fn hit(&self, p: Point) -> Option<usize> {
        self.hit_all(p).into_iter().next()
    }

    /// Every node at a board-space point, topmost first (the right-click menu's Select layer list).
    pub fn hit_all(&self, p: Point) -> Vec<usize> {
        let mut cands = Vec::new();
        let Some(bvh) = self.bvh.as_ref() else { return cands };
        bvh.query(p, &mut cands);
        cands.sort_unstable_by(|a, b| self.rank[*b].cmp(&self.rank[*a]));
        cands.retain(|&i| {
            if !self.inside(i, p) {
                return false;
            }
            let mut c = self.clip_parent[i];
            while let Some(a) = c {
                if !self.inside(a, p) {
                    return false;
                }
                c = self.clip_parent[a];
            }
            true
        });
        cands
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::layout_doc;
    use crate::text::TextSystem;
    use serde_json::json;

    fn idx(v: serde_json::Value) -> (Doc, HitIndex) {
        let d = Doc::from_value(&v).unwrap();
        let l = layout_doc(&d, &mut TextSystem::new());
        let h = HitIndex::build(&d, &l);
        (d, h)
    }

    fn at(d: &Doc, h: &HitIndex, x: f64, y: f64) -> Option<String> {
        h.hit(Point::new(x, y)).map(|i| d.nodes[i].id.clone())
    }

    #[test]
    fn topmost_in_paint_order() {
        let (d, h) = idx(json!({ "type": "frame", "id": "r", "layout": "none", "width": 200, "height": 200, "children": [
            { "type": "rectangle", "id": "a", "x": 10, "y": 10, "width": 100, "height": 100 },
            { "type": "rectangle", "id": "b", "x": 50, "y": 50, "width": 100, "height": 100 }
        ] }));
        assert_eq!(at(&d, &h, 60.0, 60.0).as_deref(), Some("b"));
        assert_eq!(at(&d, &h, 20.0, 20.0).as_deref(), Some("a"));
        assert_eq!(at(&d, &h, 190.0, 5.0).as_deref(), Some("r"));
        assert_eq!(at(&d, &h, 250.0, 5.0), None);
    }

    #[test]
    fn every_layer_under_a_point_topmost_first() {
        let (d, h) = idx(json!({ "type": "frame", "id": "r", "layout": "none", "width": 200, "height": 200, "children": [
            { "type": "frame", "id": "f", "layout": "none", "x": 0, "y": 0, "width": 150, "height": 150, "clip": true, "children": [
                { "type": "rectangle", "id": "a", "x": 10, "y": 10, "width": 100, "height": 100 },
                { "type": "rectangle", "id": "far", "x": 100, "y": 100, "width": 100, "height": 100 }
            ] },
            { "type": "rectangle", "id": "b", "x": 50, "y": 50, "width": 100, "height": 100 }
        ] }));
        let ids = |x: f64, y: f64| h.hit_all(Point::new(x, y)).into_iter().map(|i| d.nodes[i].id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(60.0, 60.0), ["b", "a", "f", "r"]);
        assert_eq!(ids(170.0, 170.0), ["r"], "a clipped child is not under the point outside its clip");
        assert!(ids(250.0, 5.0).is_empty());
    }

    #[test]
    fn clip_hides_overflow_from_hits() {
        let (d, h) = idx(json!({ "type": "frame", "id": "r", "layout": "none", "width": 300, "height": 300, "children": [
            { "type": "frame", "id": "c", "layout": "none", "x": 0, "y": 0, "width": 100, "height": 100, "clip": true, "children": [
                { "type": "rectangle", "id": "big", "x": 50, "y": 50, "width": 200, "height": 200 }
            ] }
        ] }));
        assert_eq!(at(&d, &h, 75.0, 75.0).as_deref(), Some("big"));
        assert_eq!(at(&d, &h, 150.0, 150.0).as_deref(), Some("r"), "outside the clip the child is not there");
    }

    #[test]
    fn rounded_corners_and_rotation() {
        let (d, h) = idx(json!({ "type": "frame", "id": "r", "layout": "none", "width": 300, "height": 300, "children": [
            { "type": "rectangle", "id": "round", "x": 0, "y": 0, "width": 100, "height": 100, "cornerRadius": 50 },
            { "type": "rectangle", "id": "rot", "x": 200, "y": 100, "width": 50, "height": 10, "rotation": -90 }
        ] }));
        assert_eq!(at(&d, &h, 3.0, 3.0).as_deref(), Some("r"), "the rounded corner is not part of the box");
        assert_eq!(at(&d, &h, 50.0, 50.0).as_deref(), Some("round"));
        // rotate(90deg) clockwise about (200,100): the bar now covers x 190..200, y 100..150.
        assert_eq!(at(&d, &h, 195.0, 140.0).as_deref(), Some("rot"));
        assert_eq!(at(&d, &h, 230.0, 105.0).as_deref(), Some("r"));
    }

    #[test]
    fn many_nodes_go_through_the_bvh() {
        let kids: Vec<_> = (0..500).map(|i| json!({ "type": "rectangle", "id": format!("n{i}"), "x": (i % 25) * 20, "y": (i / 25) * 20, "width": 18, "height": 18 })).collect();
        let (d, h) = idx(json!({ "type": "frame", "id": "r", "layout": "none", "width": 500, "height": 400, "children": kids }));
        assert_eq!(at(&d, &h, 20.0 * 7.0 + 5.0, 20.0 * 3.0 + 5.0).as_deref(), Some("n82"));
        assert_eq!(at(&d, &h, 20.0 * 7.0 + 19.0, 5.0).as_deref(), Some("r"), "the gap between cells");
    }

    #[test]
    fn locked_layers_let_the_point_through() {
        let (d, h) = idx(json!({ "type": "frame", "id": "r", "layout": "none", "width": 300, "height": 300, "children": [
            { "type": "rectangle", "id": "under", "x": 0, "y": 0, "width": 100, "height": 100 },
            { "type": "rectangle", "id": "lid", "x": 0, "y": 0, "width": 100, "height": 100, "locked": true },
            { "type": "frame", "id": "f", "layout": "none", "x": 150, "y": 0, "width": 100, "height": 100, "locked": true, "children": [
                { "type": "rectangle", "id": "kid", "x": 10, "y": 10, "width": 50, "height": 50 }
            ] }
        ] }));
        assert_eq!(at(&d, &h, 50.0, 50.0).as_deref(), Some("under"), "a locked layer on top is not hit");
        assert_eq!(at(&d, &h, 170.0, 20.0).as_deref(), Some("r"), "a locked frame locks its children");
        let (d, h) = idx(json!({ "type": "frame", "id": "b", "layout": "none", "width": 100, "height": 100, "locked": true, "children": [
            { "type": "rectangle", "id": "k", "x": 0, "y": 0, "width": 50, "height": 50 }
        ] }));
        assert_eq!(at(&d, &h, 20.0, 20.0), None, "a locked board is empty canvas");
    }
}
