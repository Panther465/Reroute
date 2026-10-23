# Roo, the green sprout, as a plush toy. This script builds the "Roo" scene in Blender 5.2 from nothing: the
# stuffed shapes, real fur (hair curves grown by geometry nodes), a stitched face and felt mouth, and a soft
# studio. render_roo.py then renders it into the layers the web app stacks and moves (src/components/roo3d/).
#
#   exec(open(r"<repo>/frontend/roo3d/build_roo.py").read()); build()
#
# Units: the body is 1 from its centre to its side, as in the app. Z is up and Roo faces -Y.

import math
import random

import bmesh
import bpy
from mathutils import Vector

SCENE = "Roo"
# Sizes and places are measured from the reference photo, in body radii from the body's centre.
GROUND = -1.1

# The body: round from the front, a little shallower front to back. It stands on its feet.
BODY = Vector((1.0, 0.95, 1.0))

# Where the shoulders, the sprout and the feet are. The arms hang low on the sides, angled a little out.
SHOULDER = Vector((0.96, 0.08, -0.05))
ARM_REST = math.radians(22)
STEM_BASE = Vector((0.0, 0.0, 0.9))
FOOT = Vector((0.34, -0.37, GROUND + 0.2))

# The face, as seen from straight ahead (x across, z up) and laid onto the body's front. The stitching and the
# felt sit FACE_LIFT out from the fabric, up on the pile (as if sewn on top of it), which is pressed flat only
# right under them: so they sit on the fur, not down in a hollow.
EYE = (0.41, 0.245)  # each eye's middle (x mirrored)
MOUTH_Z = -0.24  # where the mouth's corners meet
MOUTH_UNIT = 1.1 / 29  # the app's mouth shapes are in flat-drawing units, 29 to the body's radius
CHEEK = (0.64, -0.125, 0.15, 0.111)  # centre x and z, radii
FACE_LIFT = 0.045
HAPPY = {"open": 0.55, "wide": 0.45, "round": 0.0, "smile": 1.0}

# The pile on the body and arms (the fur_nodes() inputs; the feet, stem and leaves have shorter pile).
PILE = dict(
    density=260000.0,
    length=0.16,
    length_random=0.4,
    root_radius=0.0007,
    rise=0.65,
    lie=1.5,
    lie_random=0.1,
    comb_random=0.3,
    tousle=0.45,
    tousle_scale=3.0,
    wave=0.05,
    waves=1.2,
    frizz=0.04,
    clump=0.25,
    clump_density=7000.0,
    stray=0.015,
)

# The fur's colours (root to tip) and the light, calibrated so renders measure like the photo.
FUR_ROOT, FUR_TIP = "#326D3D", "#589460"
STEM_ROOT, STEM_TIP = "#1E4A26", "#356E3E"
KEY, FILL, RIM, TOP, ROOM = 350.0, 380.0, 40.0, 230.0, 0.4
BOUNCE = 200.0

# The layers are rendered square, LAYER_FRAME across, centred on LAYER_CENTRE.
LAYER_FRAME = 3.1
LAYER_CENTRE = Vector((0.0, 0.0, 0.22))


def lin(hex_: str, a: float = 1.0):
    """An sRGB hex colour as linear RGBA, which is what Blender's colour inputs take."""
    h = hex_.lstrip("#")
    srgb = [int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    return (*[v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in srgb], a)


# ---------- scene ----------


def roo_scene() -> bpy.types.Scene:
    sc = bpy.data.scenes.get(SCENE) or bpy.data.scenes.new(SCENE)
    if bpy.context.window:
        bpy.context.window.scene = sc
    sc.render.engine = "CYCLES"
    sc.cycles.device = "GPU"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "OPTIX"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type != "CPU"
    sc.unit_settings.system = "METRIC"
    sc.render.fps = 60
    try:
        sc.view_settings.view_transform = "Khronos PBR Neutral"
    except TypeError:
        sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    sc.view_settings.exposure = 0.15
    sc.cycles_curves.shape = "THICK"
    return sc


def clear(sc: bpy.types.Scene):
    """Empties the Roo scene (only it: nothing else in the file is touched)."""
    for coll in list(sc.collection.children):
        for ob in list(coll.all_objects):
            bpy.data.objects.remove(ob, do_unlink=True)
        for child in list(coll.children_recursive):
            bpy.data.collections.remove(child)
        bpy.data.collections.remove(coll)
    for ob in list(sc.collection.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for name in ("Roo Lit", "Roo Lit From Below"):
        if bpy.data.collections.get(name):
            bpy.data.collections.remove(bpy.data.collections[name])
    for block in (bpy.data.meshes, bpy.data.curves, bpy.data.hair_curves, bpy.data.materials, bpy.data.lights, bpy.data.cameras):
        for item in list(block):
            if item.name.startswith("Roo ") and item.users == 0:
                block.remove(item)


def collection(sc: bpy.types.Scene, name: str) -> bpy.types.Collection:
    coll = bpy.data.collections.new(name)
    sc.collection.children.link(coll)
    return coll


def place(coll: bpy.types.Collection, name: str, data, location=(0, 0, 0), parent=None) -> bpy.types.Object:
    ob = bpy.data.objects.new(name, data)
    ob.location = location
    coll.objects.link(ob)
    if parent is not None:
        ob.parent = parent
    return ob


# ---------- shapes ----------


def mesh_from(name: str, bm: bmesh.types.BMesh, closed: bool = True) -> bpy.types.Mesh:
    # Faces outwards: a closed mesh's signed volume is positive. (recalc_face_normals can be fooled by the
    # leaves' pinched ends.)
    bm.normal_update()
    volume = sum(f.calc_center_median().dot(f.normal) * f.calc_area() for f in bm.faces)
    if closed and volume < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.shade_smooth()
    return me


def sphere_mesh(name: str, fn, u: int = 64, v: int = 40) -> bpy.types.Mesh:
    """A UV sphere (poles on Z) with every vertex moved by fn(unit sphere point)."""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=1.0, calc_uvs=True)
    for vert in bm.verts:
        vert.co = fn(vert.co.copy())
    return mesh_from(name, bm)


def body_shape(p: Vector) -> Vector:
    return Vector((p.x * BODY.x, p.y * BODY.y, p.z * BODY.z))


def body_point(x: float, z: float, lift: float = 0.0):
    """The point on the body's front seen at (x, z) from straight ahead, `lift` out along the surface, and its
    normal."""
    a, b, c = BODY
    y = -b * math.sqrt(max(1e-6, 1 - (x / a) ** 2 - (z / c) ** 2))
    n = Vector((x / a**2, y / b**2, z / c**2)).normalized()
    return Vector((x, y, z)) + n * lift, n


def arm_shape(p: Vector) -> Vector:
    # A stuffed stub like a bean, hanging from the shoulder (the origin), fuller at the paw end.
    t = (1 - p.z) / 2
    s = 0.9 + 0.16 * t
    return Vector((p.x * 0.165 * s, p.y * 0.155 * s, p.z * 0.35 - 0.32))


def foot_shape(p: Vector) -> Vector:
    # An oblong pill lying across, flatter underneath.
    p = Vector((p.x * 0.265, p.y * 0.245, p.z * 0.2))
    if p.z < 0:
        p.z *= 0.85
    return p


def stem_mesh(name: str) -> bpy.types.Mesh:
    """A thin stem from inside the head, in a gentle S, with a rounded top. Origin at its base."""
    rings, segs, length = 30, 16, 0.46
    bm = bmesh.new()
    ring_verts = []
    for i in range(rings + 1):
        t = i / rings
        centre = Vector((0.05 * t * t - 0.02 * math.sin(math.pi * t), 0.0, length * t))
        tangent = Vector((0.1 * t - 0.02 * math.pi * math.cos(math.pi * t), 0.0, length)).normalized()
        across = tangent.cross(Vector((0, 1, 0))).normalized()
        depth = tangent.cross(across)
        cap = 1.0 if t < 0.9 else math.sqrt(max(0.0, 1 - ((t - 0.9) / 0.1) ** 2))
        r = (0.044 - 0.007 * t) * cap
        if i == rings:
            ring_verts.append([bm.verts.new(centre)])
            break
        ring_verts.append([bm.verts.new(centre + (across * math.cos(a) + depth * math.sin(a)) * r) for a in (2 * math.pi * k / segs for k in range(segs))])
    for i in range(rings - 1):
        a, b = ring_verts[i], ring_verts[i + 1]
        for k in range(segs):
            bm.faces.new((a[k], a[(k + 1) % segs], b[(k + 1) % segs], b[k]))
    tip = ring_verts[-1][0]
    last = ring_verts[-2]
    for k in range(segs):
        bm.faces.new((last[k], last[(k + 1) % segs], tip))
    bm.faces.new(list(reversed(ring_verts[0])))
    return mesh_from(name, bm)


def leaf_mesh(name: str, length: float, width: float, thick: float, side: int) -> bpy.types.Mesh:
    """A soft plush leaf: narrow at the stem, widest a little before halfway, pointed at the tip, and folded
    along its middle so its halves tilt forward. Origin at its base; it points along +X (or -X for side -1)
    with its face to the front."""

    def fn(p: Vector) -> Vector:
        t = (p.z + 1) / 2  # 0 at the base, 1 at the tip
        ring = math.sqrt(max(0.0, 1 - p.z * p.z))
        cos_a, sin_a = (p.x / ring, p.y / ring) if ring > 1e-6 else (0.0, 0.0)
        f = math.sin(math.pi * t**0.85) ** 0.9
        up = cos_a * width / 2 * f
        front = sin_a * thick / 2 * f**0.6
        fold = -0.22 * abs(up) - 0.12 * (up * up) / (width / 2)  # the halves tilt towards the front
        arch = 0.05 * length * math.sin(math.pi * t)
        return Vector((side * length * t, front + fold, up + arch))

    me = sphere_mesh(name, fn, 48, 36)
    return me


def ellipsoid(name: str, radii) -> bpy.types.Mesh:
    return sphere_mesh(name, lambda p: Vector((p.x * radii[0], p.y * radii[1], p.z * radii[2])))


# ---------- materials ----------


def principled(name: str, colour: str, roughness: float = 1.0, sheen: float = 0.0) -> bpy.types.Material:
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = lin(colour)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Sheen Weight"].default_value = sheen
    mat.diffuse_color = lin(colour)
    return mat


def fur_material(name: str, root: str, tip: str) -> bpy.types.Material:
    """Plush pile: soft, matte fibres, darker at the root where the pile shades itself and lighter at the tips,
    each strand a shade different from its neighbours."""
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    hair = nt.nodes.new("ShaderNodeBsdfHairPrincipled")
    hair.model = "CHIANG"
    hair.parametrization = "COLOR"
    hair.inputs["Roughness"].default_value = 0.65
    hair.inputs["Radial Roughness"].default_value = 0.95
    hair.inputs["Coat"].default_value = 0.0
    hair.inputs["IOR"].default_value = 1.5
    hair.inputs["Random Roughness"].default_value = 0.2
    info = nt.nodes.new("ShaderNodeHairInfo")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = lin(root)
    ramp.color_ramp.elements[1].position = 1.0
    ramp.color_ramp.elements[1].color = lin(tip)
    nt.links.new(info.outputs["Intercept"], ramp.inputs["Fac"])
    shade = nt.nodes.new("ShaderNodeMapRange")
    shade.inputs["To Min"].default_value = 0.86
    shade.inputs["To Max"].default_value = 1.12
    nt.links.new(info.outputs["Random"], shade.inputs["Value"])
    vary = nt.nodes.new("ShaderNodeMix")
    vary.data_type = "RGBA"
    vary.blend_type = "MULTIPLY"
    vary.inputs["Factor"].default_value = 1.0
    nt.links.new(ramp.outputs["Color"], vary.inputs["A"])
    nt.links.new(shade.outputs["Result"], vary.inputs["B"])
    nt.links.new(vary.outputs["Result"], hair.inputs["Color"])
    nt.links.new(info.outputs["Random"], hair.inputs["Random"])
    nt.links.new(hair.outputs[0], out.inputs["Surface"])
    mat.diffuse_color = lin(tip)
    return mat


# ---------- fur ----------


def fur_nodes() -> bpy.types.NodeTree:
    """Roo's fur as geometry nodes, on a hair object that rides on the part it covers (Cycles draws real hair
    only from hair objects). Like a long-pile plush, it grows in locks: each lock has its own direction (combed
    one way, `Comb`, in the part's own axes, with a slow tousle across the surface and a turn of its own), length,
    tilt and wave, and its strands follow it, each a little different, gathering towards its middle at the tip.
    A strand rises a little from the fabric and bends over to lie nearly flat. A few strays run longer, for the
    wispy outline. Under the stitched face the pile is pressed flat (a mask drawn from the front), and so are
    strands that would lie across it. The viewport shows a sparse version; renders get the full density."""
    old = bpy.data.node_groups.get("Roo Fur")
    if old:
        bpy.data.node_groups.remove(old)
    ng = bpy.data.node_groups.new("Roo Fur", "GeometryNodeTree")

    def put(name, kind, default=None, lo=None, hi=None, out=False):
        s = ng.interface.new_socket(name, in_out="OUTPUT" if out else "INPUT", socket_type=kind)
        if default is not None:
            s.default_value = default
        if lo is not None:
            s.min_value = lo
        if hi is not None:
            s.max_value = hi

    put("Geometry", "NodeSocketGeometry")
    put("Surface", "NodeSocketObject")
    put("Density", "NodeSocketFloat", 200000.0, 0.0)
    put("Viewport Density", "NodeSocketFloat", 2500.0, 0.0)
    put("Length", "NodeSocketFloat", 0.12, 0.0)
    put("Length Random", "NodeSocketFloat", 0.35, 0.0, 1.0)
    put("Root Radius", "NodeSocketFloat", 0.0007, 0.0)
    put("Tip Radius", "NodeSocketFloat", 0.35, 0.0, 1.0)
    put("Rise", "NodeSocketFloat", 0.12)  # radians off the surface's normal at the root
    put("Lie", "NodeSocketFloat", 1.45)  # and at the tip
    put("Lie Random", "NodeSocketFloat", 0.08)
    put("Comb", "NodeSocketVector", (0.0, 0.12, -1.0))
    put("Comb From", "NodeSocketVector", (0.0, 0.0, 0.0))  # a point the pile flows away from...
    put("Comb From Weight", "NodeSocketFloat", 0.0)  # ...and how much
    put("Comb Random", "NodeSocketFloat", 0.25)  # how far each lock turns from the combed way, radians either way
    put("Tousle", "NodeSocketFloat", 0.25)
    put("Tousle Scale", "NodeSocketFloat", 2.5)
    put("Wave", "NodeSocketFloat", 0.025)
    put("Waves", "NodeSocketFloat", 1.0)
    put("Frizz", "NodeSocketFloat", 0.03)
    put("Frizz Scale", "NodeSocketFloat", 40.0)
    put("Clump", "NodeSocketFloat", 0.08)  # how far a lock's strands gather towards its middle at the tip
    put("Clump Density", "NodeSocketFloat", 15000.0, 0.0)  # locks per unit of area
    put("Stray", "NodeSocketFloat", 0.005, 0.0, 1.0)
    put("Shorten Below", "NodeSocketFloat", -10.0)  # below this height (the part's own z)...
    put("Shorten To", "NodeSocketFloat", 1.0)  # ...the pile is this much of its length
    put("Seed", "NodeSocketInt", 0)
    put("Face Mask", "NodeSocketImage")
    put("Face Mask Strength", "NodeSocketFloat", 0.0, 0.0, 1.0)
    put("Material", "NodeSocketMaterial")
    put("Geometry", "NodeSocketGeometry", out=True)

    nodes, links = ng.nodes, ng.links

    def node(kind, **props):
        n = nodes.new(kind)
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def feed(sock, v):
        if isinstance(v, bpy.types.NodeSocket):
            links.new(v, sock)
        else:
            sock.default_value = v

    def out(n):
        return next(o for o in n.outputs if o.enabled)

    def math_(op, a, b=None):
        m = node("ShaderNodeMath", operation=op)
        feed(m.inputs[0], a)
        if b is not None:
            feed(m.inputs[1], b)
        return m.outputs[0]

    def vec(op, a, b=None, scale=None):
        m = node("ShaderNodeVectorMath", operation=op)
        feed(m.inputs[0], a)
        if b is not None:
            feed(m.inputs[1], b)
        if scale is not None:
            feed(m.inputs[3], scale)
        return m.outputs["Value"] if op in ("DOT_PRODUCT", "LENGTH", "DISTANCE") else m.outputs["Vector"]

    def rand(lo, hi, seed):
        r = node("FunctionNodeRandomValue", data_type="FLOAT")
        feed(r.inputs["Min"], lo)
        feed(r.inputs["Max"], hi)
        r.inputs["Seed"].default_value = seed
        return out(r)

    def either_way(amount, seed):
        return rand(math_("MULTIPLY", amount, -1.0), amount, seed)

    def noise(at, scale):
        n = node("ShaderNodeTexNoise", noise_dimensions="3D")
        feed(n.inputs["Vector"], at)
        feed(n.inputs["Scale"], scale)
        n.inputs["Detail"].default_value = 1.0
        return vec("SCALE", vec("SUBTRACT", n.outputs["Color"], (0.5, 0.5, 0.5)), scale=2.0)

    def store(geo, name, value, kind):
        s = node("GeometryNodeStoreNamedAttribute", data_type=kind, domain="POINT")
        links.new(geo, s.inputs["Geometry"])
        s.inputs["Name"].default_value = name
        feed(s.inputs["Value"], value)
        return s.outputs["Geometry"]

    def named(name, kind):
        a = node("GeometryNodeInputNamedAttribute", data_type=kind)
        a.inputs["Name"].default_value = name
        return a.outputs["Attribute"]

    def tangent(v, n):
        """`v` laid flat on the surface with normal `n`, made unit length."""
        return vec("NORMALIZE", vec("SUBTRACT", v, vec("SCALE", n, scale=vec("DOT_PRODUCT", v, n))))

    def turned(v, n, angle):
        """Tangent `v` turned about the normal `n` by `angle`."""
        return vec("ADD", vec("SCALE", v, scale=math_("COSINE", angle)), vec("SCALE", vec("CROSS_PRODUCT", n, v), scale=math_("SINE", angle)))

    gi = node("NodeGroupInput")
    go = node("NodeGroupOutput")
    gin = gi.outputs
    # The part this fur covers, in its own space (the hair object sits at its origin).
    surface = node("GeometryNodeObjectInfo", transform_space="ORIGINAL")
    links.new(gin["Surface"], surface.inputs["Object"])
    skin = surface.outputs["Geometry"]
    position = out(node("GeometryNodeInputPosition"))

    # The locks: where each grows, and its own direction, length, tilt and wave.
    locks = node("GeometryNodeDistributePointsOnFaces", distribute_method="RANDOM")
    links.new(skin, locks.inputs["Mesh"])
    links.new(gin["Clump Density"], locks.inputs["Density"])
    links.new(gin["Seed"], locks.inputs["Seed"])
    away = vec("SCALE", vec("NORMALIZE", vec("SUBTRACT", position, gin["Comb From"])), scale=gin["Comb From Weight"])
    flow = vec("ADD", vec("ADD", gin["Comb"], away), vec("SCALE", noise(position, gin["Tousle Scale"]), scale=gin["Tousle"]))
    lock_way = turned(tangent(flow, locks.outputs["Normal"]), locks.outputs["Normal"], either_way(gin["Comb Random"], 13))
    stray = node("FunctionNodeRandomValue", data_type="BOOLEAN")
    links.new(gin["Stray"], stray.inputs["Probability"])
    stray.inputs["Seed"].default_value = 5
    stray_len = node("GeometryNodeSwitch", input_type="FLOAT")
    links.new(out(stray), stray_len.inputs["Switch"])
    stray_len.inputs["False"].default_value = 1.0
    stray_len.inputs["True"].default_value = 1.4
    lock_len = math_("MULTIPLY", math_("MULTIPLY", gin["Length"], rand(math_("SUBTRACT", 1.0, gin["Length Random"]), 1.0, 3)), out(stray_len))
    lock_lie = math_("ADD", gin["Lie"], either_way(gin["Lie Random"], 9))
    lock_phase = rand(0.0, 6.283, 11)

    # Where the strands grow: the full density for renders, a sparse version in the viewport.
    viewport = node("GeometryNodeIsViewport")
    density = node("GeometryNodeSwitch", input_type="FLOAT")
    links.new(out(viewport), density.inputs["Switch"])
    links.new(gin["Density"], density.inputs["False"])
    links.new(gin["Viewport Density"], density.inputs["True"])
    roots = node("GeometryNodeDistributePointsOnFaces", distribute_method="RANDOM")
    links.new(skin, roots.inputs["Mesh"])
    links.new(out(density), roots.inputs["Density"])
    links.new(gin["Seed"], roots.inputs["Seed"])
    normal_at_root = roots.outputs["Normal"]

    # Each strand joins the nearest lock and follows it, a little differently.
    nearest = node("GeometryNodeSampleNearest", domain="POINT")
    links.new(locks.outputs["Points"], nearest.inputs["Geometry"])
    links.new(position, nearest.inputs["Sample Position"])

    def of_lock(value, kind):
        s = node("GeometryNodeSampleIndex", data_type=kind, domain="POINT")
        links.new(locks.outputs["Points"], s.inputs["Geometry"])
        feed(s.inputs["Value"], value)
        links.new(out(nearest), s.inputs["Index"])
        return out(s)

    comb = turned(tangent(of_lock(lock_way, "FLOAT_VECTOR"), normal_at_root), normal_at_root, rand(-0.18, 0.18, 17))
    length = math_("MULTIPLY", of_lock(lock_len, "FLOAT"), rand(0.72, 1.04, 19))
    low = node("ShaderNodeMapRange", interpolation_type="SMOOTHSTEP")
    height = node("ShaderNodeSeparateXYZ")
    links.new(position, height.inputs["Vector"])
    links.new(height.outputs["Z"], low.inputs["Value"])
    feed(low.inputs["From Min"], math_("SUBTRACT", gin["Shorten Below"], 0.3))
    links.new(gin["Shorten Below"], low.inputs["From Max"])
    links.new(gin["Shorten To"], low.inputs["To Min"])
    low.inputs["To Max"].default_value = 1.0
    length = math_("MULTIPLY", length, low.outputs["Result"])

    # Under the stitched face the pile is pressed flat: a mask drawn from the front (x and z across the body,
    # -1 to 1), for the front half only. A strand that grows there is pressed flat (red); one that would lie
    # across a piece that blocks the pile (green) stops short of its edge, looked up at points along the way
    # the strand lies.
    def mask_at(p, channel):
        xyz = node("ShaderNodeSeparateXYZ")
        feed(xyz.inputs["Vector"], p)
        uv = node("ShaderNodeCombineXYZ")
        feed(uv.inputs["X"], math_("ADD", math_("MULTIPLY", xyz.outputs["X"], 0.5), 0.5))
        feed(uv.inputs["Y"], math_("ADD", math_("MULTIPLY", xyz.outputs["Z"], 0.5), 0.5))
        mask = node("GeometryNodeImageTexture")
        links.new(gin["Face Mask"], mask.inputs["Image"])
        links.new(uv.outputs["Vector"], mask.inputs["Vector"])
        rgb = node("FunctionNodeSeparateColor")
        links.new(mask.outputs["Color"], rgb.inputs["Color"])
        return math_("MULTIPLY", rgb.outputs[channel], math_("LESS_THAN", xyz.outputs["Y"], 0.0))

    strength = gin["Face Mask Strength"]
    under = math_("MULTIPLY", mask_at(position, "Red"), strength)
    reach = 1.0
    for f in (0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1.0):
        along = vec("ADD", position, vec("SCALE", comb, scale=math_("MULTIPLY", length, 0.75 * f)))
        hit = math_("MULTIPLY", math_("GREATER_THAN", mask_at(along, "Green"), 0.5), strength)
        reach = math_("MINIMUM", reach, math_("SUBTRACT", 1.0, math_("MULTIPLY", hit, 1.0 - max(0.05, f - 0.15))))
    length = math_("MULTIPLY", length, math_("MULTIPLY", reach, math_("SUBTRACT", 1.0, math_("MULTIPLY", under, 0.93))))

    pts = roots.outputs["Points"]
    pts = store(pts, "fur_root", position, "FLOAT_VECTOR")
    pts = store(pts, "fur_n", normal_at_root, "FLOAT_VECTOR")
    pts = store(pts, "fur_c", comb, "FLOAT_VECTOR")
    pts = store(pts, "fur_lock", of_lock(position, "FLOAT_VECTOR"), "FLOAT_VECTOR")
    pts = store(pts, "fur_l", length, "FLOAT")
    pts = store(pts, "fur_rise", math_("MULTIPLY", gin["Rise"], rand(0.7, 1.3, 7)), "FLOAT")
    pts = store(pts, "fur_lie", math_("ADD", of_lock(lock_lie, "FLOAT"), rand(-0.1, 0.1, 21)), "FLOAT")
    pts = store(pts, "fur_phase", math_("ADD", of_lock(lock_phase, "FLOAT"), rand(-0.35, 0.35, 23)), "FLOAT")

    # A strand of ten points per root (its shape is set below).
    line = node("GeometryNodeCurvePrimitiveLine", mode="POINTS")
    line.inputs["Start"].default_value = (0.0, 0.0, 0.0)
    line.inputs["End"].default_value = (0.0, 0.0, 1.0)
    resample = node("GeometryNodeResampleCurve")
    if "Mode" in resample.inputs:
        resample.inputs["Mode"].default_value = "Count"
    links.new(out(line), resample.inputs["Curve"])
    resample.inputs["Count"].default_value = 10
    strands = node("GeometryNodeInstanceOnPoints")
    links.new(pts, strands.inputs["Points"])
    links.new(out(resample), strands.inputs["Instance"])
    real = node("GeometryNodeRealizeInstances")
    links.new(out(strands), real.inputs["Geometry"])

    # The strand's shape (t: 0 at the root, 1 at the tip). Its angle off the normal turns evenly from `rise` to
    # `lie` along it, so it rises and bends over in an arc:
    #   p(t) = root + L (n (sin(r + k t) - sin r) + c (cos r - cos(r + k t))) / k,  k = lie - rise
    # then it waves sideways with its lock, gathers towards the lock's middle, and frizzes a little at the tip.
    t = node("GeometryNodeSplineParameter").outputs["Factor"]
    root = named("fur_root", "FLOAT_VECTOR")
    n = named("fur_n", "FLOAT_VECTOR")
    c = named("fur_c", "FLOAT_VECTOR")
    flen = named("fur_l", "FLOAT")
    rise = named("fur_rise", "FLOAT")
    k = math_("ADD", math_("SUBTRACT", named("fur_lie", "FLOAT"), rise), 0.001)
    angle = math_("ADD", rise, math_("MULTIPLY", k, t))
    up = math_("DIVIDE", math_("SUBTRACT", math_("SINE", angle), math_("SINE", rise)), k)
    over = math_("DIVIDE", math_("SUBTRACT", math_("COSINE", rise), math_("COSINE", angle)), k)
    side = vec("CROSS_PRODUCT", n, c)
    wave = math_("MULTIPLY", math_("MULTIPLY", gin["Wave"], t), math_("SINE", math_("ADD", math_("MULTIPLY", t, math_("MULTIPLY", gin["Waves"], 6.283)), named("fur_phase", "FLOAT"))))
    shape = vec("ADD", vec("ADD", vec("SCALE", n, scale=up), vec("SCALE", c, scale=over)), vec("SCALE", side, scale=wave))
    gather = vec("SCALE", vec("SUBTRACT", named("fur_lock", "FLOAT_VECTOR"), root), scale=math_("MULTIPLY", gin["Clump"], math_("POWER", t, 1.2)))
    frizz_amount = math_("MULTIPLY", math_("MULTIPLY", gin["Frizz"], flen), math_("POWER", t, 1.5))
    frizz = vec("SCALE", noise(vec("ADD", position, vec("SCALE", root, scale=31.0)), gin["Frizz Scale"]), scale=frizz_amount)
    where = vec("ADD", vec("ADD", root, vec("SCALE", shape, scale=flen)), vec("ADD", gather, frizz))
    shaped = node("GeometryNodeSetPosition")
    links.new(out(real), shaped.inputs["Geometry"])
    links.new(where, shaped.inputs["Position"])
    radius = math_("MULTIPLY", gin["Root Radius"], math_("SUBTRACT", 1.0, math_("MULTIPLY", t, math_("SUBTRACT", 1.0, gin["Tip Radius"]))))
    thin = node("GeometryNodeSetCurveRadius")
    links.new(shaped.outputs["Geometry"], thin.inputs["Curve"])
    links.new(radius, thin.inputs["Radius"])
    dressed = node("GeometryNodeSetMaterial")
    links.new(thin.outputs["Curve"], dressed.inputs["Geometry"])
    links.new(gin["Material"], dressed.inputs["Material"])
    links.new(dressed.outputs["Geometry"], go.inputs["Geometry"])
    return ng


def add_fur(ob: bpy.types.Object, ng: bpy.types.NodeTree, material: bpy.types.Material, **settings) -> bpy.types.Object:
    """A hair object for `ob`'s fur, riding on it."""
    hair = bpy.data.hair_curves.new(f"Roo Fur.{ob.name[4:]}")
    hair.materials.append(material)
    fur = bpy.data.objects.new(f"Roo Fur.{ob.name[4:]}", hair)
    for coll in ob.users_collection:
        coll.objects.link(fur)
    fur.parent = ob
    mod = fur.modifiers.new("Fur", "NODES")
    mod.node_group = ng
    ids = {it.name: it.identifier for it in ng.interface.items_tree if it.item_type == "SOCKET" and it.in_out == "INPUT"}
    inputs = mod.properties.inputs  # Blender 5.2 keeps a modifier's inputs here, not as ID properties
    getattr(inputs, ids["Surface"]).value = ob
    getattr(inputs, ids["Material"]).value = material
    for name, value in settings.items():
        getattr(inputs, ids[name.replace("_", " ").title()]).value = value
    return fur


def fur_input(fur: bpy.types.Object, name: str, value):
    ng = fur.modifiers["Fur"].node_group
    ident = next(it.identifier for it in ng.interface.items_tree if it.item_type == "SOCKET" and it.in_out == "INPUT" and it.name == name)
    getattr(fur.modifiers["Fur"].properties.inputs, ident).value = value


# ---------- the face ----------


def mouth_outline(p: dict, n: int = 64):
    """The app's mouth (lib/roo/lipsync/mouth.ts) as n points, x across and y down in flat-drawing units, centred
    where the corners meet; and its half width, height and dip."""
    w = 6.5 * (1 + 0.35 * p["wide"] - 0.45 * p["round"])
    h = 1.1 + 9.5 * max(0.0, p["open"]) * (1 - 0.25 * p["round"])
    dip = 3.2 * p["smile"]
    half = n // 2
    top, bottom = dip - 0.45 * h, dip + 0.75 * h
    pts = [(-w + 2 * w * t, 4 * t * (1 - t) * top) for t in (i / half for i in range(half + 1))]
    pts += [(w - 2 * w * t, 4 * t * (1 - t) * bottom) for t in (i / (n - half) for i in range(1, n - half))]
    return pts, (w, h, dip)


def mouth_front(pts):
    """Flat-drawing mouth points to the front of the body."""
    return [(x * MOUTH_UNIT, MOUTH_Z - y * MOUTH_UNIT) for x, y in pts]


def tongue_outline(p: dict, n: int = 48):
    """The felt tongue: an oval low in the mouth, cut to the mouth's shape (as the app draws it)."""
    pts, (w, h, dip) = mouth_outline(p)
    oval = [(0.55 * w * math.cos(a), dip + 0.66 * h + 0.36 * h * math.sin(a)) for a in (2 * math.pi * k / n for k in range(n))]
    return clip(oval, pts)


def clip(poly, window):
    """Sutherland–Hodgman: `poly` cut to the convex `window`."""

    def side(a, b, p):
        return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])

    orient = 1 if sum(side(window[0], window[i], window[i + 1]) for i in range(1, len(window) - 1)) > 0 else -1
    out = list(poly)
    for i in range(len(window)):
        a, b = window[i], window[(i + 1) % len(window)]
        src, out = out, []
        for j in range(len(src)):
            p, q = src[j - 1], src[j]
            pin, qin = side(a, b, p) * orient >= 0, side(a, b, q) * orient >= 0
            if qin != pin:
                sp, sq = side(a, b, p), side(a, b, q)
                t = sp / (sp - sq)
                out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
            if qin:
                out.append(q)
    return out


def wrap(x: float, z: float, lift: float) -> Vector:
    return body_point(x, z, FACE_LIFT + lift)[0]


def felt_patch(coll, name: str, outline, thickness: float, material, lift: float = 0.0) -> bpy.types.Object:
    """A felt piece cut to `outline` (front x, z points, convex), lying on the body: a cut edge, a rounded top
    edge, and a top that follows the body's curve."""
    cx = sum(x for x, _ in outline) / len(outline)
    cz = sum(z for _, z in outline) / len(outline)
    reach = max(math.hypot(x - cx, z - cz) for x, z in outline)
    bevel = min(0.35, 0.007 / reach)
    levels = [(1.0, 0.0), (1.0, thickness * 0.5), (1 - bevel * 0.35, thickness * 0.88), (1 - bevel, thickness)]
    levels += [((1 - bevel) * (1 - k / 6), thickness) for k in range(1, 6)]
    bm = bmesh.new()
    rings = [[bm.verts.new(wrap(cx + (x - cx) * s, cz + (z - cz) * s, lift + d)) for x, z in outline] for s, d in levels]
    n = len(outline)
    for a, b in zip(rings, rings[1:]):
        for i in range(n):
            bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
    centre = bm.verts.new(wrap(cx, cz, lift + thickness))
    for i in range(n):
        bm.faces.new((rings[-1][i], rings[-1][(i + 1) % n], centre))
    bm.faces.new(list(reversed(rings[0])))
    me = mesh_from(name, bm)
    me.materials.append(material)
    return place(coll, name, me)


def threads(coll, name: str, strands, radius: float, material) -> bpy.types.Object:
    """Embroidery thread: each strand a list of 3D points, drawn as a round thread."""
    hc = bpy.data.hair_curves.new(name)
    hc.add_curves([len(s) for s in strands])
    hc.position_data.foreach_set("vector", [c for s in strands for p in s for c in p])
    rad = hc.attributes.get("radius") or hc.attributes.new("radius", "FLOAT", "POINT")
    taper = []
    for s in strands:
        k = len(s)
        taper += [radius * (0.75 if i in (0, k - 1) else 1.0) for i in range(k)]
    rad.data.foreach_set("value", taper)
    hc.materials.append(material)
    return place(coll, name, hc)


def satin(centre, width, spacing: float = 0.0055, slant: float = 0.2, puff: float = 0.007, base: float = 0.0, seed: int = 0):
    """Satin stitch along a stroke: threads laid side by side across it, slanted a little and puffed up in the
    middle. `centre(s)` gives the stroke's middle (front x, z) for s in -1..1, `width(s)` its width there."""
    rng = random.Random(seed)
    fine = [centre(-1 + 2 * i / 400) for i in range(401)]
    run = [0.0]
    for a, b in zip(fine, fine[1:]):
        run.append(run[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    strands = []
    count = max(2, int(run[-1] / spacing))
    for k in range(count + 1):
        at = run[-1] * k / count
        i = next((j for j in range(400) if run[j + 1] >= at), 399)
        s = -1 + 2 * i / 400
        (x0, z0), (x1, z1) = fine[i], fine[i + 1]
        tx, tz = x1 - x0, z1 - z0
        tl = math.hypot(tx, tz) or 1.0
        nx, nz = -tz / tl, tx / tl
        a = slant + rng.uniform(-0.05, 0.05)
        dx, dz = nx * math.cos(a) + tx / tl * math.sin(a), nz * math.cos(a) + tz / tl * math.sin(a)
        w = width(s) * rng.uniform(0.96, 1.04)
        cx, cz = x0 + rng.uniform(-0.0008, 0.0008), z0
        pts = []
        for j in range(9):
            u = j / 8
            lift = base + puff * math.sin(math.pi * u) ** 0.6 - (0.004 if j in (0, 8) else 0.0)
            pts.append(wrap(cx + dx * (u - 0.5) * w, cz + dz * (u - 0.5) * w, lift))
        strands.append(pts)
    return strands


def fill_rows(cx: float, cz: float, rx: float, rz: float, spacing: float = 0.0055, slant: float = 0.12, puff: float = 0.008, lift: float = 0.0, seed: int = 0):
    """Satin stitch filling an oval: rows of thread across it, bottom to top."""
    rng = random.Random(seed)
    strands = []
    rows = int(2 * rz / spacing)
    for k in range(rows + 1):
        v = -1 + 2 * (k + 0.5) / (rows + 1)
        half = rx * math.sqrt(max(0.0, 1 - v * v))
        if half < 0.004:
            continue
        z = cz + v * rz
        tilt = (slant + rng.uniform(-0.04, 0.04)) * half
        pts = []
        for j in range(11):
            u = j / 10
            up = lift + puff * math.sqrt(max(0.0, 1 - v * v)) * math.sin(math.pi * u) ** 0.5 - (0.004 if j in (0, 10) else 0.0)
            pts.append(wrap(cx + (u - 0.5) * 2 * half, z + (u - 0.5) * tilt, up))
        strands.append(pts)
    return strands


def arc(cx: float, cz: float, half: float, rise: float, round_: bool = False):
    """A stroke's middle along an arc: rising (rise > 0, like ^) or dipping (like ‿) in the middle; `round_`
    makes it half an ellipse, its ends coming straight down."""
    if round_:
        return lambda s: (cx + s * half, cz + rise * math.sqrt(max(0.0, 1 - s * s)))
    return lambda s: (cx + s * half, cz + rise * (1 - s * s))


def round_ends(w: float):
    return lambda s: w * max(0.35, (1 - abs(s) ** 6)) ** 0.4


def ribbon(coll, name: str, centre, width, material, lift: float = -0.003) -> bpy.types.Object:
    """A strip under a stroke's threads, so no fur shows between them."""
    bm = bmesh.new()
    rows = []
    for i in range(121):
        s = -1 + 2 * i / 120
        (x0, z0), (x1, z1) = centre(max(-1, s - 0.01)), centre(min(1, s + 0.01))
        tl = math.hypot(x1 - x0, z1 - z0) or 1.0
        nx, nz = -(z1 - z0) / tl, (x1 - x0) / tl
        x, z = centre(s)
        w = width(s) * 0.48
        rows.append((bm.verts.new(wrap(x - nx * w, z - nz * w, lift)), bm.verts.new(wrap(x + nx * w, z + nz * w, lift))))
    for (a, b), (c, d) in zip(rows, rows[1:]):
        bm.faces.new((a, b, d, c))
    me = mesh_from(name, bm, closed=False)
    me.materials.append(material)
    return place(coll, name, me)


def thread_material(name: str, colour: str) -> bpy.types.Material:
    """Satin-stitch thread: dark, with the soft shine of rayon along each stitch."""
    mat = principled(name, colour, 0.45, 0.3)
    mat.node_tree.nodes["Principled BSDF"].inputs["Specular IOR Level"].default_value = 0.45
    return mat


def felt_material(name: str, colour: str) -> bpy.types.Material:
    """Felt: matte, with a soft sheen, a fibrous surface and a slightly mottled colour."""
    mat = principled(name, colour, 1.0, 0.8)
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Sheen Roughness"].default_value = 0.4
    coord = nt.nodes.new("ShaderNodeTexCoord")
    fibres = nt.nodes.new("ShaderNodeTexNoise")
    fibres.inputs["Scale"].default_value = 650.0
    fibres.inputs["Detail"].default_value = 14.0
    fibres.inputs["Roughness"].default_value = 0.75
    fibres.inputs["Distortion"].default_value = 0.6
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.55
    bump.inputs["Distance"].default_value = 0.0015
    nt.links.new(coord.outputs["Object"], fibres.inputs["Vector"])
    nt.links.new(fibres.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    mottle = nt.nodes.new("ShaderNodeTexNoise")
    mottle.inputs["Scale"].default_value = 120.0
    mottle.inputs["Detail"].default_value = 6.0
    shade = nt.nodes.new("ShaderNodeMapRange")
    shade.inputs["To Min"].default_value = 0.9
    shade.inputs["To Max"].default_value = 1.1
    nt.links.new(coord.outputs["Object"], mottle.inputs["Vector"])
    nt.links.new(mottle.outputs["Fac"], shade.inputs["Value"])
    tint = nt.nodes.new("ShaderNodeMix")
    tint.data_type = "RGBA"
    tint.blend_type = "MULTIPLY"
    tint.inputs["Factor"].default_value = 1.0
    tint.inputs["A"].default_value = lin(colour)
    nt.links.new(shade.outputs["Result"], tint.inputs["B"])
    nt.links.new(tint.outputs["Result"], bsdf.inputs["Base Color"])
    return mat


# Each face piece: how to draw it on the fur mask (for pressing the pile flat under it), as strokes (centre,
# width) and filled shapes (front polygons); and its objects.
FACE_SHAPES: dict = {}
FACE_PIECES: dict = {}
# Where each piece sits on the front (x, z): the app moves it from there when Roo turns its head.
FACE_ANCHORS: dict = {}


def build_face(sc: bpy.types.Scene) -> dict:
    face = collection(sc, "Roo Face")
    ink = thread_material("Roo Thread", "#0A0A0A")
    white = thread_material("Roo Thread White", "#F4F4F2")
    black_felt = felt_material("Roo Felt Black", "#1E1E1E")
    pink_felt = felt_material("Roo Felt Pink", "#FFBAC6")
    tongue_felt = felt_material("Roo Felt Tongue", "#F0909C")
    made = {}
    FACE_SHAPES.clear()
    for side, tag in ((-1, "L"), (1, "R")):
        ex, ez = side * EYE[0], EYE[1]
        # Closed happy eyes, like ^ ^: thick satin-stitched arcs.
        centre, width = arc(ex, ez - 0.05, 0.133, 0.105, round_=True), round_ends(0.06)
        made[f"Eye Happy.{tag}"] = [threads(face, f"Roo Eye Happy.{tag}", satin(centre, width, spacing=0.0042, slant=0.35, puff=0.013, base=0.014, seed=1 + side), 0.003, ink), ribbon(face, f"Roo Eye Happy Under.{tag}", centre, width, black_felt, 0.011)]
        FACE_SHAPES[f"Eye Happy.{tag}"] = {"strokes": [(centre, width)], "inset": 0.0}
        # Asleep: a thinner arc the other way, like ‿.
        centre, width = arc(ex, ez + 0.03, 0.12, -0.065), round_ends(0.032)
        made[f"Eye Sleep.{tag}"] = [threads(face, f"Roo Eye Sleep.{tag}", satin(centre, width, spacing=0.0042, puff=0.006, base=0.01, seed=3 + side), 0.0024, ink), ribbon(face, f"Roo Eye Sleep Under.{tag}", centre, width, black_felt, 0.007)]
        FACE_SHAPES[f"Eye Sleep.{tag}"] = {"strokes": [(centre, width)], "inset": 0.0}
        # Open: a satin-filled oval with a white stitched catchlight up and to the left.
        oval = [(ex + 0.085 * math.cos(a), ez + 0.105 * math.sin(a)) for a in (2 * math.pi * k / 48 for k in range(48))]
        made[f"Eye Open.{tag}"] = [
            threads(face, f"Roo Eye Open.{tag}", fill_rows(ex, ez, 0.085, 0.105, spacing=0.0045, seed=5 + side), 0.0028, ink),
            felt_patch(face, f"Roo Eye Open Under.{tag}", oval, 0.003, black_felt, -0.003),
            threads(face, f"Roo Eye Glint.{tag}", fill_rows(ex - 0.028, ez + 0.042, 0.02, 0.022, spacing=0.004, puff=0.004, lift=0.0075, seed=7 + side), 0.0024, white),
        ]
        FACE_SHAPES[f"Eye Open.{tag}"] = {"fills": [oval], "inset": 0.0}
        # A stitched brow, for thinking and alarm.
        centre, width = arc(ex, ez + 0.19, 0.075, 0.012), round_ends(0.028)
        made[f"Brow.{tag}"] = [threads(face, f"Roo Brow.{tag}", satin(centre, width, spacing=0.0042, puff=0.006, base=0.01, seed=9 + side), 0.0024, ink), ribbon(face, f"Roo Brow Under.{tag}", centre, width, black_felt, 0.007)]
        FACE_SHAPES[f"Brow.{tag}"] = {"strokes": [(centre, width)], "inset": 0.0}
        # A felt cheek below and outside the eye.
        cheek = [(side * CHEEK[0] + CHEEK[2] * math.cos(a), CHEEK[1] + CHEEK[3] * math.sin(a)) for a in (2 * math.pi * k / 48 for k in range(48))]
        made[f"Cheek.{tag}"] = [felt_patch(face, f"Roo Cheek.{tag}", cheek, 0.004, pink_felt, 0.008)]
        FACE_SHAPES[f"Cheek.{tag}"] = {"fills": [cheek], "feather": 0.002, "inset": 0.005}
    groom = bpy.data.node_groups["Roo Fur"]
    for side, tag in ((-1, "L"), (1, "R")):
        made[f"Cheek.{tag}"] += fuzz(made[f"Cheek.{tag}"], "#FFBAC6", groom, 0.01)
    # The mouth: the app's happy shape in black felt, with a pink felt tongue low in it.
    mouth = mouth_front(mouth_outline(HAPPY)[0])
    made["Mouth"] = [felt_patch(face, "Roo Mouth", mouth, 0.01, black_felt)]
    made["Mouth"] += fuzz(made["Mouth"], "#1E1E1E", groom)
    made["Tongue"] = [felt_patch(face, "Roo Tongue", mouth_front(tongue_outline(HAPPY)), 0.004, tongue_felt, 0.01)]
    made["Tongue"] += fuzz(made["Tongue"], "#F0909C", groom)
    FACE_SHAPES["Mouth"] = {"fills": [mouth], "inset": 0.0}
    # Swatches of the mouth's felt, as wide as any mouth Roo makes: the app cuts its live mouth from these.
    swatch = [(-0.37, MOUTH_Z - 0.45), (0.37, MOUTH_Z - 0.45), (0.37, MOUTH_Z + 0.09), (-0.37, MOUTH_Z + 0.09)]
    swatch = [(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t) for (x0, z0), (x1, z1) in zip(swatch, swatch[1:] + swatch[:1]) for t in (k / 12 for k in range(12))]
    made["Felt Black"] = [felt_patch(face, "Roo Felt Black", swatch, 0.01, black_felt)]
    made["Felt Black"] += fuzz(made["Felt Black"], "#1E1E1E", groom)
    made["Felt Tongue"] = [felt_patch(face, "Roo Felt Tongue", swatch, 0.01, tongue_felt)]
    made["Felt Tongue"] += fuzz(made["Felt Tongue"], "#F0909C", groom)
    FACE_SHAPES["Felt Black"] = FACE_SHAPES["Felt Tongue"] = {"fills": [swatch]}
    FACE_PIECES.clear()
    FACE_PIECES.update(made)
    FACE_ANCHORS.clear()
    for side, tag in ((-1, "L"), (1, "R")):
        for kind in ("Eye Happy", "Eye Sleep", "Eye Open"):
            FACE_ANCHORS[f"{kind}.{tag}"] = (side * EYE[0], EYE[1])
        FACE_ANCHORS[f"Brow.{tag}"] = (side * EYE[0], EYE[1] + 0.19)
        FACE_ANCHORS[f"Cheek.{tag}"] = (side * CHEEK[0], CHEEK[1])
    FACE_ANCHORS["Mouth"] = FACE_ANCHORS["Tongue"] = FACE_ANCHORS["Felt Black"] = FACE_ANCHORS["Felt Tongue"] = (0.0, MOUTH_Z)
    return made


def face_mask(names, size: int = 1024) -> bpy.types.Image:
    """The fur mask for these face pieces: red where the pile is pressed flat (under a piece, fading out
    `feather` past its edge), green where strands lying across must stop short (inside a piece, `inset` in from
    its edge: so the pile may lie over its rim that much, as a real plush's does). It covers the body's front
    from -1 to 1 across and up."""
    import numpy as np

    g = (np.arange(size) + 0.5) / size * 2 - 1
    x, z = np.meshgrid(g, g)
    press = np.zeros((size, size), dtype=np.float32)
    block = np.zeros((size, size), dtype=np.float32)
    for name in names:
        shape = FACE_SHAPES.get(name, {})  # the tongue lies on the mouth
        feather = shape.get("feather", 0.006)
        inset = shape.get("inset", 0.006)
        # The distance out from the piece's edge (negative inside it).
        out = np.full((size, size), 1e9, dtype=np.float32)
        for centre, width in shape.get("strokes", []):
            for i in range(97):
                s = -1 + 2 * i / 96
                cx, cz = centre(s)
                out = np.minimum(out, np.hypot(x - cx, z - cz) - width(s) / 2)
        for poly in shape.get("fills", []):
            inside = np.ones_like(out, dtype=bool)
            dist = np.full_like(out, 1e9)
            px, pz = np.array([p[0] for p in poly]), np.array([p[1] for p in poly])
            orient = np.sign(np.sum(px * np.roll(pz, -1) - np.roll(px, -1) * pz))
            for i in range(len(poly)):
                ax, az, bx, bz = px[i], pz[i], px[(i + 1) % len(poly)], pz[(i + 1) % len(poly)]
                ex, ez = bx - ax, bz - az
                cross = (ex * (z - az) - ez * (x - ax)) * orient
                inside &= cross >= 0
                t = np.clip(((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez), 0, 1)
                dist = np.minimum(dist, np.hypot(x - (ax + t * ex), z - (az + t * ez)))
            out = np.minimum(out, np.where(inside, -dist, dist))
        press = np.maximum(press, np.clip(1 - out / feather, 0, 1))
        block = np.maximum(block, np.clip((-out - inset) / 0.01, 0, 1))
    key = "Roo Mask " + ",".join(sorted(names))
    old = bpy.data.images.get(key)
    if old:
        bpy.data.images.remove(old)
    # Made as data from the start: changing a generated image's colour space afterwards wipes its pixels.
    img = bpy.data.images.new(key, size, size, alpha=False, is_data=True)
    rgba = np.ones((size, size, 4), dtype=np.float32)
    rgba[..., 0] = press
    rgba[..., 1] = block
    rgba[..., 2] = 0.0
    img.pixels.foreach_set(rgba.ravel())
    img.pack()
    return img


def fuzz(pieces, colour: str, groom: bpy.types.NodeTree, length: float = 0.012):
    """Short loose fibres on felt pieces, lying every which way, which soften their edges as real felt's are."""
    fibre = principled(f"Roo Fuzz {colour}", colour, 0.9, 0.6)
    out = []
    for ob in pieces:
        out.append(add_fur(ob, groom, fibre, density=160000.0, length=length, length_random=0.6, root_radius=0.0005, rise=0.5, lie=1.3, comb=(0.0, 0.0, 0.0), comb_random=1.6, tousle=3.0, tousle_scale=40.0, clump=0.0, seed=21))
    return out


def show_face(made: dict, names, body_fur: bpy.types.Object):
    """Shows only these face pieces (in renders), and presses the pile flat under them."""
    for name, obs in made.items():
        for ob in obs:
            ob.hide_render = ob.hide_viewport = name not in names
    fur_input(body_fur, "Face Mask", face_mask(names) if names else None)
    fur_input(body_fur, "Face Mask Strength", 1.0 if names else 0.0)


# ---------- build ----------


def build_shapes(sc: bpy.types.Scene) -> dict:
    parts = collection(sc, "Roo")
    fabric = principled("Roo Fabric", "#3A7F40", 1.0, 0.6)
    stem_fabric = principled("Roo Stem Fabric", "#1F4F25", 1.0, 0.6)
    # Dense fibres bounce light between them and look far more saturated than one fibre: these paler greens
    # come out as the reference's greens (measured on renders against the photo).
    fur = fur_material("Roo Fur", FUR_ROOT, FUR_TIP)
    stem_fur = fur_material("Roo Stem Fur", STEM_ROOT, STEM_TIP)
    groom = fur_nodes()

    body = place(parts, "Roo Body", sphere_mesh("Roo Body", body_shape, 96, 64))
    body.data.materials.append(fabric)
    # Long, fine pile brushed down from the crown (where the stem hides its whorl) all the way round. Each
    # strand leaves the fabric already leaning and lies down along it, so the pile shingles: you see the
    # strands' lengths, softly waved, in loose locks, and little of the dark between them.
    add_fur(body, groom, fur, **PILE, comb=(0.0, 0.05, -1.0), comb_from=(0.0, 0.15, 1.45), comb_from_weight=0.6, shorten_below=-0.7, shorten_to=0.5, seed=1)

    # The arms' and feet's fur runs down them and towards the toes.
    arms = []
    for side, tag in ((-1, "L"), (1, "R")):
        arm = place(parts, f"Roo Arm.{tag}", sphere_mesh(f"Roo Arm.{tag}", arm_shape, 48, 32), (side * SHOULDER.x, SHOULDER.y, SHOULDER.z))
        arm.rotation_euler = (0.0, -side * ARM_REST, 0.0)
        arm.data.materials.append(fabric)
        add_fur(arm, groom, fur, **{**PILE, "density": 230000.0, "length": 0.1, "clump_density": 12000.0}, seed=2 + side)
        arms.append(arm)

    feet = []
    for side, tag in ((-1, "L"), (1, "R")):
        foot = place(parts, f"Roo Foot.{tag}", sphere_mesh(f"Roo Foot.{tag}", foot_shape, 48, 32), (side * FOOT.x, FOOT.y, FOOT.z))
        foot.rotation_euler = (0.0, 0.0, side * math.radians(-6))
        foot.data.materials.append(fabric)
        add_fur(foot, groom, fur, density=200000.0, length=0.065, rise=0.15, lie=1.4, comb=(0.0, 0.0, -0.3), comb_from=(0.0, 0.03, 0.22), comb_from_weight=1.0, comb_random=0.15, tousle=0.15, seed=6 + side)
        feet.append(foot)

    # The sprout: a thin stem from the top of the head, and two long leaves; the right one is larger and
    # higher. Their fur is short, running down the stem and out along each leaf.
    stem = place(parts, "Roo Stem", stem_mesh("Roo Stem"), STEM_BASE)
    stem.data.materials.append(stem_fabric)
    add_fur(stem, groom, stem_fur, density=140000.0, length=0.04, root_radius=0.001, rise=0.5, lie=1.1, comb=(0.0, 0.0, -1.0), comb_random=0.3, tousle=0.8, tousle_scale=12.0, clump=0.25, clump_density=9000.0, seed=9)
    right = place(parts, "Roo Leaf.R", leaf_mesh("Roo Leaf.R", 0.66, 0.27, 0.11, 1), (0.045, 0.0, 0.43), stem)
    right.rotation_euler = (0.0, -math.radians(33), 0.0)
    left = place(parts, "Roo Leaf.L", leaf_mesh("Roo Leaf.L", 0.58, 0.25, 0.105, -1), (0.0, 0.0, 0.37), stem)
    left.rotation_euler = (0.0, math.radians(13), 0.0)
    for i, (leaf, side) in enumerate(((right, 1), (left, -1))):
        leaf.data.materials.append(fabric)
        add_fur(leaf, groom, fur, density=160000.0, length=0.045, root_radius=0.0009, rise=0.4, lie=1.25, comb=(side, 0.0, 0.0), tousle=0.3, tousle_scale=12.0, comb_random=0.25, clump=0.15, clump_density=9000.0, seed=11 + i)

    return {"body": body, "arms": arms, "feet": feet, "stem": stem, "leaves": [left, right]}


def build_studio(sc: bpy.types.Scene):
    studio = collection(sc, "Studio")
    # What the studio lights light: Roo and its face, not the ground.
    lit = bpy.data.collections.new("Roo Lit")
    lit.children.link(bpy.data.collections["Roo"])
    lit.children.link(bpy.data.collections["Roo Face"])
    # The light off the pale floor reaches the body's underside, as in the photo; the feet and arms stay in
    # its shade.
    below = bpy.data.collections.new("Roo Lit From Below")
    for name in ("Roo Body", "Roo Fur.Body"):
        below.objects.link(bpy.data.objects[name])
    below.children.link(bpy.data.collections["Roo Face"])
    # As the reference was shot: from the front, a touch above, with a long lens.
    cam_data = bpy.data.cameras.new("Roo Hero Camera")
    cam_data.lens = 85
    cam = place(studio, "Roo Hero Camera", cam_data, (0.0, -8.5, 0.35))
    direction = Vector((0.0, 0.0, 0.15)) - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    sc.camera = cam
    # The layers' camera looks the same way, without perspective, so the app can move the pieces flat.
    layer_data = bpy.data.cameras.new("Roo Layer Camera")
    layer_data.type = "ORTHO"
    layer_data.ortho_scale = LAYER_FRAME
    layer = place(studio, "Roo Layer Camera", layer_data)
    forward = direction.normalized()
    layer.location = LAYER_CENTRE - forward * 10.0
    layer.rotation_euler = cam.rotation_euler.copy()
    ground_me = bpy.data.meshes.new("Roo Ground")
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=6.0)
    bm.to_mesh(ground_me)
    bm.free()
    ground = place(studio, "Roo Ground", ground_me, (0, 0, GROUND))
    ground.is_shadow_catcher = True
    # Soft studio light, as in the reference: a big key from above and a little to the left, a broad fill
    # from the front, a top light that brightens the crown, and only a faint rim, so the outline doesn't glow.
    for name, where, size, energy, colour in (
        ("Roo Key", (-0.8, -6.5, 5.0), 7.0, KEY, "#FFF8F0"),
        ("Roo Fill", (1.0, -7.0, 0.6), 8.0, FILL, "#F4F9FF"),
        ("Roo Rim", (2.5, 5.0, 3.5), 4.0, RIM, "#FFFFFF"),
        ("Roo Top", (0.0, -1.5, 7.0), 5.0, TOP, "#FFFFFF"),
        ("Roo Bounce", (0.0, -4.5, -2.2), 6.0, BOUNCE, "#EEF8F0"),
    ):
        data = bpy.data.lights.new(name, "AREA")
        data.shape = "DISK"
        data.size = size
        data.energy = energy
        data.color = lin(colour)[:3]
        light = place(studio, name, data, where)
        aim = Vector((0.0, 0.0, -0.7 if name == "Roo Bounce" else 0.1))
        light.rotation_euler = (aim - light.location).to_track_quat("-Z", "Y").to_euler()
        # Only Roo gets these: on the ground they'd cast shadows with edges. The ground is lit by the room
        # alone, which leaves the very soft contact shadow of the reference.
        light.light_linking.receiver_collection = below if name == "Roo Bounce" else lit
    world = bpy.data.worlds.get("Roo Studio") or bpy.data.worlds.new("Roo Studio")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = lin("#EBF8EF")
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = ROOM
    sc.world = world


HERO_FACE = ("Eye Happy.L", "Eye Happy.R", "Cheek.L", "Cheek.R", "Mouth", "Tongue")


def build():
    sc = roo_scene()
    clear(sc)
    shapes = build_shapes(sc)
    face = build_face(sc)
    build_studio(sc)
    show_face(face, HERO_FACE, bpy.data.objects["Roo Fur.Body"])
    return {"objects": [ob.name for ob in sc.objects], "parts": list(shapes), "face": list(face)}
