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
GROUND = -0.92

# The body: an ellipsoid a touch wider than tall and not quite as deep, its bottom pressed flat where it sits.
BODY = Vector((1.0, 0.92, 0.95))
BODY_FLAT_FROM = -0.6

# Where the shoulders, the sprout and the feet are. The arms hang down and a little out.
SHOULDER = Vector((0.84, -0.1, -0.06))
ARM_REST = math.radians(34)
STEM_BASE = Vector((0.0, 0.0, 0.8))
FOOT = Vector((0.33, -0.44, GROUND + 0.13))

# The face, as seen from straight ahead (x across, z up) and laid onto the body's front. The stitching and the
# felt sit FACE_LIFT out from the fabric, on the pile, which is pressed flat under them.
EYE = (0.38, 0.12)  # each eye's centre (x mirrored)
MOUTH_Z = -0.2  # where the mouth's corners meet
MOUTH_UNIT = 1.25 / 29  # the app's mouth shapes are in flat-drawing units, 29 to the body's radius
CHEEK = (0.62, -0.14, 0.125, 0.092)  # centre x and z, radii
FACE_LIFT = 0.024
HAPPY = {"open": 0.55, "wide": 0.45, "round": 0.0, "smile": 1.0}

# The layers are rendered square, LAYER_FRAME across, centred on LAYER_CENTRE.
LAYER_FRAME = 3.1
LAYER_CENTRE = Vector((0.0, 0.0, 0.25))


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
    if bpy.data.collections.get("Roo Lit"):
        bpy.data.collections.remove(bpy.data.collections["Roo Lit"])
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
    p = Vector((p.x * BODY.x, p.y * BODY.y, p.z * BODY.z))
    if p.z < BODY_FLAT_FROM:
        # The bottom presses flat where Roo sits, and bulges out a little.
        d = BODY_FLAT_FROM - p.z
        p.z = BODY_FLAT_FROM - d + 0.45 * d * d
        s = 1 + 0.05 * min(1.0, d / 0.35)
        p.x *= s
        p.y *= s
    return p


def body_point(x: float, z: float, lift: float = 0.0):
    """The point on the body's front seen at (x, z) from straight ahead, `lift` out along the surface, and its
    normal. (The face sits well above where the bottom flattens, so the ellipsoid is exact there.)"""
    a, b, c = BODY
    y = -b * math.sqrt(max(1e-6, 1 - (x / a) ** 2 - (z / c) ** 2))
    n = Vector((x / a**2, y / b**2, z / c**2)).normalized()
    return Vector((x, y, z)) + n * lift, n


def arm_shape(p: Vector) -> Vector:
    # A short stub hanging from the shoulder (the origin), fuller at the paw end.
    t = (1 - p.z) / 2
    s = 0.92 + 0.14 * t
    return Vector((p.x * 0.165 * s, p.y * 0.158 * s, p.z * 0.26 - 0.2))


def foot_shape(p: Vector) -> Vector:
    p = Vector((p.x * 0.19, p.y * 0.22, p.z * 0.13))
    if p.z < 0:
        p.z *= 0.85  # flatter underneath
    return p


def stem_mesh(name: str) -> bpy.types.Mesh:
    """A short stem from inside the head, curving gently, with a rounded top. Origin at its base."""
    rings, segs, length = 30, 20, 0.5
    bm = bmesh.new()
    ring_verts = []
    for i in range(rings + 1):
        t = i / rings
        centre = Vector((0.04 * t * t - 0.012 * math.sin(math.pi * t), 0.0, length * t))
        tangent = Vector((0.08 * t - 0.012 * math.pi * math.cos(math.pi * t), 0.0, length)).normalized()
        across = tangent.cross(Vector((0, 1, 0))).normalized()
        depth = tangent.cross(across)
        cap = 1.0 if t < 0.9 else math.sqrt(max(0.0, 1 - ((t - 0.9) / 0.1) ** 2))
        r = (0.07 - 0.014 * t) * cap
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
    """A stuffed teardrop leaf: round at the stem, widest a third of the way out, pointed at the tip, and
    cupped a little. Origin at its base; it points along +X (or -X for side -1) with its face to the front."""

    def fn(p: Vector) -> Vector:
        t = (p.z + 1) / 2  # 0 at the base, 1 at the tip
        ring = math.sqrt(max(0.0, 1 - p.z * p.z))
        cos_a, sin_a = (p.x / ring, p.y / ring) if ring > 1e-6 else (0.0, 0.0)
        f = math.sin(math.pi * t**0.68) ** 0.8
        up = cos_a * width / 2 * f
        front = sin_a * thick / 2 * f**0.75
        cup = -0.35 * (up * up) / (width / 2)  # the edges curl towards the front
        arch = 0.05 * length * math.sin(math.pi * t)
        return Vector((side * length * t, front + cup, up + arch))

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
    hair.inputs["Roughness"].default_value = 0.55
    hair.inputs["Radial Roughness"].default_value = 0.9
    hair.inputs["Coat"].default_value = 0.0
    hair.inputs["IOR"].default_value = 1.55
    hair.inputs["Random Roughness"].default_value = 0.15
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
    only from hair objects): strands grown from random points on the part's surface,
    each along the surface normal, then leaned the way the pile is brushed (down), drooped a little, gathered
    into small tufts, frizzed, and thinned towards the tip. A few strays run longer, for the wispy outline.
    The viewport shows a sparse version; renders get the full density."""
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
    put("Density", "NodeSocketFloat", 70000.0, 0.0)
    put("Viewport Density", "NodeSocketFloat", 3000.0, 0.0)
    put("Length", "NodeSocketFloat", 0.05, 0.0)
    put("Length Random", "NodeSocketFloat", 0.35, 0.0, 1.0)
    put("Root Radius", "NodeSocketFloat", 0.0018, 0.0)
    put("Tip Radius", "NodeSocketFloat", 0.3, 0.0, 1.0)
    put("Lean", "NodeSocketFloat", 0.3)
    put("Droop", "NodeSocketFloat", 0.08)
    put("Frizz", "NodeSocketFloat", 0.07)
    put("Frizz Scale", "NodeSocketFloat", 30.0)
    put("Clump", "NodeSocketFloat", 0.2)
    put("Clump Density", "NodeSocketFloat", 6000.0, 0.0)
    put("Stray", "NodeSocketFloat", 0.02, 0.0, 1.0)
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

    gi = node("NodeGroupInput")
    go = node("NodeGroupOutput")
    gin = gi.outputs
    # The part this fur covers, in its own space (the hair object sits at its origin).
    surface = node("GeometryNodeObjectInfo", transform_space="ORIGINAL")
    links.new(gin["Surface"], surface.inputs["Object"])
    skin = surface.outputs["Geometry"]

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

    # Tufts: each strand leans towards the nearest of a sparser set of points.
    tufts = node("GeometryNodeDistributePointsOnFaces", distribute_method="RANDOM")
    links.new(skin, tufts.inputs["Mesh"])
    links.new(gin["Clump Density"], tufts.inputs["Density"])
    links.new(gin["Seed"], tufts.inputs["Seed"])
    position = out(node("GeometryNodeInputPosition"))
    nearest = node("GeometryNodeSampleNearest", domain="POINT")
    links.new(tufts.outputs["Points"], nearest.inputs["Geometry"])
    links.new(position, nearest.inputs["Sample Position"])
    tuft = node("GeometryNodeSampleIndex", data_type="FLOAT_VECTOR", domain="POINT")
    links.new(tufts.outputs["Points"], tuft.inputs["Geometry"])
    links.new(position, tuft.inputs["Value"])
    links.new(out(nearest), tuft.inputs["Index"])

    # Each strand's length: a little random, and now and then a long stray.
    length_rand = node("FunctionNodeRandomValue", data_type="FLOAT")
    feed(length_rand.inputs["Min"], math_("SUBTRACT", 1.0, gin["Length Random"]))
    length_rand.inputs["Max"].default_value = 1.0
    length_rand.inputs["Seed"].default_value = 3
    stray = node("FunctionNodeRandomValue", data_type="BOOLEAN")
    links.new(gin["Stray"], stray.inputs["Probability"])
    stray.inputs["Seed"].default_value = 5
    stray_len = node("GeometryNodeSwitch", input_type="FLOAT")
    links.new(out(stray), stray_len.inputs["Switch"])
    stray_len.inputs["False"].default_value = 1.0
    stray_len.inputs["True"].default_value = 1.6
    length = math_("MULTIPLY", math_("MULTIPLY", gin["Length"], out(length_rand)), out(stray_len))
    # Under the stitched face the pile is pressed flat: a mask drawn from the front (x and z across the body,
    # -1 to 1), for the front half only.
    xyz = node("ShaderNodeSeparateXYZ")
    links.new(position, xyz.inputs["Vector"])
    uv = node("ShaderNodeCombineXYZ")
    feed(uv.inputs["X"], math_("ADD", math_("MULTIPLY", xyz.outputs["X"], 0.5), 0.5))
    feed(uv.inputs["Y"], math_("ADD", math_("MULTIPLY", xyz.outputs["Z"], 0.5), 0.5))
    mask = node("GeometryNodeImageTexture")
    links.new(gin["Face Mask"], mask.inputs["Image"])
    links.new(uv.outputs["Vector"], mask.inputs["Vector"])
    front = math_("LESS_THAN", xyz.outputs["Y"], 0.0)
    pressed = math_("MULTIPLY", math_("MULTIPLY", mask.outputs["Color"], front), math_("MULTIPLY", gin["Face Mask Strength"], 0.92))
    length = math_("MULTIPLY", length, math_("SUBTRACT", 1.0, pressed))

    pts = roots.outputs["Points"]
    pts = store(pts, "fur_root", position, "FLOAT_VECTOR")
    pts = store(pts, "fur_n", roots.outputs["Normal"], "FLOAT_VECTOR")
    pts = store(pts, "fur_tuft", out(tuft), "FLOAT_VECTOR")
    pts = store(pts, "fur_l", length, "FLOAT")
    pts = store(pts, "fur_stray", out(stray_len), "FLOAT")

    # A straight strand along the normal, scaled to its length.
    line = node("GeometryNodeCurvePrimitiveLine", mode="POINTS")
    line.inputs["Start"].default_value = (0.0, 0.0, 0.0)
    line.inputs["End"].default_value = (0.0, 0.0, 1.0)
    resample = node("GeometryNodeResampleCurve")
    if "Mode" in resample.inputs:
        resample.inputs["Mode"].default_value = "Count"
    links.new(out(line), resample.inputs["Curve"])
    resample.inputs["Count"].default_value = 7
    align = node("FunctionNodeAlignRotationToVector", axis="Z")
    links.new(roots.outputs["Normal"], align.inputs["Vector"])
    strands = node("GeometryNodeInstanceOnPoints")
    links.new(pts, strands.inputs["Points"])
    links.new(out(resample), strands.inputs["Instance"])
    links.new(out(align), strands.inputs["Rotation"])
    links.new(length, strands.inputs["Scale"])
    real = node("GeometryNodeRealizeInstances")
    links.new(out(strands), real.inputs["Geometry"])

    # Shape each strand, more towards its tip (t: 0 at the root, 1 at the tip).
    t = node("GeometryNodeSplineParameter").outputs["Factor"]
    root = named("fur_root", "FLOAT_VECTOR")
    normal = named("fur_n", "FLOAT_VECTOR")
    tuft_at = named("fur_tuft", "FLOAT_VECTOR")
    flen = named("fur_l", "FLOAT")
    fstray = named("fur_stray", "FLOAT")
    droop = vec("SCALE", (0.0, 0.0, -1.0), scale=math_("MULTIPLY", math_("MULTIPLY", gin["Droop"], flen), math_("POWER", t, 2.0)))
    down = (0.0, 0.243, -0.97)  # brushed down, and back over the top of the head
    along = vec("SUBTRACT", down, vec("SCALE", normal, scale=vec("DOT_PRODUCT", down, normal)))
    lean = vec("SCALE", vec("NORMALIZE", along), scale=math_("MULTIPLY", math_("MULTIPLY", gin["Lean"], flen), math_("POWER", t, 1.5)))
    wiggle = node("ShaderNodeTexNoise", noise_dimensions="3D")
    feed(wiggle.inputs["Vector"], vec("ADD", position, vec("SCALE", root, scale=25.0)))
    links.new(gin["Frizz Scale"], wiggle.inputs["Scale"])
    wiggle.inputs["Detail"].default_value = 1.0
    frizz_amount = math_("MULTIPLY", math_("MULTIPLY", math_("MULTIPLY", gin["Frizz"], flen), t), math_("MULTIPLY", fstray, 2.0))
    frizz = vec("SCALE", vec("SUBTRACT", wiggle.outputs["Color"], (0.5, 0.5, 0.5)), scale=frizz_amount)
    clump = vec("SCALE", vec("SUBTRACT", tuft_at, root), scale=math_("MULTIPLY", gin["Clump"], math_("POWER", t, 1.3)))
    offset = vec("ADD", vec("ADD", droop, lean), vec("ADD", frizz, clump))
    shaped = node("GeometryNodeSetPosition")
    links.new(out(real), shaped.inputs["Geometry"])
    links.new(offset, shaped.inputs["Offset"])
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
    oval = [(0.62 * w * math.cos(a), dip + 0.62 * h + 0.36 * h * math.sin(a)) for a in (2 * math.pi * k / n for k in range(n))]
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


def satin(centre, width, spacing: float = 0.0055, slant: float = 0.2, puff: float = 0.007, seed: int = 0):
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
            lift = puff * math.sin(math.pi * u) ** 0.6 - (0.004 if j in (0, 8) else 0.0)
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


def arc(cx: float, cz: float, half: float, rise: float):
    """A stroke's middle along an arc: rising (rise > 0, like ^) or dipping (like ‿) in the middle."""
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
    mat = principled(name, colour, 0.42, 0.45)
    mat.node_tree.nodes["Principled BSDF"].inputs["Specular IOR Level"].default_value = 0.4
    return mat


def felt_material(name: str, colour: str) -> bpy.types.Material:
    """Felt: matte, with a soft sheen and a fine fibrous surface."""
    mat = principled(name, colour, 1.0, 0.8)
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Sheen Roughness"].default_value = 0.4
    coord = nt.nodes.new("ShaderNodeTexCoord")
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 420.0
    noise.inputs["Detail"].default_value = 12.0
    noise.inputs["Roughness"].default_value = 0.7
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.35
    bump.inputs["Distance"].default_value = 0.002
    nt.links.new(coord.outputs["Object"], noise.inputs["Vector"])
    nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


# Each face piece: how to draw it on the fur mask (for pressing the pile flat under it), as strokes (centre,
# width) and filled shapes (front polygons); and its objects.
FACE_SHAPES: dict = {}
FACE_PIECES: dict = {}
# Where each piece sits on the front (x, z): the app moves it from there when Roo turns its head.
FACE_ANCHORS: dict = {}


def build_face(sc: bpy.types.Scene) -> dict:
    face = collection(sc, "Roo Face")
    ink = thread_material("Roo Thread", "#151515")
    white = thread_material("Roo Thread White", "#F4F4F2")
    black_felt = felt_material("Roo Felt Black", "#1E1E1E")
    pink_felt = felt_material("Roo Felt Pink", "#F39AAC")
    tongue_felt = felt_material("Roo Felt Tongue", "#E9798F")
    made = {}
    FACE_SHAPES.clear()
    for side, tag in ((-1, "L"), (1, "R")):
        ex, ez = side * EYE[0], EYE[1]
        # Closed happy eyes, like ^ ^: thick satin-stitched arcs.
        centre, width = arc(ex, ez - 0.04, 0.15, 0.085), round_ends(0.074)
        made[f"Eye Happy.{tag}"] = [threads(face, f"Roo Eye Happy.{tag}", satin(centre, width, seed=1 + side), 0.0034, ink), ribbon(face, f"Roo Eye Happy Under.{tag}", centre, width, black_felt)]
        FACE_SHAPES[f"Eye Happy.{tag}"] = {"strokes": [(centre, width)]}
        # Asleep: a thinner arc the other way, like ‿.
        centre, width = arc(ex, ez + 0.02, 0.12, -0.05), round_ends(0.042)
        made[f"Eye Sleep.{tag}"] = [threads(face, f"Roo Eye Sleep.{tag}", satin(centre, width, seed=3 + side), 0.003, ink), ribbon(face, f"Roo Eye Sleep Under.{tag}", centre, width, black_felt)]
        FACE_SHAPES[f"Eye Sleep.{tag}"] = {"strokes": [(centre, width)]}
        # Open: a satin-filled oval with a white stitched catchlight up and to the left.
        oval = [(ex + 0.1 * math.cos(a), ez + 0.12 * math.sin(a)) for a in (2 * math.pi * k / 48 for k in range(48))]
        made[f"Eye Open.{tag}"] = [
            threads(face, f"Roo Eye Open.{tag}", fill_rows(ex, ez, 0.1, 0.12, seed=5 + side), 0.0034, ink),
            felt_patch(face, f"Roo Eye Open Under.{tag}", oval, 0.003, black_felt, -0.003),
            threads(face, f"Roo Eye Glint.{tag}", fill_rows(ex - 0.035, ez + 0.05, 0.024, 0.026, spacing=0.0045, puff=0.004, lift=0.0075, seed=7 + side), 0.0028, white),
        ]
        FACE_SHAPES[f"Eye Open.{tag}"] = {"fills": [oval]}
        # A stitched brow, for thinking and alarm.
        centre, width = arc(ex, ez + 0.2, 0.075, 0.012), round_ends(0.032)
        made[f"Brow.{tag}"] = [threads(face, f"Roo Brow.{tag}", satin(centre, width, seed=9 + side), 0.003, ink), ribbon(face, f"Roo Brow Under.{tag}", centre, width, black_felt)]
        FACE_SHAPES[f"Brow.{tag}"] = {"strokes": [(centre, width)]}
        # A felt cheek below and outside the eye.
        cheek = [(side * CHEEK[0] + CHEEK[2] * math.cos(a), CHEEK[1] + CHEEK[3] * math.sin(a)) for a in (2 * math.pi * k / 48 for k in range(48))]
        made[f"Cheek.{tag}"] = [felt_patch(face, f"Roo Cheek.{tag}", cheek, 0.008, pink_felt)]
        FACE_SHAPES[f"Cheek.{tag}"] = {"fills": [cheek]}
    # The mouth: the app's happy shape in black felt, with a pink felt tongue low in it.
    mouth = mouth_front(mouth_outline(HAPPY)[0])
    made["Mouth"] = [felt_patch(face, "Roo Mouth", mouth, 0.01, black_felt)]
    made["Tongue"] = [felt_patch(face, "Roo Tongue", mouth_front(tongue_outline(HAPPY)), 0.004, tongue_felt, 0.01)]
    FACE_SHAPES["Mouth"] = {"fills": [mouth]}
    # Swatches of the mouth's felt, as wide as any mouth Roo makes: the app cuts its live mouth from these.
    swatch = [(-0.42, MOUTH_Z - 0.46), (0.42, MOUTH_Z - 0.46), (0.42, MOUTH_Z + 0.1), (-0.42, MOUTH_Z + 0.1)]
    swatch = [(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t) for (x0, z0), (x1, z1) in zip(swatch, swatch[1:] + swatch[:1]) for t in (k / 12 for k in range(12))]
    made["Felt Black"] = [felt_patch(face, "Roo Felt Black", swatch, 0.01, black_felt)]
    made["Felt Tongue"] = [felt_patch(face, "Roo Felt Tongue", swatch, 0.01, tongue_felt)]
    FACE_SHAPES["Felt Black"] = FACE_SHAPES["Felt Tongue"] = {"fills": [swatch]}
    FACE_PIECES.clear()
    FACE_PIECES.update(made)
    FACE_ANCHORS.clear()
    for side, tag in ((-1, "L"), (1, "R")):
        for kind in ("Eye Happy", "Eye Sleep", "Eye Open"):
            FACE_ANCHORS[f"{kind}.{tag}"] = (side * EYE[0], EYE[1])
        FACE_ANCHORS[f"Brow.{tag}"] = (side * EYE[0], EYE[1] + 0.2)
        FACE_ANCHORS[f"Cheek.{tag}"] = (side * CHEEK[0], CHEEK[1])
    FACE_ANCHORS["Mouth"] = FACE_ANCHORS["Tongue"] = FACE_ANCHORS["Felt Black"] = FACE_ANCHORS["Felt Tongue"] = (0.0, MOUTH_Z)
    return made


def face_mask(names, size: int = 1024) -> bpy.types.Image:
    """The fur mask for these face pieces: white where the pile is pressed flat, feathered at the edges. It
    covers the body's front from -1 to 1 across and up."""
    import numpy as np

    g = (np.arange(size) + 0.5) / size * 2 - 1
    x, z = np.meshgrid(g, g)
    m = np.zeros((size, size), dtype=np.float32)
    feather = 0.018
    for name in names:
        shape = FACE_SHAPES.get(name, {})  # the tongue lies on the mouth
        for centre, width in shape.get("strokes", []):
            for i in range(97):
                s = -1 + 2 * i / 96
                cx, cz = centre(s)
                d = np.hypot(x - cx, z - cz) - width(s) / 2
                m = np.maximum(m, np.clip(1 - d / feather, 0, 1))
        for poly in shape.get("fills", []):
            inside = np.ones_like(m, dtype=bool)
            dist = np.full_like(m, 1e9)
            px, pz = np.array([p[0] for p in poly]), np.array([p[1] for p in poly])
            orient = np.sign(np.sum(px * np.roll(pz, -1) - np.roll(px, -1) * pz))
            for i in range(len(poly)):
                ax, az, bx, bz = px[i], pz[i], px[(i + 1) % len(poly)], pz[(i + 1) % len(poly)]
                ex, ez = bx - ax, bz - az
                cross = (ex * (z - az) - ez * (x - ax)) * orient
                inside &= cross >= 0
                t = np.clip(((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez), 0, 1)
                dist = np.minimum(dist, np.hypot(x - (ax + t * ex), z - (az + t * ez)))
            m = np.maximum(m, np.where(inside, 1.0, np.clip(1 - dist / feather, 0, 1)))
    key = "Roo Mask " + ",".join(sorted(names))
    old = bpy.data.images.get(key)
    if old:
        bpy.data.images.remove(old)
    # Made as data from the start: changing a generated image's colour space afterwards wipes its pixels.
    img = bpy.data.images.new(key, size, size, alpha=False, is_data=True)
    rgba = np.ones((size, size, 4), dtype=np.float32)
    rgba[..., 0] = rgba[..., 1] = rgba[..., 2] = m
    img.pixels.foreach_set(rgba.ravel())
    img.pack()
    return img


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
    fabric = principled("Roo Fabric", "#2F7F37", 1.0, 0.6)
    stem_fabric = principled("Roo Stem Fabric", "#2A6F31", 1.0, 0.6)
    # Dense fibres bounce light between them and look far more saturated than one fibre: these pale greens
    # come out as the reference's #3F9F45 to #4CAF50 (measured on renders).
    fur = fur_material("Roo Fur", "#4A8A50", "#80C483")
    stem_fur = fur_material("Roo Stem Fur", "#3E7744", "#6AAA6E")
    groom = fur_nodes()

    body = place(parts, "Roo Body", sphere_mesh("Roo Body", body_shape, 96, 64))
    body.data.materials.append(fabric)
    add_fur(body, groom, fur, density=130000.0, length=0.055, seed=1)

    arms = []
    for side, tag in ((-1, "L"), (1, "R")):
        arm = place(parts, f"Roo Arm.{tag}", sphere_mesh(f"Roo Arm.{tag}", arm_shape, 48, 32), (side * SHOULDER.x, SHOULDER.y, SHOULDER.z))
        arm.rotation_euler = (0.0, -side * ARM_REST, 0.0)
        arm.data.materials.append(fabric)
        add_fur(arm, groom, fur, density=130000.0, length=0.045, seed=2 + side)
        arms.append(arm)

    feet = []
    for side, tag in ((-1, "L"), (1, "R")):
        foot = place(parts, f"Roo Foot.{tag}", sphere_mesh(f"Roo Foot.{tag}", foot_shape, 48, 32), (side * FOOT.x, FOOT.y, FOOT.z))
        foot.rotation_euler = (0.0, 0.0, side * math.radians(-12))
        foot.data.materials.append(fabric)
        add_fur(foot, groom, fur, density=130000.0, length=0.04, seed=6 + side)
        feet.append(foot)

    # The sprout: a stem from the top of the head, and two leaves; the right one is a little larger and higher.
    stem = place(parts, "Roo Stem", stem_mesh("Roo Stem"), STEM_BASE)
    stem.data.materials.append(stem_fabric)
    add_fur(stem, groom, stem_fur, density=150000.0, length=0.026, root_radius=0.0015, lean=0.2, droop=0.04, seed=9)
    tip = STEM_BASE + Vector((0.03, 0.0, 0.47))
    right = place(parts, "Roo Leaf.R", leaf_mesh("Roo Leaf.R", 0.45, 0.31, 0.2, 1), tip + Vector((0.01, 0.0, -0.01)) - STEM_BASE, stem)
    right.rotation_euler = (0.0, -math.radians(32), 0.0)
    left = place(parts, "Roo Leaf.L", leaf_mesh("Roo Leaf.L", 0.39, 0.28, 0.18, -1), tip + Vector((-0.02, 0.0, -0.06)) - STEM_BASE, stem)
    left.rotation_euler = (0.0, math.radians(18), 0.0)
    for i, leaf in enumerate((right, left)):
        leaf.data.materials.append(fabric)
        add_fur(leaf, groom, fur, density=150000.0, length=0.03, root_radius=0.0015, lean=0.25, droop=0.04, seed=11 + i)

    return {"body": body, "arms": arms, "feet": feet, "stem": stem, "leaves": [left, right]}


def build_studio(sc: bpy.types.Scene):
    studio = collection(sc, "Studio")
    # What the studio lights light: Roo and its face, not the ground.
    lit = bpy.data.collections.new("Roo Lit")
    lit.children.link(bpy.data.collections["Roo"])
    lit.children.link(bpy.data.collections["Roo Face"])
    cam_data = bpy.data.cameras.new("Roo Hero Camera")
    cam_data.lens = 85
    cam = place(studio, "Roo Hero Camera", cam_data, (0.0, -9.0, 1.62))
    direction = Vector((0.0, 0.0, 0.2)) - cam.location
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
    # Soft studio light: a big warm key from the upper left, a broad fill from the right, a rim from behind
    # that makes the fur's outline glow, and a soft top light.
    for name, where, size, energy, colour in (
        ("Roo Key", (-4.5, -5.0, 5.5), 5.0, 1100.0, "#FFF6EC"),
        ("Roo Fill", (5.5, -4.0, 1.2), 6.0, 380.0, "#F1F7FF"),
        ("Roo Rim", (3.0, 5.0, 4.5), 3.0, 600.0, "#FFFFFF"),
        ("Roo Top", (0.0, 0.5, 6.5), 4.0, 280.0, "#FFFFFF"),
    ):
        data = bpy.data.lights.new(name, "AREA")
        data.shape = "DISK"
        data.size = size
        data.energy = energy
        data.color = lin(colour)[:3]
        light = place(studio, name, data, where)
        light.rotation_euler = (Vector((0.0, 0.0, 0.1)) - light.location).to_track_quat("-Z", "Y").to_euler()
        # Only Roo gets these: on the ground they'd cast shadows with edges. The ground is lit by the room
        # alone, which leaves the very soft contact shadow of the reference.
        light.light_linking.receiver_collection = lit
    world = bpy.data.worlds.get("Roo Studio") or bpy.data.worlds.new("Roo Studio")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = lin("#E4F3E8")
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.5
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
