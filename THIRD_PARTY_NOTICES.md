Third-party code in Canvas, and what each one is used for.

## Corner smoothing curve

- Used in: `engine/src/paint.rs` (`smooth_path`, the smoothed-corner path), adapted to Rust.
- License: MIT

```
MIT License

Copyright (c) 2021 Tien Pham

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Paper Shaders

- Source: https://github.com/paper-design/shaders at commit `e7003a2d4e6e932e30b8fa11ec1239e6ea48e16a` (packages 0.0.82)
- License: Apache-2.0 (`vendor/paper-shaders/LICENSE`), notice in `vendor/paper-shaders/NOTICE`: "Powered by Paper Shaders: https://shaders.paper.design"
- Vendored unmodified in `vendor/paper-shaders`: the fragment shaders, shader utilities, vertex shader, colour parsing and noise texture of `packages/shaders`, the presets of `packages/shaders-react`, and the parameter definitions of `docs/src/shader-defs`, for 22 shaders (the image-only ones are left out).
- Modified works: `src/paper/library.json` holds WGSL that `scripts/paper/gen.ts` generates from that GLSL (translated by naga, vertex stage folded into the fragment stage, uniforms read from the card's uniform block); every generated shader starts with a comment saying so. `engine/src/paper_noise.rgba` is Paper's noise texture decoded to premultiplied RGBA. `src/paper/thumbs` are frames of the generated shaders.
- `src/paper.ts` imports `get-shader-color-from-string.ts` from the vendored copy at runtime.

## naga

- Source: https://crates.io/crates/naga 30.0.2 (features `glsl-in`, `wgsl-out`), used by the build tool in `engine/glsl` only. The engine already links naga through wgpu.
- License: MIT OR Apache-2.0.

## pp-rs

- Source: https://crates.io/crates/pp-rs 0.2.1 (the GLSL preprocessor naga's `glsl-in` uses), build tool only.
- License: BSD-3-Clause, Copyright (c) 2020, Corentin Wallez.

## unicode-xid

- Source: https://crates.io/crates/unicode-xid 0.2.6 (a dependency of pp-rs), build tool only.
- License: MIT OR Apache-2.0.

## npm packages the server and Canvas MCP run on

The runtime dependencies in `package.json` and everything they pull in (`pnpm licenses list --prod`), 96 packages. Licence metadata ships with the packages in `node_modules`.

| Package | Version | Licence |
|---|---|---|
| @hono/node-server | 2.1.8 | MIT |
| @iconify-json/feather | 1.2.1 | MIT |
| @iconify-json/lucide | 1.2.151 | ISC |
| @iconify-json/material-symbols | 1.2.101 | Apache-2.0 |
| @iconify-json/ph | 1.2.2 | MIT |
| @iconify/types | 2.0.0 | MIT |
| @modelcontextprotocol/sdk | 1.32.2 | MIT |
| accepts | 2.0.0 | MIT |
| ajv | 8.20.0 | MIT |
| ajv-formats | 3.0.1 | MIT |
| body-parser | 2.4.0 | MIT |
| bytes | 3.1.2 | MIT |
| call-bind-apply-helpers | 1.0.2 | MIT |
| call-bound | 1.0.4 | MIT |
| content-disposition | 2.0.1 | MIT |
| content-type | 1.0.5, 2.1.0 | MIT |
| cookie | 0.7.2 | MIT |
| cookie-signature | 1.2.2 | MIT |
| cors | 2.8.6 | MIT |
| cross-spawn | 7.0.6 | MIT |
| debug | 4.4.3 | MIT |
| depd | 2.0.0 | MIT |
| dunder-proto | 1.0.1 | MIT |
| ee-first | 1.1.1 | MIT |
| encodeurl | 2.0.3 | MIT |
| es-define-property | 1.0.1 | MIT |
| es-errors | 1.3.0 | MIT |
| es-object-atoms | 1.1.2 | MIT |
| escape-html | 1.0.3 | MIT |
| etag | 1.8.1 | MIT |
| eventsource | 3.0.7 | MIT |
| eventsource-parser | 3.1.1 | MIT |
| express | 5.3.0 | MIT |
| express-rate-limit | 8.7.4 | MIT |
| fast-deep-equal | 3.1.3 | MIT |
| fast-uri | 3.1.9 | BSD-3-Clause |
| finalhandler | 2.1.1 | MIT |
| forwarded | 0.2.0 | MIT |
| fresh | 2.0.0 | MIT |
| function-bind | 1.1.2 | MIT |
| get-intrinsic | 1.3.0 | MIT |
| get-proto | 1.0.1 | MIT |
| gopd | 1.2.0 | MIT |
| has-symbols | 1.1.0 | MIT |
| hasown | 2.0.4 | MIT |
| hono | 4.13.18 | MIT |
| http-errors | 2.0.1 | MIT |
| iconv-lite | 0.7.3 | MIT |
| inherits | 2.0.4 | ISC |
| ip-address | 10.7.6 | MIT |
| ipaddr.js | 1.9.1 | MIT |
| is-promise | 4.0.0 | MIT |
| isexe | 2.0.0 | ISC |
| jose | 6.2.17 | MIT |
| json-schema-traverse | 1.0.0 | MIT |
| json-schema-typed | 8.0.2 | BSD-2-Clause |
| math-intrinsics | 1.1.0 | MIT |
| media-typer | 1.1.1 | MIT |
| merge-descriptors | 2.0.0 | MIT |
| mime-db | 1.54.0 | MIT |
| mime-types | 3.0.2 | MIT |
| ms | 2.1.3 | MIT |
| negotiator | 1.1.0 | MIT |
| object-assign | 4.1.1 | MIT |
| object-inspect | 1.13.4 | MIT |
| on-finished | 2.4.2 | MIT |
| once | 1.4.0 | ISC |
| parseurl | 1.3.3 | MIT |
| path-key | 3.1.1 | MIT |
| path-to-regexp | 8.4.2 | MIT |
| pkce-challenge | 5.0.1 | MIT |
| proxy-addr | 2.0.8 | MIT |
| qs | 6.17.1 | BSD-3-Clause |
| range-parser | 1.3.0 | MIT |
| raw-body | 3.0.2 | MIT |
| require-from-string | 2.0.2 | MIT |
| router | 2.2.0 | MIT |
| safer-buffer | 2.1.2 | MIT |
| send | 1.2.1 | MIT |
| serve-static | 2.2.1 | MIT |
| setprototypeof | 1.2.0 | ISC |
| shebang-command | 2.0.0 | MIT |
| shebang-regex | 3.0.0 | MIT |
| side-channel | 1.1.1 | MIT |
| side-channel-list | 1.0.1 | MIT |
| side-channel-map | 1.0.1 | MIT |
| side-channel-weakmap | 1.0.2 | MIT |
| statuses | 2.0.2 | MIT |
| toidentifier | 1.0.1 | MIT |
| type-is | 2.1.0 | MIT |
| unpipe | 1.0.0 | MIT |
| vary | 1.1.2 | MIT |
| which | 2.0.2 | ISC |
| wrappy | 1.0.2 | ISC |
| zod | 4.6.7 | MIT |
| zod-to-json-schema | 3.25.2 | ISC |

## tailcat

- Used in: `cloud/tunnel` (the `canvas-tunnel` helper inside Canvas.app), which reaches a Cloud hosted on a Mac through an encrypted tunnel. Built from source at v0.7.0 (commit 546a07dc6b93df6ce42e36059f8a8b339061de7a). Its own Go dependencies (Tailscale libraries and others) are pinned in `cloud/tunnel/go.sum` and carry their own licences.
- License: BSD-3-Clause

```
BSD 3-Clause License

Copyright (c) 2020 Tailscale Inc & contributors.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Rust crates compiled into the engine

The crates `engine/Cargo.toml` builds into `engine/pkg` (WebAssembly), 143 crates, from `cargo metadata --locked`. Each crate's licence text is in its source on crates.io.

| Crate | Version | Licence |
|---|---|---|
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 |
| arrayvec | 0.7.8 | MIT OR Apache-2.0 |
| autocfg | 1.5.1 | Apache-2.0 OR MIT |
| bit-set | 0.10.0 | Apache-2.0 OR MIT |
| bit-vec | 0.9.1 | Apache-2.0 OR MIT |
| bitflags | 2.13.2 | MIT OR Apache-2.0 |
| bumpalo | 3.20.4 | MIT OR Apache-2.0 |
| bytemuck | 1.25.2 | Zlib OR Apache-2.0 OR MIT |
| bytemuck_derive | 1.12.1 | Zlib OR Apache-2.0 OR MIT |
| cfg_aliases | 0.2.2 | MIT |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 |
| codespan-reporting | 0.13.1 | Apache-2.0 |
| color | 0.3.3 | Apache-2.0 OR MIT |
| crc32fast | 1.5.5 | MIT OR Apache-2.0 |
| crunchy | 0.2.4 | MIT |
| displaydoc | 0.2.7 | MIT OR Apache-2.0 |
| document-features | 0.2.12 | MIT OR Apache-2.0 |
| equivalent | 1.0.3 | Apache-2.0 OR MIT |
| euclid | 0.22.14 | MIT OR Apache-2.0 |
| fdeflate | 0.3.7 | MIT OR Apache-2.0 |
| flate2 | 1.1.11 | MIT OR Apache-2.0 |
| foldhash | 0.2.0 | Zlib |
| font-types | 0.12.7 | MIT OR Apache-2.0 |
| fontique | 0.12.0 | Apache-2.0 OR MIT |
| futures-core | 0.3.34 | MIT OR Apache-2.0 |
| futures-intrusive | 0.5.0 | MIT OR Apache-2.0 |
| futures-task | 0.3.34 | MIT OR Apache-2.0 |
| futures-util | 0.3.34 | MIT OR Apache-2.0 |
| guillotiere | 0.7.0 | MIT/Apache-2.0 |
| half | 2.7.1 | MIT OR Apache-2.0 |
| harfrust | 0.12.0 | MIT |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 |
| icu_collections | 2.4.0 | Unicode-3.0 |
| icu_locale_core | 2.4.0 | Unicode-3.0 |
| icu_locale_fallback | 2.4.0 | Unicode-3.0 |
| icu_locale_fallback_data | 2.4.0 | Unicode-3.0 |
| icu_normalizer | 2.4.0 | Unicode-3.0 |
| icu_normalizer_data | 2.4.0 | Unicode-3.0 |
| icu_properties | 2.4.0 | Unicode-3.0 |
| icu_properties_data | 2.4.0 | Unicode-3.0 |
| icu_provider | 2.4.0 | Unicode-3.0 |
| icu_segmenter | 2.4.0 | Unicode-3.0 |
| icu_segmenter_data | 2.4.0 | Unicode-3.0 |
| indexmap | 2.14.2 | Apache-2.0 OR MIT |
| itoa | 1.0.19 | MIT OR Apache-2.0 |
| js-sys | 0.3.107 | MIT OR Apache-2.0 |
| kurbo | 0.13.1 | Apache-2.0 OR MIT |
| libc | 0.2.191 | MIT OR Apache-2.0 |
| libloading | 0.8.9 | ISC |
| libm | 0.2.16 | MIT |
| linebender_resource_handle | 0.1.1 | Apache-2.0 OR MIT |
| litemap | 0.8.3 | Unicode-3.0 |
| litrs | 1.0.1 | MIT OR Apache-2.0 |
| lock_api | 0.4.14 | MIT OR Apache-2.0 |
| log | 0.4.35 | MIT OR Apache-2.0 |
| memchr | 2.8.3 | Unlicense OR MIT |
| memmap2 | 0.9.12 | MIT OR Apache-2.0 |
| miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 |
| naga | 30.0.2 | MIT OR Apache-2.0 |
| naga-types | 30.0.2 | MIT OR Apache-2.0 |
| num-traits | 0.2.19 | MIT OR Apache-2.0 |
| once_cell | 1.21.4 | MIT OR Apache-2.0 |
| parking_lot | 0.12.5 | MIT OR Apache-2.0 |
| parking_lot_core | 0.9.12 | MIT OR Apache-2.0 |
| parlance | 0.1.1 | Apache-2.0 OR MIT |
| parley | 0.12.0 | Apache-2.0 OR MIT |
| parley_data | 0.12.0 | Apache-2.0 OR MIT |
| parley_emoji | 0.12.0 | MIT |
| parley_engine | 0.12.0 | Apache-2.0 OR MIT |
| peniko | 0.6.1 | Apache-2.0 OR MIT |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT |
| png | 0.18.1 | MIT OR Apache-2.0 |
| polycool | 0.4.0 | MIT OR Apache-2.0 |
| portable-atomic | 1.15.0 | Apache-2.0 OR MIT |
| portable-atomic-util | 0.2.8 | Apache-2.0 OR MIT |
| potential_utf | 0.1.6 | Unicode-3.0 |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 |
| profiling | 1.0.18 | MIT OR Apache-2.0 |
| quote | 1.0.47 | MIT OR Apache-2.0 |
| raw-window-handle | 0.6.2 | MIT OR Apache-2.0 OR Zlib |
| read-fonts | 0.41.0 | MIT OR Apache-2.0 |
| redox_syscall | 0.5.18 | MIT |
| renderdoc-sys | 1.1.0 | MIT OR Apache-2.0 |
| rustc-hash | 1.1.0 | Apache-2.0/MIT |
| rustversion | 1.0.23 | MIT OR Apache-2.0 |
| scopeguard | 1.2.0 | MIT OR Apache-2.0 |
| serde | 1.0.229 | MIT OR Apache-2.0 |
| serde_core | 1.0.229 | MIT OR Apache-2.0 |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 |
| serde_json | 1.0.154 | MIT OR Apache-2.0 |
| simd-adler32 | 0.3.10 | MIT |
| skrifa | 0.44.0 | MIT OR Apache-2.0 |
| slab | 0.4.12 | MIT |
| slotmap | 1.1.1 | Zlib |
| smallvec | 1.16.5 | MIT OR Apache-2.0 |
| stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 |
| static_assertions | 1.1.0 | MIT OR Apache-2.0 |
| svg_fmt | 0.4.5 | MIT/Apache-2.0 |
| syn | 2.0.119 | MIT OR Apache-2.0 |
| syn | 3.0.10 | MIT OR Apache-2.0 |
| synstructure | 0.14.0 | MIT |
| taffy | 0.15.1 | MIT |
| termcolor | 1.4.1 | Unlicense OR MIT |
| thiserror | 2.0.21 | MIT OR Apache-2.0 |
| thiserror-impl | 2.0.21 | MIT OR Apache-2.0 |
| tinystr | 0.8.5 | Unicode-3.0 |
| tokio | 1.54.1 | MIT |
| unicode-ident | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| unicode-width | 0.2.3 | MIT OR Apache-2.0 |
| utf_types | 1.0.0 | Apache-2.0 OR MIT |
| utf8_iter | 1.1.0 | Apache-2.0 OR MIT |
| vello | 0.11.0 | Apache-2.0 OR MIT |
| vello_encoding | 0.11.0 | Apache-2.0 OR MIT |
| vello_shaders | 0.11.0 | Apache-2.0 OR MIT |
| version_check | 0.9.5 | MIT/Apache-2.0 |
| wasm-bindgen | 0.2.130 | MIT OR Apache-2.0 |
| wasm-bindgen-futures | 0.4.80 | MIT OR Apache-2.0 |
| wasm-bindgen-macro | 0.2.130 | MIT OR Apache-2.0 |
| wasm-bindgen-macro-support | 0.2.130 | MIT OR Apache-2.0 |
| wasm-bindgen-shared | 0.2.130 | MIT OR Apache-2.0 |
| web-sys | 0.3.107 | MIT OR Apache-2.0 |
| wgpu | 30.0.1 | MIT OR Apache-2.0 |
| wgpu-core | 30.0.2 | MIT OR Apache-2.0 |
| wgpu-core-deps-windows-linux-android | 30.0.2 | MIT OR Apache-2.0 |
| wgpu-hal | 30.0.2 | MIT OR Apache-2.0 |
| wgpu-naga-bridge | 30.0.2 | MIT OR Apache-2.0 |
| wgpu-types | 30.0.2 | MIT OR Apache-2.0 |
| winapi-util | 0.1.11 | Unlicense OR MIT |
| windows-link | 0.2.1 | MIT OR Apache-2.0 |
| windows-sys | 0.61.2 | MIT OR Apache-2.0 |
| writeable | 0.6.4 | Unicode-3.0 |
| yoke | 0.8.4 | Unicode-3.0 |
| yoke-derive | 0.8.4 | Unicode-3.0 |
| zerocopy | 0.8.63 | BSD-2-Clause OR Apache-2.0 OR MIT |
| zerocopy-derive | 0.8.63 | BSD-2-Clause OR Apache-2.0 OR MIT |
| zerofrom | 0.1.8 | Unicode-3.0 |
| zerofrom-derive | 0.1.8 | Unicode-3.0 |
| zerotrie | 0.2.5 | Unicode-3.0 |
| zerovec | 0.11.9 | Unicode-3.0 |
| zerovec-derive | 0.11.7 | Unicode-3.0 |
| zlib-rs | 0.6.8 | Zlib |
| zmij | 1.0.23 | MIT |
