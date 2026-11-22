//! GPU side (wasm32 only): the WebGPU surface, vello's renderer, tile textures and the compositor
//! that draws them as textured quads with the camera applied.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use kurbo::{Affine, Rect};
use peniko::{Color, ImageAlphaType, ImageData};
use wasm_bindgen::{JsCast, JsValue};
use wgpu::util::DeviceExt;
use vello::util::RenderContext;
use vello::{AaConfig, AaSupport, RenderParams, Renderer, RendererOptions, Scene, wgpu};

use crate::board::Board;
use crate::cache::{ATLAS_SIDE, CellAlloc, DEFAULT_BUDGET, GUTTER, TileCache, TileRect, atlas_needs_flush, cell_class, lru_over_budget};
use crate::cull::{Target, plan_costed};
use crate::paint::{EffectJob, JobKind, JobScene, gpu_image, smooth_glyphs};

/// A tile's pixels: a texture of its own, or a cell of the small-tile atlas.
pub struct GpuTile {
    own: Option<(wgpu::Texture, wgpu::BindGroup)>,
    cell: Option<AtlasCell>,
}

impl GpuTile {
    fn own(tex: wgpu::Texture, bind: wgpu::BindGroup) -> GpuTile {
        GpuTile { own: Some((tex, bind)), cell: None }
    }
    /// The texture of a tile that has one of its own (one can be brought up to date in place: `Gpu::render_into`).
    /// None for a tile in the atlas: it is rendered whole again (it is small).
    pub fn texture(&self) -> Option<&wgpu::Texture> {
        self.own.as_ref().map(|o| &o.0)
    }
}

// wgpu's WebGPU backend does not destroy a texture when it is dropped: the GPU memory went only when the JS
// garbage collector finalized the handle, which a page with a 4 MB heap rarely runs (stress: 120 page switches
// grew the GPU process by 415 MB). Everything the engine owns alone is destroyed when it goes; the GPU frees
// it after the work already submitted with it.
impl Drop for GpuTile {
    fn drop(&mut self) {
        if let Some((t, _)) = &self.own {
            t.destroy();
        }
    }
}

/// The small-tile atlas: an array texture of `ATLAS_SIDE` square layers, cells handed out by `CellAlloc`. Grows a
/// layer at a time up to `ATLAS_MAX_LAYERS` (copying what it holds into the bigger texture); a tile that finds no
/// cell gets a texture of its own as before.
pub struct AtlasPool {
    alloc: CellAlloc,
    tex: Option<wgpu::Texture>,
    bind: Option<wgpu::BindGroup>,
}

/// Layers the atlas grows to at most (16 MB each).
const ATLAS_MAX_LAYERS: u32 = 16;

impl Drop for AtlasPool {
    fn drop(&mut self) {
        if let Some(t) = &self.tex {
            t.destroy();
        }
    }
}

/// One tile's cell in the atlas: given back when the tile goes. `size`: the tile texture's px (gutter included).
pub struct AtlasCell {
    pool: Rc<RefCell<AtlasPool>>,
    layer: u32,
    at: (u32, u32),
    size: (u32, u32),
}

impl Drop for AtlasCell {
    fn drop(&mut self) {
        if let Ok(mut p) = self.pool.try_borrow_mut() {
            p.alloc.free(self.layer, self.at.0, self.at.1);
        }
    }
}

impl AtlasPool {
    /// A cell for a w x h texture, growing the texture when every layer is taken. None: too big, or the atlas is
    /// at its largest and full.
    fn cell(pool: &Rc<RefCell<AtlasPool>>, device: &wgpu::Device, queue: &wgpu::Queue, layout: &wgpu::BindGroupLayout, w: u32, h: u32) -> Option<AtlasCell> {
        let class = cell_class(w, h)?;
        let mut p = pool.borrow_mut();
        let got = match p.alloc.alloc(class) {
            Some(c) => Some(c),
            None => {
                let have = p.alloc.layers();
                if have >= ATLAS_MAX_LAYERS {
                    return None;
                }
                let to = (have + 2).min(ATLAS_MAX_LAYERS);
                let tex = device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("tile atlas"),
                    size: wgpu::Extent3d { width: ATLAS_SIDE, height: ATLAS_SIDE, depth_or_array_layers: to },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC,
                    view_formats: &[],
                });
                if let Some(old) = p.tex.take() {
                    let mut enc = device.create_command_encoder(&Default::default());
                    enc.copy_texture_to_texture(
                        wgpu::TexelCopyTextureInfo { texture: &old, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                        wgpu::TexelCopyTextureInfo { texture: &tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                        wgpu::Extent3d { width: ATLAS_SIDE, height: ATLAS_SIDE, depth_or_array_layers: have },
                    );
                    queue.submit([enc.finish()]);
                    old.destroy(); // after the copy already submitted
                }
                let view = tex.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() });
                p.bind = Some(device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("tile atlas"), layout, entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) }] }));
                p.tex = Some(tex);
                p.alloc.grow(to);
                p.alloc.alloc(class)
            }
        };
        let (layer, x, y) = got?;
        Some(AtlasCell { pool: pool.clone(), layer, at: (x, y), size: (w, h) })
    }
}

/// One textured quad: device-px rect, uv rect, premultiplied tint, optional scissor. `extra` is only
/// read for premultiplied sources: `[width px, height px, corner radius px, 0]` (rounded corners).
#[derive(Clone, Copy)]
pub struct Quad {
    pub rect: [f32; 4],
    pub uv: [f32; 4],
    pub tint: [f32; 4],
    pub scissor: Option<[u32; 4]>,
    pub extra: [f32; 4],
}

/// A render of part of a board's scene into one texture, in as many vello renders as its content needs
/// (cull.rs). Dropped unfinished, it frees its texture.
pub struct BoardJob {
    tex: Option<wgpu::Texture>,
    parts: Vec<[u32; 4]>,
    /// Per part: its scene cost in megapixel equivalents.
    lines: Vec<f64>,
    next: usize,
    t: Target,
    upto: usize,
    /// Put text baselines on whole pixels of this render (tiles; not effect content, see `smooth_glyphs`).
    snap: bool,
    /// Some part was rendered while an image was below the level the scale needs: the tile is drawn again.
    pub short: bool,
}

impl BoardJob {
    /// What the next part costs to render: its pixels and its part of the scene, in megapixels.
    pub fn next_mpx(&self) -> f64 {
        self.parts.get(self.next).map_or(0.0, |p| f64::from(p[2]) * f64::from(p[3]) / 1e6 + self.lines.get(self.next).copied().unwrap_or(0.0))
    }
}

impl Drop for BoardJob {
    fn drop(&mut self) {
        if let Some(t) = self.tex.take() {
            t.destroy();
        }
    }
}

fn part_texture(device: &wgpu::Device, w: u32, h: u32, usage: wgpu::TextureUsages) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("tile"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage,
        view_formats: &[],
    })
}

pub enum Source {
    Tile(crate::cache::TileKey),
    White,
    /// A texture that already holds premultiplied colour (shader cards): drawn without premultiplying
    /// again, corners rounded by `Quad::extra`.
    Premul(wgpu::BindGroup),
}

pub struct Gpu {
    pub ctx: RenderContext,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    dev_id: usize,
    configured: bool,
    /// Create Vello's pipelines in a task after `Engine.create` resolves so scene fetches can overlap compilation.
    /// An operation that needs the renderer sooner builds it directly.
    renderer: Option<Renderer>,
    warm: Rc<RefCell<Warm>>,
    pub init_ms: Rc<Cell<f64>>,
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    /// Small tiles (an overview's boards, base textures): cells of one array texture, drawn by `pipeline_atlas`.
    atlas: Rc<RefCell<AtlasPool>>,
    atlas_layout: wgpu::BindGroupLayout,
    pipeline_atlas: wgpu::RenderPipeline,
    inst: wgpu::Buffer,
    inst_cap: u64,
    white: GpuTile,
    scratch: Scene,
    /// The part of a board's scene one render draws (cull.rs), built again for each.
    cull: Scene,
    /// Debug: render every tile from the board's whole scene, as before culling (to compare against).
    pub no_cull: bool,
    pub tiles: TileCache<GpuTile>,
    pub bg: Color,
    pub adapter: String,
    blur: Option<(wgpu::RenderPipeline, wgpu::BindGroupLayout)>,
    /// Blurred effect-job textures by the id of the placeholder image the board's scene draws.
    /// (placeholder, texture, bytes, last frame a tile render needed it)
    jobs: HashMap<u64, (ImageData, wgpu::Texture, u64, u64)>,
    pub job_bytes: u64,
    /// Job placeholders with no texture of their own (not rendered yet, or evicted) show this transparent
    /// texture: vello needs every image a scene draws to have pixels, even off the tile.
    blank: Option<(wgpu::Texture, u32)>,
    blanked: HashMap<u64, ImageData>,
    /// Shader fill placeholders by image id: the placeholder and which texture it copies from (the fill's own
    /// texture's token, 0: the shared transparent one until its shader drew a frame).
    fills: HashMap<u64, (ImageData, u64)>,
    /// Image atlas pixels the last two tile renders used: vello keeps them resident (not evictable)
    /// for two more renders, and an image that does not fit is not drawn.
    atlas_recent: (u64, u64),
    flush_tex: Option<wgpu::Texture>,
    /// A 1x1 transparent image every render draws off its target (`pin_atlas`). vello 0.11 resolves a scene
    /// with no gradient, glyph or image as "solid paths only" and reports an atlas of size 0, and on that it
    /// frees its atlas texture; the next scene with images allocates a new one (2048 or 4096 px square) and
    /// uploads every image again. Alternating renders did that on every tile: 1 to 3 GB of textures a minute
    /// while switching pages, which the GPU process gave back only lazily (its sawtooth).
    atlas_pin: ImageData,
}

/// Keep vello's image atlas from being freed by this render (see `Gpu::atlas_pin`): a patch the resolver must
/// resolve, drawn transparent and outside the target.
fn pin_atlas(sc: &mut Scene, pin: &ImageData) {
    sc.draw_image(&peniko::ImageBrush::new(pin.clone()), Affine::translate((-8.0, -8.0)));
}

const BLUR_SHADER: &str = r#"
struct P { dir: vec2<f32>, sigma: f32, premul: f32, tint: vec4<f32>, mode: vec4<f32> };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> p: P;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var c = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  return vec4<f32>(c[vi], 0.0, 1.0);
}
fn tap(q: vec2<i32>, hi: vec2<i32>) -> vec4<f32> {
  if (any(q < vec2<i32>(0, 0)) || any(q > hi)) { return vec4<f32>(0.0); }
  let c = textureLoad(src, q, 0);
  if (p.premul > 0.5) { return vec4<f32>(c.rgb * c.a, c.a); }
  return c;
}
// One direction of a separable Gaussian; texels outside are transparent. The output is
// premultiplied; with mode.x set it is the tint times the blurred alpha (shadows).
@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let hi = vec2<i32>(textureDimensions(src)) - vec2<i32>(1, 1);
  let q = vec2<i32>(floor(pos.xy));
  let r = min(i32(ceil(p.sigma * 3.0)), 48);
  let d = vec2<i32>(p.dir);
  var acc = vec4<f32>(0.0);
  var wsum = 0.0;
  for (var k = -r; k <= r; k = k + 1) {
    let w = exp(-f32(k * k) / (2.0 * p.sigma * p.sigma));
    acc = acc + w * tap(q + d * k, hi);
    wsum = wsum + w;
  }
  acc = acc / wsum;
  if (p.mode.x > 0.5) { return p.tint * acc.a; }
  return acc;
}
"#;

pub enum Warm {
    Pending,
    Done(Box<Renderer>),
    Taken,
    Failed(String),
}

fn renderer_options() -> RendererOptions {
    RendererOptions { antialiasing_support: AaSupport::area_only(), ..Default::default() }
}

/// Resolve after the current task (a macrotask: the caller's promise continuations run first).
async fn yield_task() {
    let p = js_sys::Promise::new(&mut |res, _| {
        if let Some(w) = web_sys::window() {
            let _ = w.set_timeout_with_callback(&res);
        } else {
            let _ = res.call0(&JsValue::NULL);
        }
    });
    let _ = wasm_bindgen_futures::JsFuture::from(p).await;
}

/// Build the pipelines without submitting a warm-up render before the first board.
fn build_renderer(device: &wgpu::Device) -> Result<Renderer, String> {
    Renderer::new(device, renderer_options()).map_err(|e| format!("vello: {e}"))
}

thread_local! {
    pub static GPU_DONE_MS: Cell<f64> = const { Cell::new(0.0) };
    /// GPU cost model from `onSubmittedWorkDone`: fixed ms per frame, ms per megapixel of tiles.
    pub static GPU_BASE_MS: Cell<f64> = const { Cell::new(1.0) };
    pub static GPU_MS_PER_MPX: Cell<f64> = const { Cell::new(2.0) };
}

const SHADER: &str = r#"
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) tint: vec4<f32>, @location(2) extra: vec4<f32>, @location(3) local: vec2<f32> };
@group(0) @binding(0) var t: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) rect: vec4<f32>, @location(1) uv: vec4<f32>, @location(2) tint: vec4<f32>, @location(3) extra: vec4<f32>) -> VOut {
  var c = array<vec2<f32>, 6>(vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0));
  let p = c[vi];
  var o: VOut;
  o.pos = vec4<f32>(mix(rect.xy, rect.zw, p), 0.0, 1.0);
  o.uv = mix(uv.xy, uv.zw, p);
  o.tint = tint;
  o.extra = extra;
  o.local = p * extra.xy;
  return o;
}
// vello writes straight alpha. Filtering straight alpha drags the colour of transparent texels
// (black) into edges, so each texel is premultiplied before it is blended, by hand.
fn load(q: vec2<i32>, hi: vec2<i32>, pm: bool) -> vec4<f32> {
  let c = textureLoad(t, clamp(q, vec2<i32>(0, 0), hi), 0);
  if (pm) { return c; }
  return vec4<f32>(c.rgb * c.a, c.a);
}
fn bilinear(uv: vec2<f32>, pm: bool) -> vec4<f32> {
  let dim = vec2<i32>(textureDimensions(t));
  let hi = dim - vec2<i32>(1, 1);
  let p = uv * vec2<f32>(dim) - vec2<f32>(0.5, 0.5);
  let f = fract(p);
  let b = vec2<i32>(floor(p));
  let t00 = load(b, hi, pm);
  let t10 = load(b + vec2<i32>(1, 0), hi, pm);
  let t01 = load(b + vec2<i32>(0, 1), hi, pm);
  let t11 = load(b + vec2<i32>(1, 1), hi, pm);
  return mix(mix(t00, t10, f.x), mix(t01, t11, f.x), f.y);
}
// A texture drawn smaller than 1:1 (a finer stand-in, or the power-of-two texture mid-zoom): the
// exact area average of the texels under the pixel's footprint (`fp` texels wide), so fine text and
// one-pixel lines neither shimmer as the camera moves nor drop out. Up to 10 x 10 texels.
fn sample_fp(uv: vec2<f32>, fp: vec2<f32>, pm: bool) -> vec4<f32> {
  if (max(fp.x, fp.y) <= 1.001) { return bilinear(uv, pm); }
  let dim = vec2<f32>(textureDimensions(t));
  let hi = vec2<i32>(textureDimensions(t)) - vec2<i32>(1, 1);
  let f = max(fp, vec2<f32>(1.0, 1.0));
  let c = uv * dim;
  if (max(f.x, f.y) > 9.0) {
    // Wider than the exact loop: 10 x 10 bilinear taps spread over the whole footprint.
    var acc2 = vec4<f32>(0.0);
    let taps = i32(clamp(ceil(max(f.x, f.y)), 1.0, 10.0));
    for (var y = 0; y < taps; y++) {
      for (var x = 0; x < taps; x++) {
        let q = c + (vec2<f32>(f32(x), f32(y)) + vec2<f32>(0.5, 0.5) - vec2<f32>(5.0, 5.0)) * f / 10.0;
        acc2 += bilinear(q / dim, pm);
      }
    }
    return acc2 / 100.0;
  }
  let lo = c - f * 0.5;
  let up = c + f * 0.5;
  let i0 = vec2<i32>(floor(lo));
  let n = min(vec2<i32>(ceil(up)) - i0, vec2<i32>(10, 10));
  var acc = vec4<f32>(0.0);
  var wsum = 0.0;
  for (var y = 0; y < n.y; y++) {
    let ty = f32(i0.y + y);
    let wy = min(up.y, ty + 1.0) - max(lo.y, ty);
    for (var x = 0; x < n.x; x++) {
      let tx = f32(i0.x + x);
      let w = (min(up.x, tx + 1.0) - max(lo.x, tx)) * wy;
      acc += load(vec2<i32>(i0.x + x, i0.y + y), hi, pm) * w;
      wsum += w;
    }
  }
  return acc / max(wsum, 1e-6);
}
// Texels per device pixel along each axis (quads are axis-aligned).
fn footprint(uv: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(abs(dpdx(uv.x)), abs(dpdy(uv.y))) * vec2<f32>(textureDimensions(t));
}
@fragment fn fs(i: VOut) -> @location(0) vec4<f32> {
  let fp = footprint(i.uv);
  let pm = i.extra.w > 0.0;
  var cover = 1.0;
  if (pm) {
    let half = i.extra.xy * 0.5;
    let r = min(i.extra.z, min(half.x, half.y));
    let q = abs(i.local - half) - (half - vec2<f32>(r));
    let d = length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
    cover = clamp(0.5 - d, 0.0, 1.0);
  }
  return sample_fp(i.uv, fp, pm) * i.tint * cover;
}
"#;

/// `SHADER`'s `fs` for tiles in the atlas: the tile is the `cell` of layer `extra.x` (texel x, y, w, h), sampled
/// and clamped exactly as a texture of its own of that size is, and `clip` (device px x0, y0, x1, y1) stands in
/// for the scissor rect (a run of quads with different clips is one draw).
const ATLAS_SHADER: &str = r#"
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) tint: vec4<f32>, @location(2) @interpolate(flat) cell: vec4<f32>, @location(3) @interpolate(flat) clip: vec4<f32>, @location(4) @interpolate(flat) layer: i32 };
@group(0) @binding(0) var t: texture_2d_array<f32>;
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) rect: vec4<f32>, @location(1) uv: vec4<f32>, @location(2) tint: vec4<f32>, @location(3) extra: vec4<f32>, @location(4) cell: vec4<f32>, @location(5) clip: vec4<f32>) -> VOut {
  var c = array<vec2<f32>, 6>(vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0));
  let p = c[vi];
  var o: VOut;
  o.pos = vec4<f32>(mix(rect.xy, rect.zw, p), 0.0, 1.0);
  o.uv = mix(uv.xy, uv.zw, p);
  o.tint = tint;
  o.cell = cell;
  o.clip = clip;
  o.layer = i32(extra.x);
  return o;
}
fn load(q: vec2<i32>, hi: vec2<i32>, off: vec2<i32>, layer: i32) -> vec4<f32> {
  let c = textureLoad(t, clamp(q, vec2<i32>(0, 0), hi) + off, layer, 0);
  return vec4<f32>(c.rgb * c.a, c.a);
}
fn bilinear(uv: vec2<f32>, cell: vec4<f32>, layer: i32) -> vec4<f32> {
  let dim = vec2<i32>(cell.zw);
  let off = vec2<i32>(cell.xy);
  let hi = dim - vec2<i32>(1, 1);
  let p = uv * vec2<f32>(dim) - vec2<f32>(0.5, 0.5);
  let f = fract(p);
  let b = vec2<i32>(floor(p));
  let t00 = load(b, hi, off, layer);
  let t10 = load(b + vec2<i32>(1, 0), hi, off, layer);
  let t01 = load(b + vec2<i32>(0, 1), hi, off, layer);
  let t11 = load(b + vec2<i32>(1, 1), hi, off, layer);
  return mix(mix(t00, t10, f.x), mix(t01, t11, f.x), f.y);
}
fn sample_fp(uv: vec2<f32>, fp: vec2<f32>, cell: vec4<f32>, layer: i32) -> vec4<f32> {
  if (max(fp.x, fp.y) <= 1.001) { return bilinear(uv, cell, layer); }
  let dim = cell.zw;
  let off = vec2<i32>(cell.xy);
  let hi = vec2<i32>(cell.zw) - vec2<i32>(1, 1);
  let f = max(fp, vec2<f32>(1.0, 1.0));
  let c = uv * dim;
  if (max(f.x, f.y) > 9.0) {
    var acc2 = vec4<f32>(0.0);
    let taps = i32(clamp(ceil(max(f.x, f.y)), 1.0, 10.0));
    for (var y = 0; y < taps; y++) {
      for (var x = 0; x < taps; x++) {
        let q = c + (vec2<f32>(f32(x), f32(y)) + vec2<f32>(0.5, 0.5) - vec2<f32>(5.0, 5.0)) * f / 10.0;
        acc2 += bilinear(q / dim, cell, layer);
      }
    }
    return acc2 / 100.0;
  }
  let lo = c - f * 0.5;
  let up = c + f * 0.5;
  let i0 = vec2<i32>(floor(lo));
  let n = min(vec2<i32>(ceil(up)) - i0, vec2<i32>(10, 10));
  var acc = vec4<f32>(0.0);
  var wsum = 0.0;
  for (var y = 0; y < n.y; y++) {
    let ty = f32(i0.y + y);
    let wy = min(up.y, ty + 1.0) - max(lo.y, ty);
    for (var x = 0; x < n.x; x++) {
      let tx = f32(i0.x + x);
      let w = (min(up.x, tx + 1.0) - max(lo.x, tx)) * wy;
      acc += load(vec2<i32>(i0.x + x, i0.y + y), hi, off, layer) * w;
      wsum += w;
    }
  }
  return acc / max(wsum, 1e-6);
}
@fragment fn fs(i: VOut) -> @location(0) vec4<f32> {
  let fp = vec2<f32>(abs(dpdx(i.uv.x)), abs(dpdy(i.uv.y))) * i.cell.zw;
  let inside = i.pos.x >= i.clip.x && i.pos.y >= i.clip.y && i.pos.x < i.clip.z && i.pos.y < i.clip.w;
  let c = sample_fp(i.uv, fp, i.cell, i.layer) * i.tint;
  return select(vec4<f32>(0.0), c, inside);
}
"#;

/// Per quad: rect, uv, tint, extra (pipelines `fs` and `fs_pm` read these four), cell and clip (the atlas's).
const FLOATS: usize = 24;

impl Gpu {
    pub async fn new(canvas: web_sys::HtmlCanvasElement) -> Result<Gpu, String> {
        let (w, h) = (canvas.width().max(1), canvas.height().max(1));
        let mut ctx = RenderContext::new();
        let surface = ctx.instance.create_surface(wgpu::SurfaceTarget::Canvas(canvas))
            .map_err(|e| format!("WebGPU surface: {e}"))?;
        let dev_id = ctx.device(Some(&surface)).await.ok_or("No compatible WebGPU device")?;
        let dev = &ctx.devices[dev_id];
        let format = surface.get_capabilities(dev.adapter()).formats.into_iter()
            .find(|f| matches!(f, wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::Bgra8Unorm))
            .ok_or("Unsupported WebGPU surface format")?;
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: w,
            height: h,
            present_mode: wgpu::PresentMode::AutoVsync,
            color_space: wgpu::SurfaceColorSpace::Auto,
            desired_maximum_frame_latency: 2,
            alpha_mode: wgpu::CompositeAlphaMode::Auto,
            view_formats: vec![],
        };
        let info = dev.adapter().get_info();
        let device = &dev.device;
        let warm = Rc::new(RefCell::new(Warm::Pending));
        let init_ms = Rc::new(Cell::new(0.0));
        {
            let (warm, init_ms, device) = (warm.clone(), init_ms.clone(), device.clone());
            wasm_bindgen_futures::spawn_local(async move {
                yield_task().await;
                if !matches!(*warm.borrow(), Warm::Pending) {
                    return;
                }
                let t0 = crate::api::now();
                let r = build_renderer(&device);
                init_ms.set(crate::api::now() - t0);
                *warm.borrow_mut() = match r {
                    Ok(r) => Warm::Done(Box::new(r)),
                    Err(e) => Warm::Failed(e),
                };
            });
        }
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("composite"), source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("tile"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: false }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
                    count: None,
                },
            ],
        });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let blend = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add };
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("composite"),
            layout: Some(&pl),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: (FLOATS * 4) as u64,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32x4, 2 => Float32x4, 3 => Float32x4],
                })],
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState { color: blend, alpha: blend }), write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        let amodule = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("composite atlas"), source: wgpu::ShaderSource::Wgsl(ATLAS_SHADER.into()) });
        let atlas_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("tile atlas"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: false }, view_dimension: wgpu::TextureViewDimension::D2Array, multisampled: false },
                count: None,
            }],
        });
        let apl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&atlas_layout)], immediate_size: 0 });
        let pipeline_atlas = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("composite atlas"),
            layout: Some(&apl),
            vertex: wgpu::VertexState {
                module: &amodule,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: (FLOATS * 4) as u64,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32x4, 2 => Float32x4, 3 => Float32x4, 4 => Float32x4, 5 => Float32x4],
                })],
            },
            fragment: Some(wgpu::FragmentState {
                module: &amodule,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState { color: blend, alpha: blend }), write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        let inst_cap = 4096 * (FLOATS * 4) as u64;
        let inst = device.create_buffer(&wgpu::BufferDescriptor { label: Some("quads"), size: inst_cap, usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        // 1x1 white texel: placeholders and debug lines are tinted quads of it.
        let wt = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("white"),
            size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        dev.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &wt, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            &[255, 255, 255, 255],
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4), rows_per_image: Some(1) },
            wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        );
        let white_bind = bind(device, &layout, &wt);
        Ok(Gpu {
            blur: None,
            jobs: HashMap::new(),
            job_bytes: 0,
            blank: None,
            blanked: HashMap::new(),
            fills: HashMap::new(),
            atlas_recent: (0, 0),
            flush_tex: None,
            atlas_pin: ImageData { data: peniko::Blob::new(std::sync::Arc::new(vec![0u8; 4])), format: peniko::ImageFormat::Rgba8, alpha_type: ImageAlphaType::Alpha, width: 1, height: 1 },
            adapter: format!("{} ({:?})", info.name, info.backend),
            ctx,
            surface,
            config,
            dev_id,
            configured: false,
            renderer: None,
            warm,
            init_ms,
            pipeline,
            layout,
            atlas: Rc::new(RefCell::new(AtlasPool { alloc: CellAlloc::default(), tex: None, bind: None })),
            atlas_layout,
            pipeline_atlas,
            inst,
            inst_cap,
            white: GpuTile::own(wt, white_bind),
            scratch: Scene::new(),
            cull: Scene::new(),
            no_cull: false,
            tiles: TileCache::new(DEFAULT_BUDGET),
            bg: Color::from_rgba8(0xEC, 0xEC, 0xF0, 0xFF),
        })
    }

    /// The renderer is built (or failed): tiles can be drawn.
    /// Give the atlas texture back once no tile is in it (an overview's small tiles evicted after zooming in): it
    /// grows a layer pair at a time and its cells are not moved, so it is freed whole or not at all.
    pub fn trim_atlas(&mut self) {
        let mut p = self.atlas.borrow_mut();
        if p.alloc.layers() > 0 && p.alloc.used() == 0 {
            p.bind = None;
            if let Some(t) = p.tex.take() {
                t.destroy();
            }
            p.alloc.clear();
        }
    }

    /// The atlas's layers and the cells in use (stats).
    pub fn atlas_layers(&self) -> (u32, u32) {
        let p = self.atlas.borrow();
        (p.alloc.layers(), p.alloc.used())
    }

    pub fn ready(&self) -> bool {
        self.renderer.is_some() || !matches!(*self.warm.borrow(), Warm::Pending)
    }

    fn vello(&mut self) -> Result<&mut Renderer, String> {
        if self.renderer.is_none() {
            let state = std::mem::replace(&mut *self.warm.borrow_mut(), Warm::Taken);
            let r = match state {
                Warm::Done(r) => *r,
                Warm::Pending | Warm::Taken => {
                    let dev = &self.ctx.devices[self.dev_id];
                    let t0 = crate::api::now();
                    let r = build_renderer(&dev.device)?;
                    self.init_ms.set(crate::api::now() - t0);
                    r
                }
                Warm::Failed(e) => return Err(e),
            };
            self.renderer = Some(r);
        }
        Ok(self.renderer.as_mut().expect("set above"))
    }

    pub fn device(&self) -> &wgpu::Device {
        &self.ctx.devices[self.dev_id].device
    }

    pub fn queue(&self) -> &wgpu::Queue {
        &self.ctx.devices[self.dev_id].queue
    }

    /// A bind group the compositor can draw `tex` with.
    pub fn bind_texture(&self, tex: &wgpu::Texture) -> wgpu::BindGroup {
        bind(self.device(), &self.layout, tex)
    }

    pub fn size(&self) -> (u32, u32) {
        (self.config.width, self.config.height)
    }

    pub fn resize(&mut self, w: u32, h: u32) {
        if (w, h) != self.size() {
            self.config.width = w.max(1);
            self.config.height = h.max(1);
            if self.configured {
                self.surface.configure(self.device(), &self.config);
            }
        }
    }

    /// Start rendering one tile of a board at scale (`sx`, `sy`) (device px per board unit; they differ by a
    /// hair when the board is fitted to whole device pixels), with `GUTTER` px of the board's real content around
    /// it (see `cache::GUTTER`). `tile.rect` is in board space: where the board sits in the world is the
    /// compositor's business, so moving a board renders nothing. Nothing is rendered yet: `step_job` renders
    /// one part at a time, so a dense tile (see cull.rs) spreads over frames.
    pub fn begin_tile(&mut self, b: &Board, tile: &TileRect, scale: (f64, f64)) -> Result<BoardJob, String> {
        let g = f64::from(GUTTER);
        let t = Target { origin: (tile.rect.x0 - g / scale.0, tile.rect.y0 - g / scale.1), scale };
        self.begin_job(b, b.index.len(), t, tile.w + 2 * GUTTER, tile.h + 2 * GUTTER, true)
    }

    /// The finished tile of a job whose every part is rendered: the texture and how many vello renders it took.
    pub fn finish_tile(&self, mut job: BoardJob) -> (GpuTile, u32) {
        let tex = job.tex.take().expect("held until finished");
        let bind = bind(self.device(), &self.layout, &tex);
        (GpuTile::own(tex, bind), job.parts.len() as u32)
    }

    /// Plan a render of the first `upto` items of board `b`'s scene over target `t` into a new `w` × `h` texture
    /// that can be sampled: only the items that meet it, and in parts when it holds more than vello's fixed
    /// buffers do (cull.rs; a scene over them renders as nothing, silently). A target no split makes drawable is
    /// an error: nothing is rendered, so nothing empty is cached.
    fn begin_job(&mut self, b: &Board, upto: usize, t: Target, w: u32, h: u32, snap: bool) -> Result<BoardJob, String> {
        // Each part with what it costs beyond its pixels, for the frame's admission.
        let (parts, lines): (Vec<[u32; 4]>, Vec<f64>) = if self.no_cull { (vec![[0, 0, w, h]], vec![0.0]) } else { plan_costed(&b.index, upto, &t, w, h).map_err(|e| format!("board {}: {e}", b.id))?.into_iter().map(|(p, e)| (p, e.mpx())).unzip() };
        self.vello()?;
        // COPY_DST always: an edit later renders only the part it changed and copies that in (`render_into`).
        let whole = wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | if parts.len() == 1 { wgpu::TextureUsages::STORAGE_BINDING } else { wgpu::TextureUsages::empty() };
        let tex = part_texture(self.device(), w, h, whole);
        Ok(BoardJob { tex: Some(tex), parts, lines, next: 0, t, upto, snap, short: false })
    }

    /// Render the next part of a job (the caller has not run `before_render`: this does). Returns true when
    /// that was the last one.
    pub fn step_job(&mut self, job: &mut BoardJob, b: &Board, atlas_px: u64, images: &[ImageData]) -> Result<bool, String> {
        let Some(part) = job.parts.get(job.next).copied() else { return Ok(true) };
        self.before_render(atlas_px, images, &b.jobs)?;
        let single = job.parts.len() == 1;
        if self.no_cull {
            self.cull.reset();
            self.cull.append(&b.scene, Some(job.t.transform()));
        } else {
            b.index.build(&b.scene, job.upto, &job.t, part, &mut self.cull);
        }
        smooth_glyphs(&mut self.cull, 0, job.snap);
        pin_atlas(&mut self.cull, &self.atlas_pin);
        let [x, y, pw, ph] = part;
        let tex = job.tex.as_ref().expect("held until finished");
        let dev = &self.ctx.devices[self.dev_id];
        let (device, queue) = (&dev.device, &dev.queue);
        let sub = (!single).then(|| part_texture(device, pw, ph, wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC));
        let view = sub.as_ref().unwrap_or(tex).create_view(&Default::default());
        let params = RenderParams { base_color: Color::TRANSPARENT, width: pw, height: ph, antialiasing_method: AaConfig::Area };
        let r = self.renderer.as_mut().expect("built by begin_job");
        let done = r.render_to_texture(device, queue, &self.cull, &view, &params).map_err(|e| format!("vello render: {e}"));
        if let Some(sub) = sub {
            if done.is_ok() {
                let mut enc = device.create_command_encoder(&Default::default());
                enc.copy_texture_to_texture(
                    wgpu::TexelCopyTextureInfo { texture: &sub, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                    wgpu::TexelCopyTextureInfo { texture: tex, mip_level: 0, origin: wgpu::Origin3d { x, y, z: 0 }, aspect: wgpu::TextureAspect::All },
                    wgpu::Extent3d { width: pw, height: ph, depth_or_array_layers: 1 },
                );
                queue.submit([enc.finish()]);
            }
            sub.destroy(); // after the copy already submitted
        }
        done?;
        job.next += 1;
        Ok(job.next >= job.parts.len())
    }

    /// What one render of a small tile (the whole texture, gutter included) asks of vello's buffers, or None when
    /// it needs more than one part (see `begin_job`): such a tile is rendered on its own.
    pub fn small_tile_estimate(&self, b: &Board, tile: &TileRect, scale: (f64, f64)) -> Option<crate::cull::Estimate> {
        if self.no_cull {
            return None;
        }
        let g = f64::from(GUTTER);
        let t = Target { origin: (tile.rect.x0 - g / scale.0, tile.rect.y0 - g / scale.1), scale };
        let e = b.index.estimate(b.index.len(), &t, [0, 0, tile.w + 2 * GUTTER, tile.h + 2 * GUTTER]);
        e.fits().then_some(e)
    }

    /// Render many small tiles in one vello render: each tile's part of its board's scene goes into its own cell of
    /// a scratch atlas (`cells`: x, y in the atlas; the atlas is `aw` × `ah`), clipped to that cell, and every cell is
    /// copied into a texture of its own. A render costs about the same whatever its size up to a few Mpx, so a view
    /// of hundreds of boards a few dozen px wide (an overview) renders in a frame or two instead of one tile a frame.
    /// The pixels are the ones a render of each tile alone makes: the same scene, transform and baseline snap,
    /// moved by whole px. `atlas_px` and `images`: every image and effect texture those boards draw.
    #[allow(clippy::too_many_arguments)]
    pub fn render_batch(&mut self, items: &[(&Board, TileRect, (f64, f64), (u32, u32))], aw: u32, ah: u32, atlas_px: u64, images: &[ImageData], jobs: &[&EffectJob]) -> Result<Vec<GpuTile>, String> {
        self.vello()?;
        if atlas_needs_flush(atlas_px, self.atlas_recent) {
            self.flush_atlas()?;
        }
        {
            let r = self.vello()?;
            for img in images.iter().chain(jobs.iter().map(|j| &j.image)) {
                r.mark_override_image_dirty(img);
            }
        }
        self.atlas_recent = (self.atlas_recent.1, atlas_px);
        let g = f64::from(GUTTER);
        let mut scene = std::mem::take(&mut self.scratch);
        scene.reset();
        for (b, tile, scale, (cx, cy)) in items {
            let t = Target { origin: (tile.rect.x0 - g / scale.0, tile.rect.y0 - g / scale.1), scale: *scale };
            let (w, h) = (tile.w + 2 * GUTTER, tile.h + 2 * GUTTER);
            b.index.build(&b.scene, b.index.len(), &t, [0, 0, w, h], &mut self.cull);
            smooth_glyphs(&mut self.cull, 0, true);
            let xf = Affine::translate((f64::from(*cx), f64::from(*cy)));
            scene.push_clip_layer(peniko::Fill::NonZero, xf, &Rect::new(0.0, 0.0, f64::from(w), f64::from(h)));
            scene.append(&self.cull, Some(xf));
            scene.pop_layer();
        }
        pin_atlas(&mut scene, &self.atlas_pin);
        let dev = &self.ctx.devices[self.dev_id];
        let (device, queue) = (&dev.device, &dev.queue);
        let atlas = part_texture(device, aw, ah, wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC);
        let view = atlas.create_view(&Default::default());
        let params = RenderParams { base_color: Color::TRANSPARENT, width: aw, height: ah, antialiasing_method: AaConfig::Area };
        let r = self.renderer.as_mut().expect("built above");
        let done = r.render_to_texture(device, queue, &scene, &view, &params).map_err(|e| format!("vello render (batch): {e}"));
        self.scratch = scene;
        let mut out = Vec::with_capacity(items.len());
        if done.is_ok() {
            // Cells first: growing the atlas submits a copy of its own, which must go before this encoder's copies.
            let cells: Vec<Option<AtlasCell>> = items
                .iter()
                .map(|(_, tile, _, _)| AtlasPool::cell(&self.atlas, device, queue, &self.atlas_layout, tile.w + 2 * GUTTER, tile.h + 2 * GUTTER))
                .collect();
            let mut enc = device.create_command_encoder(&Default::default());
            for ((_, tile, _, (cx, cy)), cell) in items.iter().zip(cells) {
                let (w, h) = (tile.w + 2 * GUTTER, tile.h + 2 * GUTTER);
                let src = wgpu::TexelCopyTextureInfo { texture: &atlas, mip_level: 0, origin: wgpu::Origin3d { x: *cx, y: *cy, z: 0 }, aspect: wgpu::TextureAspect::All };
                let size = wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 };
                if let Some(cell) = cell {
                    let pool = self.atlas.borrow();
                    let dst = pool.tex.as_ref().expect("a cell was handed out");
                    enc.copy_texture_to_texture(src, wgpu::TexelCopyTextureInfo { texture: dst, mip_level: 0, origin: wgpu::Origin3d { x: cell.at.0, y: cell.at.1, z: cell.layer }, aspect: wgpu::TextureAspect::All }, size);
                    drop(pool);
                    out.push(GpuTile { own: None, cell: Some(cell) });
                    continue;
                }
                let tex = part_texture(device, w, h, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::STORAGE_BINDING);
                enc.copy_texture_to_texture(src, wgpu::TexelCopyTextureInfo { texture: &tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All }, size);
                let bind = bind(device, &self.layout, &tex);
                out.push(GpuTile::own(tex, bind));
            }
            queue.submit([enc.finish()]);
        }
        atlas.destroy(); // after the copies already submitted
        done?;
        Ok(out)
    }

    /// Bring a tile texture of board `b` (rendered for `tile` at `scale`, as `begin_tile` plans it) up to date where
    /// it changed: only `area` (texture px, gutter included) is rendered again, in parts as cull.rs plans them, each
    /// copied into `tex` where it belongs. All in this call: the texture is never left half updated across frames.
    /// Returns the px rendered, or an error (a region too dense to draw: the caller renders the tile whole).
    pub fn render_into(&mut self, tex: &wgpu::Texture, b: &Board, tile: &TileRect, scale: (f64, f64), area: [u32; 4], atlas_px: u64, images: &[ImageData]) -> Result<u64, String> {
        let g = f64::from(GUTTER);
        let t = Target { origin: (tile.rect.x0 - g / scale.0, tile.rect.y0 - g / scale.1), scale };
        let parts: Vec<[u32; 4]> = if self.no_cull { vec![area] } else { crate::cull::plan_costed_in(&b.index, b.index.len(), &t, area).map_err(|e| format!("board {}: {e}", b.id))?.into_iter().map(|(p, _)| p).collect() };
        self.vello()?;
        let mut px = 0u64;
        for part in parts {
            self.before_render(atlas_px, images, &b.jobs)?;
            if self.no_cull {
                self.cull.reset();
                self.cull.append(&b.scene, Some(t.transform()));
            } else {
                b.index.build(&b.scene, b.index.len(), &t, part, &mut self.cull);
            }
            smooth_glyphs(&mut self.cull, 0, true);
            pin_atlas(&mut self.cull, &self.atlas_pin);
            let [x, y, pw, ph] = part;
            let dev = &self.ctx.devices[self.dev_id];
            let (device, queue) = (&dev.device, &dev.queue);
            let sub = part_texture(device, pw, ph, wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC);
            let view = sub.create_view(&Default::default());
            let params = RenderParams { base_color: Color::TRANSPARENT, width: pw, height: ph, antialiasing_method: AaConfig::Area };
            let r = self.renderer.as_mut().expect("built above");
            let done = r.render_to_texture(device, queue, &self.cull, &view, &params).map_err(|e| format!("vello render: {e}"));
            if done.is_ok() {
                let mut enc = device.create_command_encoder(&Default::default());
                enc.copy_texture_to_texture(
                    wgpu::TexelCopyTextureInfo { texture: &sub, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                    wgpu::TexelCopyTextureInfo { texture: tex, mip_level: 0, origin: wgpu::Origin3d { x, y, z: 0 }, aspect: wgpu::TextureAspect::All },
                    wgpu::Extent3d { width: pw, height: ph, depth_or_array_layers: 1 },
                );
                queue.submit([enc.finish()]);
            }
            sub.destroy();
            done?;
            px += u64::from(pw) * u64::from(ph);
        }
        Ok(px)
    }

    /// Render a whole job now (effect content: a backdrop blur's texture is needed by the tile that shows it).
    fn render_board(&mut self, b: &Board, upto: usize, t: Target, w: u32, h: u32, atlas_px: u64, images: &[ImageData]) -> Result<wgpu::Texture, String> {
        let mut job = self.begin_job(b, upto, t, w, h, false)?;
        while !self.step_job(&mut job, b, atlas_px, images)? {}
        Ok(job.tex.take().expect("held until finished"))
    }

    /// What every vello render of a board's content does first (tiles and effect jobs alike): flush the image atlas
    /// when this render's images (`atlas_px` of them) and the last two renders' would not fit it together, and
    /// copy every image the board draws (`images`, and its effect textures) into the atlas again. vello copies a
    /// texture-backed image into its atlas once and then trusts the copy; when the atlas grows or repacks, that
    /// copy can be lost and the image is drawn empty (photos and screenshots went missing tile by tile, and a
    /// blurred group holding a photo was baked empty).
    fn before_render(&mut self, atlas_px: u64, images: &[ImageData], jobs: &[EffectJob]) -> Result<(), String> {
        if atlas_needs_flush(atlas_px, self.atlas_recent) {
            self.flush_atlas()?;
        }
        let r = self.vello()?;
        for img in images.iter().chain(jobs.iter().map(|j| &j.image)) {
            r.mark_override_image_dirty(img);
        }
        self.atlas_recent = (self.atlas_recent.1, atlas_px);
        Ok(())
    }

    /// Two tiny renders without images: everything the image atlas holds becomes evictable, so the
    /// next render's images fit.
    fn flush_atlas(&mut self) -> Result<(), String> {
        self.vello()?;
        let dev = &self.ctx.devices[self.dev_id];
        let (device, queue) = (&dev.device, &dev.queue);
        let tex = self.flush_tex.get_or_insert_with(|| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some("atlas flush"),
                size: wgpu::Extent3d { width: 8, height: 8, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
        });
        let view = tex.create_view(&Default::default());
        let mut sc = Scene::new();
        sc.fill(peniko::Fill::NonZero, Affine::IDENTITY, Color::BLACK, None, &Rect::new(0.0, 0.0, 1.0, 1.0));
        pin_atlas(&mut sc, &self.atlas_pin);
        let params = RenderParams { base_color: Color::TRANSPARENT, width: 8, height: 8, antialiasing_method: AaConfig::Area };
        let r = self.renderer.as_mut().expect("built above");
        for _ in 0..2 {
            r.render_to_texture(device, queue, &sc, &view, &params).map_err(|e| format!("vello render (flush): {e}"))?;
        }
        self.atlas_recent = (0, 0);
        Ok(())
    }

    /// Decode the part `crop` (x, y, width, height in the image's own px; None: all of it) of an image at
    /// `lw` × `lh` into a GPU texture (drawn into a scratch canvas, then copied by the GPU: no pixels pass
    /// through WASM memory) and attach it to a fresh placeholder `ImageData` that scenes draw.
    ///
    /// A smaller copy is made by halving: every step is a bilinear draw at 2:1, which is a box filter, so the
    /// result is the mip level Chrome draws an `<img>` from. One scaled `drawImage` (any smoothing quality)
    /// is not an area filter: stripes and rings finer than the level came out as moire.
    pub fn upload_image(&mut self, src: &JsValue, w: u32, h: u32, crop: Option<[f64; 4]>, lw: u32, lh: u32) -> Result<(wgpu::Texture, ImageData), String> {
        let err = |e: JsValue| format!("image decode: {}", e.as_string().unwrap_or_else(|| format!("{e:?}")));
        let canvas = |cw: u32, ch: u32| -> Result<(web_sys::OffscreenCanvas, web_sys::OffscreenCanvasRenderingContext2d), String> {
            let oc = web_sys::OffscreenCanvas::new(cw.max(1), ch.max(1)).map_err(err)?;
            let cx: web_sys::OffscreenCanvasRenderingContext2d = oc.get_context("2d").map_err(err)?.ok_or("no 2d context")?.dyn_into().map_err(|_| "no 2d context".to_string())?;
            let _ = js_sys::Reflect::set(&cx, &"imageSmoothingQuality".into(), &"low".into());
            Ok((oc, cx))
        };
        let [sx, sy, sw, sh] = crop.unwrap_or([0.0, 0.0, f64::from(w), f64::from(h)]);
        let steps = crate::images::box_steps(sw.max(sh), f64::from(lw.max(lh)));
        // The first draw, from the source: all the way when one step (or none) is left, else to twice the
        // size the remaining steps end at.
        let first = (lw << steps.saturating_sub(1), lh << steps.saturating_sub(1));
        let (mut oc, cx) = canvas(first.0, first.1)?;
        let (dw, dh) = (f64::from(first.0), f64::from(first.1));
        if let Some(bm) = src.dyn_ref::<web_sys::ImageBitmap>() {
            if bm.width() == 0 {
                return Err("image decode: the ImageBitmap was closed".into());
            }
            cx.draw_image_with_image_bitmap_and_sw_and_sh_and_dx_and_dy_and_dw_and_dh(bm, sx, sy, sw, sh, 0.0, 0.0, dw, dh).map_err(err)?;
        } else if let Some(id) = src.dyn_ref::<web_sys::ImageData>() {
            if (sw, sh) == (dw, dh) && sx.fract() == 0.0 && sy.fract() == 0.0 {
                // Its own pixels: only the part asked for is copied.
                cx.put_image_data_with_dirty_x_and_dirty_y_and_dirty_width_and_dirty_height(id, -(sx as i32), -(sy as i32), sx as i32, sy as i32, first.0 as i32, first.1 as i32).map_err(err)?;
            } else {
                let (full, fx) = canvas(w, h)?;
                fx.put_image_data(id, 0, 0).map_err(err)?;
                cx.draw_image_with_offscreen_canvas_and_sw_and_sh_and_dx_and_dy_and_dw_and_dh(&full, sx, sy, sw, sh, 0.0, 0.0, dw, dh).map_err(err)?;
            }
        } else {
            return Err("image decode: unknown source".into());
        }
        for i in (0..steps.saturating_sub(1)).rev() {
            let (next, nx) = canvas(lw << i, lh << i)?;
            nx.draw_image_with_offscreen_canvas_and_dw_and_dh(&oc, 0.0, 0.0, f64::from(lw << i), f64::from(lh << i)).map_err(err)?;
            oc = next;
        }
        let dev = &self.ctx.devices[self.dev_id];
        let tex = dev.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("image"),
            size: wgpu::Extent3d { width: lw, height: lh, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        dev.queue.copy_external_image_to_texture(
            &wgpu::CopyExternalImageSourceInfo { source: wgpu::ExternalImageSource::OffscreenCanvas(oc), origin: wgpu::Origin2d::ZERO, flip_y: false },
            wgpu::CopyExternalImageDestInfo { texture: &tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All, color_space: wgpu::PredefinedColorSpace::Srgb, premultiplied_alpha: false },
            wgpu::Extent3d { width: lw, height: lh, depth_or_array_layers: 1 },
        );
        let img = gpu_image(lw, lh, ImageAlphaType::Alpha);
        self.vello()?.override_image(&img, Some(wgpu::TexelCopyTextureInfoBase { texture: tex.clone(), mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All }));
        Ok((tex, img))
    }

    /// Has the image no transparency? Judged on 256 x 256 point samples (one readback, once per image; a
    /// filtered copy of a 12 Mpx photo took 50 ms): a hole between the samples goes unseen, and costs at most
    /// a faint line across it.
    pub fn image_opaque(&mut self, src: &JsValue, w: u32, h: u32) -> bool {
        const N: u32 = 256;
        let Ok(oc) = web_sys::OffscreenCanvas::new(N, N) else { return false };
        let Some(cx) = oc.get_context("2d").ok().flatten().and_then(|c| c.dyn_into::<web_sys::OffscreenCanvasRenderingContext2d>().ok()) else { return false };
        cx.set_image_smoothing_enabled(false);
        let n = f64::from(N);
        let drawn = if let Some(bm) = src.dyn_ref::<web_sys::ImageBitmap>() {
            bm.width() > 0 && cx.draw_image_with_image_bitmap_and_dw_and_dh(bm, 0.0, 0.0, n, n).is_ok()
        } else if let Some(id) = src.dyn_ref::<web_sys::ImageData>() {
            web_sys::OffscreenCanvas::new(w, h).ok().is_some_and(|full| {
                full.get_context("2d").ok().flatten().and_then(|c| c.dyn_into::<web_sys::OffscreenCanvasRenderingContext2d>().ok()).is_some_and(|fx| fx.put_image_data(id, 0, 0).is_ok() && cx.draw_image_with_offscreen_canvas_and_dw_and_dh(&full, 0.0, 0.0, n, n).is_ok())
            })
        } else {
            false
        };
        drawn && cx.get_image_data(0, 0, N as i32, N as i32).is_ok_and(|d| d.data().chunks_exact(4).all(|p| p[3] == 255))
    }

    /// Rows `y0 .. y0 + rows` of the image read in full: do they hold a pixel with transparency? None when the
    /// rows could not be read (the caller treats the image as having transparency: it is never tiled). The
    /// sampled check above misses anything narrower than its sample spacing (a translucent hairline in a 3000 px
    /// image), and tiles overlap by a level px: such a line blended twice along every tile edge it ran in.
    pub fn image_rows_transparent(&mut self, src: &JsValue, w: u32, y0: u32, rows: u32) -> Option<bool> {
        let oc = web_sys::OffscreenCanvas::new(w.max(1), rows.max(1)).ok()?;
        let opts = js_sys::Object::new();
        let _ = js_sys::Reflect::set(&opts, &"willReadFrequently".into(), &JsValue::TRUE);
        let cx: web_sys::OffscreenCanvasRenderingContext2d = oc.get_context_with_context_options("2d", &opts).ok().flatten()?.dyn_into().ok()?;
        let (fw, fr, fy) = (f64::from(w), f64::from(rows), f64::from(y0));
        if let Some(bm) = src.dyn_ref::<web_sys::ImageBitmap>() {
            if bm.width() == 0 {
                return None;
            }
            cx.draw_image_with_image_bitmap_and_sw_and_sh_and_dx_and_dy_and_dw_and_dh(bm, 0.0, fy, fw, fr, 0.0, 0.0, fw, fr).ok()?;
        } else if let Some(id) = src.dyn_ref::<web_sys::ImageData>() {
            cx.put_image_data_with_dirty_x_and_dirty_y_and_dirty_width_and_dirty_height(id, 0, -(y0 as i32), 0, y0 as i32, w as i32, rows as i32).ok()?;
        } else {
            return None;
        }
        let d = cx.get_image_data(0, 0, w as i32, rows as i32).ok()?;
        Some(d.data().chunks_exact(4).any(|p| p[3] != 255))
    }

    /// Detach a placeholder's texture (its level was evicted).
    pub fn forget_image(&mut self, img: &ImageData) {
        if let Some(r) = self.renderer.as_mut() {
            r.override_image(img, None);
        }
    }

    /// Give a shader fill's placeholder its pixels: `tex` (token `token`, the same texture keeps the same token), or
    /// the shared transparent texture. vello needs every image a scene draws to have pixels.
    pub fn attach_fill(&mut self, img: &ImageData, tex: Option<(&wgpu::Texture, u64)>) -> Result<(), String> {
        let id = img.data.id();
        let token = tex.map_or(0, |t| t.1);
        if self.fills.get(&id).is_some_and(|f| f.1 == token) {
            return Ok(());
        }
        let texture = match tex {
            Some((t, _)) => t.clone(),
            None => self.blank_for(img.width.max(img.height)),
        };
        self.vello()?.override_image(img, Some(wgpu::TexelCopyTextureInfoBase { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All }));
        self.fills.insert(id, (img.clone(), token));
        Ok(())
    }

    /// A fill's texture has a new frame: vello copies it into its atlas again at the next render that draws it.
    pub fn fill_changed(&mut self, img: &ImageData) {
        if let Some(r) = self.renderer.as_mut() {
            r.mark_override_image_dirty(img);
        }
    }

    /// Detach fill placeholders no board draws any more (before their textures go).
    pub fn retain_fills(&mut self, live: &HashSet<u64>) {
        let gone: Vec<u64> = self.fills.keys().filter(|k| !live.contains(k)).copied().collect();
        for k in gone {
            if let Some((img, _)) = self.fills.remove(&k)
                && let Some(r) = self.renderer.as_mut()
            {
                r.override_image(&img, None);
            }
        }
    }

    /// Detach every placeholder that copies from texture `token` (it is about to be destroyed).
    pub fn detach_fill_texture(&mut self, token: u64) {
        let ids: Vec<u64> = self.fills.iter().filter(|(_, f)| f.1 == token).map(|(k, _)| *k).collect();
        for k in ids {
            if let Some((img, _)) = self.fills.remove(&k)
                && let Some(r) = self.renderer.as_mut()
            {
                r.override_image(&img, None);
            }
        }
    }

    /// The effect job with this placeholder id has its texture.
    pub fn has_job(&self, id: u64) -> bool {
        self.jobs.contains_key(&id)
    }

    pub fn touch_job(&mut self, id: u64, frame: u64) {
        if let Some(j) = self.jobs.get_mut(&id) {
            j.3 = frame;
        }
    }

    /// Every effect job `jobs` draws gets pixels before a tile of its board renders: its own blurred
    /// texture, or (until a tile shows it) the shared transparent one.
    pub fn prepare_jobs(&mut self, jobs: &[EffectJob]) -> Result<(), String> {
        for job in jobs {
            let id = job.image.data.id();
            if self.jobs.contains_key(&id) || self.blanked.contains_key(&id) {
                continue;
            }
            let tex = self.blank_for(job.w.max(job.h));
            self.vello()?.override_image(&job.image, Some(wgpu::TexelCopyTextureInfoBase { texture: tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All }));
            self.blanked.insert(id, job.image.clone());
        }
        Ok(())
    }

    /// The shared transparent texture, at least `side` px square (a bigger one replaces it; overrides
    /// pointing at the old one keep it alive until they are replaced).
    fn blank_for(&mut self, side: u32) -> wgpu::Texture {
        if let Some((t, have)) = &self.blank
            && *have >= side
        {
            return t.clone();
        }
        let side = side.next_power_of_two().max(256);
        let t = self.device().create_texture(&wgpu::TextureDescriptor {
            label: Some("blank effect"),
            size: wgpu::Extent3d { width: side, height: side, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        self.blank = Some((t.clone(), side));
        t
    }

    /// Render, blur and attach one effect job of board `b` (`atlas_px` and `images`: as for its tiles).
    pub fn render_effect(&mut self, b: &Board, job: &EffectJob, frame: u64, atlas_px: u64, images: &[ImageData]) -> Result<(), String> {
        let id = job.image.data.id();
        if self.jobs.contains_key(&id) {
            return Ok(());
        }
        let tex = self.render_job(b, job, atlas_px, images)?;
        let bytes = u64::from(job.w) * u64::from(job.h) * 4;
        self.vello()?.override_image(&job.image, Some(wgpu::TexelCopyTextureInfoBase { texture: tex.clone(), mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All }));
        self.blanked.remove(&id);
        self.jobs.insert(id, (job.image.clone(), tex, bytes, frame));
        self.job_bytes += bytes;
        Ok(())
    }

    /// Drop job textures no board draws any more.
    pub fn retain_jobs(&mut self, live: &HashSet<u64>) {
        let gone: Vec<u64> = self.jobs.keys().filter(|k| !live.contains(k)).copied().collect();
        for k in gone {
            if let Some((img, tex, bytes, _)) = self.jobs.remove(&k) {
                if let Some(r) = self.renderer.as_mut() {
                    r.override_image(&img, None);
                }
                tex.destroy();
                self.job_bytes -= bytes;
            }
        }
        let gone: Vec<u64> = self.blanked.keys().filter(|k| !live.contains(k)).copied().collect();
        for k in gone {
            if let Some(img) = self.blanked.remove(&k)
                && let Some(r) = self.renderer.as_mut()
            {
                r.override_image(&img, None);
            }
        }
    }

    /// Stay under `budget` bytes of effect textures, least recently used first. Tiles already drawn keep
    /// their pixels; the job shows the blank texture until a tile needs it again and renders it again.
    pub fn evict_jobs(&mut self, budget: u64, frame: u64) {
        let items: Vec<(u64, u64, u64)> = self.jobs.iter().map(|(id, j)| (*id, j.2, j.3)).collect();
        for k in lru_over_budget(&items, budget, frame) {
            if let Some((img, old, bytes, _)) = self.jobs.remove(&k) {
                self.job_bytes -= bytes;
                let tex = self.blank_for(img.width.max(img.height));
                if let Some(r) = self.renderer.as_mut() {
                    r.override_image(&img, Some(wgpu::TexelCopyTextureInfoBase { texture: tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All }));
                }
                old.destroy(); // vello now copies from the blank texture
                self.blanked.insert(k, img);
            }
        }
    }

    fn render_job(&mut self, b: &Board, job: &EffectJob, atlas_px: u64, images: &[ImageData]) -> Result<wgpu::Texture, String> {
        let (w, h) = (job.w, job.h);
        // What is behind a backdrop blur is a prefix of the board's scene: rendered like a tile, only what meets it.
        let behind = match &job.scene {
            JobScene::Behind(p) if !self.no_cull => {
                let t = Target { origin: (job.bounds.x0, job.bounds.y0), scale: (f64::from(w) / job.bounds.width(), f64::from(h) / job.bounds.height()) };
                Some(self.render_board(b, p.items, t, w, h, atlas_px, images)?)
            }
            _ => None,
        };
        if behind.is_none() {
            self.before_render(atlas_px, images, &b.jobs)?;
        }
        let board_scene = &b.scene;
        let device = &self.ctx.devices[self.dev_id].device;
        let make = |usage: wgpu::TextureUsages| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some("effect"),
                size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage,
                view_formats: &[],
            })
        };
        let mid = make(wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING);
        let out = make(wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC);
        let content = match behind {
            Some(t) => t,
            None => {
                let content = make(wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING);
                self.scratch.reset();
                let to_tex = Affine::scale_non_uniform(f64::from(w) / job.bounds.width(), f64::from(h) / job.bounds.height()) * Affine::translate((-job.bounds.x0, -job.bounds.y0));
                self.scratch.append(&job.scene.scene(board_scene), Some(to_tex));
                smooth_glyphs(&mut self.scratch, 0, false);
                pin_atlas(&mut self.scratch, &self.atlas_pin);
                let params = RenderParams { base_color: Color::TRANSPARENT, width: w, height: h, antialiasing_method: AaConfig::Area };
                let content_view = content.create_view(&Default::default());
                self.vello()?;
                let dev = &self.ctx.devices[self.dev_id];
                self.renderer.as_mut().expect("built above").render_to_texture(&dev.device, &dev.queue, &self.scratch, &content_view, &params).map_err(|e| format!("vello render (effect): {e}"))?;
                content
            }
        };
        let dev = &self.ctx.devices[self.dev_id];
        let (device, queue) = (&dev.device, &dev.queue);
        let (blur, blur_layout) = self.blur.get_or_insert_with(|| blur_pipeline(device));
        let sigma_px = (job.sigma * f64::from(w) / job.bounds.width()).max(0.01) as f32;
        let (tint, mode) = match job.kind {
            JobKind::Layer => ([0.0f32; 4], 0.0f32),
            JobKind::Tint(c) => {
                let [r, g, b, a] = c.components;
                ([r * a, g * a, b * a, a], 1.0)
            }
        };
        let mut enc = device.create_command_encoder(&Default::default());
        let mut bufs = Vec::with_capacity(2);
        for (src, dst, dir, premul, tint, mode) in [(&content, &mid, [1.0f32, 0.0], 1.0f32, [0.0f32; 4], 0.0f32), (&mid, &out, [0.0, 1.0], 0.0, tint, mode)] {
            let u: [f32; 12] = [dir[0], dir[1], sigma_px, premul, tint[0], tint[1], tint[2], tint[3], mode, 0.0, 0.0, 0.0];
            let buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("blur"), contents: bytemuck::cast_slice(&u), usage: wgpu::BufferUsages::UNIFORM });
            let view = src.create_view(&Default::default());
            let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: blur_layout,
                entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) }, wgpu::BindGroupEntry { binding: 1, resource: buf.as_entire_binding() }],
            });
            let target = dst.create_view(&Default::default());
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("blur"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &target, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(blur);
            pass.set_bind_group(0, &bg, &[]);
            pass.draw(0..3, 0..1);
            drop(pass);
            bufs.push(buf);
        }
        queue.submit([enc.finish()]);
        // The two passes' inputs and uniforms are done with once this work runs.
        content.destroy();
        mid.destroy();
        for b in bufs {
            b.destroy();
        }
        Ok(out)
    }

    /// Draw the frame: clear to the background, then every quad in order.
    /// `shader_ms`: GPU time the shader cards submitted this frame are predicted to take; it is taken out
    /// of the measurement so the tile cost model stays about tiles.
    pub fn composite(&mut self, quads: &[(Source, Quad)], t_start: f64, tile_mpx: f64, shader_ms: f64) -> Result<(), String> {
        let dev = &self.ctx.devices[self.dev_id];
        let (device, queue) = (&dev.device, &dev.queue);
        // WebKit can synchronously wait for a configured canvas at the next display update.
        // Configure only when the page presents its first frame.
        if !self.configured {
            self.surface.configure(device, &self.config);
            self.configured = true;
        }
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            _ => return Err("no surface texture".into()),
        };
        let (w, h) = (self.config.width as f32, self.config.height as f32);
        let (fw, fh) = (self.config.width, self.config.height);
        let mut data: Vec<f32> = Vec::with_capacity(quads.len() * FLOATS);
        // Per quad, how it draws: None (skipped), or (pipeline 0 straight, 1 premultiplied, 2 atlas; its bind group;
        // its scissor rect). Atlas quads clip in the shader, so their scissor is the whole frame.
        let pool = self.atlas.borrow();
        let mut how: Vec<Option<(u8, &wgpu::BindGroup, [u32; 4])>> = Vec::with_capacity(quads.len());
        for (src, q) in quads {
            let r = q.rect;
            data.extend_from_slice(&[r[0] / w * 2.0 - 1.0, 1.0 - r[1] / h * 2.0, r[2] / w * 2.0 - 1.0, 1.0 - r[3] / h * 2.0]);
            data.extend_from_slice(&q.uv);
            data.extend_from_slice(&q.tint);
            let scissor = match q.scissor {
                Some([x, y, sw, sh]) => {
                    let x = x.min(fw);
                    let y = y.min(fh);
                    Some([x, y, sw.min(fw - x), sh.min(fh - y)])
                }
                None => None,
            };
            let full = [0, 0, fw, fh];
            let cell = match src {
                Source::Tile(key) => self.tiles.get(key).and_then(|s| s.tex.cell.as_ref()),
                _ => None,
            };
            match (cell, pool.bind.as_ref()) {
                (Some(c), Some(bind)) => {
                    data.extend_from_slice(&[c.layer as f32, 0.0, 0.0, 0.0]);
                    data.extend_from_slice(&[c.at.0 as f32, c.at.1 as f32, c.size.0 as f32, c.size.1 as f32]);
                    let clip = scissor.map_or([0.0, 0.0, fw as f32, fh as f32], |[x, y, sw, sh]| [x as f32, y as f32, (x + sw) as f32, (y + sh) as f32]);
                    data.extend_from_slice(&clip);
                    how.push(if scissor.is_some_and(|s| s[2] == 0 || s[3] == 0) { None } else { Some((2, bind, full)) });
                }
                _ => {
                    let mut extra = q.extra;
                    extra[3] = if matches!(src, Source::Premul(_)) { 1.0 } else { 0.0 };
                    data.extend_from_slice(&extra);
                    data.extend_from_slice(&[0.0; 8]);
                    let bind = match src {
                        Source::White => Some(&self.white.own.as_ref().expect("white has a texture").1),
                        Source::Tile(key) => self.tiles.get(key).and_then(|s| s.tex.own.as_ref()).map(|o| &o.1),
                        Source::Premul(b) => Some(b),
                    };
                    let sc = scissor.unwrap_or(full);
                    how.push(bind.filter(|_| sc[2] > 0 && sc[3] > 0).map(|b| (0, b, sc)));
                }
            }
        }
        let need = (data.len() * 4) as u64;
        if need > self.inst_cap {
            self.inst_cap = need.next_power_of_two();
            self.inst = device.create_buffer(&wgpu::BufferDescriptor { label: Some("quads"), size: self.inst_cap, usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        }
        if !data.is_empty() {
            queue.write_buffer(&self.inst, 0, bytemuck::cast_slice(&data));
        }
        let view = frame.texture.create_view(&Default::default());
        let mut enc = device.create_command_encoder(&Default::default());
        {
            let [r, g, b, a] = self.bg.components;
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("composite"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: f64::from(r), g: f64::from(g), b: f64::from(b), a: f64::from(a) }), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_vertex_buffer(0, self.inst.slice(..));
            // Consecutive quads that draw the same way go in one instanced draw; state is set only when it changes.
            let (mut pipe, mut bound, mut scis): (Option<u8>, Option<&wgpu::BindGroup>, Option<[u32; 4]>) = (None, None, None);
            let mut k = 0;
            while k < how.len() {
                let Some((p, b, sc)) = how[k] else {
                    k += 1;
                    continue;
                };
                let mut end = k + 1;
                while end < how.len() && how[end].is_some_and(|(p2, b2, sc2)| p2 == p && std::ptr::eq(b2, b) && sc2 == sc) {
                    end += 1;
                }
                if pipe != Some(p) {
                    pipe = Some(p);
                    pass.set_pipeline(match p {
                        0 => &self.pipeline,
                        _ => &self.pipeline_atlas,
                    });
                }
                if scis != Some(sc) {
                    scis = Some(sc);
                    pass.set_scissor_rect(sc[0], sc[1], sc[2], sc[3]);
                }
                if !bound.is_some_and(|x| std::ptr::eq(x, b)) {
                    bound = Some(b);
                    pass.set_bind_group(0, b, &[]);
                }
                pass.draw(0..6, k as u32..end as u32);
                k = end;
            }
        }
        drop(pool);
        queue.submit([enc.finish()]);
        queue.present(frame);
        // Frame start (the first tile submit) to GPU idle: an upper bound on this frame's GPU time.
        // It feeds the cost model the tile budget plans with.
        queue.on_submitted_work_done(move || {
            let done = crate::api::now() - t_start;
            GPU_DONE_MS.with(|c| c.set(done));
            let done = (done - shader_ms).max(0.0);
            if tile_mpx < 0.01 {
                GPU_BASE_MS.with(|c| c.set(c.get() * 0.8 + done * 0.2));
            } else {
                let base = GPU_BASE_MS.with(Cell::get);
                let k = ((done - base).max(0.0) / tile_mpx).min(200.0);
                // One late callback (the page was busy) is not a slower GPU: a sample counts for at most half again
                // the current estimate, so a single outlier cannot cut a pan to one tile a frame.
                GPU_MS_PER_MPX.with(|c| c.set(c.get() * 0.7 + k.min(c.get() * 1.5 + 0.1) * 0.3));
            }
        });
        Ok(())
    }
}

fn blur_pipeline(device: &wgpu::Device) -> (wgpu::RenderPipeline, wgpu::BindGroupLayout) {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("blur"), source: wgpu::ShaderSource::Wgsl(BLUR_SHADER.into()) });
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("blur"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: false }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
                count: None,
            },
            wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
        ],
    });
    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("blur"),
        layout: Some(&pl),
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), compilation_options: Default::default(), targets: &[Some(wgpu::ColorTargetState { format: wgpu::TextureFormat::Rgba8Unorm, blend: None, write_mask: wgpu::ColorWrites::ALL })] }),
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    });
    (pipeline, layout)
}

fn bind(device: &wgpu::Device, layout: &wgpu::BindGroupLayout, tex: &wgpu::Texture) -> wgpu::BindGroup {
    let view = tex.create_view(&Default::default());
    device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout, entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) }] })
}

/// World rect → device px with the camera (screen_css = world * z + cam).
pub fn to_device(r: Rect, cam: (f64, f64, f64), dpr: f64) -> Rect {
    let (cx, cy, z) = cam;
    Rect::new((r.x0 * z + cx) * dpr, (r.y0 * z + cy) * dpr, (r.x1 * z + cx) * dpr, (r.y1 * z + cy) * dpr)
}
