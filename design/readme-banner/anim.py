"""Animates the 3D Canvas icon for a LinkedIn post: the white frame crouches, jumps, flips, lands,
and a ripple runs through the tile's blueprint grid. 6 s loop at 30 fps, square, on a very light floor.

Run: /Applications/Blender.app/Contents/MacOS/Blender -b -P design/readme-banner/anim.py -- <frames_dir/> [samples]
Then: ffmpeg -framerate 30 -i <frames_dir>/%04d.png -c:v libx264 -pix_fmt yuv420p -crf 16 canvas-icon-linkedin.mp4
In the user's Blender (MCP) it only builds the scene, for previewing.
"""
import bpy, math, os, sys
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.environ.get("CANVAS_BANNER_DIR", os.path.join(os.getcwd(), "design", "readme-banner"))
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT_DIR = argv[0] if argv else "/tmp/canvas-anim/"
SAMPLES = int(argv[1]) if len(argv) > 1 else 64

os.environ["ICON3D_BUILD_ONLY"] = "1"
sys_argv = sys.argv
sys.argv = ["blender", "--", "/tmp/unused.png", str(SAMPLES)]
exec(compile(open(os.path.join(HERE, "icon3d.py")).read(), "icon3d.py", "exec"), {"__name__": "__main__"})
sys.argv = sys_argv

scene = bpy.context.scene
tile, ring = bpy.data.objects["Tile"], bpy.data.objects["Frame"]
FPS, END = 30, 180
scene.render.fps = FPS
scene.frame_start, scene.frame_end = 1, END


def srgb(h):
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c) + (1.0,)


# --- A very light floor instead of the shadow catcher: the blueprint stays on the icon ---
floor = bpy.data.objects["Plane"]
floor.is_shadow_catcher = False
fm = bpy.data.materials.new("Floor")
fm.use_nodes = True
N, L = fm.node_tree.nodes, fm.node_tree.links
bsdf = next(n for n in N if n.type == "BSDF_PRINCIPLED")
bsdf.inputs["Roughness"].default_value = 0.95
bsdf.inputs["Specular IOR Level"].default_value = 0.1
tc = N.new("ShaderNodeTexCoord")
sep = N.new("ShaderNodeSeparateXYZ")
L.new(tc.outputs["Object"], sep.inputs[0])


def m(op, a, b=None):
    n = N.new("ShaderNodeMath")
    n.operation = op
    for i, v in enumerate((a, b)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = v
        else:
            L.new(v, n.inputs[i])
    return n.outputs[0]


def gline(v, step, width, aa=0.004):
    d = m("MULTIPLY", m("ABSOLUTE", m("SUBTRACT", m("FRACT", m("ADD", m("DIVIDE", v, step), 0.5)), 0.5)), step)
    mr = N.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = width / 2
    mr.inputs["From Max"].default_value = width / 2 + aa
    mr.inputs["To Min"].default_value = 1
    mr.inputs["To Max"].default_value = 0
    L.new(d, mr.inputs["Value"])
    return mr.outputs[0]


X, Y = sep.outputs[0], sep.outputs[1]
minor = m("MAXIMUM", gline(X, 0.2, 0.008), gline(Y, 0.2, 0.008))
major = m("MAXIMUM", gline(X, 1.0, 0.014), gline(Y, 1.0, 0.014))
g = m("MAXIMUM", m("MULTIPLY", minor, 0.05), m("MULTIPLY", major, 0.11))
mix = N.new("ShaderNodeMix")
mix.data_type = "RGBA"
mix.inputs["A"].default_value = srgb("#F3F6FB")
mix.inputs["B"].default_value = srgb("#FFFFFF")
mix.inputs["Factor"].default_value = 0  # plain; link g here for a faint grid
L.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
floor.data.materials.clear()
floor.data.materials.append(fm)
next(n for n in scene.world.node_tree.nodes if n.type == "BACKGROUND").inputs["Color"].default_value = srgb("#F4F7FC")

# --- Grid ripple on the tile when the frame lands: a bright ring that runs outwards ---
tm = tile.data.materials[0]
TN, TL = tm.node_tree.nodes, tm.node_tree.links
wave = TN.new("ShaderNodeValue")
wave.name = "Wave"
wave.outputs[0].default_value = -1
mixnode = next(n for n in TN if n.type == "MIX" and n.data_type == "RGBA")
grid_in = mixnode.inputs["Factor"].links[0].from_socket
tsep = next(n for n in TN if n.type == "SEPXYZ" and n.inputs[0].links and n.inputs[0].links[0].from_node.type == "TEX_COORD")


def tm_math(op, a, b=None):
    n = TN.new("ShaderNodeMath")
    n.operation = op
    for i, v in enumerate((a, b)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = v
        else:
            TL.new(v, n.inputs[i])
    return n.outputs[0]


tx, ty = tsep.outputs[0], tsep.outputs[1]
rad = tm_math("SQRT", tm_math("ADD", tm_math("MULTIPLY", tx, tx), tm_math("MULTIPLY", ty, ty)))
# pulse = max(0, 1 - |rad - wave| / 0.16) ^ 2, fading as the wave travels
p = tm_math("MAXIMUM", tm_math("SUBTRACT", 1.0, tm_math("DIVIDE", tm_math("ABSOLUTE", tm_math("SUBTRACT", rad, wave.outputs[0])), 0.16)), 0.0)
p = tm_math("MULTIPLY", p, p)
p = tm_math("MULTIPLY", p, tm_math("MAXIMUM", tm_math("SUBTRACT", 1.0, tm_math("MULTIPLY", wave.outputs[0], 0.55)), 0.0))
boost = tm_math("ADD", 1.0, tm_math("MULTIPLY", p, 3.2))
TL.new(tm_math("MINIMUM", tm_math("MULTIPLY", grid_in, boost), 0.9), mixnode.inputs["Factor"])
# The ring also lights the tile surface a little.
bsdf_t = next(n for n in TN if n.type == "BSDF_PRINCIPLED")
bsdf_t.inputs["Emission Color"].default_value = srgb("#7CC4FF")
TL.new(tm_math("MULTIPLY", p, 0.35), bsdf_t.inputs["Emission Strength"])


def key_wave(frame, value):
    wave.outputs[0].default_value = value
    wave.outputs[0].keyframe_insert("default_value", frame=frame)


key_wave(1, -1.0)
key_wave(111, -0.3)
key_wave(150, 1.6)
key_wave(151, -1.0)

# --- The frame's jump ---
REST_Z = ring.location.z
RZ = math.radians(-8)
ring.rotation_mode = "XYZ"


def key(frame, z=REST_Z, rx=0.0, rz=RZ, sxy=1.0, sz=1.0, ease=None):
    ring.location.z = z
    ring.rotation_euler = (rx, 0, rz)
    ring.scale = (sxy, sxy, sz)
    for path in ("location", "rotation_euler", "scale"):
        ring.keyframe_insert(path, frame=frame)


key(1)
key(14, z=REST_Z + 0.05)                                         # idle bob
key(28)
key(40, z=REST_Z - 0.12, sxy=1.09, sz=0.62)                      # crouch
key(48, z=REST_Z + 0.5, sxy=0.93, sz=1.25)                      # launch, stretched
key(78, z=REST_Z + 1.05, rx=math.pi, rz=RZ - math.pi / 4)        # apex, upside down
key(104, z=REST_Z + 0.15, rx=2 * math.pi, rz=RZ - math.pi / 2, sxy=0.96, sz=1.12)
key(110, z=REST_Z - 0.13, rx=2 * math.pi, rz=RZ - math.pi / 2, sxy=1.12, sz=0.6)   # land, squashed
key(119, z=REST_Z + 0.06, rx=2 * math.pi, rz=RZ - math.pi / 2, sxy=0.97, sz=1.08)
key(128, z=REST_Z - 0.02, rx=2 * math.pi, rz=RZ - math.pi / 2)
key(138, z=REST_Z, rx=2 * math.pi, rz=RZ - math.pi / 2)
key(158, z=REST_Z + 0.05, rx=2 * math.pi, rz=RZ - math.pi / 2)
key(END + 1, z=REST_Z, rx=2 * math.pi, rz=RZ - math.pi / 2)   # same pose as frame 1: the square repeats every 90 degrees

# The tile dips under the landing.
TZ = tile.location.z
for f, dz in ((1, 0), (106, 0), (112, -0.06), (122, 0.015), (132, 0)):
    tile.location.z = TZ + dz
    tile.keyframe_insert("location", frame=f)
tile.location.z = TZ


def ease_all(ob_or_data):
    ad = ob_or_data.animation_data
    if not ad or not ad.action:
        return
    try:
        curves = ad.action.fcurves
    except AttributeError:  # Blender 5 layered actions
        curves = [fc for layer in ad.action.layers for strip in layer.strips
                  for bag in strip.channelbags for fc in bag.fcurves]
    for fc in curves:
        for kp in fc.keyframe_points:
            kp.interpolation = "BEZIER"
            kp.handle_left_type = kp.handle_right_type = "AUTO_CLAMPED"
    return curves


ease_all(ring)
ease_all(tile)
for fc in ease_all(tm.node_tree) or []:
    for kp in fc.keyframe_points:
        kp.interpolation = "LINEAR"

# Softer key: the tile reads paler from this far back.
bpy.data.objects["Key"].data.energy *= 0.8

# --- Camera: square, room above for the jump ---
cam = scene.camera
target = Vector((0, 0, 0.62))
direction = Vector((0.28, -0.42, 1.0)).normalized()
cam.data.lens = 85
cam.location = target + direction * 13.2
cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
cam.rotation_euler.rotate_axis("Z", math.radians(-4))

r = scene.render
r.resolution_x = r.resolution_y = 1080
r.film_transparent = False
r.image_settings.color_mode = "RGB"
scene.cycles.samples = SAMPLES
r.filepath = OUT_DIR

if not bpy.app.background:
    scene.frame_set(1)
else:
    bpy.ops.render.render(animation=True)
    print("WROTE", OUT_DIR)
