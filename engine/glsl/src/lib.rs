//! GLSL fragment code to WGSL through naga (glsl-in, validate, wgsl-out). A build tool: the Paper Shaders
//! library (scripts/paper/gen.ts) is translated once and only the WGSL ships.
//!
//! The input is one GLSL 4.50 fragment translation unit. Its entry point is dropped: what is wanted is the
//! module's functions and private globals, which the generated glue calls from `fn shade(p)` (see
//! engine/src/shaders.rs for that contract). Module-scope names the shader card wrapper owns (`u`, `shade`)
//! are renamed so they cannot collide.

use naga::front::glsl::{Frontend, Options};
use naga::valid::{Capabilities, ValidationFlags, Validator};

/// One problem, 1-based line and column in the GLSL source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub line: u32,
    pub col: u32,
    pub message: String,
}

/// Names the wrapper appended to every shader card defines at module scope.
const RESERVED: &[&str] = &["u", "shade", "CanvasUniforms", "canvas_vs", "canvas_fs", "canvas_noise", "canvas_noise_tex", "canvas_noise_smp"];

fn at(span: naga::Span, src: &str, message: String) -> Problem {
    if span.is_defined() {
        let loc = span.location(src);
        Problem { line: loc.line_number, col: loc.line_position, message }
    } else {
        Problem { line: 0, col: 0, message }
    }
}

/// The error and every cause under it, one line.
fn chain(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut cur = e.source();
    while let Some(c) = cur {
        s.push_str(": ");
        s.push_str(&c.to_string());
        cur = c.source();
    }
    s
}

/// Translate a GLSL fragment translation unit to WGSL without entry points.
pub fn translate(src: &str) -> Result<String, Vec<Problem>> {
    let mut fe = Frontend::default();
    let mut module = fe
        .parse(&Options::from(naga::ShaderStage::Fragment), src)
        .map_err(|errs| errs.errors.into_iter().map(|e| at(e.meta, src, e.kind.to_string())).collect::<Vec<_>>())?;
    module.entry_points.clear();
    for (_, g) in module.global_variables.iter_mut() {
        if let Some(n) = &g.name {
            if RESERVED.contains(&n.as_str()) {
                g.name = Some(format!("glsl_{n}"));
            }
        }
    }
    for (_, f) in module.functions.iter_mut() {
        if let Some(n) = &f.name {
            if RESERVED.contains(&n.as_str()) {
                f.name = Some(format!("glsl_{n}"));
            }
        }
    }
    let info = Validator::new(ValidationFlags::all(), Capabilities::empty()).validate(&module).map_err(|e| {
        let span = e.spans().next().map(|(s, _)| *s).unwrap_or_default();
        vec![at(span, src, chain(e.as_inner()))]
    })?;
    naga::back::wgsl::write_string(&module, &info, naga::back::wgsl::WriterFlags::empty()).map_err(|e| vec![Problem { line: 0, col: 0, message: format!("wgsl-out: {e}") }])
}

/// JSON string literal.
pub fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// The result as JSON: {"wgsl": "..."} or {"errors": [{"line", "col", "message"}]}.
pub fn to_json(r: &Result<String, Vec<Problem>>) -> String {
    match r {
        Ok(w) => format!("{{\"wgsl\":{}}}", json_str(w)),
        Err(errs) => {
            let items: Vec<String> = errs.iter().map(|e| format!("{{\"line\":{},\"col\":{},\"message\":{}}}", e.line, e.col, json_str(&e.message))).collect();
            format!("{{\"errors\":[{}]}}", items.join(","))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OK: &str = "#version 450\nfloat u_time;\nvec4 fragColor;\nvec2 rot(vec2 p, float a) { return mat2(cos(a), sin(a), -sin(a), cos(a)) * p; }\nvoid paperMain() {\n  vec2 q = rot(vec2(1.0, 0.0), u_time);\n  for (int i = 0; i < 4; i++) { q *= 1.1; if (q.x > 3.0) break; }\n  fragColor = vec4(q, 0.0, 1.0);\n}\nvoid main() {}\n";

    #[test]
    fn translates_without_entry_points() {
        let w = translate(OK).expect("translates");
        assert!(w.contains("fn paperMain()"), "{w}");
        assert!(w.contains("var<private> u_time: f32;"), "{w}");
        assert!(!w.contains("@fragment"), "{w}");
        assert!(!w.contains("@group"), "{w}");
    }

    #[test]
    fn renames_reserved_names() {
        let w = translate("#version 450\nfloat u;\nfloat shade(float x) { return x * u; }\nvoid main() {}\n").expect("translates");
        assert!(w.contains("glsl_u"), "{w}");
        assert!(w.contains("fn glsl_shade("), "{w}");
        assert!(!w.contains("fn shade("), "{w}");
    }

    #[test]
    fn errors_point_at_glsl_lines() {
        let e = translate("#version 450\nvoid main() {\n  float x = 1.0;\n  x = nope(x);\n}\n").unwrap_err();
        assert_eq!(e[0].line, 4, "{e:?}");
        assert!(e[0].col >= 3, "{e:?}");
    }

    #[test]
    fn json_escapes() {
        assert_eq!(json_str("a\"b\\c\nd"), "\"a\\\"b\\\\c\\nd\"");
        let j = to_json(&Err(vec![Problem { line: 2, col: 3, message: "x".into() }]));
        assert_eq!(j, "{\"errors\":[{\"line\":2,\"col\":3,\"message\":\"x\"}]}");
    }
}
