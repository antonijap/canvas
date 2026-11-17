// Paper Shaders "mesh-gradient" (github.com/paper-design/shaders@e7003a2d4e6e, Apache-2.0), modified:
// translated from GLSL ES 3.0 to WGSL by naga at build time (scripts/paper/gen.ts), the vertex stage folded
// into the fragment, uniforms read from u.params. Do not edit; regenerate.
var<private> u_time: f32;
var<private> u_resolution: vec2<f32>;
var<private> u_pixelRatio: f32;
var<private> canvas_fragCoord: vec4<f32>;
var<private> fragColor: vec4<f32>;
var<private> u_imageAspectRatio: f32;
var<private> u_originX: f32;
var<private> u_originY: f32;
var<private> u_worldWidth: f32;
var<private> u_worldHeight: f32;
var<private> u_fit: f32;
var<private> u_scale: f32;
var<private> u_rotation: f32;
var<private> u_offsetX: f32;
var<private> u_offsetY: f32;
var<private> u_colors: array<vec4<f32>, 10>;
var<private> u_colorsCount: f32;
var<private> u_distortion: f32;
var<private> u_swirl: f32;
var<private> u_grainMixer: f32;
var<private> u_grainOverlay: f32;
var<private> v_objectUV: vec2<f32>;
var<private> v_objectBoxSize: vec2<f32>;
var<private> v_responsiveUV: vec2<f32>;
var<private> v_responsiveBoxGivenSize: vec2<f32>;
var<private> v_patternUV: vec2<f32>;
var<private> v_patternBoxSize: vec2<f32>;
var<private> v_imageUV: vec2<f32>;


fn canvas_zero(t: f32, uv_2: vec2<f32>) -> vec4<f32> {
    var t_1: f32;
    var uv_3: vec2<f32>;

    t_1 = t;
    uv_3 = uv_2;
    return vec4(0f);
}

fn canvas_zero_1(t_2: f32, uv_4: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> vec4<f32> {
    var t_3: f32;
    var uv_5: vec2<f32>;
    var a_1: vec2<f32>;
    var b_1: vec2<f32>;

    t_3 = t_2;
    uv_5 = uv_4;
    a_1 = a;
    b_1 = b;
    return vec4(0f);
}

fn canvas_zero_2(t_4: f32, uv_6: vec2<f32>, l: f32) -> vec4<f32> {
    var t_5: f32;
    var uv_7: vec2<f32>;
    var l_1: f32;

    t_5 = t_4;
    uv_7 = uv_6;
    l_1 = l;
    return vec4(0f);
}

fn getBoxSize(boxRatio: f32, givenBoxSize: vec2<f32>) -> vec3<f32> {
    var boxRatio_1: f32;
    var givenBoxSize_1: vec2<f32>;
    var box: vec2<f32> = vec2(0f);
    var noFitBoxWidth: f32;

    boxRatio_1 = boxRatio;
    givenBoxSize_1 = givenBoxSize;
    let _e36 = boxRatio_1;
    let _e37 = givenBoxSize_1;
    let _e39 = boxRatio_1;
    let _e41 = givenBoxSize_1;
    box.x = (_e36 * min((_e37.x / _e39), _e41.y));
    let _e45 = box;
    noFitBoxWidth = _e45.x;
    let _e48 = u_fit;
    if (_e48 == 1f) {
        {
            let _e52 = boxRatio_1;
            let _e53 = u_resolution;
            let _e55 = boxRatio_1;
            let _e57 = u_resolution;
            box.x = (_e52 * min((_e53.x / _e55), _e57.y));
        }
    } else {
        let _e61 = u_fit;
        if (_e61 == 2f) {
            {
                let _e65 = boxRatio_1;
                let _e66 = u_resolution;
                let _e68 = boxRatio_1;
                let _e70 = u_resolution;
                box.x = (_e65 * max((_e66.x / _e68), _e70.y));
            }
        }
    }
    let _e75 = box;
    let _e77 = boxRatio_1;
    box.y = (_e75.x / _e77);
    let _e79 = box;
    let _e80 = noFitBoxWidth;
    return vec3<f32>(_e79.x, _e79.y, _e80);
}

fn canvasVertex(canvas_pos: vec2<f32>) {
    var canvas_pos_1: vec2<f32>;
    var canvas_glPosition: vec4<f32>;
    var uv_8: vec2<f32>;
    var boxOrigin: vec2<f32>;
    var givenBoxSize_2: vec2<f32>;
    var r: f32;
    var graphicRotation: mat2x2<f32>;
    var graphicOffset: vec2<f32>;
    var fixedRatio: f32 = 1f;
    var local: f32;
    var local_1: f32;
    var fixedRatioBoxGivenSize: vec2<f32>;
    var objectWorldScale: vec2<f32>;
    var local_2: f32;
    var local_3: f32;
    var responsiveRatio: f32;
    var responsiveBoxSize: vec2<f32>;
    var responsiveBoxScale: vec2<f32>;
    var patternBoxRatio: f32;
    var local_4: f32;
    var local_5: f32;
    var patternBoxGivenSize: vec2<f32>;
    var boxSizeData: vec3<f32>;
    var patternBoxNoFitBoxWidth: f32;
    var patternBoxScale: vec2<f32>;
    var imageBoxSize: vec2<f32>;
    var imageBoxScale: vec2<f32>;

    canvas_pos_1 = canvas_pos;
    let _e30 = canvas_pos_1;
    canvas_glPosition = vec4<f32>(_e30.x, _e30.y, 0f, 1f);
    let _e37 = canvas_glPosition;
    uv_8 = (_e37.xy * 0.5f);
    let _e43 = u_originX;
    let _e45 = u_originY;
    boxOrigin = vec2<f32>((0.5f - _e43), (_e45 - 0.5f));
    let _e50 = u_worldWidth;
    let _e51 = u_worldHeight;
    givenBoxSize_2 = vec2<f32>(_e50, _e51);
    let _e54 = givenBoxSize_2;
    let _e58 = u_pixelRatio;
    givenBoxSize_2 = (max(_e54, vec2(1f)) * _e58);
    let _e60 = u_rotation;
    r = ((_e60 * 3.1415927f) / 180f);
    let _e66 = r;
    let _e68 = r;
    let _e70 = r;
    let _e73 = r;
    graphicRotation = mat2x2<f32>(vec2<f32>(cos(_e66), sin(_e68)), vec2<f32>(-(sin(_e70)), cos(_e73)));
    let _e79 = u_offsetX;
    let _e81 = u_offsetY;
    graphicOffset = vec2<f32>(-(_e79), _e81);
    let _e86 = u_worldWidth;
    if (_e86 == 0f) {
        let _e89 = u_resolution;
        local = _e89.x;
    } else {
        let _e91 = givenBoxSize_2;
        local = _e91.x;
    }
    let _e94 = local;
    let _e95 = u_worldHeight;
    if (_e95 == 0f) {
        let _e98 = u_resolution;
        local_1 = _e98.y;
    } else {
        let _e100 = givenBoxSize_2;
        local_1 = _e100.y;
    }
    let _e103 = local_1;
    fixedRatioBoxGivenSize = vec2<f32>(_e94, _e103);
    let _e106 = fixedRatio;
    let _e107 = fixedRatioBoxGivenSize;
    let _e108 = getBoxSize(_e106, _e107);
    v_objectBoxSize = _e108.xy;
    let _e110 = u_resolution;
    let _e112 = v_objectBoxSize;
    objectWorldScale = (_e110.xy / _e112);
    let _e115 = uv_8;
    v_objectUV = _e115;
    let _e116 = v_objectUV;
    let _e117 = objectWorldScale;
    v_objectUV = (_e116 * _e117);
    let _e119 = v_objectUV;
    let _e120 = boxOrigin;
    let _e121 = objectWorldScale;
    v_objectUV = (_e119 + (_e120 * (_e121 - vec2(1f))));
    let _e127 = v_objectUV;
    let _e128 = graphicOffset;
    v_objectUV = (_e127 + _e128);
    let _e130 = v_objectUV;
    let _e131 = u_scale;
    v_objectUV = (_e130 / vec2(_e131));
    let _e134 = graphicRotation;
    let _e135 = v_objectUV;
    v_objectUV = (_e134 * _e135);
    let _e137 = u_worldWidth;
    if (_e137 == 0f) {
        let _e140 = u_resolution;
        local_2 = _e140.x;
    } else {
        let _e142 = givenBoxSize_2;
        local_2 = _e142.x;
    }
    let _e145 = local_2;
    let _e146 = u_worldHeight;
    if (_e146 == 0f) {
        let _e149 = u_resolution;
        local_3 = _e149.y;
    } else {
        let _e151 = givenBoxSize_2;
        local_3 = _e151.y;
    }
    let _e154 = local_3;
    v_responsiveBoxGivenSize = vec2<f32>(_e145, _e154);
    let _e156 = v_responsiveBoxGivenSize;
    let _e158 = v_responsiveBoxGivenSize;
    responsiveRatio = (_e156.x / _e158.y);
    let _e162 = responsiveRatio;
    let _e163 = v_responsiveBoxGivenSize;
    let _e164 = getBoxSize(_e162, _e163);
    responsiveBoxSize = _e164.xy;
    let _e167 = u_resolution;
    let _e169 = responsiveBoxSize;
    responsiveBoxScale = (_e167.xy / _e169);
    let _e172 = uv_8;
    v_responsiveUV = _e172;
    let _e173 = v_responsiveUV;
    let _e174 = responsiveBoxScale;
    v_responsiveUV = (_e173 * _e174);
    let _e176 = v_responsiveUV;
    let _e177 = boxOrigin;
    let _e178 = responsiveBoxScale;
    v_responsiveUV = (_e176 + (_e177 * (_e178 - vec2(1f))));
    let _e184 = v_responsiveUV;
    let _e185 = graphicOffset;
    v_responsiveUV = (_e184 + _e185);
    let _e187 = v_responsiveUV;
    let _e188 = u_scale;
    v_responsiveUV = (_e187 / vec2(_e188));
    let _e192 = v_responsiveUV;
    let _e194 = responsiveRatio;
    v_responsiveUV.x = (_e192.x * _e194);
    let _e196 = graphicRotation;
    let _e197 = v_responsiveUV;
    v_responsiveUV = (_e196 * _e197);
    let _e200 = v_responsiveUV;
    let _e202 = responsiveRatio;
    v_responsiveUV.x = (_e200.x / _e202);
    let _e204 = givenBoxSize_2;
    let _e206 = givenBoxSize_2;
    patternBoxRatio = (_e204.x / _e206.y);
    let _e210 = u_worldWidth;
    if (_e210 == 0f) {
        let _e213 = u_resolution;
        local_4 = _e213.x;
    } else {
        let _e215 = givenBoxSize_2;
        local_4 = _e215.x;
    }
    let _e218 = local_4;
    let _e219 = u_worldHeight;
    if (_e219 == 0f) {
        let _e222 = u_resolution;
        local_5 = _e222.y;
    } else {
        let _e224 = givenBoxSize_2;
        local_5 = _e224.y;
    }
    let _e227 = local_5;
    patternBoxGivenSize = vec2<f32>(_e218, _e227);
    let _e230 = patternBoxGivenSize;
    let _e232 = patternBoxGivenSize;
    patternBoxRatio = (_e230.x / _e232.y);
    let _e235 = patternBoxRatio;
    let _e236 = patternBoxGivenSize;
    let _e237 = getBoxSize(_e235, _e236);
    boxSizeData = _e237;
    let _e239 = boxSizeData;
    v_patternBoxSize = _e239.xy;
    let _e241 = boxSizeData;
    patternBoxNoFitBoxWidth = _e241.z;
    let _e244 = u_resolution;
    let _e246 = v_patternBoxSize;
    patternBoxScale = (_e244.xy / _e246);
    let _e249 = uv_8;
    v_patternUV = _e249;
    let _e250 = v_patternUV;
    let _e251 = graphicOffset;
    let _e252 = patternBoxScale;
    v_patternUV = (_e250 + (_e251 / _e252));
    let _e255 = v_patternUV;
    let _e256 = boxOrigin;
    v_patternUV = (_e255 + _e256);
    let _e258 = v_patternUV;
    let _e259 = boxOrigin;
    let _e260 = patternBoxScale;
    v_patternUV = (_e258 - (_e259 / _e260));
    let _e263 = v_patternUV;
    let _e264 = u_resolution;
    v_patternUV = (_e263 * _e264.xy);
    let _e267 = v_patternUV;
    let _e268 = u_pixelRatio;
    v_patternUV = (_e267 / vec2(_e268));
    let _e271 = u_fit;
    if (_e271 > 0f) {
        {
            let _e274 = v_patternUV;
            let _e275 = patternBoxNoFitBoxWidth;
            let _e276 = v_patternBoxSize;
            v_patternUV = (_e274 * (_e275 / _e276.x));
        }
    }
    let _e280 = v_patternUV;
    let _e281 = u_scale;
    v_patternUV = (_e280 / vec2(_e281));
    let _e284 = graphicRotation;
    let _e285 = v_patternUV;
    v_patternUV = (_e284 * _e285);
    let _e287 = v_patternUV;
    let _e288 = boxOrigin;
    let _e289 = patternBoxScale;
    v_patternUV = (_e287 + (_e288 / _e289));
    let _e292 = v_patternUV;
    let _e293 = boxOrigin;
    v_patternUV = (_e292 - _e293);
    let _e295 = v_patternUV;
    v_patternUV = (_e295 * 0.01f);
    let _e299 = u_fit;
    if (_e299 == 1f) {
        {
            let _e303 = u_resolution;
            let _e305 = u_imageAspectRatio;
            let _e307 = u_resolution;
            let _e310 = u_imageAspectRatio;
            imageBoxSize.x = (min((_e303.x / _e305), _e307.y) * _e310);
        }
    } else {
        let _e312 = u_fit;
        if (_e312 == 2f) {
            {
                let _e316 = u_resolution;
                let _e318 = u_imageAspectRatio;
                let _e320 = u_resolution;
                let _e323 = u_imageAspectRatio;
                imageBoxSize.x = (max((_e316.x / _e318), _e320.y) * _e323);
            }
        } else {
            {
                let _e328 = u_imageAspectRatio;
                let _e330 = u_imageAspectRatio;
                imageBoxSize.x = min(10f, ((10f / _e328) * _e330));
            }
        }
    }
    let _e334 = imageBoxSize;
    let _e336 = u_imageAspectRatio;
    imageBoxSize.y = (_e334.x / _e336);
    let _e338 = u_resolution;
    let _e340 = imageBoxSize;
    imageBoxScale = (_e338.xy / _e340);
    let _e343 = uv_8;
    v_imageUV = _e343;
    let _e344 = v_imageUV;
    let _e345 = imageBoxScale;
    v_imageUV = (_e344 * _e345);
    let _e347 = v_imageUV;
    let _e348 = boxOrigin;
    let _e349 = imageBoxScale;
    v_imageUV = (_e347 + (_e348 * (_e349 - vec2(1f))));
    let _e355 = v_imageUV;
    let _e356 = graphicOffset;
    v_imageUV = (_e355 + _e356);
    let _e358 = v_imageUV;
    let _e359 = u_scale;
    v_imageUV = (_e358 / vec2(_e359));
    let _e363 = v_imageUV;
    let _e365 = u_imageAspectRatio;
    v_imageUV.x = (_e363.x * _e365);
    let _e367 = graphicRotation;
    let _e368 = v_imageUV;
    v_imageUV = (_e367 * _e368);
    let _e371 = v_imageUV;
    let _e373 = u_imageAspectRatio;
    v_imageUV.x = (_e371.x / _e373);
    let _e375 = v_imageUV;
    v_imageUV = (_e375 + vec2(0.5f));
    let _e381 = v_imageUV;
    v_imageUV.y = (1f - _e381.y);
    return;
}

fn rotate(uv_9: vec2<f32>, th: f32) -> vec2<f32> {
    var uv_10: vec2<f32>;
    var th_1: f32;

    uv_10 = uv_9;
    th_1 = th;
    let _e32 = th_1;
    let _e34 = th_1;
    let _e36 = th_1;
    let _e39 = th_1;
    let _e44 = uv_10;
    return (mat2x2<f32>(vec2<f32>(cos(_e32), sin(_e34)), vec2<f32>(-(sin(_e36)), cos(_e39))) * _e44);
}

fn hash21_(p: vec2<f32>) -> f32 {
    var p_1: vec2<f32>;

    p_1 = p;
    let _e30 = p_1;
    p_1 = (fract((_e30 * vec2<f32>(0.3183099f, 0.3678794f))) + vec2(0.1f));
    let _e39 = p_1;
    let _e40 = p_1;
    let _e41 = p_1;
    p_1 = (_e39 + vec2(dot(_e40, (_e41 + vec2(19.19f)))));
    let _e48 = p_1;
    let _e50 = p_1;
    return fract((_e48.x * _e50.y));
}

fn valueNoise(st: vec2<f32>) -> f32 {
    var st_1: vec2<f32>;
    var i: vec2<f32>;
    var f: vec2<f32>;
    var a_2: f32;
    var b_2: f32;
    var c: f32;
    var d: f32;
    var u: vec2<f32>;
    var x1_: f32;
    var x2_: f32;

    st_1 = st;
    let _e30 = st_1;
    i = floor(_e30);
    let _e33 = st_1;
    f = fract(_e33);
    let _e36 = i;
    let _e37 = hash21_(_e36);
    a_2 = _e37;
    let _e39 = i;
    let _e44 = hash21_((_e39 + vec2<f32>(1f, 0f)));
    b_2 = _e44;
    let _e46 = i;
    let _e51 = hash21_((_e46 + vec2<f32>(0f, 1f)));
    c = _e51;
    let _e53 = i;
    let _e58 = hash21_((_e53 + vec2<f32>(1f, 1f)));
    d = _e58;
    let _e60 = f;
    let _e61 = f;
    let _e65 = f;
    u = ((_e60 * _e61) * (vec2(3f) - (2f * _e65)));
    let _e71 = a_2;
    let _e72 = b_2;
    let _e73 = u;
    x1_ = mix(_e71, _e72, _e73.x);
    let _e77 = c;
    let _e78 = d;
    let _e79 = u;
    x2_ = mix(_e77, _e78, _e79.x);
    let _e83 = x1_;
    let _e84 = x2_;
    let _e85 = u;
    return mix(_e83, _e84, _e85.y);
}

fn noise(n: vec2<f32>, seedOffset: vec2<f32>) -> f32 {
    var n_1: vec2<f32>;
    var seedOffset_1: vec2<f32>;

    n_1 = n;
    seedOffset_1 = seedOffset;
    let _e32 = n_1;
    let _e33 = seedOffset_1;
    let _e35 = valueNoise((_e32 + _e33));
    return _e35;
}

fn getPosition(i_1: i32, t_6: f32) -> vec2<f32> {
    var i_2: i32;
    var t_7: f32;
    var a_3: f32;
    var b_3: f32;
    var c_1: f32;
    var x: f32;
    var y: f32;

    i_2 = i_1;
    t_7 = t_6;
    let _e32 = i_2;
    a_3 = (f32(_e32) * 0.37f);
    let _e38 = i_2;
    b_3 = (0.6f + (fract((f32(_e38) / 3f)) * 0.9f));
    let _e48 = i_2;
    c_1 = (0.8f + fract((f32((_e48 + 1i)) / 4f)));
    let _e57 = t_7;
    let _e58 = b_3;
    let _e60 = a_3;
    x = sin(((_e57 * _e58) + _e60));
    let _e64 = t_7;
    let _e65 = c_1;
    let _e67 = a_3;
    y = cos(((_e64 * _e65) + (_e67 * 1.5f)));
    let _e75 = x;
    let _e76 = y;
    return (vec2(0.5f) + (0.5f * vec2<f32>(_e75, _e76)));
}

fn paperMain() {
    var uv_11: vec2<f32>;
    var grainUV: vec2<f32>;
    var mixerGrain: f32 = 0f;
    var firstFrameOffset: f32 = 41.5f;
    var t_8: f32;
    var radius: f32;
    var center: f32;
    var i_3: f32 = 1f;
    var uvRotated: vec2<f32>;
    var angle: f32;
    var color: vec3<f32> = vec3(0f);
    var opacity: f32 = 0f;
    var totalWeight: f32 = 0f;
    var i_4: i32 = 0i;
    var pos: vec2<f32>;
    var colorFraction: vec3<f32>;
    var opacityFraction: f32;
    var dist: f32;
    var weight: f32;
    var grainOverlay: f32;
    var grainOverlayV: f32;
    var grainOverlayColor: vec3<f32>;
    var grainOverlayStrength: f32;

    let _e28 = v_objectUV;
    uv_11 = _e28;
    let _e30 = uv_11;
    uv_11 = (_e30 + vec2(0.5f));
    let _e34 = uv_11;
    grainUV = (_e34 * 1000f);
    let _e40 = u_grainMixer;
    if (_e40 > 0f) {
        {
            let _e44 = u_grainMixer;
            let _e46 = grainUV;
            let _e49 = noise(_e46, vec2(0f));
            mixerGrain = ((0.4f * _e44) * (_e49 - 0.5f));
        }
    }
    let _e56 = u_time;
    let _e57 = firstFrameOffset;
    t_8 = (0.5f * (_e56 + _e57));
    let _e63 = uv_11;
    radius = smoothstep(0f, 1f, length((_e63 - vec2(0.5f))));
    let _e71 = radius;
    center = (1f - _e71);
    loop {
        let _e76 = i_3;
        if !((_e76 <= 2f)) {
            break;
        }
        {
            let _e84 = uv_11;
            let _e86 = u_distortion;
            let _e87 = center;
            let _e89 = i_3;
            let _e91 = t_8;
            let _e92 = i_3;
            let _e97 = uv_11;
            let _e105 = t_8;
            let _e107 = i_3;
            let _e112 = uv_11;
            uv_11.x = (_e84.x + ((((_e86 * _e87) / _e89) * sin((_e91 + ((_e92 * 0.4f) * smoothstep(0f, 1f, _e97.y))))) * cos(((0.2f * _e105) + ((_e107 * 2.4f) * smoothstep(0f, 1f, _e112.y))))));
            let _e121 = uv_11;
            let _e123 = u_distortion;
            let _e124 = center;
            let _e126 = i_3;
            let _e128 = t_8;
            let _e129 = i_3;
            let _e134 = uv_11;
            uv_11.y = (_e121.y + (((_e123 * _e124) / _e126) * cos((_e128 + ((_e129 * 2f) * smoothstep(0f, 1f, _e134.x))))));
        }
        continuing {
            let _e80 = i_3;
            i_3 = (_e80 + 1f);
        }
    }
    let _e142 = uv_11;
    uvRotated = _e142;
    let _e144 = uvRotated;
    uvRotated = (_e144 - vec2(0.5f));
    let _e149 = u_swirl;
    let _e151 = radius;
    angle = ((3f * _e149) * _e151);
    let _e154 = uvRotated;
    let _e155 = angle;
    let _e157 = rotate(_e154, -(_e155));
    uvRotated = _e157;
    let _e158 = uvRotated;
    uvRotated = (_e158 + vec2(0.5f));
    loop {
        let _e171 = i_4;
        if !((_e171 < 10i)) {
            break;
        }
        {
            let _e178 = i_4;
            let _e179 = u_colorsCount;
            if (_e178 >= i32(_e179)) {
                break;
            }
            let _e182 = i_4;
            let _e183 = t_8;
            let _e184 = getPosition(_e182, _e183);
            let _e185 = mixerGrain;
            pos = (_e184 + vec2(_e185));
            let _e189 = i_4;
            let _e191 = u_colors[_e189];
            let _e193 = i_4;
            let _e195 = u_colors[_e193];
            colorFraction = (_e191.xyz * _e195.w);
            let _e199 = i_4;
            let _e201 = u_colors[_e199];
            opacityFraction = _e201.w;
            let _e204 = uvRotated;
            let _e205 = pos;
            dist = length((_e204 - _e205));
            let _e209 = dist;
            dist = pow(_e209, 3.5f);
            let _e213 = dist;
            weight = (1f / (_e213 + 0.001f));
            let _e218 = color;
            let _e219 = colorFraction;
            let _e220 = weight;
            color = (_e218 + (_e219 * _e220));
            let _e223 = opacity;
            let _e224 = opacityFraction;
            let _e225 = weight;
            opacity = (_e223 + (_e224 * _e225));
            let _e228 = totalWeight;
            let _e229 = weight;
            totalWeight = (_e228 + _e229);
        }
        continuing {
            let _e175 = i_4;
            i_4 = (_e175 + 1i);
        }
    }
    let _e231 = color;
    let _e233 = totalWeight;
    color = (_e231 / vec3(max(0.0001f, _e233)));
    let _e237 = opacity;
    let _e239 = totalWeight;
    opacity = (_e237 / max(0.0001f, _e239));
    let _e242 = u_grainOverlay;
    if (_e242 > 0f) {
        {
            let _e245 = grainUV;
            let _e247 = rotate(_e245, 1f);
            let _e251 = valueNoise((_e247 + vec2(3f)));
            grainOverlay = _e251;
            let _e253 = grainOverlay;
            let _e254 = grainUV;
            let _e256 = rotate(_e254, 2f);
            let _e261 = valueNoise((_e256 + vec2(-1f)));
            grainOverlay = mix(_e253, _e261, 0.5f);
            let _e264 = grainOverlay;
            grainOverlay = pow(_e264, 1.3f);
            let _e267 = grainOverlay;
            grainOverlayV = ((_e267 * 2f) - 1f);
            let _e274 = grainOverlayV;
            grainOverlayColor = vec3(step(0f, _e274));
            let _e278 = u_grainOverlay;
            let _e279 = grainOverlayV;
            grainOverlayStrength = (_e278 * abs(_e279));
            let _e283 = grainOverlayStrength;
            grainOverlayStrength = pow(_e283, 0.8f);
            let _e286 = color;
            let _e287 = grainOverlayColor;
            let _e289 = grainOverlayStrength;
            color = mix(_e286, _e287, vec3((0.35f * _e289)));
            let _e293 = opacity;
            let _e295 = grainOverlayStrength;
            opacity = (_e293 + (0.5f * _e295));
        }
    }
    let _e298 = opacity;
    opacity = clamp(_e298, 0f, 1f);
    let _e302 = color;
    let _e303 = opacity;
    fragColor = vec4<f32>(_e302.x, _e302.y, _e302.z, _e303);
    return;
}

fn canvasShade(p_2: vec2<f32>, res: vec2<f32>, texel: vec2<f32>, time: f32, P: array<vec4<f32>, 32>) -> vec4<f32> {
    var p_3: vec2<f32>;
    var res_1: vec2<f32>;
    var texel_1: vec2<f32>;
    var time_1: f32;
    var P_1: array<vec4<f32>, 32>;

    p_3 = p_2;
    res_1 = res;
    texel_1 = texel;
    time_1 = time;
    P_1 = P;
    let _e38 = res_1;
    let _e39 = texel_1;
    u_resolution = (_e38 / _e39);
    let _e42 = texel_1;
    u_pixelRatio = (1f / _e42.x);
    let _e47 = P_1[0];
    let _e51 = time_1;
    let _e54 = P_1[0];
    u_time = ((_e47.y * 0.001f) + (_e51 * _e54.x));
    let _e58 = p_3;
    let _e60 = texel_1;
    let _e63 = res_1;
    let _e65 = p_3;
    let _e68 = texel_1;
    canvas_fragCoord = vec4<f32>((_e58.x / _e60.x), ((_e63.y - _e65.y) / _e68.y), 0.5f, 1f);
    let _e76 = P_1[1];
    u_imageAspectRatio = _e76.x;
    let _e80 = P_1[1];
    u_originX = _e80.y;
    let _e84 = P_1[1];
    u_originY = _e84.z;
    let _e88 = P_1[1];
    u_worldWidth = _e88.w;
    let _e92 = P_1[2];
    u_worldHeight = _e92.x;
    let _e96 = P_1[2];
    u_fit = _e96.y;
    let _e100 = P_1[2];
    u_scale = _e100.z;
    let _e104 = P_1[2];
    u_rotation = _e104.w;
    let _e108 = P_1[3];
    u_offsetX = _e108.x;
    let _e112 = P_1[3];
    u_offsetY = _e112.y;
    let _e118 = P_1[4];
    u_colors[0i] = _e118;
    let _e123 = P_1[5];
    u_colors[1i] = _e123;
    let _e128 = P_1[6];
    u_colors[2i] = _e128;
    let _e133 = P_1[7];
    u_colors[3i] = _e133;
    let _e138 = P_1[8];
    u_colors[4i] = _e138;
    let _e143 = P_1[9];
    u_colors[5i] = _e143;
    let _e148 = P_1[10];
    u_colors[6i] = _e148;
    let _e153 = P_1[11];
    u_colors[7i] = _e153;
    let _e158 = P_1[12];
    u_colors[8i] = _e158;
    let _e163 = P_1[13];
    u_colors[9i] = _e163;
    let _e166 = P_1[14];
    u_colorsCount = _e166.x;
    let _e170 = P_1[14];
    u_distortion = _e170.y;
    let _e174 = P_1[14];
    u_swirl = _e174.z;
    let _e178 = P_1[14];
    u_grainMixer = _e178.w;
    let _e182 = P_1[15];
    u_grainOverlay = _e182.x;
    let _e184 = p_3;
    let _e186 = res_1;
    let _e194 = p_3;
    let _e196 = res_1;
    canvasVertex(vec2<f32>((((_e184.x / _e186.x) * 2f) - 1f), (1f - ((_e194.y / _e196.y) * 2f))));
    paperMain();
    let _e203 = fragColor;
    return _e203;
}

fn main() {
    return;
}

fn shade(p: vec2<f32>) -> vec4<f32> {
  return canvasShade(p, u.resolution, u.canvas_texel, u.time, u.params);
}
