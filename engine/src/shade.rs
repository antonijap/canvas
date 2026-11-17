//! Shader cards on the GPU (wasm32 only): compiling a checked source, one uniform buffer per card
//! and per use (live frames, offscreen frames), the card's own texture, offscreen frames read back
//! for posters and agents. Policy (sizes, admission, clocks) is in `shaders.rs`.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use vello::wgpu;
use wasm_bindgen::JsValue;

use crate::shaders::{NOISE_RGBA, NOISE_SIZE, PARAM_FLOATS, SrcError, UNIFORM_BYTES, UNIFORM_FLOATS, unpremultiply, user_lines, wrap};

/// A card's compile state. `sgen` is the source generation it belongs to: a compile that finishes
/// after a newer source arrived is dropped.
pub enum Status {
    Empty,
    Compiling,
    Ready,
    Failed(Vec<SrcError>),
}

pub struct Compiled {
    pub sgen: u64,
    pub status: Status,
    /// A compile finished: the engine swaps in `pending` (on success) at its next frame.
    pub fresh: bool,
    /// The pipeline of the source being compiled. The last good one keeps running until this one
    /// compiles cleanly.
    pub pending: Option<wgpu::RenderPipeline>,
}

pub struct CardTex {
    pub tex: wgpu::Texture,
    pub bind: wgpu::BindGroup,
    pub size: (u32, u32),
    /// The size the picture in it was asked for (the budget may have granted less); `None` for a cached
    /// poster, which stands for any size.
    pub want: Option<(u32, u32)>,
}

/// Destroyed when dropped (wgpu's WebGPU backend leaves that to the JS garbage collector; see gpu.rs GpuTile).
impl Drop for CardTex {
    fn drop(&mut self) {
        self.tex.destroy();
    }
}

impl CardTex {
    pub fn bytes(&self) -> u64 {
        u64::from(self.size.0) * u64::from(self.size.1) * 4
    }
}

pub struct Card {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// Paint order among cards (the widget list's order).
    pub order: f64,
    /// Corner radius in world units.
    pub radius: f64,
    pub hash: u64,
    pub lines: u32,
    pub sgen: u64,
    pub compiled: Rc<RefCell<Compiled>>,
    pub pipeline: Option<wgpu::RenderPipeline>,
    /// Live frames and offscreen frames each write their own uniform buffer: no buffer is rewritten
    /// between a write and the submit that reads it.
    live: (wgpu::Buffer, wgpu::BindGroup),
    off: (wgpu::Buffer, wgpu::BindGroup),
    pub tex: Option<CardTex>,
    /// The texture holds a picture (a live frame, a poster or a snapshot frame).
    pub has_frame: bool,
    /// What the shown picture is: "live", "poster" (t = 2 s frame), "bitmap" (cached PNG).
    pub shows: &'static str,
    /// Wants to play (config autoplay and not paused by the person).
    pub play: bool,
    pub clock: crate::shaders::Clock,
    pub next_due: f64,
    /// Measured GPU ms per megapixel (0 = not measured yet). A latency estimate from
    /// onSubmittedWorkDone, an upper bound.
    pub cost: Rc<Cell<f64>>,
    /// A cost probe is in flight.
    pub probing: Rc<Cell<bool>>,
    /// A probe was started and the engine has not looked at its result yet.
    pub probe_seen: bool,
    /// Probes run for this pipeline and when the last one started (a high reading is probed again:
    /// callback latency only ever inflates it, so the lowest reading is kept).
    pub probes: u32,
    pub last_probe: f64,
    pub admitted: bool,
    /// Mouse in card px and hover / pressed flags while the pointer is over it.
    pub mouse: Option<[f32; 4]>,
    pub params: [f32; PARAM_FLOATS],
    pub last_render: f64,
    pub renders: u64,
    pub seen_frame: u64,
    pub snapped: bool,
    /// The frame its texture was refused (no room in the budget): no still picture is waited for then.
    pub denied_at: u64,
    /// A video card: frames come from this element instead of a pipeline.
    pub video: Option<VideoSrc>,
    /// A shader fill (not a card): its frames go into a node's placeholder on a board, never into a quad.
    pub fill: Option<FillLink>,
}

/// Where a shader fill's frames go: the board (by uid) and node that draw them, and the placeholder that copies them.
pub struct FillLink {
    pub board: u64,
    pub node: String,
    pub image: peniko::ImageData,
    /// What the node covers, board space: a new frame draws this part of the board's tiles again.
    pub rect: kurbo::Rect,
    /// The texture's token (`Gpu::attach_fill`).
    pub token: u64,
    /// The source and params it was last given.
    pub hash: u64,
    pub params: Vec<f32>,
}

/// A removed card's uniform buffers go with it (wgpu's WebGPU backend leaves dropped buffers to the JS garbage
/// collector; see gpu.rs GpuTile). A cost probe still in flight draws with the offscreen one later: that one is
/// left to the collector then. Its texture is a `CardTex`, destroyed on its own.
impl Drop for Card {
    fn drop(&mut self) {
        self.live.0.destroy();
        if !self.probing.get() {
            self.off.0.destroy();
        }
    }
}

/// Where a video card's frames come from. The page owns the element (src, loop, muted, seeking);
/// the engine plays and pauses it with the shared admission and copies its frames.
pub struct VideoSrc {
    pub el: Option<web_sys::HtmlVideoElement>,
    /// currentTime of the frame in the texture (-1: none yet).
    pub last_time: f64,
    /// The person pressed play in the card's controls: it plays like a hovered card.
    pub forced: bool,
    /// The page asked for the current frame (a seek or scrub while still).
    pub want: bool,
    /// The element was told to play (so a transition calls play or pause once).
    pub told_play: bool,
    /// Its metadata had arrived at the last look: a card becomes eligible to play when it does.
    pub seen_ready: bool,
}

impl VideoSrc {
    /// HAVE_METADATA: size known, can be admitted (play starts the download).
    pub fn has_metadata(&self) -> bool {
        self.el.as_ref().is_some_and(|e| e.ready_state() >= 1 && e.video_width() > 0 && e.video_height() > 0)
    }
    /// HAVE_CURRENT_DATA: a frame can be copied (copying earlier throws).
    pub fn has_frame(&self) -> bool {
        self.el.as_ref().is_some_and(|e| e.ready_state() >= 2 && e.video_width() > 0 && e.video_height() > 0)
    }
    pub fn native(&self) -> (u32, u32) {
        self.el.as_ref().map_or((0, 0), |e| (e.video_width(), e.video_height()))
    }
    pub fn time(&self) -> f64 {
        self.el.as_ref().map_or(0.0, |e| e.current_time())
    }
    /// Played to its end and not looping: it shows its last frame and needs no playback slot (the page's play
    /// button seeks it back to the start, which makes it playable again).
    pub fn ended(&self) -> bool {
        self.el.as_ref().is_some_and(|e| e.ended() && !e.loop_())
    }
    /// Play or pause the element on a change of admission. play() returns a promise that rejects when
    /// the browser refuses (autoplay policy, no source): the card then stays on its still frame.
    pub fn set_playing(&mut self, on: bool) {
        if self.told_play == on {
            return;
        }
        self.told_play = on;
        let Some(el) = &self.el else { return };
        if on {
            if let Ok(p) = el.play() {
                wasm_bindgen_futures::spawn_local(async move {
                    let _ = wasm_bindgen_futures::JsFuture::from(p).await;
                });
            }
        } else {
            let _ = el.pause();
        }
    }
}

/// The down-filter from a decoded video frame (staging texture, the video's own size) into a card's
/// texture (its on-screen size): a box of `taps` x `taps` bilinear samples per target pixel.
pub const BLIT_WGSL: &str = r#"
struct Blit { src: vec2<f32>, dst: vec2<f32>, taps: f32, pad0: f32, pad1: vec2<f32>, crop: vec4<f32> };
@group(0) @binding(0) var<uniform> b: Blit;
@group(0) @binding(1) var frame: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  var c = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(c[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let n = i32(b.taps);
  let corner = pos.xy - vec2<f32>(0.5);
  var acc = vec4<f32>(0.0);
  for (var y = 0; y < 6; y++) {
    if (y >= n) { break; }
    for (var x = 0; x < 6; x++) {
      if (x >= n) { break; }
      let q = corner + (vec2<f32>(f32(x), f32(y)) + vec2<f32>(0.5)) / f32(n);
      acc += textureSampleLevel(frame, smp, b.crop.xy + (q / b.dst) * b.crop.zw, 0.0);
    }
  }
  return acc / f32(n * n);
}
"#;

/// The staging texture a decoded frame is copied into, at the video's size, shared by every video of
/// that size (each copy is filtered into its card before the next copy is queued).
pub struct Staging {
    pub tex: wgpu::Texture,
    pub bind: wgpu::BindGroup,
    pub size: (u32, u32),
    pub used: f64,
}

impl Drop for Staging {
    fn drop(&mut self) {
        self.tex.destroy();
    }
}

impl Staging {
    pub fn bytes(&self) -> u64 {
        u64::from(self.size.0) * u64::from(self.size.1) * 4
    }
}

pub struct VideoGpu {
    pub pipe: wgpu::RenderPipeline,
    pub bgl: wgpu::BindGroupLayout,
    pub buf: wgpu::Buffer,
    pub sampler: wgpu::Sampler,
}

impl VideoGpu {
    pub fn new(device: &wgpu::Device) -> VideoGpu {
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("video blit"),
            entries: &[
                wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None },
                wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("video blit"), bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("video blit"), source: wgpu::ShaderSource::Wgsl(BLIT_WGSL.into()) });
        let pipe = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("video blit"),
            layout: Some(&pl),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: wgpu::TextureFormat::Rgba8Unorm, blend: None, write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        let buf = device.create_buffer(&wgpu::BufferDescriptor { label: Some("video blit"), size: 48, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("video blit"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });
        VideoGpu { pipe, bgl, buf, sampler }
    }

    pub fn staging(&self, device: &wgpu::Device, size: (u32, u32)) -> Staging {
        let tex = new_tex(device, size, "video staging");
        let view = tex.create_view(&Default::default());
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("video blit"),
            layout: &self.bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });
        Staging { tex, bind, size, used: 0.0 }
    }

    /// Copy a decoded frame into `st` and filter it into `target`. Two queue operations in
    /// order: the next copy into the same staging texture lands after this filter has read it.
    #[allow(clippy::too_many_arguments)]
    pub fn upload(&self, device: &wgpu::Device, queue: &wgpu::Queue, frame: &web_sys::VideoFrame, st: &Staging, target: &wgpu::Texture, size: (u32, u32), crop: [f32; 4]) {
        queue.copy_external_image_to_texture(
            &wgpu::CopyExternalImageSourceInfo { source: wgpu::ExternalImageSource::VideoFrame(Clone::clone(frame)), origin: wgpu::Origin2d::ZERO, flip_y: false },
            wgpu::CopyExternalImageDestInfo { texture: &st.tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All, color_space: wgpu::PredefinedColorSpace::Srgb, premultiplied_alpha: true },
            wgpu::Extent3d { width: st.size.0, height: st.size.1, depth_or_array_layers: 1 },
        );
        queue.write_buffer(&self.buf, 0, bytemuck::cast_slice(&crate::shaders::blit_uniforms(st.size, size, crop)));
        let view = target.create_view(&Default::default());
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("video blit") });
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("video blit"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.pipe);
            pass.set_bind_group(0, &st.bind, &[]);
            pass.draw(0..3, 0..1);
        }
        queue.submit([enc.finish()]);
    }
}

thread_local! {
    /// Resolvers waiting on `onSubmittedWorkDone` (whose callback must be Send: it carries a token).
    static DONE: RefCell<HashMap<u64, js_sys::Function>> = RefCell::new(HashMap::new());
    static NEXT: Cell<u64> = const { Cell::new(1) };
}

/// A promise and the function that resolves it.
fn signal() -> (js_sys::Promise, js_sys::Function) {
    let slot: Rc<RefCell<Option<js_sys::Function>>> = Rc::new(RefCell::new(None));
    let s2 = slot.clone();
    let p = js_sys::Promise::new(&mut |res, _| {
        *s2.borrow_mut() = Some(res);
    });
    let f = slot.borrow_mut().take().expect("the executor runs synchronously");
    (p, f)
}

/// Resolves (with the time it happened) when the GPU has finished everything submitted before this
/// call. Registered now, so two calls around some work bracket it.
pub fn work_done(queue: &wgpu::Queue) -> impl std::future::Future<Output = f64> + 'static + use<> {
    let (p, f) = signal();
    let token = NEXT.with(|n| {
        let t = n.get();
        n.set(t + 1);
        t
    });
    DONE.with(|d| d.borrow_mut().insert(token, f));
    queue.on_submitted_work_done(move || {
        if let Some(f) = DONE.with(|d| d.borrow_mut().remove(&token)) {
            let _ = f.call1(&JsValue::NULL, &JsValue::from_f64(crate::api::now()));
        }
    });
    async move { wasm_bindgen_futures::JsFuture::from(p).await.ok().and_then(|v| v.as_f64()).unwrap_or_else(crate::api::now) }
}

/// Pipeline layout every card shares: one uniform block at group 0, binding 0, and Paper's noise
/// texture (binding 1) with a linear, clamped sampler (binding 2), the way Paper's ShaderMount uploads it.
pub struct ShaderGpu {
    pub bgl: wgpu::BindGroupLayout,
    pub pl: wgpu::PipelineLayout,
    noise: wgpu::TextureView,
    smp: wgpu::Sampler,
}

impl ShaderGpu {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> ShaderGpu {
        let fs = wgpu::ShaderStages::FRAGMENT;
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("shader card"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: fs | wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: fs, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None },
                wgpu::BindGroupLayoutEntry { binding: 2, visibility: fs, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("shader card"), bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
        let size = wgpu::Extent3d { width: NOISE_SIZE, height: NOISE_SIZE, depth_or_array_layers: 1 };
        let tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("paper noise"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            NOISE_RGBA,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(NOISE_SIZE * 4), rows_per_image: Some(NOISE_SIZE) },
            size,
        );
        let smp = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("paper noise"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        ShaderGpu { bgl, pl, noise: tex.create_view(&Default::default()), smp }
    }

    fn uniform(&self, device: &wgpu::Device) -> (wgpu::Buffer, wgpu::BindGroup) {
        let buf = device.create_buffer(&wgpu::BufferDescriptor { label: Some("shader uniforms"), size: UNIFORM_BYTES, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&self.noise) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.smp) },
            ],
        });
        (buf, bind)
    }

    pub fn card(&self, device: &wgpu::Device, id: &str) -> Card {
        Card {
            id: id.to_string(),
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
            order: 0.0,
            radius: 12.0,
            hash: 0,
            lines: 0,
            sgen: 0,
            compiled: Rc::new(RefCell::new(Compiled { sgen: 0, status: Status::Empty, fresh: false, pending: None })),
            pipeline: None,
            live: self.uniform(device),
            off: self.uniform(device),
            tex: None,
            has_frame: false,
            shows: "",
            play: true,
            clock: crate::shaders::Clock::default(),
            next_due: 0.0,
            cost: Rc::new(Cell::new(0.0)),
            probing: Rc::new(Cell::new(false)),
            probe_seen: true,
            probes: 0,
            last_probe: 0.0,
            admitted: false,
            mouse: None,
            params: [0.0; PARAM_FLOATS],
            last_render: 0.0,
            renders: 0,
            seen_frame: 0,
            snapped: false,
            denied_at: 0,
            video: None,
            fill: None,
        }
    }

    /// Start compiling `src` (already checked) for `card`. Returns a future of the compiler's errors
    /// (line numbers are the author's: our wrapper comes after their code). Errors in the wrapper part
    /// are reported without a position.
    pub fn compile(&self, device: &wgpu::Device, card: &mut Card, src: &str) -> impl std::future::Future<Output = Vec<SrcError>> + 'static {
        let lines = user_lines(src);
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("shader card"), source: wgpu::ShaderSource::Wgsl(wrap(src).into()) });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("shader card"),
            layout: Some(&self.pl),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("canvas_vs"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("canvas_fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: wgpu::TextureFormat::Rgba8Unorm, blend: None, write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        let popped = scope.pop();
        let info = module.get_compilation_info();
        card.compiled.borrow_mut().pending = Some(pipeline);
        async move {
            let info = info.await;
            let err = popped.await;
            let mut out: Vec<SrcError> = Vec::new();
            for m in info.messages {
                if m.message_type != wgpu::CompilationMessageType::Error {
                    continue;
                }
                match m.location {
                    Some(l) if l.line_number <= lines => out.push(SrcError { line: l.line_number, col: l.line_position.max(1), message: m.message }),
                    _ => out.push(SrcError { line: 0, col: 0, message: format!("in the Canvas wrapper: {}", m.message) }),
                }
            }
            if out.is_empty()
                && let Some(e) = err
            {
                let text = e.to_string();
                out.push(SrcError { line: 0, col: 0, message: text.lines().take(6).collect::<Vec<_>>().join(" ") });
            }
            out
        }
    }
}

pub const TEX_USAGE: wgpu::TextureUsages = wgpu::TextureUsages::RENDER_ATTACHMENT
    .union(wgpu::TextureUsages::TEXTURE_BINDING)
    .union(wgpu::TextureUsages::COPY_SRC)
    .union(wgpu::TextureUsages::COPY_DST);

pub fn new_tex(device: &wgpu::Device, size: (u32, u32), label: &str) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: TEX_USAGE,
        view_formats: &[],
    })
}

impl Card {
    /// A good pipeline exists (the last source that compiled cleanly); for a video, its size is known.
    pub fn ready(&self) -> bool {
        match &self.video {
            Some(v) => v.has_metadata(),
            None => self.pipeline.is_some(),
        }
    }

    pub fn is_video(&self) -> bool {
        self.video.is_some()
    }

    /// Compile finished since the last look: take the new pipeline when it compiled cleanly. Returns
    /// true when the pipeline changed.
    pub fn take_compiled(&mut self) -> bool {
        let mut c = self.compiled.borrow_mut();
        if !std::mem::take(&mut c.fresh) {
            return false;
        }
        if matches!(c.status, Status::Ready)
            && let Some(p) = c.pending.take()
        {
            self.pipeline = Some(p);
            return true;
        }
        false
    }

    /// A new pipeline replaced the old one: measure it again and show its own frame.
    pub fn new_pipeline(&mut self) {
        self.cost.set(0.0);
        self.probes = 0;
        self.has_frame = false;
        self.snapped = false;
    }

    pub fn compiling(&self) -> bool {
        matches!(self.compiled.borrow().status, Status::Compiling)
    }

    pub fn world(&self) -> kurbo::Rect {
        kurbo::Rect::new(self.x, self.y, self.x + self.w, self.y + self.h)
    }

    /// Record and submit one frame into `target` at time `t`. `live` picks the uniform buffer.
    #[allow(clippy::too_many_arguments)]
    pub fn draw(&self, device: &wgpu::Device, queue: &wgpu::Queue, target: &wgpu::Texture, size: (u32, u32), t: f64, dt: f64, frame: u64, live: bool) {
        let Some(pipe) = &self.pipeline else { return };
        let (buf, bind) = if live { &self.live } else { &self.off };
        let u = crate::shaders::uniforms((self.w, self.h), size, t, dt, frame, self.mouse.unwrap_or([0.0; 4]), &self.params);
        draw_raw(device, queue, pipe, buf, bind, target, &u);
    }

    /// What an offscreen frame needs, owned, for work that continues after this call returns.
    pub fn offscreen(&self) -> Option<Offscreen> {
        Some(Offscreen { pipe: self.pipeline.clone()?, buf: self.off.0.clone(), bind: self.off.1.clone(), res: (self.w, self.h), params: self.params })
    }
}

pub struct Offscreen {
    pub pipe: wgpu::RenderPipeline,
    pub buf: wgpu::Buffer,
    pub bind: wgpu::BindGroup,
    pub res: (f64, f64),
    pub params: [f32; PARAM_FLOATS],
}

impl Offscreen {
    pub fn draw(&self, device: &wgpu::Device, queue: &wgpu::Queue, target: &wgpu::Texture, size: (u32, u32), t: f64, frame: u64) {
        let u = crate::shaders::uniforms(self.res, size, t, 0.033, frame, [0.0; 4], &self.params);
        draw_raw(device, queue, &self.pipe, &self.buf, &self.bind, target, &u);
    }
}

/// One full-target draw of a card pipeline, in its own submit: a frame that fails validation loses
/// only its own work.
fn draw_raw(device: &wgpu::Device, queue: &wgpu::Queue, pipe: &wgpu::RenderPipeline, buf: &wgpu::Buffer, bind: &wgpu::BindGroup, target: &wgpu::Texture, u: &[f32; UNIFORM_FLOATS]) {
    queue.write_buffer(buf, 0, bytemuck::cast_slice(u));
    let view = target.create_view(&Default::default());
    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("shader card") });
    {
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("shader card"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(pipe);
        pass.set_bind_group(0, bind, &[]);
        pass.draw(0..3, 0..1);
    }
    queue.submit([enc.finish()]);
}

/// Copy `tex` (premultiplied RGBA8) back to the CPU as straight-alpha RGBA rows, the way a PNG
/// stores it. The copy is recorded now; the future waits for the map.
pub fn read_back(device: &wgpu::Device, queue: &wgpu::Queue, tex: &wgpu::Texture, size: (u32, u32)) -> impl std::future::Future<Output = Result<Vec<u8>, String>> + 'static {
    let (w, h) = size;
    let row = (w * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let buf = device.create_buffer(&wgpu::BufferDescriptor { label: Some("shader readback"), size: u64::from(row) * u64::from(h), usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let mut enc = device.create_command_encoder(&Default::default());
    enc.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture: tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo { buffer: &buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(h) } },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
    queue.submit([enc.finish()]);
    let (p, f) = signal();
    buf.map_async(wgpu::MapMode::Read, .., move |r| {
        let _ = f.call1(&JsValue::NULL, &JsValue::from_bool(r.is_ok()));
    });
    async move {
        let ok = wasm_bindgen_futures::JsFuture::from(p).await.ok().and_then(|v| v.as_bool()).unwrap_or(false);
        if !ok {
            buf.destroy();
            return Err("could not read the frame back".to_string());
        }
        let mut out = vec![0u8; (w * h * 4) as usize];
        {
            let view = buf.get_mapped_range(..).map_err(|e| format!("readback: {e:?}"))?;
            for y in 0..h as usize {
                let src = &view[y * row as usize..y * row as usize + w as usize * 4];
                out[y * w as usize * 4..(y + 1) * w as usize * 4].copy_from_slice(src);
            }
        }
        buf.unmap();
        // A dropped buffer is left to the JS garbage collector (see gpu.rs GpuTile).
        buf.destroy();
        unpremultiply(&mut out);
        Ok(out)
    }
}
