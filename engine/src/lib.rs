//! Canvas engine: draws resolved document boards with vello on WebGPU, from WASM.
//!
//! Modules: `scene` (input model), `layout` (taffy, CSS-faithful), `text` (parley), `paint`
//! (vello encoding), `hit` (BVH hit testing), `cache` (tile pyramid + LRU logic), `board` (one
//! board's state), `images` (mip levels and their memory budget), `shaders` (shader card policy), and on wasm32 `gpu`
//! (renderer + compositor), `shade` (shader cards on the GPU) and `api` (the JS `Engine`).

// `Engine::stats` is one serde_json::json! object with more keys than the macro's default recursion allows.
#![recursion_limit = "256"]

pub mod board;
pub mod cache;
pub mod cull;
pub mod geom;
pub mod hit;
pub mod images;
pub mod layout;
pub mod paint;
pub mod scene;
pub mod shaders;
pub mod text;

#[cfg(target_arch = "wasm32")]
mod api;
#[cfg(target_arch = "wasm32")]
mod gpu;
#[cfg(target_arch = "wasm32")]
mod shade;
