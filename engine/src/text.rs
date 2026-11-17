//! Text: fonts registered from bytes (the page fetches them from `/api/fonts/file`), and parley
//! layouts that follow the CSS html.ts sets on a text node: `white-space: pre` (auto growth) or
//! `pre-wrap` + `overflow-wrap: break-word` (fixed widths), unitless `line-height`, `letter-spacing`
//! in px, `text-align`.
//!
//! Fallback: the browser draws `"Family",system-ui,sans-serif`, picking a font per character. A
//! family name may carry a tag after `FAMILY_SEP` (`Inter\u{1f}0:latin`, `Inter\u{1f}5:cyrillic`,
//! `system-ui\u{1f}1:Lucida Grande`): every tagged face joins its family's chain after the plain
//! one, in tag-number order. That models Google Fonts' unicode-range subsets (one file per script)
//! and the platform fonts CoreText reaches for when SF Pro lacks a glyph (Hebrew, Arabic, CJK,
//! emoji). Every layout asks parley for `[chain(family)…, chain(system-ui)…, sans-serif]`; parley
//! picks the first face that maps each cluster, as the browser does.
//!
//! Variable fonts: the `wght` axis follows the font weight (fontique's synthesis), and `opsz`
//! follows the font size in px, as Chrome does with `font-optical-sizing: auto`.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Arc;

use parley::fontique::{Blob, FontInfoOverride};
use parley::{
    Alignment, AlignmentOptions, FontContext, FontFamily, FontFamilyName, FontStyle, FontWeight, GenericFamily, Layout, LayoutContext, LineHeight, OverflowWrap,
    StyleProperty, TextWrapMode, WhiteSpaceCollapse,
};

use crate::scene::{Growth, ListItem, ListKind, TextAlign, TextProps, TextSpan};
use peniko::Color;

pub const FALLBACK_FAMILY: &str = "system-ui";
/// Separates a family from a chain tag (`order:label`) in a registered family name.
pub const FAMILY_SEP: char = '\u{1f}';

/// `Family\u{1f}3:label` → ("Family", Some(3)); a plain name → (name, None).
pub fn split_family(name: &str) -> (&str, Option<i64>) {
    match name.split_once(FAMILY_SEP) {
        Some((base, tag)) => (base, Some(tag.split(':').next().and_then(|n| n.trim().parse().ok()).unwrap_or(1000))),
        None => (name, None),
    }
}

/// SF Pro (SFNS.ttf) `wght` for a CSS font weight. Its axis runs 1 to 1000 and its named weights do not sit
/// on the hundreds (the font's own instances: Ultralight 30.9, Thin 110.7, Light 274.3, Regular 400, Medium
/// 510, Semibold 590, Bold 700, Heavy 860, Black 1000). CoreText, and so Chrome, draws CSS 100 to 900 with
/// those; passing the CSS weight straight to the axis drew 100 to 300 too heavy and 800, 900 too light.
pub fn sf_wght(css: f32) -> f32 {
    const AXIS: [f32; 9] = [30.925, 110.725, 274.315, 400.0, 510.0, 590.0, 700.0, 860.0, 1000.0];
    let w = css.clamp(100.0, 900.0) / 100.0 - 1.0;
    let i = (w.floor() as usize).min(7);
    AXIS[i] + (AXIS[i + 1] - AXIS[i]) * (w - i as f32)
}

/// Is `family` the macOS system font (what `system-ui` and "SF Pro" resolve to)?
pub fn is_system_family(family: &str) -> bool {
    let f = split_family(family).0.trim().to_ascii_lowercase();
    f == FALLBACK_FAMILY || f == "-apple-system" || f == "blinkmacsystemfont" || f.starts_with("sf pro") || f.starts_with("san francisco")
}

/// The brush a glyph run carries: a styled range's own colour (sRGB components with alpha, as peniko keeps them), or
/// None for the layer's fill (which may be a gradient: paint.rs decides).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Ink(pub Option<[f32; 4]>);

pub struct TextSystem {
    /// What a text node without `fontSize` / `lineHeight` inherits. html.ts sets neither, so the
    /// page's own values apply: the Canvas page body is `13px/1.45`. None = CSS `normal`.
    pub default_size: f32,
    pub default_line_height: Option<f32>,
    pub fcx: FontContext,
    pub lcx: LayoutContext<Ink>,
    /// lower-cased family name → number of faces registered under it
    families: HashMap<String, usize>,
    /// lower-cased base family → its registered names in fallback order (plain first)
    chains: HashMap<String, Vec<(i64, String)>>,
    /// Shaped text kept while `caching` is on (a board laid out again: a live edit at display rate), by everything
    /// shaping depends on. Shaping was a third of a board's layout; a drag that lays the board out every frame
    /// shapes only the text it changed. Bounded; cleared when a font is registered (fallback can change).
    shaped: HashMap<u64, Vec<(ShapeKey, Layout<Ink>, Vec<Mark>, Vec<ParaLine>)>>,
    shaped_count: usize,
    pub caching: bool,
}

/// What a shaped layout depends on: the node's text props and the page defaults it inherits.
#[derive(Clone, PartialEq)]
struct ShapeKey {
    props: TextProps,
    default_size: f32,
    default_line_height: Option<f32>,
}

/// At most this many shaped texts are kept (a few MB of WASM memory); past it the cache starts again.
pub const SHAPE_CACHE_MAX: usize = 4096;

impl Default for TextSystem {
    fn default() -> Self {
        Self::new()
    }
}

impl TextSystem {
    pub fn new() -> Self {
        TextSystem {
            default_size: 13.0,
            default_line_height: Some(1.45),
            fcx: FontContext::new(),
            lcx: LayoutContext::new(),
            families: HashMap::new(),
            chains: HashMap::new(),
            shaped: HashMap::new(),
            shaped_count: 0,
            caching: false,
        }
    }

    /// Register font bytes (one sfnt face; collections register every face) under `family`,
    /// whatever the file's own name table says, like an `@font-face` rule. `weight` / `italic`,
    /// when given, are the face's descriptors (they win over the file's OS/2 values, as in CSS);
    /// the browser's matching (nearest weight, synthetic bold/italic) then carries over.
    pub fn register_font(&mut self, family: &str, weight: Option<f32>, italic: Option<bool>, bytes: Vec<u8>) -> Result<usize, String> {
        let blob = Blob::new(Arc::new(bytes));
        let over = FontInfoOverride {
            family_name: Some(family),
            weight: weight.map(FontWeight::new),
            style: italic.map(|i| if i { FontStyle::Italic } else { FontStyle::Normal }),
            ..Default::default()
        };
        let reg = self.fcx.collection.register_fonts(blob, Some(over));
        // A new face can change which font any text falls back to: nothing shaped before stays valid.
        self.clear_shaped();
        let faces: usize = reg.iter().map(|(_, f)| f.len()).sum();
        if faces == 0 {
            return Err(format!("no font faces in the data for {family}"));
        }
        if family.eq_ignore_ascii_case(FALLBACK_FAMILY) {
            let ids: Vec<_> = reg.iter().map(|(id, _)| *id).collect();
            for g in [GenericFamily::SystemUi, GenericFamily::SansSerif, GenericFamily::UiSansSerif] {
                self.fcx.collection.set_generic_families(g, ids.iter().copied());
            }
        }
        *self.families.entry(family.to_ascii_lowercase()).or_default() += faces;
        let (base, order) = split_family(family);
        let chain = self.chains.entry(base.to_ascii_lowercase()).or_default();
        if !chain.iter().any(|(_, n)| n.eq_ignore_ascii_case(family)) {
            chain.push((order.unwrap_or(-1), family.to_string()));
            chain.sort_by_key(|(o, _)| *o);
        }
        Ok(faces)
    }

    /// A registered name, or any face of a family registered as tagged subsets.
    pub fn has_family(&self, family: &str) -> bool {
        self.families.contains_key(&family.to_ascii_lowercase()) || self.chains.contains_key(&family.to_ascii_lowercase())
    }

    /// The registered names standing for `family`, in fallback order (the name itself when none).
    fn chain(&self, family: &str) -> Vec<String> {
        match self.chains.get(&split_family(family).0.to_ascii_lowercase()) {
            Some(c) if split_family(family).1.is_none() => c.iter().map(|(_, n)| n.clone()).collect(),
            _ => vec![family.to_string()],
        }
    }

    /// Is text asking for `family` drawn with the system font: it names it, or no face of it is registered and
    /// the fallback chain draws it. Both take SF Pro's own `wght` values (`sf_wght`); text in a missing family
    /// got the CSS weight on the axis, so 100 to 300 came out too heavy and 800, 900 too light.
    pub fn draws_with_system_font(&self, family: &str) -> bool {
        is_system_family(family) || !self.has_family(family)
    }

    pub fn has_any_font(&self) -> bool {
        !self.families.is_empty()
    }

    fn layout(&mut self, t: &TextProps, text: &str, line_height: LineHeight) -> Layout<Ink> {
        let mut names = self.chain(&t.family);
        if !t.family.eq_ignore_ascii_case(FALLBACK_FAMILY) {
            names.extend(self.chain(FALLBACK_FAMILY));
        }
        let system = self.draws_with_system_font(&t.family);
        // Each styled range's own fallback chain (when it names a family) and whether the system font draws it.
        let span_fonts: Vec<(Option<Vec<FontFamilyName>>, bool)> = t
            .spans
            .iter()
            .map(|s| {
                let fams = s.family.as_ref().map(|f| {
                    let mut names = self.chain(f);
                    if !f.eq_ignore_ascii_case(FALLBACK_FAMILY) {
                        names.extend(self.chain(FALLBACK_FAMILY));
                    }
                    let mut fams: Vec<FontFamilyName> = names.into_iter().map(|n| FontFamilyName::Named(Cow::Owned(n))).collect();
                    fams.push(FontFamilyName::Generic(GenericFamily::SansSerif));
                    fams
                });
                (fams, self.draws_with_system_font(s.family.as_deref().unwrap_or(&t.family)))
            })
            .collect();
        let mut b = self.lcx.ranged_builder(&mut self.fcx, text, 1.0, true);
        // CSS `direction: ltr`: right-to-left runs reorder inside a left-to-right paragraph.
        b.set_base_direction(parley::BaseDirection::Ltr);
        let mut families: Vec<FontFamilyName> = names.into_iter().map(|n| FontFamilyName::Named(Cow::Owned(n))).collect();
        families.push(FontFamilyName::Generic(GenericFamily::SansSerif));
        let size = if t.size_given { t.size } else { self.default_size };
        b.push_default(StyleProperty::FontFamily(FontFamily::List(Cow::Owned(families))));
        b.push_default(StyleProperty::FontSize(size));
        // font-optical-sizing: auto. Fonts without an `opsz` axis ignore it.
        // SF Pro's `wght` axis is not the CSS weight (see `sf_wght`): set it outright for the system font.
        let vars = if system { format!("\"opsz\" {size}, \"wght\" {}", sf_wght(t.weight)) } else { format!("\"opsz\" {size}") };
        b.push_default(StyleProperty::FontVariations(parley::FontVariations::Source(Cow::Owned(vars))));
        b.push_default(StyleProperty::FontWeight(FontWeight::new(t.weight)));
        b.push_default(StyleProperty::FontStyle(if t.italic { FontStyle::Italic } else { FontStyle::Normal }));
        // Small caps: the font's own small capitals; a font without `smcp` draws its letters as they are (the
        // inspector offers Small caps only for fonts that have them).
        if t.small_caps {
            b.push_default(StyleProperty::FontFeatures(parley::FontFeatures::Source(Cow::Borrowed("\"smcp\" 1"))));
        }
        if t.letter_spacing != 0.0 {
            b.push_default(StyleProperty::LetterSpacing(t.letter_spacing));
        }
        b.push_default(StyleProperty::LineHeight(line_height));
        b.push_default(StyleProperty::WhiteSpaceCollapse(WhiteSpaceCollapse::Preserve));
        if t.growth == Growth::Auto {
            b.push_default(StyleProperty::TextWrapMode(TextWrapMode::NoWrap));
        } else {
            b.push_default(StyleProperty::TextWrapMode(TextWrapMode::Wrap));
            b.push_default(StyleProperty::OverflowWrap(OverflowWrap::BreakWord));
        }
        if t.underline {
            b.push_default(StyleProperty::Underline(true));
        }
        if t.strikethrough {
            b.push_default(StyleProperty::Strikethrough(true));
        }
        // Styled ranges: what each sets over the layer's own style, on its bytes of `text` (a trailing newline the
        // caller dropped can cut the last one short).
        for (s, (fams, sys)) in t.spans.iter().zip(span_fonts) {
            let (a, z) = (s.start.min(text.len()), s.end.min(text.len()));
            if z <= a || !text.is_char_boundary(a) || !text.is_char_boundary(z) {
                continue;
            }
            let r = a..z;
            if let Some(fams) = fams {
                b.push(StyleProperty::FontFamily(FontFamily::List(Cow::Owned(fams))), r.clone());
            }
            let sz = s.size.unwrap_or(size);
            if let Some(v) = s.size {
                b.push(StyleProperty::FontSize(v), r.clone());
            }
            let w = s.weight.unwrap_or(t.weight);
            if let Some(v) = s.weight {
                b.push(StyleProperty::FontWeight(FontWeight::new(v)), r.clone());
            }
            if s.family.is_some() || s.size.is_some() || s.weight.is_some() {
                let vars = if sys { format!("\"opsz\" {sz}, \"wght\" {}", sf_wght(w)) } else { format!("\"opsz\" {sz}") };
                b.push(StyleProperty::FontVariations(parley::FontVariations::Source(Cow::Owned(vars))), r.clone());
            }
            if let Some(i) = s.italic {
                b.push(StyleProperty::FontStyle(if i { FontStyle::Italic } else { FontStyle::Normal }), r.clone());
            }
            if let Some(v) = s.letter_spacing {
                b.push(StyleProperty::LetterSpacing(v), r.clone());
            }
            if let Some(v) = s.underline {
                b.push(StyleProperty::Underline(v), r.clone());
            }
            if let Some(v) = s.strikethrough {
                b.push(StyleProperty::Strikethrough(v), r.clone());
            }
            if let Some(c) = s.color {
                b.push(StyleProperty::Brush(Ink(Some(c.components))), r);
            }
        }
        b.build(text)
    }

    /// Forget every shaped text (fonts changed).
    pub fn clear_shaped(&mut self) {
        self.shaped.clear();
        self.shaped_count = 0;
    }

    /// Shaped texts held (tests, stats).
    pub fn shaped_len(&self) -> usize {
        self.shaped_count
    }

    /// Shape a text node. Line breaking happens later, at whatever width layout settles on. While `caching` is on,
    /// a text shaped before with the same props and defaults is a copy of that layout (no shaping).
    pub fn build(&mut self, t: &TextProps) -> TextBlock {
        if !self.caching || t.content.is_empty() {
            return self.build_uncached(t);
        }
        let key = ShapeKey { props: t.clone(), default_size: self.default_size, default_line_height: self.default_line_height };
        let h = shape_hash(&key);
        if let Some((l, marks, plan)) = self.shaped.get(&h).and_then(|v| v.iter().find(|(k, ..)| *k == key)).map(|(_, l, m, p)| (l.clone(), m.clone(), p.clone())) {
            return TextBlock { layout: Some(l), align: t.align, nowrap: t.growth == Growth::Auto, broken_at: None, cap: t.max_lines.filter(|_| t.truncate), plan, marks, firsts: Vec::new() };
        }
        let tb = self.build_uncached(t);
        if let Some(l) = tb.layout.as_ref() {
            if self.shaped_count >= SHAPE_CACHE_MAX {
                self.clear_shaped();
            }
            self.shaped.entry(h).or_default().push((key, l.clone(), tb.marks.clone(), tb.plan.clone()));
            self.shaped_count += 1;
        }
        tb
    }

    /// Final line breaking for a content box `width` wide (`TextBlock::finish`), then Truncate text: past
    /// `max_lines`, or in a fixed-size box past the lines that fit `max_h`, the last line that shows ends with an
    /// ellipsis (the text is shaped again, a letter shorter at a time, until it and the ellipsis fit).
    pub fn finish_text(&mut self, tb: &mut TextBlock, t: &TextProps, width: f32, max_h: Option<f32>) {
        tb.finish(width);
        if !t.truncate {
            return;
        }
        let Some(l) = tb.layout.as_ref() else { return };
        let n = l.len();
        let mut keep = t.max_lines.unwrap_or(usize::MAX).max(1);
        if let Some(h) = max_h.filter(|_| t.growth == Growth::FixedWidthHeight) {
            let fit = (0..n).take_while(|&i| l.get(i).is_some_and(|ln| ln.metrics().block_max_coord <= h + 0.5)).count();
            keep = keep.min(fit.max(1));
        }
        if n <= keep {
            return;
        }
        let mut cut = l.get(keep - 1).map_or(0, |ln| ln.text_range().end).min(t.content.len());
        for _ in 0..400 {
            let head = t.content[..cut].trim_end();
            let mut p = t.clone();
            p.content = format!("{head}\u{2026}");
            p.truncate = false;
            p.max_lines = None;
            // The ellipsis takes the style of the letter before it.
            p.spans = t
                .spans
                .iter()
                .filter(|s| s.start < head.len())
                .map(|s| {
                    let mut s = s.clone();
                    s.end = if s.end >= head.len() { p.content.len() } else { s.end };
                    s
                })
                .collect();
            let mut nb = self.build(&p);
            nb.finish(width);
            let lines = nb.layout.as_ref().map_or(0, Layout::len);
            if lines <= keep || head.is_empty() {
                tb.layout = nb.layout;
                tb.broken_at = nb.broken_at;
                tb.firsts = nb.firsts;
                tb.marks = nb.marks;
                return;
            }
            cut = head.char_indices().last().map_or(0, |(i, _)| i);
        }
    }

    /// Where each paragraph's lines start and the space above it, and the list markers to draw (paragraph, text, x),
    /// by src/page/text-paras.js's rules. Empty when the text has no paragraph settings.
    /// Also the paragraphs whose opening quote hangs (paragraph, byte offset of the quote), and each marker's colour (its
    /// item's first letter's, when a styled range colours it).
    fn para_plan(&self, t: &TextProps, text: &str) -> (Vec<ParaLine>, Vec<MarkSpec>, Vec<(usize, usize)>) {
        let Some(pa) = t.paras.as_ref() else { return (Vec::new(), Vec::new(), Vec::new()) };
        let starts: Vec<usize> = std::iter::once(0).chain(text.match_indices('\n').map(|(i, _)| i + 1)).collect();
        let count = starts.len();
        let size = if t.size_given { t.size } else { self.default_size };
        let step = list_step(size);
        let indent = if t.align == TextAlign::Left { pa.indent } else { 0.0 };
        // Hanging lists: the text a level step further left, the first level's markers outside the box.
        let lift = if pa.hanging_list { step } else { 0.0 };
        let hang_ok = pa.hanging_quotes && matches!(t.align, TextAlign::Left | TextAlign::Justify);
        let marks = marker_texts(&pa.lists, count);
        let mut plan = Vec::with_capacity(count);
        let mut specs = Vec::new();
        let mut hangs = Vec::new();
        let item = |p: usize| pa.lists.iter().find(|l| l.p == p);
        for (p, m) in marks.into_iter().enumerate() {
            // List spacing goes between two list items; paragraph spacing everywhere else.
            let before = if p == 0 { 0.0 } else if item(p).is_some() && item(p - 1).is_some() { pa.list_spacing } else { pa.spacing };
            match item(p) {
                Some(l) => {
                    let x = f32::from(l.level) * step - lift;
                    plan.push(ParaLine { before, first: x, rest: x });
                    if let Some(m) = m {
                        let at = starts[p];
                        let color = t.spans.iter().find(|s| s.start <= at && at < s.end).and_then(|s| s.color);
                        specs.push(MarkSpec { para: p, text: m, x: x - step, color });
                    }
                }
                None => plan.push(ParaLine { before, first: indent, rest: 0.0 }),
            }
            if hang_ok && text[starts[p]..].chars().next().is_some_and(is_open_quote) {
                hangs.push((p, starts[p]));
            }
        }
        (plan, specs, hangs)
    }

    fn build_uncached(&mut self, t: &TextProps) -> TextBlock {
        // A newline at the very end of a pre / pre-wrap block makes no extra line in CSS.
        let text = body_text(t);
        let (mut plan, specs, hangs) = self.para_plan(t, &text);
        if text.is_empty() {
            return TextBlock { layout: None, align: t.align, nowrap: t.growth == Growth::Auto, broken_at: None, cap: t.max_lines.filter(|_| t.truncate), plan, marks: Vec::new(), firsts: Vec::new() };
        }
        let line_height = t.line_height.or(self.default_line_height);
        let mut lh = match line_height {
            Some(m) => LineHeight::FontSizeRelative(m),
            None => LineHeight::MetricsRelative(1.0),
        };
        let mut layout = self.layout(t, &text, lh);
        if line_height.is_none() {
            // `line-height: normal` in Chrome on macOS: ascent, descent and line gap each rounded to
            // whole pixels, from the first font used. parley keeps them fractional.
            layout.break_all_lines(None);
            let m = layout.lines().next().and_then(|l| l.runs().next().map(|r| *r.font_metrics()));
            if let Some(m) = m {
                let chrome = m.ascent.round() + m.descent.round() + m.leading.round();
                let ours = layout.lines().next().map_or(chrome, |l| l.metrics().line_height);
                if (chrome - ours).abs() > 0.01 && chrome > 0.0 {
                    layout = self.layout(t, &text, LineHeight::Absolute(chrome));
                    lh = LineHeight::Absolute(chrome);
                }
            }
        }
        // Hanging quotes: each paragraph's opening quote starts its own width left of where the paragraph's first line
        // starts (its advance as shaped here: kerning and tracking included), so the letter after it sits there.
        if !hangs.is_empty() {
            layout.break_all_lines(None);
            for (p, at) in hangs {
                if let (Some(c), Some(pl)) = (parley::Cluster::from_byte_index(&layout, at), plan.get_mut(p)) {
                    pl.first -= c.advance();
                }
            }
        }
        // List markers: the layer's style, in the colour of their item's first letter, shaped apart.
        let mut marks = Vec::with_capacity(specs.len());
        if !specs.is_empty() {
            let mut mp = t.clone();
            mp.spans = Vec::new();
            mp.paras = None;
            mp.underline = false;
            mp.strikethrough = false;
            mp.small_caps = false;
            mp.growth = Growth::Auto;
            for MarkSpec { para, text: m, x, color } in specs {
                mp.spans = color.map(|c| TextSpan { start: 0, end: m.len(), color: Some(c), ..Default::default() }).into_iter().collect();
                let mut l = self.layout(&mp, &m, lh);
                l.break_all_lines(None);
                marks.push(Mark { para, x, layout: l });
            }
        }
        TextBlock { layout: Some(layout), align: t.align, nowrap: t.growth == Growth::Auto, broken_at: None, cap: t.max_lines.filter(|_| t.truncate), plan, marks, firsts: Vec::new() }
    }
}

fn shape_hash(k: &ShapeKey) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    let p = &k.props;
    p.content.hash(&mut h);
    p.family.hash(&mut h);
    p.size.to_bits().hash(&mut h);
    p.weight.to_bits().hash(&mut h);
    p.letter_spacing.to_bits().hash(&mut h);
    p.line_height.map(f32::to_bits).hash(&mut h);
    (p.size_given, p.italic, p.underline, p.strikethrough, p.growth == Growth::Auto, p.small_caps).hash(&mut h);
    k.default_size.to_bits().hash(&mut h);
    k.default_line_height.map(f32::to_bits).hash(&mut h);
    if !p.spans.is_empty() {
        format!("{:?}", p.spans).hash(&mut h);
    }
    if let Some(pa) = p.paras.as_ref() {
        format!("{pa:?}").hash(&mut h);
    }
    h.finish()
}

/// The text a layout shapes: a newline at the very end of a pre / pre-wrap block makes no extra line in CSS.
fn body_text(t: &TextProps) -> String {
    t.content.strip_suffix('\n').unwrap_or(&t.content).to_string()
}

/// How far each list level indents: one and a half times the font size, whole px (src/page/text-paras.js listStep).
pub fn list_step(size: f32) -> f32 {
    (if size > 0.0 { size } else { 13.0 } * 1.5).round()
}

/// One paragraph's layout: the space above it, where its first and its other lines start (px).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ParaLine {
    pub before: f32,
    pub first: f32,
    pub rest: f32,
}

/// The opening quotation marks that hang (src/page/text-paras.js OPEN_QUOTES).
pub fn is_open_quote(c: char) -> bool {
    matches!(c, '"' | '\'' | '\u{201c}' | '\u{2018}' | '\u{201e}' | '\u{201a}' | '\u{ab}' | '\u{2039}' | '\u{bb}' | '\u{203a}' | '\u{201f}' | '\u{201b}')
}

/// A marker to shape: its paragraph, text, left edge and colour (None: the layer's).
struct MarkSpec {
    para: usize,
    text: String,
    x: f32,
    color: Option<Color>,
}

/// A list marker: its paragraph, its left edge, its shaped text (drawn on the paragraph's first baseline).
#[derive(Clone)]
pub struct Mark {
    pub para: usize,
    pub x: f32,
    pub layout: Layout<Ink>,
}

fn roman(mut n: usize) -> String {
    const R: [(usize, &str); 13] = [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"), (50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")];
    let mut s = String::new();
    for (v, r) in R {
        while n >= v {
            s.push_str(r);
            n -= v;
        }
    }
    s
}

fn letters(mut n: usize) -> String {
    let mut s = Vec::new();
    while n > 0 {
        n -= 1;
        s.push(b'a' + (n % 26) as u8);
        n /= 26;
    }
    s.reverse();
    String::from_utf8(s).unwrap_or_default()
}

/// Each paragraph's marker, or None (src/page/text-paras.js markers): "•" at every level; numbers count each run
/// of numbered items at a level, as 1. a. i. by level.
pub fn marker_texts(lists: &[ListItem], count: usize) -> Vec<Option<String>> {
    let mut out = vec![None; count];
    let mut counts = [0usize; 8];
    for (p, slot) in out.iter_mut().enumerate() {
        let Some(l) = lists.iter().find(|l| l.p == p) else {
            counts = [0; 8];
            continue;
        };
        let lv = usize::from(l.level.clamp(1, 5));
        for c in counts.iter_mut().skip(lv + 1) {
            *c = 0;
        }
        match l.kind {
            ListKind::Number => {
                counts[lv] += 1;
                let n = counts[lv];
                *slot = Some(match (lv - 1) % 3 {
                    0 => format!("{n}."),
                    1 => format!("{}.", letters(n)),
                    _ => format!("{}.", roman(n)),
                });
            }
            ListKind::Bullet => {
                counts[lv] = 0;
                *slot = Some("\u{2022}".to_string());
            }
            // An item without its marker keeps its level's count going (a second paragraph of an item).
            ListKind::None => {}
        }
    }
    out
}

/// Line breaking by paragraph: each line starts where its paragraph says (`line_x`, the width shrinking with it),
/// and a paragraph's first line moves down by the space above it. Returns each paragraph's first line.
fn break_paras(l: &mut Layout<Ink>, plan: &[ParaLine], width: Option<f32>) -> Vec<usize> {
    let max = width.unwrap_or(f32::MAX);
    let mut firsts = Vec::with_capacity(plan.len());
    let mut bl = l.break_lines();
    // A hanging quote starts its line left of 0 with that much more room: parley wants the layout as wide as any line.
    let hang = plan.iter().map(|p| -p.first).fold(0.0f32, f32::max);
    bl.state_mut().set_layout_max_advance(if max < f32::MAX { max + hang } else { max });
    let (mut para, mut first, mut lines) = (0usize, true, 0usize);
    loop {
        let p = plan.get(para).copied().unwrap_or_default();
        let x = if first { p.first } else { p.rest };
        // A box narrower than the indent keeps a pixel of room: every line takes at least one letter.
        let x = if max < f32::MAX { x.min((max - 1.0).max(0.0)) } else { x };
        let st = bl.state_mut();
        st.set_line_x(x);
        st.set_line_max_advance(if max < f32::MAX { max - x } else { f32::MAX });
        if first {
            if para > 0 && p.before > 0.0 {
                st.set_line_y(st.line_y() + f64::from(p.before));
            }
            firsts.push(lines);
        }
        match bl.break_next() {
            Some(parley::YieldData::LineBreak(d)) => {
                lines += 1;
                first = d.reason == parley::BreakReason::Explicit;
                if first {
                    para += 1;
                }
            }
            _ => break,
        }
    }
    bl.finish();
    firsts
}

pub struct TextBlock {
    pub layout: Option<Layout<Ink>>,
    align: TextAlign,
    nowrap: bool,
    broken_at: Option<Option<f32>>,
    /// Truncate text with max lines: the text measures as tall as its first `cap` lines.
    cap: Option<usize>,
    /// Paragraph spacing, indent and lists (`ParaLine` per paragraph); empty: lines break as before.
    plan: Vec<ParaLine>,
    /// List markers, shaped.
    marks: Vec<Mark>,
    /// Each paragraph's first line, from the last line breaking (with a plan).
    firsts: Vec<usize>,
}

/// What a measurement asks for along the inline axis.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Avail {
    Definite(f32),
    MinContent,
    MaxContent,
}

impl TextBlock {
    fn break_at(&mut self, width: Option<f32>) {
        if self.broken_at == Some(width) {
            return;
        }
        if let Some(l) = self.layout.as_mut() {
            if self.plan.is_empty() {
                l.break_all_lines(width);
            } else {
                self.firsts = break_paras(l, &self.plan, width);
            }
        }
        self.broken_at = Some(width);
    }

    /// How tall the laid-out lines are: parley's height, or with paragraph spacing down to the last line's bottom.
    fn lines_height(&self) -> f32 {
        let Some(l) = self.layout.as_ref() else { return 0.0 };
        if self.plan.is_empty() || l.len() == 0 {
            return l.height();
        }
        // parley leaves out a last empty line (after a final newline) when it sums the lines: so does this.
        let sum: f32 = l.lines().map(|ln| ln.metrics().line_height).sum();
        let last = if l.len() > 1 && l.height() < sum - 0.01 { l.len() - 2 } else { l.len() - 1 };
        l.get(last).map_or(l.height(), |ln| ln.metrics().block_max_coord)
    }

    /// The list markers to draw: (shaped marker, x, y of its layout's origin), text-origin space.
    pub fn marks(&self) -> Vec<(&Layout<Ink>, f64, f64)> {
        let Some(l) = self.layout.as_ref() else { return Vec::new() };
        self.marks
            .iter()
            .filter_map(|m| {
                let line = l.get(*self.firsts.get(m.para)?)?;
                let mb = m.layout.lines().next()?.metrics().baseline;
                Some((&m.layout, f64::from(m.x), f64::from(line.metrics().baseline - mb)))
            })
            .collect()
    }

    /// The leftmost x anything is drawn at (text-origin space): below 0 when quotes or list markers hang outside the box.
    pub fn min_x(&self) -> f32 {
        let Some(l) = self.layout.as_ref() else { return 0.0 };
        let lines = l.lines().map(|ln| ln.metrics().offset + ln.metrics().inline_min_coord);
        let marks = self.marks.iter().map(|m| m.x);
        lines.chain(marks).fold(0.0, f32::min)
    }

    /// Lines as drawn (text-origin space): x of the first letter, top, baseline, bottom, right (where the last letter
    /// ends, trailing spaces left out); for tests and QA.
    pub fn line_boxes(&self) -> Vec<[f32; 5]> {
        let Some(l) = self.layout.as_ref() else { return Vec::new() };
        l.lines()
            .map(|ln| {
                let m = ln.metrics();
                let x = m.offset + m.inline_min_coord;
                [x, m.block_min_coord, m.baseline, m.block_max_coord, x + m.advance - m.hanging_advance]
            })
            .collect()
    }

    /// Content size at an inline constraint (CSS min-content / max-content / a definite width).
    pub fn measure(&mut self, width: Avail) -> (f32, f32) {
        if self.layout.is_none() {
            return (0.0, 0.0);
        }
        let w = if self.nowrap {
            None
        } else {
            match width {
                Avail::Definite(w) => Some(w.max(0.0)),
                // overflow-wrap: break-word does not shrink min-content: it is the longest word.
                Avail::MinContent => Some(self.layout.as_ref().expect("checked above").calculate_content_widths().min),
                Avail::MaxContent => None,
            }
        };
        self.break_at(w);
        let l = self.layout.as_ref().expect("checked above");
        // `pre` keeps trailing spaces in the line's width; `pre-wrap` hangs them.
        let lw = if self.nowrap { l.full_width() } else { l.width() };
        let h = match self.cap {
            Some(n) if n >= 1 && l.len() > n => l.get(n - 1).map_or(l.height(), |ln| ln.metrics().block_max_coord),
            _ => self.lines_height(),
        };
        (lw, h)
    }

    /// Final line breaking and alignment for a content box `width` wide.
    pub fn finish(&mut self, width: f32) {
        if self.layout.is_none() {
            return;
        }
        let w = if self.nowrap { None } else { Some(width.max(0.0) + 0.01) };
        self.broken_at = None;
        self.break_at(w);
        let align = match self.align {
            TextAlign::Left => Alignment::Left,
            TextAlign::Center => Alignment::Center,
            TextAlign::Right => Alignment::Right,
            TextAlign::Justify => Alignment::Justify,
        };
        // With `pre` the lines align inside a box as wide as the widest line.
        let l = self.layout.as_mut().expect("checked above");
        l.align(align, AlignmentOptions { align_when_overflowing: false, ..Default::default() });
    }

    pub fn height(&self) -> f32 {
        self.lines_height()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::scene::VAlign;

    pub fn arial() -> Option<Vec<u8>> {
        std::fs::read("/System/Library/Fonts/Supplemental/Arial.ttf").ok()
    }

    pub fn props(content: &str, size: f32, growth: Growth) -> TextProps {
        TextProps {
            content: content.into(),
            family: "Arial".into(),
            size,
            size_given: true,
            weight: 400.0,
            italic: false,
            letter_spacing: 0.0,
            line_height: None,
            align: TextAlign::Left,
            valign: VAlign::Top,
            growth,
            underline: false,
            strikethrough: false,
            spans: vec![],
            truncate: false,
            max_lines: None,
            paras: None,
            small_caps: false,
        }
    }

    pub fn system() -> Option<TextSystem> {
        let mut ts = TextSystem::new();
        ts.default_line_height = None;
        ts.register_font("Arial", None, None, arial()?).ok()?;
        Some(ts)
    }

    #[test]
    fn normal_line_height_rounds_like_chrome() {
        let Some(mut ts) = system() else { return };
        let mut b = ts.build(&props("Hello", 16.0, Growth::Auto));
        let (w, h) = b.measure(Avail::MaxContent);
        // Arial 16px in Chrome/macOS: ascent 14.484 → 14, descent 3.394 → 3, gap 0.47 → 0 = 18px.
        assert_eq!(h, 18.0);
        assert!(w > 30.0 && w < 45.0, "{w}");
    }

    #[test]
    fn a_cached_shape_measures_like_a_fresh_one_and_new_fonts_clear_it() {
        let Some(mut ts) = system() else { return };
        let p = props("Hello there, a wrapped line", 16.0, Growth::FixedWidth);
        let mut fresh = ts.build(&p);
        ts.caching = true;
        let mut first = ts.build(&p);
        let mut hit = ts.build(&p);
        assert_eq!(ts.shaped_len(), 1, "one shape kept, the second build is a copy");
        for w in [Avail::MaxContent, Avail::MinContent, Avail::Definite(60.0)] {
            assert_eq!(hit.measure(w), fresh.measure(w));
            assert_eq!(first.measure(w), fresh.measure(w));
        }
        let mut q = p.clone();
        q.letter_spacing = 2.0;
        let mut wide = ts.build(&q);
        assert_eq!(ts.shaped_len(), 2, "other props are another entry");
        assert!(wide.measure(Avail::MaxContent).0 > fresh.measure(Avail::MaxContent).0);
        ts.default_size = 20.0;
        let mut r = p.clone();
        r.size_given = false;
        let a = ts.build(&r).measure(Avail::MaxContent);
        ts.default_size = 10.0;
        let b = ts.build(&r).measure(Avail::MaxContent);
        assert!(a.0 > b.0, "the inherited size is part of the key");
        ts.register_font("Arial", None, None, arial().unwrap()).unwrap();
        assert_eq!(ts.shaped_len(), 0, "a new face clears every shape");
        ts.caching = false;
        ts.build(&p);
        assert_eq!(ts.shaped_len(), 0, "nothing is kept while caching is off");
    }

    #[test]
    fn page_defaults_apply_when_the_node_sets_nothing() {
        let Some(mut ts) = system() else { return };
        ts.default_line_height = Some(1.45);
        let mut p = props("x", 0.0, Growth::Auto);
        p.size_given = false;
        let mut b = ts.build(&p);
        assert!((b.measure(Avail::MaxContent).1 - 13.0 * 1.45).abs() < 0.01);
    }

    #[test]
    fn unitless_line_height_multiplies_font_size() {
        let Some(mut ts) = system() else { return };
        let mut p = props("a\nb\nc", 10.0, Growth::Auto);
        p.line_height = Some(1.5);
        let mut b = ts.build(&p);
        assert_eq!(b.measure(Avail::MaxContent).1, 45.0);
    }

    #[test]
    fn wrapping_follows_width_and_min_content_is_the_longest_word() {
        let Some(mut ts) = system() else { return };
        let mut b = ts.build(&props("aaa bbbbbbbb cc", 20.0, Growth::FixedWidth));
        let (max_w, one_line) = b.measure(Avail::MaxContent);
        let (min_w, many) = b.measure(Avail::MinContent);
        assert!(min_w < max_w && min_w > 0.0);
        assert!((many / one_line - 3.0).abs() < 0.01, "three lines at min-content: {many} vs {one_line}");
        let (_, two) = b.measure(Avail::Definite(max_w - 1.0));
        assert!((two / one_line - 2.0).abs() < 0.01);
    }

    #[test]
    fn pre_does_not_wrap_and_trailing_newline_adds_nothing() {
        let Some(mut ts) = system() else { return };
        let mut b = ts.build(&props("one two three\n", 16.0, Growth::Auto));
        let (_, h) = b.measure(Avail::Definite(10.0));
        assert_eq!(h, 18.0);
        let mut e = ts.build(&props("", 16.0, Growth::Auto));
        assert_eq!(e.measure(Avail::MaxContent), (0.0, 0.0));
    }

    #[test]
    fn a_styled_range_changes_only_its_letters() {
        use crate::scene::TextSpan;
        let Some(mut ts) = system() else { return };
        let plain = ts.build(&props("abcd efgh", 16.0, Growth::Auto)).measure(Avail::MaxContent);
        let mut p = props("abcd efgh", 16.0, Growth::Auto);
        p.spans = vec![TextSpan { start: 5, end: 9, size: Some(32.0), ..Default::default() }];
        let big = ts.build(&p).measure(Avail::MaxContent);
        assert!(big.0 > plain.0 * 1.3 && big.1 > plain.1, "the second word at 32 px: {big:?} vs {plain:?}");
        let mut q = props("abcd efgh", 16.0, Growth::Auto);
        q.spans = vec![TextSpan { start: 0, end: 4, letter_spacing: Some(2.0), ..Default::default() }];
        let d = ts.build(&q).measure(Avail::MaxContent).0 - plain.0;
        assert!((d - 8.0).abs() < 0.05, "tracking on four letters only: {d}");
        // A colour rides on the runs as their brush; the rest stay the layer's.
        let mut c = props("ab cd", 16.0, Growth::Auto);
        c.spans = vec![TextSpan { start: 3, end: 5, color: crate::scene::parse_color("#ff0000"), underline: Some(true), ..Default::default() }];
        let mut b = ts.build(&c);
        b.finish(200.0);
        let l = b.layout.as_ref().unwrap();
        let runs: Vec<(bool, bool)> = l.lines().flat_map(|ln| ln.items().filter_map(|it| match it {
            parley::PositionedLayoutItem::GlyphRun(g) => Some((g.style().brush.0.is_some(), g.style().underline.is_some())),
            _ => None,
        }).collect::<Vec<_>>()).collect();
        assert_eq!(runs.first(), Some(&(false, false)), "{runs:?}");
        assert_eq!(runs.last(), Some(&(true, true)), "{runs:?}");
    }

    #[test]
    fn truncate_ends_the_last_line_that_shows_with_an_ellipsis() {
        let Some(mut ts) = system() else { return };
        let text = "one two three four five six seven eight nine ten eleven twelve";
        let mut p = props(text, 16.0, Growth::FixedWidth);
        let mut all = ts.build(&p);
        let (_, full_h) = all.measure(Avail::Definite(80.0));
        p.truncate = true;
        p.max_lines = Some(2);
        let mut b = ts.build(&p);
        let (_, h) = b.measure(Avail::Definite(80.0));
        assert!(h < full_h / 2.0, "two lines tall: {h} of {full_h}");
        ts.finish_text(&mut b, &p, 80.0, None);
        let l = b.layout.as_ref().unwrap();
        assert_eq!(l.len(), 2, "two lines drawn");
        let last = l.get(1).unwrap();
        // The layout now holds the cut text with "…" (three bytes) at the end of its last line.
        assert!(last.text_range().end > last.text_range().start);
        assert!(last.text_range().end < p.content.len(), "fewer letters than the whole text");
        // Without truncate nothing changes; a fixed-size box keeps the lines that fit.
        let mut q = props(text, 16.0, Growth::FixedWidthHeight);
        q.truncate = true;
        let mut c = ts.build(&q);
        ts.finish_text(&mut c, &q, 80.0, Some(40.0));
        assert!(c.layout.as_ref().unwrap().len() <= 2, "a 40 px box at 18 px lines: two lines");
        assert!(c.height() <= 40.5);
    }

    #[test]
    fn letter_spacing_widens_every_character() {
        let Some(mut ts) = system() else { return };
        let mut a = ts.build(&props("abcd", 16.0, Growth::Auto));
        let mut p = props("abcd", 16.0, Growth::Auto);
        p.letter_spacing = 2.0;
        let mut b = ts.build(&p);
        let d = b.measure(Avail::MaxContent).0 - a.measure(Avail::MaxContent).0;
        assert!((d - 8.0).abs() < 0.05, "CSS adds the spacing after each of the 4 letters: {d}");
    }

    /// Golden G4: CSS weights map to SF Pro's named instances, not to the axis value of the same number.
    #[test]
    fn sf_pro_weights_follow_its_named_instances() {
        assert!((sf_wght(100.0) - 30.925).abs() < 1e-3 && (sf_wght(200.0) - 110.725).abs() < 1e-3 && (sf_wght(300.0) - 274.315).abs() < 1e-3);
        assert_eq!((sf_wght(400.0), sf_wght(500.0), sf_wght(600.0), sf_wght(700.0), sf_wght(800.0), sf_wght(900.0)), (400.0, 510.0, 590.0, 700.0, 860.0, 1000.0));
        assert_eq!(sf_wght(650.0), 645.0, "between two weights: between their axis values");
        assert_eq!((sf_wght(1.0), sf_wght(1000.0)), (sf_wght(100.0), 1000.0));
        assert!(is_system_family("SF Pro") && is_system_family("SF Pro Display") && is_system_family("system-ui") && !is_system_family("Inter"));
        // On the real font: CSS 100 is Ultralight, lighter and narrower than CSS 200 (Thin). Before, 100 asked
        // for axis value 100 (about Thin) and 200 for 200: both too heavy.
        let Ok(bytes) = std::fs::read("/System/Library/Fonts/SFNS.ttf") else { return };
        let mut ts = TextSystem::new();
        ts.register_font("system-ui", None, None, bytes).unwrap();
        let mut width = |w: f32| {
            let mut p = props("Hamburgefonstiv minimum", 40.0, Growth::Auto);
            p.family = "system-ui".into();
            p.weight = w;
            ts.build(&p).measure(Avail::MaxContent).0
        };
        let (w100, w200, w800, w900) = (width(100.0), width(200.0), width(800.0), width(900.0));
        assert!(w100 < w200 && w800 < w900, "{w100} {w200} {w800} {w900}");
        println!("SF widths 100/200/800/900: {w100} {w200} {w800} {w900}");
        // Review round 6, Fable 14: text in a family that is not registered falls back to the system font and
        // takes the same weights as text that names it.
        let mut fallback = |w: f32| {
            let mut p = props("Hamburgefonstiv minimum", 40.0, Growth::Auto);
            p.family = "Not Installed Sans".into();
            p.weight = w;
            ts.build(&p).measure(Avail::MaxContent).0
        };
        assert_eq!((fallback(100.0), fallback(200.0), fallback(800.0), fallback(900.0)), (w100, w200, w800, w900));
    }

    #[test]
    fn a_missing_family_takes_the_system_fonts_weights() {
        let mut ts = TextSystem::new();
        assert!(ts.draws_with_system_font("system-ui") && ts.draws_with_system_font("Not Installed Sans"));
        let Some(bytes) = arial() else { return };
        ts.register_font("Arial", None, None, bytes).unwrap();
        assert!(!ts.draws_with_system_font("Arial") && !ts.draws_with_system_font("arial"), "a registered family keeps the CSS weight");
        assert!(ts.draws_with_system_font("Not Installed Sans"));
    }

    #[test]
    fn missing_family_falls_back_to_system_ui() {
        let Some(bytes) = arial() else { return };
        let mut ts = TextSystem::new();
        ts.default_line_height = None;
        ts.register_font(FALLBACK_FAMILY, None, None, bytes).unwrap();
        let mut p = props("Hello", 16.0, Growth::Auto);
        p.family = "Nope".into();
        let mut b = ts.build(&p);
        assert!(b.measure(Avail::MaxContent).0 > 30.0);
    }

    fn paras(spacing: f32, indent: f32, lists: Vec<ListItem>) -> Option<crate::scene::Paras> {
        Some(crate::scene::Paras { spacing, indent, lists, ..Default::default() })
    }

    #[test]
    fn paragraph_spacing_goes_between_paragraphs_only() {
        let Some(mut ts) = system() else { return };
        let mut p = props("One\nTwo\nThree", 16.0, Growth::Auto);
        let mut plain = ts.build(&p);
        let (_, h0) = plain.measure(Avail::MaxContent);
        p.paras = paras(10.0, 0.0, vec![]);
        let mut b = ts.build(&p);
        let (_, h) = b.measure(Avail::MaxContent);
        assert!((h - (h0 + 20.0)).abs() < 0.6, "two gaps of 10: {h0} -> {h}");
        b.finish(200.0);
        let lines = b.line_boxes();
        assert_eq!(lines.len(), 3);
        assert!(lines[0][1].abs() < 0.01, "nothing above the first paragraph");
        assert!((lines[1][1] - (18.0 + 10.0)).abs() < 0.6, "the second starts a line and a gap down: {lines:?}");
        assert!((b.height() - h).abs() < 0.01);
    }

    #[test]
    fn paragraph_indent_moves_each_paragraphs_first_line_only() {
        let Some(mut ts) = system() else { return };
        let mut p = props("aaaa bbbb cccc dddd eeee\nffff", 16.0, Growth::FixedWidth);
        p.paras = paras(0.0, 24.0, vec![]);
        let mut b = ts.build(&p);
        b.measure(Avail::Definite(90.0));
        b.finish(90.0);
        let lines = b.line_boxes();
        assert!(lines.len() >= 3, "wraps: {lines:?}");
        assert!((lines[0][0] - 24.0).abs() < 0.01, "the first line indented: {lines:?}");
        assert!(lines[1][0].abs() < 0.01, "a wrapped line is not");
        assert!((lines.last().unwrap()[0] - 24.0).abs() < 0.01, "the next paragraph's first line is");
        // Indent only with left-aligned text.
        p.align = TextAlign::Center;
        let mut c = ts.build(&p);
        c.measure(Avail::Definite(400.0));
        c.finish(400.0);
        let mut q = props(&p.content, 16.0, Growth::FixedWidth);
        q.align = TextAlign::Center;
        let mut d = ts.build(&q);
        d.measure(Avail::Definite(400.0));
        d.finish(400.0);
        assert_eq!(c.line_boxes(), d.line_boxes(), "centred text ignores the indent");
    }

    #[test]
    fn list_items_hang_and_carry_markers() {
        let Some(mut ts) = system() else { return };
        let mut p = props("Apples and pears and plums\nNested\nPlain", 16.0, Growth::FixedWidth);
        p.paras = paras(0.0, 0.0, vec![ListItem { p: 0, kind: ListKind::Number, level: 1 }, ListItem { p: 1, kind: ListKind::Number, level: 2 }]);
        let mut b = ts.build(&p);
        b.measure(Avail::Definite(120.0));
        b.finish(120.0);
        let lines = b.line_boxes();
        let step = list_step(16.0);
        assert_eq!(step, 24.0);
        assert!(lines.len() >= 4, "the first item wraps: {lines:?}");
        assert!((lines[0][0] - step).abs() < 0.01 && (lines[1][0] - step).abs() < 0.01, "every line of an item starts one step in (hanging): {lines:?}");
        let n = lines.len();
        assert!((lines[n - 2][0] - 2.0 * step).abs() < 0.01, "level 2 two steps in");
        assert!(lines[n - 1][0].abs() < 0.01, "a plain paragraph at the left edge");
        let marks = b.marks();
        assert_eq!(marks.len(), 2);
        assert!(marks[0].1.abs() < 0.01 && (marks[1].1 - f64::from(step)).abs() < 0.01, "markers a step left of their text");
        assert!((marks[1].2 - f64::from(lines[n - 2][1])).abs() < 1.0, "the second marker on its item's line");
        assert_eq!(marker_texts(&[ListItem { p: 0, kind: ListKind::Number, level: 1 }, ListItem { p: 1, kind: ListKind::Number, level: 2 }, ListItem { p: 2, kind: ListKind::Number, level: 2 }, ListItem { p: 3, kind: ListKind::Number, level: 3 }, ListItem { p: 4, kind: ListKind::Number, level: 1 }, ListItem { p: 6, kind: ListKind::Bullet, level: 4 }], 7),
            vec![Some("1.".into()), Some("a.".into()), Some("b.".into()), Some("i.".into()), Some("2.".into()), None, Some("\u{2022}".into())]);
        // The shape cache keeps the markers.
        ts.caching = true;
        let mut c1 = ts.build(&p);
        let mut c2 = ts.build(&p);
        for c in [&mut c1, &mut c2] {
            c.measure(Avail::Definite(120.0));
            c.finish(120.0);
        }
        assert_eq!(c2.marks().len(), 2);
    }

    fn sf() -> Option<TextSystem> {
        let mut ts = TextSystem::new();
        ts.default_line_height = None;
        ts.register_font("system-ui", None, None, std::fs::read("/System/Library/Fonts/SFNS.ttf").ok()?).ok()?;
        ts.register_font("Arial", None, None, arial()?).ok()?;
        Some(ts)
    }

    #[test]
    fn small_caps_take_the_fonts_smcp_and_leave_a_font_without_it_alone() {
        let Some(mut ts) = sf() else { return };
        let mut width = |content: &str, family: &str, small: bool| {
            let mut p = props(content, 40.0, Growth::Auto);
            p.family = family.into();
            p.small_caps = small;
            ts.build(&p).measure(Avail::MaxContent).0
        };
        let (plain, small) = (width("Hamburgefonstiv", "system-ui", false), width("Hamburgefonstiv", "system-ui", true));
        assert!((plain - small).abs() > 2.0, "SF Pro has small capitals: {plain} vs {small}");
        // Small capitals are wider than lower case letters and narrower than capitals.
        let upper = width("HAMBURGEFONSTIV", "system-ui", false);
        assert!(small > plain && small < upper, "{plain} < {small} < {upper}");
        assert_eq!(width("Hamburg", "Arial", true), width("Hamburg", "Arial", false), "Arial has no smcp: drawn as typed (no synthesized capitals)");
    }

    fn quoted(ts: &mut TextSystem, content: &str, align: TextAlign, hang: bool) -> TextBlock {
        let mut p = props(content, 16.0, Growth::FixedWidth);
        p.align = align;
        p.paras = Some(crate::scene::Paras { hanging_quotes: hang, ..Default::default() });
        let mut b = ts.build(&p);
        b.measure(Avail::Definite(300.0));
        b.finish(300.0);
        b
    }

    #[test]
    fn an_opening_quote_that_starts_a_paragraph_hangs_outside_the_box() {
        let Some(mut ts) = system() else { return };
        let b = quoted(&mut ts, "\u{201c}Quoted,\u{201d} she said.\nPlain line\n\"Straight\"", TextAlign::Left, true);
        let lines = b.line_boxes();
        // The quote's own advance in Arial 16 px: about 5.3 px.
        let q = {
            let mut p = props("\u{201c}", 16.0, Growth::Auto);
            p.paras = None;
            ts.build(&p).measure(Avail::MaxContent).0
        };
        assert!(q > 3.0, "{q}");
        assert!((lines[0][0] + q).abs() < 0.6, "the quote starts its width left of the box: {lines:?} ({q})");
        assert!(lines[1][0].abs() < 0.01, "a paragraph without a quote starts at the edge");
        assert!(lines[2][0] < -1.0, "a straight quote hangs too");
        assert!(b.min_x() < -3.0);
        // Off, or centred text: nothing hangs.
        let off = quoted(&mut ts, "\u{201c}Quoted\u{201d}", TextAlign::Left, false);
        assert!(off.line_boxes()[0][0].abs() < 0.01);
        let mid = quoted(&mut ts, "\u{201c}Quoted\u{201d}", TextAlign::Center, true);
        let plain = quoted(&mut ts, "\u{201c}Quoted\u{201d}", TextAlign::Center, false);
        assert_eq!(mid.line_boxes(), plain.line_boxes(), "centred text does not hang");
        // With an indent the quote hangs left of the indent.
        let mut p = props("\u{201c}Indented", 16.0, Growth::FixedWidth);
        p.paras = Some(crate::scene::Paras { indent: 20.0, hanging_quotes: true, ..Default::default() });
        let mut c = ts.build(&p);
        c.finish(300.0);
        assert!((c.line_boxes()[0][0] - (20.0 - q)).abs() < 0.6, "{:?}", c.line_boxes());
    }

    #[test]
    fn list_spacing_goes_between_items_and_hanging_lists_put_markers_outside() {
        let Some(mut ts) = system() else { return };
        let item = |p: usize, kind: ListKind, level: u8| ListItem { p, kind, level };
        let mut p = props("One\nTwo\nThree\nAfter", 16.0, Growth::FixedWidth);
        p.paras = Some(crate::scene::Paras {
            spacing: 10.0,
            list_spacing: 4.0,
            lists: vec![item(0, ListKind::Bullet, 1), item(1, ListKind::Bullet, 1), item(2, ListKind::Bullet, 2)],
            ..Default::default()
        });
        let mut b = ts.build(&p);
        b.finish(300.0);
        let l = b.line_boxes();
        assert!((l[1][1] - l[0][3] - 4.0).abs() < 0.6 && (l[2][1] - l[1][3] - 4.0).abs() < 0.6, "4 px between items: {l:?}");
        assert!((l[3][1] - l[2][3] - 10.0).abs() < 0.6, "the paragraph after the list: paragraph spacing");
        let step = list_step(16.0);
        assert!((l[0][0] - step).abs() < 0.01, "not hanging: the text a step in");
        // Hanging lists: the first level's text at the box edge, its marker a step outside; level 2 a step in.
        p.paras.as_mut().unwrap().hanging_list = true;
        let mut h = ts.build(&p);
        h.finish(300.0);
        let l = h.line_boxes();
        assert!(l[0][0].abs() < 0.01 && (l[2][0] - step).abs() < 0.01, "{l:?}");
        let marks = h.marks();
        assert!((marks[0].1 + f64::from(step)).abs() < 0.01 && marks[2].1.abs() < 0.01, "markers a step left of their text");
        assert!(h.min_x() <= -step + 0.01);
    }

    #[test]
    fn an_item_without_its_marker_keeps_its_indent_and_the_count() {
        let Some(mut ts) = system() else { return };
        let item = |p: usize, kind: ListKind| ListItem { p, kind, level: 1 };
        let lists = vec![item(0, ListKind::Number), item(1, ListKind::None), item(2, ListKind::Number)];
        assert_eq!(marker_texts(&lists, 3), vec![Some("1.".into()), None, Some("2.".into())]);
        let mut p = props("First\nMore of the first\nSecond", 16.0, Growth::FixedWidth);
        p.paras = paras(0.0, 0.0, lists);
        let mut b = ts.build(&p);
        b.finish(300.0);
        let l = b.line_boxes();
        assert!(l.iter().all(|x| (x[0] - list_step(16.0)).abs() < 0.01), "all three a step in: {l:?}");
        assert_eq!(b.marks().len(), 2);
    }

    #[test]
    fn a_marker_takes_its_items_first_letters_colour() {
        let Some(mut ts) = system() else { return };
        let mut p = props("Red item\nPlain item", 16.0, Growth::FixedWidth);
        p.paras = paras(0.0, 0.0, vec![ListItem { p: 0, kind: ListKind::Bullet, level: 1 }, ListItem { p: 1, kind: ListKind::Bullet, level: 1 }]);
        p.spans = vec![TextSpan { start: 0, end: 3, color: crate::scene::parse_color("#ff0000"), ..Default::default() }];
        let mut b = ts.build(&p);
        b.finish(300.0);
        let inks: Vec<Option<[f32; 4]>> = b
            .marks()
            .iter()
            .map(|(l, _, _)| l.lines().flat_map(|ln| ln.items().filter_map(|it| match it {
                parley::PositionedLayoutItem::GlyphRun(g) => Some(g.style().brush.0),
                _ => None,
            }).collect::<Vec<_>>()).next().flatten())
            .collect();
        assert_eq!(inks.len(), 2);
        assert!(inks[0].is_some_and(|c| c[0] > 0.99 && c[1] < 0.01), "the first marker red: {inks:?}");
        assert_eq!(inks[1], None, "the second in the layer's fill");
    }

    #[test]
    fn a_hanging_quote_leaves_its_line_the_whole_box() {
        let Some(mut ts) = system() else { return };
        let text = "\u{201c}Quoted words fill the line";
        let lines = |ts: &mut TextSystem, hang: bool, width: f32| {
            let mut p = props(text, 14.0, Growth::FixedWidth);
            p.paras = Some(crate::scene::Paras { hanging_quotes: hang, ..Default::default() });
            let mut b = ts.build(&p);
            b.measure(Avail::Definite(width));
            b.finish(width);
            b.line_boxes()
        };
        let one = lines(&mut ts, false, 1000.0);
        let full = one[0][4];
        let q = -lines(&mut ts, true, 1000.0)[0][0];
        // A box a little narrower than the whole line: without the hang the last word wraps; with it, the letters after
        // the quote fit the box (the quote outside).
        let w = full - q / 2.0;
        assert_eq!(lines(&mut ts, false, w).len(), 2);
        let h = lines(&mut ts, true, w);
        assert_eq!(h.len(), 1, "{h:?}");
        assert!(h[0][4] <= w + 0.01, "the line ends inside the box");
    }
}


