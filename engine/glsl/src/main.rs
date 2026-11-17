//! canvas-glsl: GLSL fragment code on stdin, JSON on stdout ({"wgsl"} or {"errors"}). Exit 1 on errors.

use std::io::Read;

fn main() {
    let mut src = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut src) {
        eprintln!("canvas-glsl: reading stdin: {e}");
        std::process::exit(2);
    }
    let r = canvas_glsl::translate(&src);
    println!("{}", canvas_glsl::to_json(&r));
    if r.is_err() {
        std::process::exit(1);
    }
}
