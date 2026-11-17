"""Renders the Canvas app icon as a 3D object for the README banner.

Run: /Applications/Blender.app/Contents/MacOS/Blender -b -P design/readme-banner/icon3d.py -- <out.png> [samples]
The icon follows design/app-icon/canvas-icon.svg: a blue tile with a blueprint grid, and a puffy white
rounded-square frame floating above it, turned -8 degrees. Transparent background, with a shadow catcher
so the tile drops a soft shadow onto whatever sits behind it in the banner.
"""
import bpy, math, sys
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[0] if argv else "/tmp/icon3d.png"
SAMPLES = int(argv[1]) if len(argv) > 1 else 160

LIVE = not bpy.app.background  # run inside the user's Blender (MCP): build the scene, don't render
if LIVE:
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# Icon units: the SVG tile is 824 px wide; here it is 2.0 wide, so 1 unit = 412 px.
S = 1 / 412


def srgb(h):
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c) + (1.0,)


def rounded_rect(spline, half, r, n=12):
    """A rounded rectangle of half-size `half` and corner radius `r`, as poly points (counter-clockwise)."""
    pts = []
    for cx, cy, a0 in ((half - r, half - r, 0), (-half + r, half - r, 90), (-half + r, -half + r, 180), (half - r, -half + r, 270)):
        for i in range(n + 1):
            a = math.radians(a0 + 90 * i / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    spline.points.add(len(pts) - 1)
    for p, (x, y) in zip(spline.points, pts):
        p.co = (x, y, 0, 1)
    spline.use_cyclic_u = True


def curve_obj(name, loops, extrude, bevel, offset=0.0):
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "2D"
    cu.fill_mode = "BOTH"
    cu.extrude = extrude
    cu.bevel_depth = bevel
    cu.bevel_resolution = 10
    cu.offset = offset
    cu.resolution_u = 12
    for half, r in loops:
        rounded_rect(cu.splines.new("POLY"), half, r)
    ob = bpy.data.objects.new(name, cu)
    scene.collection.objects.link(ob)
    return ob


# --- Tile: 2 x 2, corner radius ~ 0.45 (the SVG's squircle reads close to a 185 px radius) ---
TILE_T = 0.24  # thick enough that the grid on the sides reads
tile = curve_obj("Tile", [(1.0, 0.45)], extrude=TILE_T, bevel=0.05, offset=-0.05)

# --- Frame: outer 456 px with r 104, hole 318 px with r 52, turned -8 degrees ---
RING_BEVEL = 0.095
# A curve bevel grows each loop by the bevel depth, so draw the outer loop that much smaller and the hole that much
# bigger: the band comes out a little chunkier than the SVG's 456/318 px, with a round, puffy profile.
ring = curve_obj("Frame", [(236 * S - RING_BEVEL, 108 * S - RING_BEVEL), (150 * S + RING_BEVEL, 48 * S + RING_BEVEL)],
                 extrude=0.03, bevel=RING_BEVEL)
ring.rotation_euler = (0, 0, math.radians(-8))
ring.location = (0, 6 * S * -1, TILE_T + 0.22)

# --- Materials ---
def tile_material():
    m = bpy.data.materials.new("Tile")
    m.use_nodes = True
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    bsdf = next(n for n in N if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.42
    bsdf.inputs["Coat Weight"].default_value = 0.3
    bsdf.inputs["Coat Roughness"].default_value = 0.2

    tc = N.new("ShaderNodeTexCoord")
    sep = N.new("ShaderNodeSeparateXYZ")
    L.new(tc.outputs["Object"], sep.inputs[0])
    X, Y = sep.outputs[0], sep.outputs[1]

    def math_node(op, a, b=None, clamp=False):
        n = N.new("ShaderNodeMath")
        n.operation = op
        n.use_clamp = clamp
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                L.new(v, n.inputs[i])
        return n.outputs[0]

    def line(d, width, aa=0.003):
        """1 on a line of `width` around d == 0, 0 elsewhere, soft edge aa."""
        mr = N.new("ShaderNodeMapRange")
        mr.inputs["From Min"].default_value = width / 2
        mr.inputs["From Max"].default_value = width / 2 + aa
        mr.inputs["To Min"].default_value = 1
        mr.inputs["To Max"].default_value = 0
        L.new(d, mr.inputs["Value"])
        return mr.outputs[0]

    def grid_dist(v, step):
        # distance to the nearest multiple of step: |fract(v/step + .5) - .5| * step
        a = math_node("DIVIDE", v, step)
        a = math_node("ADD", a, 0.5)
        a = math_node("FRACT", a)
        a = math_node("SUBTRACT", a, 0.5)
        a = math_node("ABSOLUTE", a)
        return math_node("MULTIPLY", a, step)

    # The grid wraps over the edge and runs down the sides: lines along X show where the surface faces +-Y
    # (and on top), lines along Y where it faces +-X. One line rings the sides at half height.
    geo = N.new("ShaderNodeNewGeometry")
    nrm = N.new("ShaderNodeSeparateXYZ")
    L.new(geo.outputs["Normal"], nrm.inputs[0])
    wx = math_node("SUBTRACT", 1.0, math_node("ABSOLUTE", nrm.outputs[0]))
    wy = math_node("SUBTRACT", 1.0, math_node("ABSOLUTE", nrm.outputs[1]))
    side = math_node("LESS_THAN", math_node("ABSOLUTE", nrm.outputs[2]), 0.5)
    ring_z = math_node("MULTIPLY", line(math_node("ABSOLUTE", math_node("SUBTRACT", sep.outputs[2], TILE_T / 2)), 0.008), side)

    def both(step, width):
        return math_node("MAXIMUM", math_node("MULTIPLY", line(grid_dist(X, step), width), wx),
                         math_node("MULTIPLY", line(grid_dist(Y, step), width), wy))

    minor = math_node("MAXIMUM", both(0.1, 0.007), ring_z)
    major = both(0.4, 0.012)
    ax, ay = math_node("ABSOLUTE", X), math_node("ABSOLUTE", Y)
    diag = line(math_node("ABSOLUTE", math_node("SUBTRACT", ax, ay)), 0.009)
    diag = math_node("MULTIPLY", diag, math_node("LESS_THAN", math_node("MAXIMUM", ax, ay), 0.85))
    axes = math_node("MAXIMUM", math_node("MULTIPLY", line(ax, 0.009), wx), math_node("MULTIPLY", line(ay, 0.009), wy))
    axes = math_node("MULTIPLY", axes, math_node("LESS_THAN", math_node("MINIMUM", ax, ay), 0.9))  # the centre lines run down the sides too
    rad = math_node("SQRT", math_node("ADD", math_node("MULTIPLY", X, X), math_node("MULTIPLY", Y, Y)))
    circle = line(math_node("ABSOLUTE", math_node("SUBTRACT", rad, 0.70)), 0.009)

    g = math_node("MULTIPLY", minor, 0.24)
    g = math_node("MAXIMUM", g, math_node("MULTIPLY", major, 0.45))
    g = math_node("MAXIMUM", g, math_node("MULTIPLY", diag, 0.5))
    g = math_node("MAXIMUM", g, math_node("MULTIPLY", axes, 0.5))
    g = math_node("MAXIMUM", g, math_node("MULTIPLY", circle, 0.5))
    # Not on the underside; fade towards the bottom like the SVG's grid mask.
    top = math_node("GREATER_THAN", nrm.outputs[2], -0.5)  # everything but the underside
    fade = math_node("ADD", math_node("MULTIPLY", Y, 0.1), 0.9)
    g = math_node("MULTIPLY", math_node("MULTIPLY", g, top), fade)

    # Base gradient top (+Y) to bottom (-Y): #3AA6FF, #0A84FF, #0062E0
    ramp = N.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = srgb("#0062E0")
    ramp.color_ramp.elements[1].position = 1.0
    ramp.color_ramp.elements[1].color = srgb("#3AA6FF")
    mid = ramp.color_ramp.elements.new(0.5)
    mid.color = srgb("#0A84FF")
    gy = N.new("ShaderNodeMapRange")
    gy.inputs["From Min"].default_value = -1
    gy.inputs["From Max"].default_value = 1
    L.new(Y, gy.inputs["Value"])
    L.new(gy.outputs[0], ramp.inputs[0])

    mix = N.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs["B"].default_value = (1, 1, 1, 1)
    L.new(g, mix.inputs["Factor"])
    L.new(ramp.outputs["Color"], mix.inputs["A"])
    L.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
    return m


def frame_material():
    m = bpy.data.materials.new("Frame")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = srgb("#F4F9FF")
    bsdf.inputs["Roughness"].default_value = 0.38
    bsdf.inputs["Subsurface Weight"].default_value = 0.25
    bsdf.inputs["Subsurface Radius"].default_value = (0.4, 0.6, 1.0)
    bsdf.inputs["Subsurface Scale"].default_value = 0.05
    bsdf.inputs["Coat Weight"].default_value = 0.35
    bsdf.inputs["Coat Roughness"].default_value = 0.15
    return m


tile.data.materials.append(tile_material())
ring.data.materials.append(frame_material())

# --- Shadow catcher under the tile ---
bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, -0.051))
catcher = bpy.context.active_object
catcher.is_shadow_catcher = True

# --- Lights ---
def area(name, loc, energy, size, color=(1, 1, 1)):
    ld = bpy.data.lights.new(name, "AREA")
    ld.energy = energy
    ld.size = size
    ld.color = color
    ob = bpy.data.objects.new(name, ld)
    ob.location = loc
    scene.collection.objects.link(ob)
    d = Vector((0, 0, 0.2)) - Vector(loc)
    ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    return ob


area("Key", (-3.2, 2.6, 5.5), 420, 3.0)
# Fill and rim cast no shadow: the low rim light threw a long faint shadow that showed as a grey box on light
# backgrounds once the render was cropped.
for ob in (area("Fill", (4.5, -3.0, 3.0), 110, 5.0, (0.86, 0.92, 1.0)), area("Rim", (2.5, 5.0, 1.6), 260, 2.5, (0.8, 0.9, 1.0))):
    ob.data.use_shadow = False

world = bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
bg.inputs["Color"].default_value = srgb("#C9DBF5")
bg.inputs["Strength"].default_value = 0.3

# --- Camera: three-quarter view from below-right, looking up at the tile so it tips back ---
cam_d = bpy.data.cameras.new("Cam")
cam_d.lens = 85
cam = bpy.data.objects.new("Cam", cam_d)
scene.collection.objects.link(cam)
scene.camera = cam
target = Vector((0, 0, 0.18))
direction = Vector((0.28, -0.42, 1.0)).normalized()
cam.location = target + direction * 8.4
cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
cam.rotation_euler.rotate_axis("Z", math.radians(-4))

# --- Render ---
r = scene.render
try:
    r.engine = "CYCLES"
except TypeError as e:
    print(e)
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = True
try:
    scene.cycles.device = "GPU"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = True
except Exception as e:
    print("GPU setup:", e)
r.resolution_x = 1400
r.resolution_y = 1400
r.film_transparent = True
r.image_settings.file_format = "PNG"
r.image_settings.color_mode = "RGBA"
scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "None"
r.filepath = OUT
import os
if not LIVE and not os.environ.get("ICON3D_BUILD_ONLY"):  # anim.py builds on this scene and renders itself
    bpy.ops.render.render(write_still=True)
    print("WROTE", OUT)
