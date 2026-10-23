# Renders the Roo scene that build_roo.py makes:
#   still   a studio still on the reference photo's mint backdrop, framed like the photo, for checking the look;
#   layers  the pieces the web app stacks and moves, each cropped tight, plus layers.json saying where each
#           one sits, how it pivots and where the camera looks from;
#   check   those pieces stacked back up beside the whole render (they should match);
#   atlas   the pieces packed into one WebP per size, and the TypeScript the app reads them with;
#   save    the Roo scene alone as a .blend, to open and tweak in Blender.
#
# Renders take minutes, so run it in a background Blender:
#   blender -b --factory-startup --python frontend/roo3d/render_roo.py -- still <out.png> [width height samples]
#   blender -b --factory-startup --python frontend/roo3d/render_roo.py -- layers <dir> [samples]
#   blender -b --factory-startup --python frontend/roo3d/render_roo.py -- check <dir> <out.png>
#   blender -b --factory-startup --python frontend/roo3d/render_roo.py -- atlas <dir> <app dir>
#   blender -b --factory-startup --python frontend/roo3d/render_roo.py -- save <out.blend>

import json
import math
import os
import sys
import tempfile

import bpy
import numpy as np
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

MINT = (0xEB, 0xF8, 0xEF)  # the reference photo's backdrop
# How dark the contact shadow is drawn (the photo's is very soft).
SHADOW = 0.6
# The layers are rendered at this many pixels to the body's radius, then scaled down for each size.
PPU = 320
# Arm poses, in radians raised from hanging: the app turns the nearest one the rest of the way. Higher than
# this an arm goes behind the head.
ARM_POSES = (0.0, 0.6, 1.2, 1.75)
SPRITES = ("Eye Happy.L", "Eye Happy.R", "Eye Open.L", "Eye Open.R", "Eye Sleep.L", "Eye Sleep.R", "Brow.L", "Brow.R", "Cheek.L", "Cheek.R")
# The livelier faces: starry, heart and > < eyes, stitched blushes and a drop of sweat.
SPRITES += ("Eye Star.L", "Eye Star.R", "Eye Heart.L", "Eye Heart.R", "Eye Squint.L", "Eye Squint.R", "Blush.L", "Blush.R", "Sweat")
# Felt cutouts the app floats about Roo.
EMOTES = ("Emote Heart", "Emote Sparkle", "Emote Z", "Emote Question", "Emote Exclaim")
SWATCHES = ("Felt Black", "Felt Tongue")
# Sizes the app picks from: pixels to the body's radius.
SETS = {"lg": 192, "md": 128, "sm": 80}

BODY = ("Roo Body", "Roo Fur.Body")
FEET = ("Roo Foot.L", "Roo Fur.Foot.L", "Roo Foot.R", "Roo Fur.Foot.R")
SPROUT = ("Roo Stem", "Roo Fur.Stem", "Roo Leaf.L", "Roo Fur.Leaf.L", "Roo Leaf.R", "Roo Fur.Leaf.R")


def arm(tag: str):
    return (f"Roo Arm.{tag}", f"Roo Fur.Arm.{tag}")


# ---------- rendering ----------


def render_rgba(sc: bpy.types.Scene, path: str, width: int, height: int, samples: int, camera: str | None = None, border=None):
    """Renders with a transparent background to an 8-bit RGBA PNG; `border` (x0, y0, x1, y1 from the bottom
    left, 0..1) renders and keeps only that part of the frame."""
    sc.render.resolution_x = width
    sc.render.resolution_y = height
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = True
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.render.image_settings.color_depth = "8"
    sc.render.use_border = border is not None
    sc.render.use_crop_to_border = border is not None
    if border:
        sc.render.border_min_x, sc.render.border_min_y, sc.render.border_max_x, sc.render.border_max_y = border
    if camera:
        sc.camera = bpy.data.objects[camera]
    sc.render.filepath = path
    with bpy.context.temp_override(scene=sc):
        bpy.ops.render.render(write_still=True, scene=sc.name)


def pixels(path: str) -> np.ndarray:
    """An 8-bit image file's pixels as a float array (rows from the top, straight alpha, sRGB-encoded)."""
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(h, w, 4)[::-1]


def save(px: np.ndarray, path: str, quality: int = 0):
    """Writes a float array (rows from the top) as PNG, or as WebP when the path ends in .webp."""
    h, w, c = px.shape
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[..., :c] = px
    img = bpy.data.images.new("roo-out", w, h, alpha=c == 4)
    img.pixels.foreach_set(rgba[::-1].ravel())
    img.filepath_raw = path
    img.file_format = "WEBP" if path.endswith(".webp") else "PNG"
    img.save(filepath=path, quality=quality)
    bpy.data.images.remove(img)


def over(px: np.ndarray, colour=MINT) -> np.ndarray:
    """Straight-alpha pixels over a flat colour, in sRGB as a browser composites them."""
    bg = np.array(colour, dtype=np.float32) / 255
    a = px[..., 3:4]
    return px[..., :3] * a + bg * (1 - a)


def stack(*layers) -> np.ndarray:
    """Straight-alpha layers, bottom first, composited in sRGB as a browser does."""
    out = np.zeros_like(layers[0])
    for px in layers:
        a = px[..., 3:4]
        rgb = px[..., :3] * a + out[..., :3] * out[..., 3:4] * (1 - a)
        alpha = a + out[..., 3:4] * (1 - a)
        out = np.concatenate([np.where(alpha > 0, rgb / np.maximum(alpha, 1e-6), 0), alpha], axis=-1)
    return out


# ---------- the scene ----------


def load_build(here: str) -> dict:
    ns = {"__name__": "roo_build", "__file__": os.path.join(here, "build_roo.py")}
    exec(compile(open(ns["__file__"], encoding="utf-8").read(), ns["__file__"], "exec"), ns)
    return ns


def visibility(sc: bpy.types.Scene, shown=(), catchers=(), hidden=(), ground: str = "holdout", holdouts=()):
    """Who the camera sees in this render. Everything else still casts shadows and bounces light (it is only
    invisible to the camera); `hidden` is left out entirely, and `holdouts` cut away what's behind them. The
    ground cuts away fur below it (holdout) or catches the shadow."""
    for ob in sc.objects:
        if ob.type not in {"MESH", "CURVES"}:
            continue
        if ob.name == "Roo Ground":
            ob.is_holdout = ground == "holdout"
            ob.is_shadow_catcher = ground == "catcher"
            ob.visible_camera = True
            continue
        ob.hide_render = ob.name in hidden
        ob.is_holdout = ob.name in holdouts
        ob.is_shadow_catcher = ob.name in catchers
        ob.visible_camera = ob.name in shown or ob.name in catchers or ob.name in holdouts


def border_of(sc: bpy.types.Scene, names, margin: float = 0.08):
    """The part of the layer camera's frame these objects cover (with their fur), plus a margin, as a render
    border."""
    cam = bpy.data.objects["Roo Layer Camera"]
    dg = bpy.context.evaluated_depsgraph_get()
    xs, ys = [], []
    for name in names:
        ob = bpy.data.objects[name].evaluated_get(dg)
        for corner in ob.bound_box:
            p = world_to_camera_view(sc, cam, ob.matrix_world @ Vector(corner))
            xs.append(p.x)
            ys.append(p.y)
    m = margin / cam.data.ortho_scale
    return (max(0.0, min(xs) - m), max(0.0, min(ys) - m), min(1.0, max(xs) + m), min(1.0, max(ys) + m))


def project(sc: bpy.types.Scene, p: Vector, size: int):
    """A world point to the layer frame's pixels (x right, y down)."""
    v = world_to_camera_view(sc, bpy.data.objects["Roo Layer Camera"], p)
    return [round(v.x * size, 2), round((1 - v.y) * size, 2)]


# ---------- outputs ----------


def still(path: str, width: int = 1355, height: int = 1160, samples: int = 256, camera: str = "Roo Hero Camera"):
    """The look check: Roo on the mint backdrop, the soft contact shadow under it, framed like the reference
    photo (1355 by 1160) so the two can be laid side by side."""
    sc = bpy.data.scenes["Roo"]
    hidden = {ob.name for ob in sc.objects if ob.hide_render}
    roo = os.path.join(tempfile.gettempdir(), "roo-still-rgba.png")
    visibility(sc, shown=[ob.name for ob in sc.objects], hidden=hidden, ground="holdout")
    render_rgba(sc, roo, width, height, samples, camera)
    shadow = os.path.join(tempfile.gettempdir(), "roo-still-shadow.png")
    visibility(sc, hidden=hidden, ground="catcher")
    render_rgba(sc, shadow, width, height, max(32, samples // 4), camera)
    under = pixels(shadow)
    under[..., 3] *= SHADOW
    save(over(stack(under, pixels(roo))), path)
    return path


def layers(out: str, samples: int = 256, build: dict | None = None):
    """Renders every piece the app moves, each cropped tight, and layers.json. Run again after a crash (the GPU
    sometimes gives up on a render this heavy), it picks up where it stopped."""
    sc = bpy.data.scenes["Roo"]
    os.makedirs(out, exist_ok=True)
    partial = os.path.join(out, "layers.partial.json")
    done = {}
    if os.path.exists(partial):
        with open(partial, encoding="utf-8") as f:
            done = json.load(f)
    size = round(bpy.data.objects["Roo Layer Camera"].data.ortho_scale * PPU)
    # Where things land in the square frame, worked out without rendering (pieces kept from an earlier run
    # render nothing): the frame square and every object where it is.
    sc.render.resolution_x = sc.render.resolution_y = size
    sc.render.resolution_percentage = 100
    sc.view_layers[0].update()
    pieces = build["FACE_PIECES"]
    face_obs = {ob.name for obs in pieces.values() for ob in obs}
    body_fur = bpy.data.objects["Roo Fur.Body"]
    meta: dict = {}

    def shoot(key: str, names, border=None, post=None, **vis):
        if key in done and os.path.exists(os.path.join(out, f"{key}.png")):
            meta[key] = dict(done[key])
            return meta[key]
        visibility(sc, **vis)
        border = border or border_of(sc, names)
        tmp = os.path.join(tempfile.gettempdir(), f"roo-layer-{key}.png")
        render_rgba(sc, tmp, size, size, samples, "Roo Layer Camera", border)
        px = pixels(tmp)
        if post:
            px = post(px, round(border[0] * size), size - round(border[3] * size))
        # Where this crop sits in the whole frame (y from the top), then trimmed to what's drawn.
        x0 = round(border[0] * size)
        y0 = size - round(border[3] * size)
        alpha = px[..., 3]
        rows, cols = np.nonzero(alpha > 1 / 255)
        if not len(rows):
            raise RuntimeError(f"{key}: nothing drawn")
        top, bottom, left, right = rows.min(), rows.max() + 1, cols.min(), cols.max() + 1
        save(px[top:bottom, left:right], os.path.join(out, f"{key}.png"))
        meta[key] = {"rect": [int(x0 + left), int(y0 + top), int(right - left), int(bottom - top)]}
        print(f"roo: {key} {meta[key]['rect']}", flush=True)
        with open(partial, "w", encoding="utf-8") as f:
            json.dump(meta, f)
        return meta[key]

    # The body; the face goes on top of it, so the pile is full everywhere. The arms and sprout are drawn
    # behind it and move, so they aren't there to shade its edge; nor are the feet, a layer of their own that
    # turns on the spot when Roo does (it would leave their shadow behind on the belly).
    build["show_face"](pieces, (), body_fur)
    shoot("body", BODY, shown=BODY, hidden=face_obs | set(arm("L")) | set(arm("R")) | set(SPROUT) | set(FEET))

    # The feet, in front of the body: what the belly hides of them is cut away.
    foot = build["FOOT"]
    info = shoot("feet", FEET, shown=FEET, holdouts=BODY, hidden=face_obs)
    info["anchor"] = [0.0, round(foot.y, 5), round(foot.z, 5)]
    info["pivot"] = project(sc, Vector((0.0, foot.y, foot.z)), size)

    # Each arm in each pose, turning about its shoulder. The app draws arms and sprout behind the body, whose
    # fuzzy edge covers where they join; so they're rendered without the body, lit all over (with it, the parts
    # buried in the body come out black and show through that edge).
    for tag, side in (("L", -1), ("R", 1)):
        ob = bpy.data.objects[f"Roo Arm.{tag}"]
        rest = ob.rotation_euler.y
        for k, raise_ in enumerate(ARM_POSES):
            ob.rotation_euler.y = rest - side * raise_
            info = shoot(f"arm.{tag}.{k}", arm(tag), shown=arm(tag), hidden=face_obs | set(BODY) | set(FEET))
            sc.view_layers[0].update()
            info["pivot"] = project(sc, ob.matrix_world.translation, size)
            info["anchor"] = [round(v, 5) for v in ob.matrix_world.translation]
            info["raise"] = raise_
        ob.rotation_euler.y = rest

    # The sprout, swaying about where it comes out of the head.
    info = shoot("sprout", SPROUT, shown=SPROUT, hidden=face_obs | set(BODY) | set(FEET))
    info["pivot"] = project(sc, Vector((0.0, 0.0, build["BODY"].z)), size)
    info["anchor"] = [0.0, 0.0, round(build["BODY"].z, 5)]

    # The contact shadow alone, on the ground: the faintest shading dropped and the rest faded out towards
    # the edges, so it has no edge of its own.
    gx, gy = project(sc, Vector((0.0, 0.0, build["GROUND"])), size)

    def soften(px, x0, y0):
        h, w = px.shape[:2]
        xs = (np.arange(w) + x0 - gx) / (1.25 * PPU)
        ys = (np.arange(h) + y0 - gy) / (0.42 * PPU)
        r = np.sqrt(xs[None, :] ** 2 + ys[:, None] ** 2)
        fade = np.clip((1.0 - r) / 0.45, 0, 1)
        px = px.copy()
        px[..., 3] = np.clip((px[..., 3] - 0.02) / 0.98, 0, 1) * fade * fade * (3 - 2 * fade) * SHADOW
        return px

    shoot("shadow", (), hidden=face_obs, ground="catcher", border=(0.0, 0.0, 1.0, 0.5), post=soften)

    # The face pieces, each on the fur it presses down: the body only catches their shadow. That catches a
    # faint haze far around a piece too, which would show as the edge of its box: it's dropped, and what's left
    # fades out before the edge.
    def feather(px, x0, y0):
        h, w = px.shape[:2]
        ramp = 0.05 * PPU
        wx = np.clip(np.minimum(np.arange(w), w - 1 - np.arange(w)) / ramp, 0, 1)
        wy = np.clip(np.minimum(np.arange(h), h - 1 - np.arange(h)) / ramp, 0, 1)
        px = px.copy()
        px[..., 3] = np.clip((px[..., 3] - 0.015) / 0.985, 0, 1) * wy[:, None] * wx[None, :]
        return px

    for name in SPRITES + SWATCHES:
        build["show_face"](pieces, (name,), body_fur)
        names = [ob.name for ob in pieces[name]]
        info = shoot(name, names, shown=names, catchers=BODY, hidden=face_obs - set(names), post=feather if name in SPRITES else None)
        x, z = build["FACE_ANCHORS"][name]
        point, normal = build["body_point"](x, z, build["FACE_LIFT"])
        info["anchor"] = [round(v, 5) for v in point]
        info["normal"] = [round(v, 5) for v in normal]

    # The floating emotes, each alone, lit as Roo is.
    for name in EMOTES:
        build["show_face"](pieces, (name,), body_fur)
        names = [ob.name for ob in pieces[name]]
        alone = (face_obs - set(names)) | set(BODY) | set(FEET) | set(arm("L")) | set(arm("R")) | set(SPROUT)
        shoot(name, names, shown=names, hidden=alone)

    # The whole of Roo at rest with the reference's face, to check the layers stack back up to it.
    build["show_face"](pieces, build["HERO_FACE"], body_fur)
    visibility(sc, shown=[ob.name for ob in sc.objects], hidden=face_obs - {ob.name for n in build["HERO_FACE"] for ob in pieces[n]}, ground="catcher")
    if not os.path.exists(os.path.join(out, "whole.png")):
        tmp = os.path.join(tempfile.gettempdir(), "roo-layer-whole.png")
        render_rgba(sc, tmp, size, size, samples, "Roo Layer Camera")
        save(pixels(tmp), os.path.join(out, "whole.png"))

    cam = bpy.data.objects["Roo Layer Camera"]
    m = cam.matrix_world.to_3x3()
    meta = {
        "ppu": PPU,
        "size": size,
        "camera": {"right": [round(v, 6) for v in m.col[0]], "up": [round(v, 6) for v in m.col[1]], "toward": [round(-v, 6) for v in m.col[2]], "centre": project(sc, Vector((0, 0, 0)), size)},
        "body": {"radii": list(build["BODY"]), "faceLift": build["FACE_LIFT"], "mouthZ": build["MOUTH_Z"], "mouthUnit": build["MOUTH_UNIT"]},
        "layers": meta,
    }
    with open(os.path.join(out, "layers.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1)
    os.remove(partial)
    return meta


def resample(px: np.ndarray, scale: float) -> np.ndarray:
    """Scales straight-alpha pixels by `scale` with an area filter, averaging premultiplied colour so the
    fuzzy edges keep their colour."""
    h, w = px.shape[:2]

    def weights(n: int, m: int) -> np.ndarray:
        edges = np.linspace(0, n, m + 1)
        out = np.zeros((m, n), dtype=np.float32)
        for j in range(m):
            a, b = edges[j], edges[j + 1]
            for i in range(int(a), min(n, int(math.ceil(b)))):
                out[j, i] = min(b, i + 1) - max(a, i)
        return out / out.sum(axis=1, keepdims=True)

    pre = px.copy()
    pre[..., :3] *= pre[..., 3:4]
    rows = np.einsum("iy,yxc->ixc", weights(h, max(1, round(h * scale))), pre)
    out = np.einsum("jx,ixc->ijc", weights(w, max(1, round(w * scale))), rows)
    a = out[..., 3:4]
    out[..., :3] = np.where(a > 1e-6, out[..., :3] / np.maximum(a, 1e-6), 0)
    return np.clip(out, 0, 1)


def pack(sizes: dict, pad: int = 2):
    """Shelf-packs rectangles (w, h) into one sheet; returns its size and each one's top-left."""
    order = sorted(sizes, key=lambda k: -sizes[k][1])
    width = max(max(w for w, _ in sizes.values()) + 2 * pad, int(math.sqrt(sum((w + 2 * pad) * (h + 2 * pad) for w, h in sizes.values())) * 1.15))
    width = (width + 3) // 4 * 4
    at, x, y, shelf = {}, 0, 0, 0
    for k in order:
        w, h = sizes[k]
        if x + w + 2 * pad > width:
            x, y, shelf = 0, y + shelf, 0
        at[k] = (x + pad, y + pad)
        x += w + 2 * pad
        shelf = max(shelf, h + 2 * pad)
    return (width, (y + shelf + 3) // 4 * 4), at


def shade(key: str, px: np.ndarray) -> np.ndarray:
    """The arms are rendered without the body (see layers()), so they miss the shade it casts on them, which
    leaves them lighter than the photo's: darken them to match. The felt cheeks' shadow on the fur, rendered
    on pressed-down pile, is darker than it looks on the full pile they're drawn over: soften it."""
    px = px.copy()
    if key.startswith("arm."):
        px[..., :3] *= 0.85
    if key.startswith(("Cheek.", "Blush.")):
        lum = px[..., :3] @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
        px[..., 3] *= np.where(lum < 0.25, 0.4, 1.0)
    return px


def shading(master: str, meta: dict) -> list:
    """The body's rendered shading as a smooth function of which way its surface faces (nine terms: a constant,
    the normal's x, y, z, and their products), fitted to its brightness. The app turns the rendered body; with
    this it relights it, so the light stays where the studio's was."""
    cam = meta["camera"]
    right, up, toward = (np.array(cam[k]) for k in ("right", "up", "toward"))
    radii = np.array(meta["body"]["radii"])
    x0, y0, w, h = meta["layers"]["body"]["rect"]
    px = pixels(os.path.join(master, "body.png"))
    ys, xs = np.mgrid[0:h, 0:w]
    u = (xs + 0.5 + x0 - cam["centre"][0]) / meta["ppu"]
    v = (cam["centre"][1] - (ys + 0.5 + y0)) / meta["ppu"]
    o = u[..., None] * right + v[..., None] * up
    oi, di = o / radii, toward / radii
    a, b, c = di @ di, 2 * (oi @ di), (oi * oi).sum(-1) - 1
    disc = b * b - 4 * a * c
    half = np.sqrt(np.maximum(disc, 0)) / (2 * a)
    x = o + (-b / (2 * a) - half)[..., None] * toward
    n = x / radii**2
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    # Well inside the outline, where the fur is solid.
    use = (disc > 0) & (half > 0.25) & (px[..., 3] > 0.99)
    nx, ny, nz = n[..., 0][use], n[..., 1][use], n[..., 2][use]
    terms = np.stack([np.ones_like(nx), nx, ny, nz, nx * ny, nx * nz, ny * nz, nx * nx - ny * ny, 3 * nz * nz - 1], -1)
    lum = px[..., :3] @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    fit, *_ = np.linalg.lstsq(terms, lum[use], rcond=None)
    return [round(float(f), 5) for f in fit]


def atlas(master: str, app: str, quality: int = 82):
    """Packs the rendered layers into one WebP per size (src/components/roo3d/assets/roo-<size>.webp) and writes
    rig.ts, which says where every piece is."""
    with open(os.path.join(master, "layers.json"), encoding="utf-8") as f:
        meta = json.load(f)
    meta["body"]["ground"] = load_build(os.path.dirname(os.path.abspath(__file__)))["GROUND"]
    meta["body"]["shade"] = shading(master, meta)
    os.makedirs(os.path.join(app, "assets"), exist_ok=True)
    sets = {}
    for name, ppu in SETS.items():
        scale = ppu / meta["ppu"]
        scaled = {key: resample(shade(key, pixels(os.path.join(master, f"{key}.png"))), scale) for key in meta["layers"]}
        (w, h), at = pack({k: (v.shape[1], v.shape[0]) for k, v in scaled.items()})
        sheet = np.zeros((h, w, 4), dtype=np.float32)
        rects = {}
        for key, px in scaled.items():
            x, y = at[key]
            sheet[y : y + px.shape[0], x : x + px.shape[1]] = px
            rects[key] = [x, y, px.shape[1], px.shape[0]]
        path = os.path.join(app, "assets", f"roo-{name}.webp")
        save(sheet, path, quality)
        sets[name] = {"ppu": ppu, "size": [w, h], "rects": rects}
        print(f"roo: {name} {w}x{h} {os.path.getsize(path)} bytes", flush=True)

    def js(v):
        return json.dumps(v, separators=(", ", ": "))

    layers = {k: {kk: vv for kk, vv in v.items()} for k, v in meta["layers"].items()}
    lines = [
        "// Generated by frontend/roo3d/render_roo.py (atlas): where each piece of the rendered Roo sits. Don't edit;",
        "// re-render instead. Positions are in the master render's pixels (`ppu` of them to the body's radius).",
        "",
        "export type Rect = readonly [x: number, y: number, w: number, h: number]",
        "",
        "export interface Piece {",
        "  /** Where it sits in the master render. */",
        "  rect: Rect",
        "  /** What it turns about (arms, sprout, feet). */",
        "  pivot?: readonly [number, number]",
        "  /** How far raised this arm pose is, in radians. */",
        "  raise?: number",
        "  /** Where it's fixed to the body (a face piece's place on it, a shoulder, the top of the head; Blender's axes:",
        "   *  x right, y back, z up), and for a face piece, the body's normal there. */",
        "  anchor?: readonly [number, number, number]",
        "  normal?: readonly [number, number, number]",
        "}",
        "",
        f"export const RIG = {{ ppu: {meta['ppu']}, size: {meta['size']}, camera: {js(meta['camera'])}, body: {js(meta['body'])} }} as const",
        "",
        "export const PIECES: Record<string, Piece> = {",
        *[f"  {json.dumps(k)}: {js(v)}," for k, v in layers.items()],
        "}",
        "",
        "/** Each size's sheet: pixels to the body's radius, and where each piece is on it. */",
        "export const SHEETS = {",
        *[f"  {k}: {{ ppu: {v['ppu']}, size: {js(v['size'])}, rects: {js(v['rects'])} as Record<string, Rect> }}," for k, v in sets.items()],
        "} as const",
        "",
    ]
    with open(os.path.join(app, "rig.ts"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))


def check(master: str, out: str):
    """The layers stacked at rest, beside the whole render: they should match."""
    with open(os.path.join(master, "layers.json"), encoding="utf-8") as f:
        meta = json.load(f)
    size = meta["size"]

    def at(key):
        px = pixels(os.path.join(master, f"{key}.png"))
        x, y, w, h = meta["layers"][key]["rect"]
        full = np.zeros((size, size, 4), dtype=np.float32)
        full[y : y + h, x : x + w] = px
        return full

    keys = ["shadow", "sprout", "arm.L.0", "arm.R.0", "body", "Cheek.L", "Cheek.R", "Eye Happy.L", "Eye Happy.R", "feet"]
    stacked = over(stack(*[at(k) for k in keys]))
    whole = over(pixels(os.path.join(master, "whole.png")))
    save(np.concatenate([stacked, whole], axis=1), out)


def main(argv):
    here = os.path.dirname(os.path.abspath(__file__))
    cmd, *rest = argv
    if cmd == "atlas":
        atlas(rest[0], rest[1])
        return
    if cmd == "check":
        check(rest[0], rest[1])
        return
    build = load_build(here)
    build["build"]()
    if cmd == "save":
        # The Roo scene alone, as a .blend to open and tweak in Blender (the fur stays procedural, so it's small).
        for sc in list(bpy.data.scenes):
            if sc.name != "Roo":
                bpy.data.scenes.remove(sc)
        bpy.ops.outliner.orphans_purge(do_recursive=True)
        bpy.ops.wm.save_as_mainfile(filepath=rest[0], compress=True)
    elif cmd == "still":
        still(rest[0], *[int(v) for v in rest[1:4]])
    elif cmd == "layers":
        layers(rest[0], int(rest[1]) if len(rest) > 1 else 256, build)
    else:
        raise SystemExit(f"unknown command {cmd}")


if __name__ == "__main__":
    main(sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else [])
