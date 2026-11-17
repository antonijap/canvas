//! Vector geometry: a forgiving SVG path-data parser (compact numbers, packed arc flags), and the
//! ellipse-arc and polygon outlines html.ts emits for `ellipse` and `polygon` nodes.

use kurbo::{Arc, BezPath, Point, SvgArc, Vec2};

struct Lexer<'a> {
    s: &'a [u8],
    i: usize,
}

impl Lexer<'_> {
    fn skip(&mut self) {
        while self.i < self.s.len() && (self.s[self.i].is_ascii_whitespace() || self.s[self.i] == b',') {
            self.i += 1;
        }
    }
    fn command(&mut self) -> Option<u8> {
        self.skip();
        let c = *self.s.get(self.i)?;
        if c.is_ascii_alphabetic() && c != b'e' && c != b'E' {
            self.i += 1;
            Some(c)
        } else {
            None
        }
    }
    fn at_number(&mut self) -> bool {
        self.skip();
        matches!(self.s.get(self.i), Some(c) if c.is_ascii_digit() || *c == b'-' || *c == b'+' || *c == b'.')
    }
    fn number(&mut self) -> Option<f64> {
        self.skip();
        let start = self.i;
        let s = self.s;
        if matches!(s.get(self.i), Some(b'-' | b'+')) {
            self.i += 1;
        }
        let mut dot = false;
        while let Some(&c) = s.get(self.i) {
            if c.is_ascii_digit() {
                self.i += 1;
            } else if c == b'.' && !dot {
                dot = true;
                self.i += 1;
            } else {
                break;
            }
        }
        if matches!(s.get(self.i), Some(b'e' | b'E')) && matches!(s.get(self.i + 1), Some(c) if c.is_ascii_digit() || *c == b'-' || *c == b'+') {
            self.i += 2;
            while matches!(s.get(self.i), Some(c) if c.is_ascii_digit()) {
                self.i += 1;
            }
        }
        if self.i == start {
            return None;
        }
        std::str::from_utf8(&s[start..self.i]).ok()?.parse().ok()
    }
    /// Arc flags may be packed with no separator: `a1 1 0 011 1`.
    fn flag(&mut self) -> Option<bool> {
        self.skip();
        let c = *self.s.get(self.i)?;
        self.i += 1;
        match c {
            b'0' => Some(false),
            b'1' => Some(true),
            _ => None,
        }
    }
}

/// Parse SVG path data. Stops at the first malformed token and keeps what came before it,
/// the way browsers render the valid prefix of a broken path.
pub fn parse_svg_path(d: &str) -> BezPath {
    let mut p = BezPath::new();
    let mut lx = Lexer { s: d.as_bytes(), i: 0 };
    let mut cur = Point::ZERO;
    let mut start = Point::ZERO;
    let mut last_ctrl: Option<Point> = None;
    let mut last_quad: Option<Point> = None;
    let mut has_move = false;
    let mut cmd = match lx.command() {
        Some(c) => c,
        None => return p,
    };
    loop {
        let rel = cmd.is_ascii_lowercase();
        let base = if rel { cur.to_vec2() } else { Vec2::ZERO };
        let up = cmd.to_ascii_uppercase();
        let mut ok = true;
        let mut ctrl: Option<Point> = None;
        let mut quad: Option<Point> = None;
        match up {
            b'M' => match (lx.number(), lx.number()) {
                (Some(x), Some(y)) => {
                    cur = Point::new(x, y) + base;
                    start = cur;
                    p.move_to(cur);
                    has_move = true;
                    // Further pairs after a moveto are implicit linetos.
                    cmd = if rel { b'l' } else { b'L' };
                }
                _ => ok = false,
            },
            b'Z' => {
                if has_move {
                    p.close_path();
                }
                cur = start;
            }
            b'L' => match (lx.number(), lx.number()) {
                (Some(x), Some(y)) => {
                    cur = Point::new(x, y) + base;
                    line(&mut p, &mut has_move, cur);
                }
                _ => ok = false,
            },
            b'H' => match lx.number() {
                Some(x) => {
                    cur = Point::new(if rel { cur.x + x } else { x }, cur.y);
                    line(&mut p, &mut has_move, cur);
                }
                None => ok = false,
            },
            b'V' => match lx.number() {
                Some(y) => {
                    cur = Point::new(cur.x, if rel { cur.y + y } else { y });
                    line(&mut p, &mut has_move, cur);
                }
                None => ok = false,
            },
            b'C' => match (lx.number(), lx.number(), lx.number(), lx.number(), lx.number(), lx.number()) {
                (Some(a), Some(b), Some(c), Some(d), Some(e), Some(f)) => {
                    let (p1, p2, p3) = (Point::new(a, b) + base, Point::new(c, d) + base, Point::new(e, f) + base);
                    ensure_move(&mut p, &mut has_move, cur);
                    p.curve_to(p1, p2, p3);
                    ctrl = Some(p2);
                    cur = p3;
                }
                _ => ok = false,
            },
            b'S' => match (lx.number(), lx.number(), lx.number(), lx.number()) {
                (Some(c), Some(d), Some(e), Some(f)) => {
                    let p1 = last_ctrl.map_or(cur, |lc| cur + (cur - lc));
                    let (p2, p3) = (Point::new(c, d) + base, Point::new(e, f) + base);
                    ensure_move(&mut p, &mut has_move, cur);
                    p.curve_to(p1, p2, p3);
                    ctrl = Some(p2);
                    cur = p3;
                }
                _ => ok = false,
            },
            b'Q' => match (lx.number(), lx.number(), lx.number(), lx.number()) {
                (Some(a), Some(b), Some(e), Some(f)) => {
                    let (p1, p2) = (Point::new(a, b) + base, Point::new(e, f) + base);
                    ensure_move(&mut p, &mut has_move, cur);
                    p.quad_to(p1, p2);
                    quad = Some(p1);
                    cur = p2;
                }
                _ => ok = false,
            },
            b'T' => match (lx.number(), lx.number()) {
                (Some(e), Some(f)) => {
                    let p1 = last_quad.map_or(cur, |lq| cur + (cur - lq));
                    let p2 = Point::new(e, f) + base;
                    ensure_move(&mut p, &mut has_move, cur);
                    p.quad_to(p1, p2);
                    quad = Some(p1);
                    cur = p2;
                }
                _ => ok = false,
            },
            b'A' => match (lx.number(), lx.number(), lx.number(), lx.flag(), lx.flag(), lx.number(), lx.number()) {
                (Some(rx), Some(ry), Some(rot), Some(large), Some(sweep), Some(x), Some(y)) => {
                    let to = Point::new(x, y) + base;
                    ensure_move(&mut p, &mut has_move, cur);
                    let arc = SvgArc { from: cur, to, radii: Vec2::new(rx.abs(), ry.abs()), x_rotation: rot.to_radians(), large_arc: large, sweep };
                    match Arc::from_svg_arc(&arc) {
                        Some(a) => a.to_cubic_beziers(0.1, |p1, p2, p3| p.curve_to(p1, p2, p3)),
                        None => p.line_to(to),
                    }
                    cur = to;
                }
                _ => ok = false,
            },
            _ => ok = false,
        }
        if !ok {
            break;
        }
        last_ctrl = ctrl;
        last_quad = quad;
        if up == b'Z' {
            match lx.command() {
                Some(c) => cmd = c,
                None => break,
            }
            continue;
        }
        if lx.at_number() {
            continue; // implicit repeat of the same command
        }
        match lx.command() {
            Some(c) => cmd = c,
            None => break,
        }
    }
    p
}

fn ensure_move(p: &mut BezPath, has_move: &mut bool, cur: Point) {
    if !*has_move {
        p.move_to(cur);
        *has_move = true;
    }
}

fn line(p: &mut BezPath, has_move: &mut bool, to: Point) {
    if *has_move {
        p.line_to(to);
    } else {
        p.move_to(to);
        *has_move = true;
    }
}

/// html.ts `ellipsePath`: a ring, pie or arc in a w×h box (y down; angles counter-clockwise from +x).
pub fn ellipse_path(w: f64, h: f64, inner: f64, start_deg: f64, sweep_deg: Option<f64>) -> String {
    let inner = inner.min(0.999);
    let start = start_deg.to_radians();
    let sweep = sweep_deg.unwrap_or(360.0).clamp(-360.0, 360.0);
    let rad = sweep.to_radians();
    let (rx, ry) = (w / 2.0, h / 2.0);
    let pt = |a: f64, k: f64| format!("{} {}", rx + k * rx * a.cos(), ry - k * ry * a.sin());
    if sweep.abs() >= 360.0 {
        let ring = |k: f64| {
            if k > 0.0 {
                format!("M{} {}a{} {} 0 1 0 {} 0a{} {} 0 1 0 {} 0Z", rx - k * rx, ry, k * rx, k * ry, 2.0 * k * rx, k * rx, k * ry, -2.0 * k * rx)
            } else {
                String::new()
            }
        };
        return ring(1.0) + &ring(inner);
    }
    let large = u8::from(sweep.abs() > 180.0);
    let ccw = u8::from(sweep <= 0.0);
    let end = start + rad;
    let inward = if inner > 0.0 {
        format!("L{}A{} {} 0 {} {} {}", pt(end, inner), inner * rx, inner * ry, large, if ccw == 1 { 0 } else { 1 }, pt(start, inner))
    } else {
        format!("L{rx} {ry}")
    };
    format!("M{}A{} {} 0 {} {} {}{}Z", pt(start, 1.0), rx, ry, large, ccw, pt(end, 1.0), inward)
}

/// html.ts `polygonPoints`: a regular polygon inscribed in the w×h box, first vertex at the top.
pub fn polygon_path(count: f64, w: f64, h: f64) -> BezPath {
    let n = count.round().max(3.0) as usize;
    let mut p = BezPath::new();
    for i in 0..n {
        let a = -std::f64::consts::FRAC_PI_2 + (i as f64) * std::f64::consts::TAU / n as f64;
        let pt = Point::new(w / 2.0 + w / 2.0 * a.cos(), h / 2.0 + h / 2.0 * a.sin());
        if i == 0 { p.move_to(pt) } else { p.line_to(pt) }
    }
    p.close_path();
    p
}

#[cfg(test)]
mod tests {
    use super::*;
    use kurbo::Shape;

    #[test]
    fn compact_numbers_and_implicit_commands() {
        let p = parse_svg_path("m16 9l-5.5 5.5L8 12");
        let b = p.bounding_box();
        assert_eq!((b.x0, b.y0, b.x1, b.y1), (8.0, 9.0, 16.0, 14.5));
        let q = parse_svg_path("M0,0 10-10.5.5.5");
        assert_eq!(q.elements().len(), 3);
    }

    #[test]
    fn packed_arc_flags() {
        let p = parse_svg_path("M0 0a5 5 0 105 5");
        let b = p.bounding_box();
        assert!(b.width() > 5.0, "the large arc goes the long way round: {b:?}");
    }

    #[test]
    fn relative_and_close() {
        let p = parse_svg_path("M10 10h10v10h-10z m5 5 l1 1");
        let b = p.bounding_box();
        assert_eq!((b.x0, b.y0, b.x1, b.y1), (10.0, 10.0, 20.0, 20.0));
    }

    #[test]
    fn broken_tail_keeps_the_valid_prefix() {
        let p = parse_svg_path("M0 0L10 0L10 x");
        assert_eq!(p.elements().len(), 2);
    }

    #[test]
    fn ring_and_pie() {
        let ring = parse_svg_path(&ellipse_path(100.0, 50.0, 0.5, 0.0, None));
        let b = ring.bounding_box();
        assert!((b.width() - 100.0).abs() < 0.01 && (b.height() - 50.0).abs() < 0.01);
        let pie = parse_svg_path(&ellipse_path(100.0, 100.0, 0.0, 0.0, Some(90.0)));
        let b = pie.bounding_box();
        // A quarter from 0deg counter-clockwise: the top-right quadrant.
        assert!((b.x0 - 50.0).abs() < 0.01 && b.y1 <= 50.01 && (b.x1 - 100.0).abs() < 0.01 && b.y0.abs() < 0.01, "{b:?}");
    }

    #[test]
    fn triangle_points_up() {
        let p = polygon_path(3.0, 100.0, 100.0);
        let first = p.elements()[0];
        assert!(matches!(first, kurbo::PathEl::MoveTo(pt) if (pt.x - 50.0).abs() < 1e-9 && pt.y.abs() < 1e-9));
    }
}
