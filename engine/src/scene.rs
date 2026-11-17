//! The engine's document model: one board's resolved tree (from `GET /api/scene`) parsed into an
//! arena of nodes in paint order (pre-order). Property semantics follow `src/doc/render/html.ts`, the
//! renderer whose browser output is the ground truth; every default here is the one it uses.

use peniko::Color;
use serde_json::Value;

/// How one axis of a node is sized (`width` / `height`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Sizing {
    Fixed(f64),
    /// `fit_content`, optionally `fit_content(fallback)`.
    Fit(Option<f64>),
    /// `fill_container`, optionally `fill_container(fallback)`.
    Fill(Option<f64>),
}

impl Sizing {
    pub fn parse(v: Option<&Value>) -> Sizing {
        match v {
            Some(Value::Number(n)) => n.as_f64().map_or(Sizing::Fit(None), Sizing::Fixed),
            Some(Value::String(s)) => {
                let s = s.trim();
                let (mode, rest) = if let Some(r) = s.strip_prefix("fit_content") {
                    (0, r)
                } else if let Some(r) = s.strip_prefix("fill_container") {
                    (1, r)
                } else {
                    return Sizing::Fit(None);
                };
                let rest = rest.trim();
                let value = if rest.is_empty() {
                    None
                } else if let Some(inner) = rest.strip_prefix('(').and_then(|r| r.strip_suffix(')')) {
                    match inner.trim().parse::<f64>() {
                        Ok(v) if v.is_finite() => Some(v),
                        _ => return Sizing::Fit(None),
                    }
                } else {
                    return Sizing::Fit(None);
                };
                if mode == 0 { Sizing::Fit(value) } else { Sizing::Fill(value) }
            }
            _ => Sizing::Fit(None),
        }
    }
    pub fn is_fixed(self) -> bool {
        matches!(self, Sizing::Fixed(_))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Frame,
    Group,
    Rectangle,
    Ellipse,
    Polygon,
    Path,
    Text,
    Note,
    Prompt,
    Context,
    Icon,
    /// Anything else (script, browser, ...): html.ts draws a #F4F4F5 placeholder box.
    Other,
}

impl Kind {
    fn parse(s: &str) -> Kind {
        match s {
            "frame" => Kind::Frame,
            "group" => Kind::Group,
            "rectangle" => Kind::Rectangle,
            "ellipse" => Kind::Ellipse,
            "polygon" => Kind::Polygon,
            "path" => Kind::Path,
            "text" => Kind::Text,
            "note" => Kind::Note,
            "prompt" => Kind::Prompt,
            "context" => Kind::Context,
            "icon" => Kind::Icon,
            _ => Kind::Other,
        }
    }
    pub fn is_texty(self) -> bool {
        matches!(self, Kind::Text | Kind::Note | Kind::Prompt | Kind::Context)
    }
    pub fn is_container(self) -> bool {
        matches!(self, Kind::Frame | Kind::Group)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlexLayout {
    None,
    Horizontal,
    Vertical,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Justify {
    Start,
    Center,
    End,
    SpaceBetween,
    SpaceAround,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Start,
    Center,
    End,
}

/// Auto layout settings the format has no native key for, from `metadata.canvasLayout` (scene.ts resolves and
/// checks them). The default changes nothing.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CanvasLayout {
    /// Items move to a new line when the current one is full.
    pub wrap: bool,
    /// Space between wrapped lines (never below 0).
    pub cross_gap: f64,
    /// Wrapped lines spread over the cross axis (Auto cross gap).
    pub cross_auto: bool,
    /// Auto gap mode; applies only while `justifyContent` is an Auto gap (space_between / space_around).
    pub gap_mode: Option<GapMode>,
    /// Horizontal flow: children sit on a shared first text baseline.
    pub baseline: bool,
    /// Canvas stacking "First on top": in-flow children draw in reverse order.
    pub first_on_top: bool,
    pub min_w: Option<f64>,
    pub max_w: Option<f64>,
    pub min_h: Option<f64>,
    pub max_h: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GapMode {
    Between,
    Around,
    Evenly,
}

impl CanvasLayout {
    fn parse(v: Option<&Value>) -> CanvasLayout {
        let Some(o) = v.and_then(Value::as_object) else { return CanvasLayout::default() };
        let flag = |k: &str| o.get(k) == Some(&Value::Bool(true));
        // A min or max of 0 (or less) is no limit.
        let limit = |k: &str| num(o.get(k)).filter(|v| *v > 0.0);
        CanvasLayout {
            wrap: flag("wrap"),
            cross_gap: num(o.get("crossGap")).unwrap_or(0.0).max(0.0),
            cross_auto: flag("crossAuto"),
            gap_mode: match str_of(o.get("gapMode")) {
                Some("between") => Some(GapMode::Between),
                Some("around") => Some(GapMode::Around),
                Some("evenly") => Some(GapMode::Evenly),
                _ => None,
            },
            baseline: flag("baseline"),
            first_on_top: str_of(o.get("stacking")) == Some("first"),
            min_w: limit("minWidth"),
            max_w: limit("maxWidth"),
            min_h: limit("minHeight"),
            max_h: limit("maxHeight"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StrokeAlign {
    Inner,
    Center,
    Outer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GradientKind {
    Linear,
    Radial,
    Angular,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Gradient {
    pub kind: GradientKind,
    /// (offset 0..1, color with the fill's opacity already applied)
    pub stops: Vec<(f32, Color)>,
    pub center: (f64, f64),
    pub size: (f64, f64),
    pub rotation: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ImageFit {
    /// Fill (`mode` "fill", or the older "cover" / none).
    Cover,
    /// Fit (`mode` "fit", or "contain").
    Contain,
    Stretch,
    /// Crop: the image's own rectangle as fractions of the layer's box [x, y, width, height], so it scales
    /// with the layer (`crop: {x, y, width, height}`).
    Crop([f64; 4]),
    /// Tile: copies of the image at `scale` times its own px size, from the layer's top left.
    Tile(f64),
}

/// A paint's or a layer's blend mode (`blendMode`, the file's names; CSS `mix-blend-mode`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Blend {
    #[default]
    Normal,
    Darken,
    Multiply,
    ColorBurn,
    Lighten,
    Screen,
    ColorDodge,
    Overlay,
    SoftLight,
    HardLight,
    Difference,
    Exclusion,
    Hue,
    Saturation,
    Color,
    Luminosity,
}

impl Blend {
    pub fn parse(v: Option<&Value>) -> Blend {
        match str_of(v) {
            Some("darken") => Blend::Darken,
            Some("multiply") => Blend::Multiply,
            Some("colorBurn" | "color-burn" | "color_burn") => Blend::ColorBurn,
            Some("light" | "lighten") => Blend::Lighten,
            Some("screen") => Blend::Screen,
            Some("colorDodge" | "color-dodge" | "color_dodge") => Blend::ColorDodge,
            Some("overlay") => Blend::Overlay,
            Some("softLight" | "soft-light" | "soft_light") => Blend::SoftLight,
            Some("hardLight" | "hard-light" | "hard_light") => Blend::HardLight,
            Some("difference") => Blend::Difference,
            Some("exclusion") => Blend::Exclusion,
            Some("hue") => Blend::Hue,
            Some("saturation") => Blend::Saturation,
            Some("color") => Blend::Color,
            Some("luminosity") => Blend::Luminosity,
            _ => Blend::Normal,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Paint {
    Solid(Color),
    Gradient(Gradient),
    /// `rot`: quarter turns clockwise the image takes inside the layer (Rotate 90°).
    Image { url: String, fit: ImageFit, opacity: f32, rot: u8 },
    /// A shader fill (src/shader-fill.ts resolves a Paper preset to its WGSL and packed params): drawn from a
    /// texture the engine renders like a shader card's (see `shaders.rs`), clipped to the node's shape.
    Shader(std::rc::Rc<ShaderPaint>),
}

/// A shader fill as the scene gives it: WGSL with `fn shade(p)`, its `u.params`, whether it plays on its own.
#[derive(Clone, Debug, PartialEq)]
pub struct ShaderPaint {
    pub source: String,
    /// `shaders::source_hash` of `source`.
    pub hash: u64,
    pub params: Vec<f32>,
    pub play: bool,
    pub opacity: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum StrokeWidth {
    Uniform(f64),
    /// top, right, bottom, left
    Sides([f64; 4]),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Effect {
    Shadow { inner: bool, x: f64, y: f64, blur: f64, spread: f64, color: Color },
    Blur { radius: f64 },
    BackgroundBlur { radius: f64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextAlign {
    Left,
    Center,
    Right,
    Justify,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VAlign {
    Top,
    Middle,
    Bottom,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Growth {
    /// `white-space: pre`, no wrapping, width = max-content.
    Auto,
    /// `pre-wrap` at the node's width, height from the text.
    FixedWidth,
    /// `pre-wrap`, both sizes from the node.
    FixedWidthHeight,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TextProps {
    pub content: String,
    pub family: String,
    /// font-size in px; `size_given` false means the page's inherited size applies.
    pub size: f32,
    pub size_given: bool,
    pub weight: f32,
    pub italic: bool,
    pub letter_spacing: f32,
    /// CSS unitless multiplier; None inherits the page's line-height (see `TextSystem`).
    pub line_height: Option<f32>,
    pub align: TextAlign,
    pub valign: VAlign,
    pub growth: Growth,
    pub underline: bool,
    pub strikethrough: bool,
    /// Styled ranges (src/page/text-spans.js), byte offsets into `content`, sorted, not overlapping. Each says only
    /// what differs from the layer's own style.
    pub spans: Vec<TextSpan>,
    /// Truncate text (`textTruncation: "ending"`): what does not fit ends with an ellipsis.
    pub truncate: bool,
    /// With truncate: at most this many lines show (`maxLines`).
    pub max_lines: Option<usize>,
    /// Paragraph spacing, indent and lists (src/page/text-paras.js); None when the text sets none of them.
    pub paras: Option<Paras>,
    /// Letter case Small caps (`letterCase: "small-caps"`): the font's `smcp` feature. Uppercase, lowercase
    /// and title case are already applied to `content` (`apply_case`).
    pub small_caps: bool,
}

/// Letter case (`letterCase`): Original (none), Uppercase, Lowercase, Title case (Capitalize), Small caps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LetterCase {
    Original,
    Upper,
    Lower,
    Title,
    SmallCaps,
}

impl LetterCase {
    pub fn of(v: Option<&str>) -> LetterCase {
        match v {
            Some("upper") => LetterCase::Upper,
            Some("lower") => LetterCase::Lower,
            Some("title") => LetterCase::Title,
            Some("small-caps") => LetterCase::SmallCaps,
            _ => LetterCase::Original,
        }
    }
}

/// A combining mark or joiner (it never starts a word): the common combining blocks.
fn is_mark(c: char) -> bool {
    matches!(c, '\u{300}'..='\u{36f}' | '\u{483}'..='\u{489}' | '\u{591}'..='\u{5bd}' | '\u{1ab0}'..='\u{1aff}' | '\u{1dc0}'..='\u{1dff}' | '\u{20d0}'..='\u{20ff}' | '\u{fe00}'..='\u{fe0f}' | '\u{fe20}'..='\u{fe2f}' | '\u{200d}')
}

/// Apostrophes keep one word together between two letters or digits ("don't"); a full stop or a hyphen does not ("e.g."
/// is "E.G."). Canvas's own word rule: CSS `capitalize` reads words differently in Chrome and WebKit, so the page draws
/// each word's first letter upper-cased by this rule too (src/page/text-paras.js wordStarts).
fn joins_word(c: char) -> bool {
    matches!(c, '\'' | '\u{2019}')
}

/// Does the char at `i` start a word (Title case): a letter or digit after no letter, digit, mark or `_`, and not after
/// an apostrophe that follows a letter or digit.
pub fn starts_word(chars: &[char], i: usize) -> bool {
    let c = chars[i];
    if !c.is_alphanumeric() {
        return false;
    }
    let Some(&p) = i.checked_sub(1).and_then(|k| chars.get(k)) else { return true };
    if p.is_alphanumeric() || p == '_' || is_mark(p) {
        return false;
    }
    !(joins_word(p) && i >= 2 && chars[i - 2].is_alphanumeric())
}

/// `content` in a letter case as CSS `text-transform` draws it (full Unicode case maps: "ß" is "SS" in upper case, a
/// sigma ending a word "ς" in lower case), each styled range moved onto the same letters (byte offsets change where a
/// letter's other case takes more or fewer bytes). Small caps and Original leave the text as it is.
pub fn apply_case(content: &str, spans: &mut [TextSpan], case: LetterCase) -> String {
    if matches!(case, LetterCase::Original | LetterCase::SmallCaps) {
        return content.to_string();
    }
    let chars: Vec<char> = content.chars().collect();
    let mut out = String::with_capacity(content.len() + 8);
    // Old byte offset -> new, at every char boundary and the end.
    let mut map: Vec<(usize, usize)> = Vec::with_capacity(chars.len() + 1);
    let mut old = 0usize;
    for (i, &c) in chars.iter().enumerate() {
        map.push((old, out.len()));
        old += c.len_utf8();
        match case {
            LetterCase::Upper => out.extend(c.to_uppercase()),
            LetterCase::Lower => {
                let last = c == '\u{3a3}' && i > 0 && chars[i - 1].is_alphabetic() && !chars.get(i + 1).is_some_and(|n| n.is_alphabetic());
                if last { out.push('\u{3c2}') } else { out.extend(c.to_lowercase()) }
            }
            // Title case: a word's first letter in upper case, as the page's span with text-transform: uppercase draws it.
            _ => {
                if starts_word(&chars, i) { out.extend(c.to_uppercase()) } else { out.push(c) }
            }
        }
    }
    map.push((old, out.len()));
    let to = |b: usize| map[map.partition_point(|(o, _)| *o < b).min(map.len() - 1)].1;
    for s in spans.iter_mut() {
        s.start = to(s.start);
        s.end = to(s.end);
    }
    out
}

/// Paragraph settings and lists on a text: `paragraphSpacing`, `paragraphIndent`, `lists`, `listSpacing`,
/// `hangingList`, `hangingPunctuation`.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Paras {
    /// px between paragraphs.
    pub spacing: f32,
    /// px the first line of each (non-list) paragraph starts in.
    pub indent: f32,
    /// List items by paragraph, sorted by paragraph.
    pub lists: Vec<ListItem>,
    /// px between two list items next to each other (List spacing), in place of the paragraph spacing.
    pub list_spacing: f32,
    /// Hanging lists: markers outside the box, the items' text a level step further left.
    pub hanging_list: bool,
    /// Hanging punctuation (also called hanging quotes): an opening quotation mark that starts a
    /// paragraph sits outside the box, left of where the paragraph's first line starts (left-aligned and justified text).
    pub hanging_quotes: bool,
}

/// A list item's marker: a bullet, a number, or none (Backspace took the marker and kept the indent).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListKind {
    Bullet,
    Number,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ListItem {
    /// The paragraph (0-based).
    pub p: usize,
    pub kind: ListKind,
    /// 1 to 5.
    pub level: u8,
}

/// The text's paragraph settings, or None when it has none (the text lays out as before).
fn text_paras(o: &serde_json::Map<String, Value>) -> Option<Paras> {
    let spacing = num(o.get("paragraphSpacing")).filter(|v| *v > 0.0).unwrap_or(0.0) as f32;
    let indent = num(o.get("paragraphIndent")).filter(|v| *v > 0.0).unwrap_or(0.0) as f32;
    let mut lists: Vec<ListItem> = Vec::new();
    if let Some(Value::Array(list)) = o.get("lists") {
        for l in list {
            let Some(l) = l.as_object() else { continue };
            let Some(p) = num(l.get("p")).filter(|p| *p >= 0.0 && p.fract() == 0.0) else { continue };
            let kind = match str_of(l.get("type")) {
                Some("number") => ListKind::Number,
                Some("bullet") => ListKind::Bullet,
                Some("none") => ListKind::None,
                _ => continue,
            };
            let level = num(l.get("level")).unwrap_or(1.0).clamp(1.0, 5.0) as u8;
            lists.push(ListItem { p: p as usize, kind, level });
        }
        lists.sort_by_key(|l| l.p);
        lists.dedup_by_key(|l| l.p);
    }
    let list_spacing = num(o.get("listSpacing")).filter(|v| *v > 0.0).unwrap_or(0.0) as f32;
    let hanging_list = o.get("hangingList") == Some(&Value::Bool(true));
    let hanging_quotes = o.get("hangingPunctuation") == Some(&Value::Bool(true));
    (spacing > 0.0 || indent > 0.0 || !lists.is_empty() || hanging_quotes).then_some(Paras { spacing, indent, lists, list_spacing, hanging_list, hanging_quotes })
}

/// One styled range of a text: `None` keeps the layer's value.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct TextSpan {
    pub start: usize,
    pub end: usize,
    pub family: Option<String>,
    pub size: Option<f32>,
    pub weight: Option<f32>,
    pub italic: Option<bool>,
    pub color: Option<Color>,
    pub letter_spacing: Option<f32>,
    pub underline: Option<bool>,
    pub strikethrough: Option<bool>,
}

/// The file's spans (UTF-16 offsets, as JavaScript counts) as byte ranges of `content`; bad or empty ones dropped.
fn text_spans(v: Option<&Value>, content: &str) -> Vec<TextSpan> {
    let Some(Value::Array(list)) = v else { return vec![] };
    // UTF-16 offset -> byte offset, at every char boundary (and the end).
    let mut at16: Vec<(usize, usize)> = Vec::with_capacity(content.len() + 1);
    let mut u = 0usize;
    for (b, ch) in content.char_indices() {
        at16.push((u, b));
        u += ch.len_utf16();
    }
    at16.push((u, content.len()));
    let byte = |x: f64| -> Option<usize> {
        if x.is_nan() || x < 0.0 {
            return None;
        }
        let x = x as usize;
        // A UTF-16 offset inside a surrogate pair rounds down to the char start.
        let i = at16.partition_point(|(o, _)| *o <= x);
        (i > 0).then(|| at16[i - 1].1)
    };
    let mut out: Vec<TextSpan> = Vec::new();
    for s in list {
        let Some(o) = s.as_object() else { continue };
        let (Some(a), Some(b)) = (num(o.get("start")).and_then(byte), num(o.get("end")).and_then(byte)) else { continue };
        if b <= a || out.last().is_some_and(|l| a < l.end) {
            continue;
        }
        let flag = |k: &str| o.get(k).and_then(Value::as_bool);
        out.push(TextSpan {
            start: a,
            end: b,
            family: str_of(o.get("fontFamily")).filter(|f| !f.is_empty()).map(str::to_string),
            size: num(o.get("fontSize")).filter(|v| *v > 0.0).map(|v| v as f32),
            weight: o.get("fontWeight").filter(|v| !v.is_null()).map(|v| weight_of(Some(v))),
            italic: str_of(o.get("fontStyle")).map(|s| s.to_ascii_lowercase().contains("italic")),
            color: str_of(o.get("fill")).and_then(parse_color),
            letter_spacing: num(o.get("letterSpacing")).map(|v| v as f32),
            underline: flag("underline"),
            strikethrough: flag("strikethrough"),
        });
    }
    out
}

#[derive(Clone, Debug, PartialEq)]
pub struct IconShape {
    pub d: String,
    /// None = no fill; Some(None) = the node's colour (currentColor); Some(Some(c)) = explicit.
    pub fill: Option<Option<Color>>,
    pub stroke: Option<Option<Color>>,
    pub stroke_width: f64,
    pub cap: Option<String>,
    pub join: Option<String>,
    pub even_odd: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Icon {
    pub size: f64,
    /// `svg`: artwork with its own paint. `mask`: the artwork's shape filled with the node colour.
    pub mask: bool,
    pub shapes: Vec<IconShape>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Node {
    pub id: String,
    pub kind: Kind,
    pub parent: Option<usize>,
    pub children: Vec<usize>,
    pub x: f64,
    pub y: f64,
    pub width: Sizing,
    pub height: Sizing,
    /// The raw numeric width/height when given (vector viewBoxes use them).
    pub num_w: Option<f64>,
    pub num_h: Option<f64>,
    pub absolute: bool,
    pub opacity: Option<f64>,
    pub rotation: f64,
    pub flip_x: bool,
    pub flip_y: bool,
    pub layout: FlexLayout,
    pub gap: f64,
    /// top, right, bottom, left
    pub padding: [f64; 4],
    pub justify: Justify,
    pub align: Align,
    pub clip: bool,
    /// `locked`: the canvas does not hit-test it or anything inside it (a lock); it still draws.
    pub locked: bool,
    /// `layoutIncludeStroke`: an inner stroke takes space inside the frame (added to its padding).
    pub layout_include_stroke: bool,
    /// `metadata.canvasLayout` (scene key `canvasLayout`).
    pub cl: CanvasLayout,
    /// top-left, top-right, bottom-right, bottom-left; None when no radius is set.
    pub corner: Option<[f64; 4]>,
    /// `cornerSmoothing` 0..1: smoothed corners (0.6 is iOS).
    pub smoothing: f64,
    /// `blendMode` of the whole layer.
    pub blend: Blend,
    pub fills: Vec<Paint>,
    /// Each fill's `blendMode`, in the order of `fills`.
    pub fill_blends: Vec<Blend>,
    /// Use as mask: this layer is not drawn; it cuts the siblings above it to its alpha.
    pub mask: bool,
    pub strokes: Vec<Paint>,
    pub stroke_width: Option<StrokeWidth>,
    pub stroke_align: StrokeAlign,
    pub cap: Option<String>,
    pub join: Option<String>,
    pub effects: Vec<Effect>,
    pub text: Option<TextProps>,
    pub geometry: Option<String>,
    pub view_box: Option<[f64; 4]>,
    pub even_odd: bool,
    pub inner_radius: f64,
    pub start_angle: f64,
    pub sweep_angle: Option<f64>,
    pub polygon_count: f64,
    pub icon: Option<Icon>,
}

/// One board: nodes in paint order, `nodes[0]` is the root.
#[derive(Clone, Debug, Default)]
pub struct Doc {
    pub nodes: Vec<Node>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FontRef {
    pub family: String,
    pub weight: f32,
    pub italic: bool,
    pub url: String,
    pub fallback: bool,
}

/// The `/api/scene` payload.
#[derive(Clone, Debug)]
pub struct SceneBoard {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub doc: Doc,
    pub fonts: Vec<FontRef>,
    pub images: Vec<String>,
}

// ------------------------------------------------------------------ value helpers

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|x| x.is_finite())
}

fn str_of(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

fn as_list(v: Option<&Value>) -> Vec<&Value> {
    match v {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(a)) => a.iter().collect(),
        Some(x) => vec![x],
    }
}

fn enabled(v: &Value) -> bool {
    !(v.is_object() && v.get("enabled") == Some(&Value::Bool(false)))
}

/// `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`.
pub fn parse_color(s: &str) -> Option<Color> {
    let h = s.trim().strip_prefix('#')?;
    if !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let full: String = match h.len() {
        3 | 4 => h.chars().flat_map(|c| [c, c]).collect(),
        6 | 8 => h.to_string(),
        _ => return None,
    };
    let byte = |i: usize| u8::from_str_radix(&full[i..i + 2], 16).ok();
    let a = if full.len() == 8 { byte(6)? } else { 255 };
    Some(Color::from_rgba8(byte(0)?, byte(2)?, byte(4)?, a))
}

/// html.ts `firstColor`: the first enabled solid colour, or a gradient's first stop.
pub fn first_color(v: Option<&Value>) -> Option<Color> {
    for f in as_list(v).into_iter().filter(|f| enabled(f)) {
        if let Some(s) = f.as_str() {
            return parse_color(s);
        }
        match str_of(f.get("type")) {
            Some("color") => return str_of(f.get("color")).and_then(parse_color),
            Some("gradient") => {
                return f.get("colors").and_then(Value::as_array).and_then(|c| c.first()).and_then(|c| str_of(c.get("color"))).and_then(parse_color);
            }
            _ => {}
        }
    }
    None
}

fn gradient_of(f: &Value) -> Gradient {
    let op = num(f.get("opacity")).unwrap_or(1.0) as f32;
    let mut stops: Vec<(f32, Color)> = Vec::new();
    let mut last = 0f32;
    for c in f.get("colors").and_then(Value::as_array).into_iter().flatten() {
        let Some(color) = str_of(c.get("color")).and_then(parse_color) else { continue };
        // CSS: a stop never sits before the one ahead of it.
        let pos = (num(c.get("position")).unwrap_or(0.0) as f32).max(last);
        last = pos;
        stops.push((pos, if op < 1.0 { color.multiply_alpha(op) } else { color }));
    }
    let kind = match str_of(f.get("gradientType")) {
        Some("radial") => GradientKind::Radial,
        Some("angular") => GradientKind::Angular,
        _ => GradientKind::Linear,
    };
    let center = f.get("center");
    let size = f.get("size");
    Gradient {
        kind,
        stops,
        center: (num(center.and_then(|c| c.get("x"))).unwrap_or(0.5), num(center.and_then(|c| c.get("y"))).unwrap_or(0.5)),
        size: (num(size.and_then(|c| c.get("width"))).unwrap_or(1.0), num(size.and_then(|c| c.get("height"))).unwrap_or(1.0)),
        rotation: num(f.get("rotation")).unwrap_or(0.0),
    }
}

fn paints(v: Option<&Value>, warnings: &mut Vec<String>, id: &str) -> Vec<Paint> {
    paints_blended(v, warnings, id).0
}

/// The image fill's placement: `mode`, with `crop` or `scale`.
fn image_fit(f: &Value) -> ImageFit {
    match str_of(f.get("mode")) {
        Some("contain" | "fit") => ImageFit::Contain,
        Some("stretch") => ImageFit::Stretch,
        Some("crop") => {
            let c = f.get("crop");
            let g = |k: &str, d: f64| num(c.and_then(|c| c.get(k))).filter(|v| v.is_finite()).unwrap_or(d);
            let (w, h) = (g("width", 1.0), g("height", 1.0));
            if w > 0.0 && h > 0.0 { ImageFit::Crop([g("x", 0.0), g("y", 0.0), w, h]) } else { ImageFit::Cover }
        }
        Some("tile") => ImageFit::Tile(num(f.get("scale")).filter(|s| s.is_finite() && *s > 0.0).unwrap_or(1.0).clamp(0.01, 100.0)),
        _ => ImageFit::Cover,
    }
}

/// Paints and, for each one drawn, its blend mode.
fn paints_blended(v: Option<&Value>, warnings: &mut Vec<String>, id: &str) -> (Vec<Paint>, Vec<Blend>) {
    let mut out = Vec::new();
    let mut blends = Vec::new();
    for f in as_list(v).into_iter().filter(|f| enabled(f)) {
        let before = out.len();
        paint_one(f, &mut out, warnings, id);
        if out.len() > before {
            blends.push(Blend::parse(f.get("blendMode")));
        }
    }
    (out, blends)
}

fn paint_one(f: &Value, out: &mut Vec<Paint>, warnings: &mut Vec<String>, id: &str) {
    {
        if let Some(s) = f.as_str() {
            if let Some(c) = parse_color(s) {
                out.push(Paint::Solid(c));
            }
            return;
        }
        match str_of(f.get("type")) {
            Some("color") => {
                if let Some(c) = str_of(f.get("color")).and_then(parse_color) {
                    out.push(Paint::Solid(c));
                }
            }
            Some("gradient") => out.push(Paint::Gradient(gradient_of(f))),
            Some("image") => {
                if let Some(url) = str_of(f.get("url")) {
                    let rot = (num(f.get("rotation")).unwrap_or(0.0) / 90.0).round().rem_euclid(4.0) as u8;
                    out.push(Paint::Image { url: url.to_string(), fit: image_fit(f), opacity: num(f.get("opacity")).unwrap_or(1.0) as f32, rot });
                }
            }
            Some("mesh_gradient") => {
                // html.ts: a 135deg linear gradient through the mesh colours.
                let colors: Vec<Color> = f.get("colors").and_then(Value::as_array).into_iter().flatten().filter_map(|c| c.as_str().and_then(parse_color)).collect();
                if !colors.is_empty() {
                    warnings.push(format!("{id}: mesh gradient drawn as a plain gradient"));
                    let n = colors.len().max(2) - 1;
                    let stops = colors.iter().enumerate().map(|(i, c)| (i as f32 / n as f32, *c)).collect();
                    out.push(Paint::Gradient(Gradient { kind: GradientKind::Linear, stops, center: (0.5, 0.5), size: (1.0, 1.0), rotation: -135.0 }));
                }
            }
            Some("shader") => match str_of(f.get("source")).filter(|s| !s.is_empty() && s.len() <= crate::shaders::MAX_SOURCE) {
                Some(src) => {
                    let params = f.get("uniforms").and_then(Value::as_array).map(|a| a.iter().take(crate::shaders::PARAM_FLOATS).map(|v| v.as_f64().unwrap_or(0.0) as f32).collect()).unwrap_or_default();
                    out.push(Paint::Shader(std::rc::Rc::new(ShaderPaint {
                        source: src.to_string(),
                        hash: crate::shaders::source_hash(src),
                        params,
                        play: f.get("play").and_then(Value::as_bool).unwrap_or(true),
                        opacity: num(f.get("opacity")).unwrap_or(1.0).clamp(0.0, 1.0) as f32,
                    })));
                }
                None => warnings.push(format!("{id}: shader fill has no source")),
            },
            _ => {}
        }
    }
}

fn padding(v: Option<&Value>) -> [f64; 4] {
    match v {
        Some(Value::Number(n)) => [n.as_f64().unwrap_or(0.0); 4],
        Some(Value::Array(a)) => {
            let x: Vec<f64> = a.iter().map(|v| v.as_f64().unwrap_or(0.0)).collect();
            match x.len() {
                2 => [x[0], x[1], x[0], x[1]],
                4 => [x[0], x[1], x[2], x[3]],
                _ => [0.0; 4],
            }
        }
        _ => [0.0; 4],
    }
}

fn corner(v: Option<&Value>) -> Option<[f64; 4]> {
    match v {
        Some(Value::Number(n)) => n.as_f64().filter(|r| *r > 0.0).map(|r| [r; 4]),
        Some(Value::Array(a)) => {
            let x: Vec<f64> = a.iter().map(|v| v.as_f64().unwrap_or(0.0)).collect();
            if x.iter().all(|r| *r <= 0.0) {
                return None;
            }
            Some(match x.len() {
                1 => [x[0]; 4],
                2 => [x[0], x[1], x[0], x[1]],
                3 => [x[0], x[1], x[2], x[1]],
                _ => [x[0], x[1], x[2], x[3]],
            })
        }
        _ => None,
    }
}

fn effects(v: Option<&Value>) -> Vec<Effect> {
    let mut out = Vec::new();
    for e in as_list(v).into_iter().filter(|f| enabled(f)) {
        match str_of(e.get("type")) {
            Some("shadow") => out.push(Effect::Shadow {
                inner: str_of(e.get("shadowType")) == Some("inner"),
                x: num(e.get("offset").and_then(|o| o.get("x"))).unwrap_or(0.0),
                y: num(e.get("offset").and_then(|o| o.get("y"))).unwrap_or(0.0),
                blur: num(e.get("blur")).unwrap_or(0.0),
                spread: num(e.get("spread")).unwrap_or(0.0),
                color: str_of(e.get("color")).and_then(parse_color).unwrap_or(Color::from_rgba8(0, 0, 0, 0x40)),
            }),
            Some("blur") => out.push(Effect::Blur { radius: num(e.get("radius")).unwrap_or(0.0) }),
            Some("background_blur") => out.push(Effect::BackgroundBlur { radius: num(e.get("radius")).unwrap_or(0.0) }),
            _ => {}
        }
    }
    out
}

/// "normal" → 400, "bold" → 700, numbers as given (same as the server's `weightOf`).
pub fn weight_of(v: Option<&Value>) -> f32 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(400.0) as f32,
        Some(Value::String(s)) => match s.trim().to_ascii_lowercase().as_str() {
            "" | "normal" | "regular" => 400.0,
            "bold" => 700.0,
            x => x.parse::<f32>().ok().filter(|w| *w > 0.0).unwrap_or(400.0),
        },
        _ => 400.0,
    }
}

fn text_props(o: &serde_json::Map<String, Value>, kind: Kind) -> TextProps {
    let growth = if kind == Kind::Text {
        match str_of(o.get("textGrowth")) {
            Some("fixed-width") => Growth::FixedWidth,
            Some("fixed-width-height") => Growth::FixedWidthHeight,
            _ => Growth::Auto,
        }
    } else {
        Growth::FixedWidthHeight
    };
    let content = str_of(o.get("content")).map(str::to_string).or_else(|| num(o.get("content")).map(|n| n.to_string())).unwrap_or_default();
    let mut spans = text_spans(o.get("spans"), &content);
    // Letter case: the letters are drawn (and lines broken) in their new case; the file keeps them as typed.
    let case = if kind == Kind::Text { LetterCase::of(str_of(o.get("letterCase"))) } else { LetterCase::Original };
    let content = apply_case(&content, &mut spans, case);
    TextProps {
        content,
        family: str_of(o.get("fontFamily")).filter(|s| !s.is_empty()).unwrap_or("Inter").to_string(),
        size: num(o.get("fontSize")).unwrap_or(16.0) as f32,
        size_given: num(o.get("fontSize")).is_some(),
        weight: weight_of(o.get("fontWeight")),
        italic: str_of(o.get("fontStyle")).is_some_and(|s| s.to_ascii_lowercase().contains("italic")),
        letter_spacing: num(o.get("letterSpacing")).unwrap_or(0.0) as f32,
        line_height: num(o.get("lineHeight")).map(|v| v as f32),
        align: match str_of(o.get("textAlign")) {
            Some("center") => TextAlign::Center,
            Some("right") => TextAlign::Right,
            Some("justify") => TextAlign::Justify,
            _ => TextAlign::Left,
        },
        valign: match str_of(o.get("textAlignVertical")) {
            Some("middle") => VAlign::Middle,
            Some("bottom") => VAlign::Bottom,
            _ => VAlign::Top,
        },
        growth,
        underline: o.get("underline") == Some(&Value::Bool(true)),
        strikethrough: o.get("strikethrough") == Some(&Value::Bool(true)),
        spans,
        truncate: kind == Kind::Text && str_of(o.get("textTruncation")) == Some("ending"),
        max_lines: num(o.get("maxLines")).filter(|v| *v >= 1.0).map(|v| v.min(10_000.0) as usize),
        paras: if kind == Kind::Text { text_paras(o) } else { None },
        small_caps: case == LetterCase::SmallCaps,
    }
}

fn icon_paint(v: Option<&Value>) -> Option<Option<Color>> {
    match str_of(v) {
        None | Some("none") => None,
        Some("current") | Some("currentColor") => Some(None),
        Some(c) => parse_color(c).map(Some),
    }
}

fn icon(o: &serde_json::Map<String, Value>) -> Option<Icon> {
    let shapes = o.get("iconShapes")?.as_array()?;
    Some(Icon {
        size: num(o.get("iconSize")).unwrap_or(24.0),
        mask: str_of(o.get("iconMode")) == Some("mask"),
        shapes: shapes
            .iter()
            .filter_map(|s| {
                Some(IconShape {
                    d: str_of(s.get("d"))?.to_string(),
                    fill: icon_paint(s.get("fill")),
                    stroke: icon_paint(s.get("stroke")),
                    stroke_width: num(s.get("strokeWidth")).unwrap_or(1.0),
                    cap: str_of(s.get("cap")).map(str::to_string),
                    join: str_of(s.get("join")).map(str::to_string),
                    even_odd: str_of(s.get("fillRule")) == Some("evenodd"),
                })
            })
            .collect(),
    })
}

impl Doc {
    /// Parse a resolved node tree (the `root` of `/api/scene`).
    pub fn from_value(root: &Value) -> Result<Doc, String> {
        let mut doc = Doc::default();
        if !root.is_object() {
            return Err("scene root must be an object".into());
        }
        doc.push(root, None);
        Ok(doc)
    }

    fn push(&mut self, v: &Value, parent: Option<usize>) {
        let Some(o) = v.as_object() else { return };
        if o.get("enabled") == Some(&Value::Bool(false)) {
            return;
        }
        let kind = Kind::parse(str_of(o.get("type")).unwrap_or(""));
        let id = match o.get("id") {
            Some(Value::String(s)) => s.clone(),
            Some(x) if !x.is_null() => x.to_string(),
            _ => String::new(),
        };
        let mut warnings = Vec::new();
        let stroke_width = match o.get("strokeWidth") {
            Some(Value::Number(n)) => n.as_f64().map(StrokeWidth::Uniform),
            Some(Value::Object(m)) => {
                let s = |k: &str| num(m.get(k)).unwrap_or(0.0);
                Some(StrokeWidth::Sides([s("top"), s("right"), s("bottom"), s("left")]))
            }
            _ => None,
        };
        let layout = if kind == Kind::Group {
            FlexLayout::None
        } else {
            match str_of(o.get("layout")) {
                Some("vertical") => FlexLayout::Vertical,
                Some("none") => FlexLayout::None,
                _ => FlexLayout::Horizontal,
            }
        };
        let fill_list = paints_blended(o.get("fill"), &mut warnings, &id);
        let node = Node {
            id: id.clone(),
            kind,
            parent,
            children: Vec::new(),
            x: num(o.get("x")).unwrap_or(0.0),
            y: num(o.get("y")).unwrap_or(0.0),
            width: Sizing::parse(o.get("width")),
            height: Sizing::parse(o.get("height")),
            num_w: num(o.get("width")),
            num_h: num(o.get("height")),
            absolute: str_of(o.get("layoutPosition")) == Some("absolute"),
            opacity: num(o.get("opacity")),
            rotation: num(o.get("rotation")).unwrap_or(0.0),
            flip_x: o.get("flipX") == Some(&Value::Bool(true)),
            flip_y: o.get("flipY") == Some(&Value::Bool(true)),
            layout,
            gap: num(o.get("gap")).unwrap_or(0.0),
            padding: padding(o.get("padding")),
            justify: match str_of(o.get("justifyContent")) {
                Some("center") => Justify::Center,
                Some("end") => Justify::End,
                Some("space_between") => Justify::SpaceBetween,
                Some("space_around") => Justify::SpaceAround,
                _ => Justify::Start,
            },
            align: match str_of(o.get("alignItems")) {
                Some("center") => Align::Center,
                Some("end") => Align::End,
                _ => Align::Start,
            },
            clip: o.get("clip") == Some(&Value::Bool(true)),
            locked: o.get("locked") == Some(&Value::Bool(true)),
            layout_include_stroke: o.get("layoutIncludeStroke") == Some(&Value::Bool(true)),
            cl: CanvasLayout::parse(o.get("canvasLayout")),
            corner: corner(o.get("cornerRadius")),
            smoothing: num(o.get("cornerSmoothing")).filter(|v| v.is_finite()).unwrap_or(0.0).clamp(0.0, 1.0),
            blend: Blend::parse(o.get("blendMode")),
            fills: fill_list.0,
            fill_blends: fill_list.1,
            mask: o.get("mask") == Some(&Value::Bool(true)),
            strokes: paints(o.get("stroke"), &mut warnings, &id),
            stroke_width,
            stroke_align: match str_of(o.get("strokeAlignment")) {
                Some("center") => StrokeAlign::Center,
                Some("outer") => StrokeAlign::Outer,
                _ => StrokeAlign::Inner,
            },
            cap: str_of(o.get("strokeLinecap")).map(str::to_string),
            join: str_of(o.get("strokeLinejoin")).map(str::to_string),
            effects: effects(o.get("effect")),
            text: kind.is_texty().then(|| text_props(o, kind)),
            geometry: str_of(o.get("geometry")).map(str::to_string),
            view_box: o.get("viewBox").and_then(Value::as_array).and_then(|a| {
                let v: Vec<f64> = a.iter().filter_map(Value::as_f64).collect();
                (v.len() == 4).then(|| [v[0], v[1], v[2], v[3]])
            }),
            even_odd: str_of(o.get("fillRule")) == Some("evenodd"),
            inner_radius: num(o.get("innerRadius")).unwrap_or(0.0),
            start_angle: num(o.get("startAngle")).unwrap_or(0.0),
            sweep_angle: num(o.get("sweepAngle")),
            polygon_count: num(o.get("polygonCount")).unwrap_or(3.0),
            icon: if kind == Kind::Icon { icon(o) } else { None },
        };
        self.warnings.extend(warnings);
        if kind == Kind::Other {
            self.warnings.push(format!("{id}: {} nodes are drawn as a placeholder", str_of(o.get("type")).unwrap_or("?")));
        }
        let me = self.nodes.len();
        self.nodes.push(node);
        if let Some(p) = parent {
            self.nodes[p].children.push(me);
        }
        if kind.is_container()
            && let Some(kids) = o.get("children").and_then(Value::as_array)
        {
            for k in kids {
                self.push(k, Some(me));
            }
        }
    }

    pub fn index_of(&self, id: &str) -> Option<usize> {
        self.nodes.iter().position(|n| n.id == id)
    }

    /// Node `i`'s children in the order they draw. Canvas stacking "First on top" on an auto layout frame
    /// draws its in-flow children last to first; absolute children keep their order, above the flow.
    pub fn paint_children(&self, i: usize) -> Vec<usize> {
        let n = &self.nodes[i];
        if !(n.cl.first_on_top && n.kind == Kind::Frame && n.layout != FlexLayout::None) {
            return n.children.clone();
        }
        let mut out: Vec<usize> = n.children.iter().rev().copied().filter(|&c| !self.nodes[c].absolute).collect();
        out.extend(n.children.iter().copied().filter(|&c| self.nodes[c].absolute));
        out
    }

    /// Each node's position in drawing order (0 draws first): pre-order with `paint_children`. Equals the
    /// node index unless some frame stacks first on top.
    pub fn paint_rank(&self) -> Vec<usize> {
        let n = self.nodes.len();
        if !self.nodes.iter().any(|x| x.cl.first_on_top) {
            return (0..n).collect();
        }
        let mut rank = vec![0; n];
        let mut next = 0;
        let mut stack = if n > 0 { vec![0] } else { vec![] };
        while let Some(i) = stack.pop() {
            rank[i] = next;
            next += 1;
            stack.extend(self.paint_children(i).into_iter().rev());
        }
        rank
    }
}

impl SceneBoard {
    pub fn parse(json: &str) -> Result<SceneBoard, String> {
        let v: Value = serde_json::from_str(json).map_err(|e| format!("scene JSON: {e}"))?;
        if let Some(e) = str_of(v.get("error")) {
            return Err(format!("scene: {e}"));
        }
        let root = v.get("root").ok_or("scene has no root")?;
        let mut doc = Doc::from_value(root)?;
        for w in v.get("warnings").and_then(Value::as_array).into_iter().flatten() {
            if let Some(s) = w.as_str() {
                doc.warnings.push(s.to_string());
            }
        }
        let fonts = v
            .get("fonts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|f| {
                Some(FontRef {
                    family: str_of(f.get("family"))?.to_string(),
                    weight: weight_of(f.get("weight")),
                    italic: str_of(f.get("style")) == Some("italic"),
                    url: str_of(f.get("url")).unwrap_or("").to_string(),
                    fallback: f.get("fallback") == Some(&Value::Bool(true)),
                })
            })
            .collect();
        let images = v.get("images").and_then(Value::as_array).into_iter().flatten().filter_map(|s| s.as_str().map(str::to_string)).collect();
        Ok(SceneBoard {
            id: str_of(v.get("id")).unwrap_or("").to_string(),
            x: num(v.get("x")).unwrap_or(0.0),
            y: num(v.get("y")).unwrap_or(0.0),
            doc,
            fonts,
            images,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sizing_forms() {
        assert_eq!(Sizing::parse(Some(&json!(12))), Sizing::Fixed(12.0));
        assert_eq!(Sizing::parse(Some(&json!("fill_container"))), Sizing::Fill(None));
        assert_eq!(Sizing::parse(Some(&json!("fill_container(320)"))), Sizing::Fill(Some(320.0)));
        assert_eq!(Sizing::parse(Some(&json!("fit_content( 40.5 )"))), Sizing::Fit(Some(40.5)));
        assert_eq!(Sizing::parse(Some(&json!("bogus"))), Sizing::Fit(None));
        assert_eq!(Sizing::parse(None), Sizing::Fit(None));
    }

    #[test]
    fn colors() {
        assert_eq!(parse_color("#FFF"), Some(Color::from_rgba8(255, 255, 255, 255)));
        assert_eq!(parse_color("#0766EB80"), Some(Color::from_rgba8(7, 102, 235, 128)));
        assert_eq!(parse_color("#12"), None);
        assert_eq!(parse_color("red"), None);
    }

    #[test]
    fn tree_in_paint_order_with_defaults() {
        let d = Doc::from_value(&json!({
            "type": "frame", "id": "r", "padding": [4, 8], "cornerRadius": [1, 2, 3, 4],
            "children": [
                { "type": "text", "id": "t", "content": "hi" },
                { "type": "rectangle", "id": "off", "enabled": false },
                { "type": "group", "id": "g", "layout": "vertical", "children": [{ "type": "ellipse", "id": "e" }] }
            ]
        }))
        .unwrap();
        let ids: Vec<&str> = d.nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, ["r", "t", "g", "e"]);
        assert_eq!(d.nodes[0].layout, FlexLayout::Horizontal, "frames default to horizontal");
        assert_eq!(d.nodes[0].padding, [4.0, 8.0, 4.0, 8.0]);
        assert_eq!(d.nodes[0].corner, Some([1.0, 2.0, 3.0, 4.0]));
        assert_eq!(d.nodes[2].layout, FlexLayout::None, "groups never lay out");
        let t = d.nodes[1].text.as_ref().unwrap();
        assert!(t.spans.is_empty(), "no spans: as before");
        assert_eq!((t.family.as_str(), t.size, t.weight, t.growth), ("Inter", 16.0, 400.0, Growth::Auto));
        assert_eq!(d.nodes[3].parent, Some(2));
    }

    #[test]
    fn canvas_layout_and_include_stroke() {
        let d = Doc::from_value(&json!({
            "type": "frame", "id": "r", "layoutIncludeStroke": true,
            "canvasLayout": { "wrap": true, "crossGap": -4, "crossAuto": true, "gapMode": "evenly", "baseline": true, "stacking": "first", "minWidth": 120, "maxWidth": 0, "maxHeight": 40 },
            "children": [
                { "type": "rectangle", "id": "a" },
                { "type": "rectangle", "id": "abs", "layoutPosition": "absolute" },
                { "type": "frame", "id": "b", "children": [{ "type": "rectangle", "id": "b1" }, { "type": "rectangle", "id": "b2" }] }
            ]
        }))
        .unwrap();
        let r = &d.nodes[0];
        assert!(r.layout_include_stroke);
        assert_eq!(
            r.cl,
            CanvasLayout { wrap: true, cross_gap: 0.0, cross_auto: true, gap_mode: Some(GapMode::Evenly), baseline: true, first_on_top: true, min_w: Some(120.0), max_w: None, min_h: None, max_h: Some(40.0) }
        );
        assert_eq!(d.nodes[1].cl, CanvasLayout::default());
        let ids = |v: Vec<usize>| v.into_iter().map(|i| d.nodes[i].id.as_str()).collect::<Vec<_>>();
        assert_eq!(ids(d.paint_children(0)), ["b", "a", "abs"], "flow reversed, absolute stays on top");
        assert_eq!(ids(d.paint_children(3)), ["b1", "b2"], "not inherited by nested frames");
        let rank = d.paint_rank();
        assert_eq!(rank, [0, 4, 5, 1, 2, 3]);
    }

    #[test]
    fn paints_in_order_and_gradient_opacity() {
        let mut w = vec![];
        let p = paints(
            Some(&json!(["#FF0000", { "type": "color", "color": "#00FF00", "enabled": false }, { "type": "gradient", "opacity": 0.5, "colors": [{ "color": "#000000", "position": 0.6 }, { "color": "#FFFFFF", "position": 0.2 }] }])),
            &mut w,
            "n",
        );
        assert_eq!(p.len(), 2);
        let Paint::Gradient(g) = &p[1] else { panic!() };
        assert_eq!(g.stops[0].1, Color::from_rgba8(0, 0, 0, 255).multiply_alpha(0.5));
        assert_eq!(g.stops[1].0, 0.6, "a stop never sits before the previous one");
    }

    #[test]
    fn spans_count_utf16_and_land_on_bytes() {
        // "é" is one UTF-16 unit and two bytes; "😀" two units and four bytes.
        let content = "é😀ab";
        let s = text_spans(Some(&json!([
            { "start": 1, "end": 3, "fontWeight": "700", "fill": "#ff0000" },
            { "start": 3, "end": 5, "fontSize": 20, "underline": true, "fontStyle": "italic" },
            { "start": 4, "end": 4, "fontWeight": "700" },
            { "start": 0, "end": 2, "fontWeight": "700" }
        ])), content);
        assert_eq!(s.len(), 2, "empty and overlapping spans are dropped: {s:?}");
        assert_eq!((s[0].start, s[0].end, s[0].weight), (2, 6, Some(700.0)));
        assert_eq!(s[0].color, parse_color("#ff0000"));
        assert_eq!((s[1].start, s[1].end, s[1].size, s[1].underline, s[1].italic), (6, 8, Some(20.0), Some(true), Some(true)));
        assert!(text_spans(Some(&json!("x")), content).is_empty());
    }

    #[test]
    fn letter_case_draws_the_letters_in_their_case_and_moves_ranges_with_them() {
        let props = |o: serde_json::Value, kind: Kind| text_props(o.as_object().unwrap(), kind);
        // Upper case: "ß" is "SS" (one byte more), so a range on the "e" after it moves a byte.
        let t = props(json!({ "content": "straße", "letterCase": "upper", "spans": [{ "start": 5, "end": 6, "fill": "#ff0000" }] }), Kind::Text);
        assert_eq!(t.content, "STRASSE");
        assert_eq!((t.spans[0].start, t.spans[0].end), (6, 7), "the range still on the E");
        assert!(!t.small_caps);
        assert_eq!(props(json!({ "content": "Hello World", "letterCase": "lower" }), Kind::Text).content, "hello world");
        assert_eq!(props(json!({ "content": "ΟΔΟΣ ΣΑΣ", "letterCase": "lower" }), Kind::Text).content, "οδος σας", "a sigma ending a word is final");
        // Title case (CSS capitalize): the first letter of each word; the rest as typed.
        assert_eq!(props(json!({ "content": "don't stop e.g. hello-world 3rd 'tis McDONALD ßa ǆungla", "letterCase": "title" }), Kind::Text).content, "Don't Stop E.G. Hello-World 3rd 'Tis McDONALD SSa Ǆungla", "upper case on each word's first letter, as the page draws it");
        let s = props(json!({ "content": "Small", "letterCase": "small-caps" }), Kind::Text);
        assert_eq!((s.content.as_str(), s.small_caps), ("Small", true), "small caps are the font's: the letters stay");
        assert_eq!(props(json!({ "content": "as typed", "letterCase": "nonsense" }), Kind::Text).content, "as typed");
        assert_eq!(props(json!({ "content": "note", "letterCase": "upper" }), Kind::Note).content, "note", "text layers only");
        // Hanging quotes, hanging lists and list spacing come with the paragraph settings.
        let h = props(json!({ "content": "\"Hi\"", "hangingPunctuation": true }), Kind::Text).paras.unwrap();
        assert!(h.hanging_quotes && !h.hanging_list);
        let l = props(json!({ "content": "a\nb", "lists": [{ "p": 0, "type": "none", "level": 2 }, { "p": 1, "type": "bullet" }], "listSpacing": 6, "hangingList": true }), Kind::Text).paras.unwrap();
        assert_eq!((l.lists[0].kind, l.lists[0].level, l.list_spacing, l.hanging_list), (ListKind::None, 2, 6.0, true));
    }
}
