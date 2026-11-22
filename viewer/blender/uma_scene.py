# builds an umastudio scene export in blender and renders it.
#
#   blender --background --python uma_scene.py -- <export folder> [--still <frame>] [--size <scale>]
#
# the export (umastudio "send to blender") has scene.glb with everything baked over the timeline,
# tex/ with the shadow colour and shading masks glTF can't carry, and scene.json. here: toon
# shading built from the game's maps (lit colour, shadow colour, painted shadow mask) on an
# emission shader so the colours stay the game's, inverted-hull outlines, a soft sun that casts
# real shadows on the umas and the place, light haze, depth of field on the active uma's head,
# glow and a grade in the compositor. frames go to <export>/frames, the .blend is saved next to
# them so a shot can be tweaked by hand.

import bpy, sys, os, json, math, re
from mathutils import Vector, Euler

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
DIR = os.path.abspath(argv[0])
STILL = int(argv[argv.index('--still') + 1]) if '--still' in argv else None
SCALE = float(argv[argv.index('--size') + 1]) if '--size' in argv else 1.0
meta = json.load(open(os.path.join(DIR, 'scene.json'), encoding='utf-8'))

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
# the importer turns seconds into frames at the scene's rate: it has to be set first
scene.render.fps = int(meta['fps'])
bpy.ops.import_scene.gltf(filepath=os.path.join(DIR, 'scene.glb'))
scene = bpy.context.scene


# --- frames and camera ----------------------------------------------------------------------------

scene.render.fps = int(meta['fps'])
frames = [a.frame_range for a in bpy.data.actions]
first = int(min((f[0] for f in frames), default=0))
scene.frame_start = first
scene.frame_end = first + int(meta['frames']) - 1
scene.render.resolution_x = int(meta['width'] * SCALE) // 2 * 2
scene.render.resolution_y = int(meta['height'] * SCALE) // 2 * 2

cam = bpy.data.objects.get('Camera') or next((o for o in bpy.data.objects if o.type == 'CAMERA'), None)
scene.camera = cam
cam.data.sensor_fit = 'VERTICAL'
cam.data.angle_y = math.radians(meta['fov'])
cam.data.clip_start = 0.05
cam.data.clip_end = 3000


# --- materials ------------------------------------------------------------------------------------

def iter_fcurves(idb):
    """An ID's animation curves (blender 5 keeps them in layered actions' channelbags)."""
    ad = getattr(idb, 'animation_data', None)
    act = ad and ad.action
    if not act:
        return []
    if hasattr(act, 'fcurves') and len(getattr(act, 'fcurves', [])):
        return list(act.fcurves)
    out = []
    for layer in getattr(act, 'layers', []):
        for strip in layer.strips:
            for bag in getattr(strip, 'channelbags', []):
                out += list(bag.fcurves)
    return out


def tex_node(mat):
    """The image the glTF importer put on the base colour (and its alpha)."""
    for n in mat.node_tree.nodes:
        if n.type == 'TEX_IMAGE' and any(l.to_socket.name in ('Base Color', 'Color') for o in n.outputs for l in o.links):
            return n
    return next((n for n in mat.node_tree.nodes if n.type == 'TEX_IMAGE'), None)


def load_image(rel, data=False):
    """A sidecar texture; data (masks) is read as plain numbers, not as colour."""
    if not rel:
        return None
    path = os.path.join(DIR, rel)
    if not os.path.exists(path):
        return None
    im = bpy.data.images.load(path, check_existing=True)
    if data:
        im.colorspace_settings.name = 'Non-Color'
    return im


def base_color(mat):
    p = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    return tuple(p.inputs['Base Color'].default_value) if p else (1, 1, 1, 1)


def toon(mat, kind, shadow_img=None, mask_img=None, cutout=0.0, env=False):
    """Rebuild mat: lit colour where the sun reaches, the shadow colour where it doesn't."""
    nt = mat.node_tree
    old = tex_node(mat)
    img = old.image if old else None
    uv = None
    if old and old.inputs['Vector'].links:
        uv = old.inputs['Vector'].links[0].from_socket
    col_const = base_color(mat)
    vcol = next((n for n in nt.nodes if n.type in ('VERTEX_COLOR', 'ATTRIBUTE') ), None)
    has_vcol = vcol is not None
    nt.nodes.clear()
    N = nt.nodes.new
    L = nt.links.new
    out = N('ShaderNodeOutputMaterial')
    uvn = N('ShaderNodeUVMap') if not uv else None
    if uvn:
        uvn.uv_map = 'UVMap'

    def image(im, closest=False):
        t = N('ShaderNodeTexImage')
        t.image = im
        t.interpolation = 'Closest' if closest else 'Linear'
        L(uvn.outputs['UV'] if uvn else uv, t.inputs['Vector'])
        return t

    if img:
        main = image(img)
        lit = main.outputs['Color']
        alpha = main.outputs['Alpha']
    else:
        rgb = N('ShaderNodeRGB'); rgb.outputs[0].default_value = col_const
        lit, alpha = rgb.outputs[0], None
    if has_vcol and (env or not img):
        attr = N('ShaderNodeVertexColor')
        mul = N('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs['Factor'].default_value = 1
        L(lit, mul.inputs['A']); L(attr.outputs['Color'], mul.inputs['B'])
        lit = mul.outputs['Result']

    if kind in ('eye', 'mayu', 'mouth', 'minieye', 'minimayu', 'minimouth'):
        color = lit                       # drawn flat, like the game
    else:
        # where the sun reaches, cast shadows included
        diff = N('ShaderNodeBsdfDiffuse')
        s2r = N('ShaderNodeShaderToRGB')
        L(diff.outputs[0], s2r.inputs[0])
        ramp = N('ShaderNodeValToRGB')
        r = ramp.color_ramp
        r.interpolation = 'LINEAR'
        lo, hi = (0.01, 0.06) if env else (0.08, 0.16)
        r.elements[0].position, r.elements[1].position = lo, hi
        L(s2r.outputs['Color'], ramp.inputs['Fac'])
        fac = ramp.outputs['Color']
        if mask_img:
            # the game's painted shadow tendency (red: 0 always shaded, 0.5 as the light says)
            m = image(mask_img)
            sep = N('ShaderNodeSeparateColor')
            L(m.outputs['Color'], sep.inputs[0])
            k = N('ShaderNodeMapRange'); k.inputs['From Min'].default_value = 0.1; k.inputs['From Max'].default_value = 0.35
            L(sep.outputs['Red'], k.inputs['Value'])
            mn = N('ShaderNodeMath'); mn.operation = 'MINIMUM'
            L(fac, mn.inputs[0]); L(k.outputs['Result'], mn.inputs[1])
            fac = mn.outputs[0]
        if kind == 'face':
            # faces mostly lit: a full shadow across a face reads as dirt
            soft = N('ShaderNodeMapRange'); soft.inputs['To Min'].default_value = 0.55
            L(fac, soft.inputs['Value'])
            fac = soft.outputs['Result']
        if shadow_img:
            shade = image(shadow_img).outputs['Color']
        else:
            tint = N('ShaderNodeMix'); tint.data_type = 'RGBA'; tint.blend_type = 'MULTIPLY'; tint.inputs['Factor'].default_value = 1
            tint.inputs['B'].default_value = (0.72, 0.66, 0.8, 1) if not env else (0.62, 0.62, 0.78, 1)
            L(lit, tint.inputs['A'])
            shade = tint.outputs['Result']
        mix = N('ShaderNodeMix'); mix.data_type = 'RGBA'
        L(fac, mix.inputs['Factor']); L(shade, mix.inputs['A']); L(lit, mix.inputs['B'])
        color = mix.outputs['Result']
        if not env:
            # a thin warm rim on the lit side
            lw = N('ShaderNodeLayerWeight'); lw.inputs['Blend'].default_value = 0.25
            rr = N('ShaderNodeValToRGB'); rr.color_ramp.elements[0].position = 0.55; rr.color_ramp.elements[1].position = 0.75
            L(lw.outputs['Facing'], rr.inputs['Fac'])
            rim = N('ShaderNodeMath'); rim.operation = 'MULTIPLY'; rim.inputs[1].default_value = 0.18
            L(rr.outputs['Color'], rim.inputs[0])
            rim2 = N('ShaderNodeMath'); rim2.operation = 'MULTIPLY'
            L(rim.outputs[0], rim2.inputs[0]); L(fac, rim2.inputs[1])
            add = N('ShaderNodeMix'); add.data_type = 'RGBA'; add.blend_type = 'ADD'
            add.inputs['B'].default_value = (1, 0.93, 0.85, 1)
            L(rim2.outputs[0], add.inputs['Factor']); L(color, add.inputs['A'])
            color = add.outputs['Result']
    em = N('ShaderNodeEmission')
    L(color, em.inputs['Color'])
    shader = em.outputs[0]
    if alpha is not None and (cutout > 0 or mat.blend_method != 'OPAQUE' or kind == 'hair'):
        tr = N('ShaderNodeBsdfTransparent')
        mx = N('ShaderNodeMixShader')
        a = alpha
        if cutout > 0:
            gt = N('ShaderNodeMath'); gt.operation = 'GREATER_THAN'; gt.inputs[1].default_value = cutout
            L(alpha, gt.inputs[0]); a = gt.outputs[0]
        L(a, mx.inputs['Fac']); L(tr.outputs[0], mx.inputs[1]); L(shader, mx.inputs[2])
        shader = mx.outputs[0]
        mat.surface_render_method = 'DITHERED'
    L(shader, out.inputs['Surface'])
    return img


def outline_mat(src, img):
    """Back faces of a pushed-out copy, a dark take on the surface colour."""
    m = bpy.data.materials.new(src.name + ' line')
    m.use_nodes = True
    m.use_backface_culling = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    mul = nt.nodes.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs['Factor'].default_value = 1
    mul.inputs['B'].default_value = (0.32, 0.27, 0.3, 1)
    if img:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = img
        nt.links.new(t.outputs['Color'], mul.inputs['A'])
    else:
        mul.inputs['A'].default_value = (0.4, 0.4, 0.4, 1)
    nt.links.new(mul.outputs['Result'], em.inputs['Color'])
    # the shell wraps the whole mesh: casting the sun's shadow it would darken everything inside it
    lp = nt.nodes.new('ShaderNodeLightPath')
    tr = nt.nodes.new('ShaderNodeBsdfTransparent')
    mx = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(lp.outputs['Is Shadow Ray'], mx.inputs['Fac'])
    nt.links.new(em.outputs[0], mx.inputs[1])
    nt.links.new(tr.outputs[0], mx.inputs[2])
    nt.links.new(mx.outputs[0], out.inputs['Surface'])
    m.surface_render_method = 'DITHERED'
    m.use_transparent_shadow = True
    return m


# LooperHonstropy's uma shader (blender/Umashaders.blend, see THIRD_PARTY.md) for bodies, hair,
# faces and tails when it's there: the game's maps go into its slots, its outlines come from a
# geometry-nodes group that faces the camera, its light from the "Uma Sun" empty
LOOPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'Umashaders.blend')
LOOPER_KINDS = {'body', 'hair', 'face', 'tail'}
looper = None
if os.path.exists(LOOPER):
    with bpy.data.libraries.load(LOOPER, link=False) as (src, dst):
        dst.materials = [m for m in src.materials if m in ('Uma Shader', 'Uma Outline Material')]
        dst.node_groups = [g for g in src.node_groups if g == 'Uma Outlines']
        dst.objects = [o for o in src.objects if o.startswith('Uma Sun')]
    if len(dst.materials) == 2 and dst.node_groups and dst.objects:
        looper = {'shader': next(m for m in dst.materials if m.name.startswith('Uma Shader')),
                  'line': next(m for m in dst.materials if m.name.startswith('Uma Outline')),
                  'outlines': dst.node_groups[0], 'sun': dst.objects[0]}
        scene.collection.objects.link(looper['sun'])


def grey():
    """A plain mid-grey map for slots the model has nothing for (0.5 = as the light says)."""
    im = bpy.data.images.get('uma grey') or bpy.data.images.new('uma grey', 4, 4)
    im.pixels = [0.5, 0.5, 0.5, 1.0] * 16
    im.colorspace_settings.name = 'Non-Color'
    return im


def looper_mat(mat, kind):
    """A copy of the uma shader with this material's maps in it."""
    old = tex_node(mat)
    m = looper['shader'].copy()
    m.name = mat.name + ' uma'
    m['uma'] = kind
    nodes = m.node_tree.nodes
    def put(node, im, data=False):
        if node in nodes:
            nodes[node].image = im
            if im is not None and data:
                im.colorspace_settings.name = 'Non-Color'
    put('Image Texture', old.image if old else None)                              # diffuse (the colour)
    put('Image Texture.002', load_image(mat.get('toon')) or (old.image if old else None))   # shaded colour
    put('Image Texture.003', load_image(mat.get('triple'), data=True) or grey(), data=True)   # base mask
    put('Image Texture.001', load_image(mat.get('ctrl'), data=True) or grey(), data=True)     # ctrl mask
    put('Image Texture.004', None)                                                # no glow maps
    grp = next((n for n in nodes if n.type == 'GROUP' and n.node_tree and n.node_tree.name.startswith('Uma Shader')), None)
    if grp:
        grp.inputs['Toggle If Face [0=Off,1=On]'].default_value = 1.0 if kind == 'face' else 0.0
        if 'Emmission Toggle' in grp.inputs:
            grp.inputs['Emmission Toggle'].default_value = 0.0
    return m


def glow(mat):
    """A model material named 'GLOW<strength> …' (lasers, lamps, stars): its colour or texture
    as plain light, bright enough to bloom; no toon shading, no outline."""
    m = re.search(r'GLOW(\d+(?:\.\d+)?)', mat.name)
    strength = float(m.group(1)) if m else 4.0
    old = tex_node(mat)
    img = old.image if old else None
    col = base_color(mat)
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Strength'].default_value = strength
    if img:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = img
        uvn = nt.nodes.new('ShaderNodeUVMap'); uvn.uv_map = 'UVMap'
        nt.links.new(uvn.outputs['UV'], t.inputs['Vector'])
        nt.links.new(t.outputs['Color'], em.inputs['Color'])
    else:
        em.inputs['Color'].default_value = col
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    return img


done = {}
looped = []
for ob in list(bpy.data.objects):
    if ob.type != 'MESH':
        continue
    # lights, beams and the space sphere: they must not shade anything
    if any(s.material and ('NOSHADOW' in s.material.name or 'GLOW' in s.material.name) for s in ob.material_slots):
        ob.visible_shadow = False
    # the sky is a dome around everything: casting the sun's shadow it would put the whole place
    # in the dark
    if any(k in (ob.name + ' ' + (ob.parent.name if ob.parent else '')).lower() for k in ('sky', 'cloud')):
        ob.visible_shadow = False
    if looper and ob.name.startswith('Icosphere of Materials'):
        continue
    if looper:
        uses = False
        for slot in ob.material_slots:
            mat = slot.material
            if mat and mat.get('uma') in LOOPER_KINDS:
                key = mat.name + ' uma'
                slot.material = bpy.data.materials.get(key) or looper_mat(mat, mat.get('uma'))
                uses = True
        if uses:
            looped.append(ob)
    mats = [s.material for s in ob.material_slots if s.material and s.material.use_nodes and not s.material.name.endswith(' uma')]
    for mat in mats:
        if mat.name in done:
            continue
        kind = mat.get('uma') or ('env' if mat.get('env') else 'prop')
        if 'GLOW' in mat.name and kind in ('env', 'prop'):
            done[mat.name] = glow(mat)
        elif kind == 'env':
            done[mat.name] = toon(mat, 'env', env=True)
        else:
            done[mat.name] = toon(mat, kind, load_image(mat.get('toon')), load_image(mat.get('triple'), data=True), float(mat.get('cutout', 0) or 0))
    # outlines on the umas and props, not on the place (hundreds of metres of lines)
    kinds = {mat.get('uma') or ('env' if mat.get('env') else 'prop') for mat in mats}
    if ob in looped or not mats or 'env' in kinds or kinds <= {'eye', 'mayu', 'mouth', 'cheek', 'tear'} \
            or any('GLOW' in m.name or 'NOSHADOW' in m.name for m in mats):
        continue
    base = len(ob.data.materials)
    for mat in mats:
        ob.data.materials.append(outline_mat(mat, done.get(mat.name)))
    sol = ob.modifiers.new('outline', 'SOLIDIFY')
    sol.thickness = 0.0022 if 'face' in kinds else 0.003
    sol.offset = 1
    sol.use_flip_normals = True
    sol.use_rim = False
    sol.material_offset = base


# --- light, air, focus ----------------------------------------------------------------------------

cam_rot = cam.matrix_world.to_quaternion() if cam else None
scene.frame_set(scene.frame_start)
az, el = math.radians(meta.get('lightAz', -35)), math.radians(meta.get('lightEl', 35))
# toward the light in camera space (three: +x right, +y up, +z toward the viewer), then world
d = Vector((math.sin(az) * math.cos(el), math.sin(el), math.cos(az) * math.cos(el)))
d = cam.matrix_world.to_3x3() @ d if meta.get('lightFollowsCamera', True) else Vector((d.x, -d.z, d.y))
sun_data = bpy.data.lights.new('Sun', 'SUN')
sun_data.energy = 4.0
sun_data.color = (1.0, 0.93, 0.82)
sun_data.angle = math.radians(2.5)
sun_data.use_shadow = True
sun = bpy.data.objects.new('Sun', sun_data)
scene.collection.objects.link(sun)
sun.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()

if looper:
    # their shader takes the light from this empty's turn: its +Z goes the way the light travels
    # (a sun lamp's -Z does), so it points opposite to the lamp
    looper['sun'].rotation_euler = (-d).to_track_quat('Z', 'Y').to_euler()
    line = looper['line']
    for ob in looped:
        gn = ob.modifiers.new('Uma Outlines', 'NODES')
        gn.node_group = looper['outlines']
        ins = {i.name: i.identifier for i in looper['outlines'].interface.items_tree if i.item_type == 'SOCKET' and i.in_out == 'INPUT'}
        # blender 5 keeps a nodes modifier's inputs on .properties.inputs, older ones as id properties
        def set_in(name, value):
            if hasattr(gn, 'properties'):
                getattr(gn.properties.inputs, ins[name]).value = value
            else:
                gn[ins[name]] = value
        set_in('Camera', cam)
        set_in('Outline Material', line)
        face = next((o for o in looped if o.parent == ob.parent and any(sl.material and sl.material.name.endswith(' uma') and
                                                                       sl.material.get('uma') == 'face' for sl in o.material_slots)), None)
        if face is not None and 'Face' in ins:
            set_in('Face', face)

world = bpy.data.worlds.new('World')
scene.world = world
world.use_nodes = True
wn = world.node_tree
bg = wn.nodes.get('Background') or wn.nodes.new('ShaderNodeBackground')
bg.inputs['Color'].default_value = (0.62, 0.72, 0.85, 1) if meta['background'] == 'place' else (1, 1, 1, 1)
bg.inputs['Strength'].default_value = 1.0
wout = next(n for n in wn.nodes if n.type == 'OUTPUT_WORLD')

ev = scene.eevee
ev.taa_render_samples = 24
ev.use_shadows = True
ev.shadow_ray_count = 1
ev.shadow_step_count = 4
# the haze shading itself would dim the sun through an endless world volume to nothing
ev.use_volumetric_shadows = False
ev.volumetric_start = 0.5
ev.volumetric_end = 80
ev.volumetric_tile_size = '8'
ev.volumetric_samples = 32
ev.use_raytracing = False
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'

# depth of field on the active uma's head
focus = next((c for c in meta['cast'] if c['key'] == meta.get('focusOn')), meta['cast'][0] if meta['cast'] else None)
arm = None
if focus and focus.get('head'):
    arm = next((o for o in bpy.data.objects if o.type == 'ARMATURE' and focus['head'] in o.data.bones), None)

# a little haze in a box around the shot: soft depth, and shafts where the sun comes past things.
# (a world volume goes on for ever and swallows the sunlight before it reaches anyone)
scene.frame_set(scene.frame_start)
# the box spans everywhere the camera goes over the whole shot, with room round it
lo, hi = Vector((1e9, 1e9, 1e9)), Vector((-1e9, -1e9, -1e9))
for f in range(scene.frame_start, scene.frame_end + 1, 15):
    scene.frame_set(f)
    p = cam.matrix_world.translation
    if p.z > 200:
        continue        # shots high above the place (space) get no haze
    lo = Vector(map(min, lo, p)); hi = Vector(map(max, hi, p))
scene.frame_set(scene.frame_start)
centre = (lo + hi) / 2
bpy.ops.mesh.primitive_cube_add(size=1, location=(centre.x, centre.y, 12))
haze = bpy.context.active_object
haze.name = 'Haze'
haze.scale = (hi.x - lo.x + 160, hi.y - lo.y + 160, 30)
hm = bpy.data.materials.new('Haze')
hm.use_nodes = True
hn = hm.node_tree
hn.nodes.clear()
vol = hn.nodes.new('ShaderNodeVolumePrincipled')
vol.inputs['Density'].default_value = float(meta.get('haze', 0.0025))
vol.inputs['Color'].default_value = (1.0, 0.93, 0.84, 1)
vol.inputs['Anisotropy'].default_value = 0.5
ho = hn.nodes.new('ShaderNodeOutputMaterial')
hn.links.new(vol.outputs[0], ho.inputs['Volume'])
haze.data.materials.append(hm)
haze.visible_shadow = False

if arm:
    tgt = bpy.data.objects.new('Focus', None)
    scene.collection.objects.link(tgt)
    c = tgt.constraints.new('COPY_LOCATION')
    c.target = arm
    c.subtarget = focus['head']
    cam.data.dof.use_dof = True
    cam.data.dof.focus_object = tgt
    cam.data.dof.aperture_fstop = 1.8
    # focusKeys [{t, key}]: who's in focus from t on (key null: everything sharp)
    keys = meta.get('focusKeys') or []
    if keys:
        heads = {c['key']: c.get('head') for c in meta['cast']}
        arms = {}
        for k, h in heads.items():
            arms[k] = next((o for o in bpy.data.objects if o.type == 'ARMATURE' and h and h in o.data.bones
                            and o.name not in [a.name for a in arms.values() if a]), None)
        tgt.constraints.clear()
        cons = {}
        for k, a in arms.items():
            if a is None:
                continue
            c = tgt.constraints.new('COPY_LOCATION'); c.target = a; c.subtarget = heads[k]
            cons[k] = c
        fps = scene.render.fps
        for fk in keys:
            f = scene.frame_start + round(fk['t'] * fps)
            for k, c in cons.items():
                c.influence = 1.0 if fk.get('key') == k else 0.0
                c.keyframe_insert('influence', frame=f)
            cam.data.dof.aperture_fstop = 1.8 if fk.get('key') in cons else 64.0
            cam.data.dof.keyframe_insert('aperture_fstop', frame=f)
        for fc in iter_fcurves(tgt) + iter_fcurves(cam.data):
            for kp in fc.keyframe_points:
                kp.interpolation = 'CONSTANT'


# --- compositor -----------------------------------------------------------------------------------

ng = bpy.data.node_groups.new('Finish', 'CompositorNodeTree')
scene.compositing_node_group = ng
ng.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
C = ng.nodes.new
rl = C('CompositorNodeRLayers')
glare = C('CompositorNodeGlare')
glare.inputs['Type'].default_value = 'Bloom'
glare.inputs['Threshold'].default_value = 0.85
glare.inputs['Strength'].default_value = 0.35
glare.inputs['Size'].default_value = 0.7
cb = C('CompositorNodeColorBalance')
cb.inputs['Type'].default_value = 'Lift/Gamma/Gain'
cb.inputs[4].default_value = (1.015, 1.008, 1.0, 1)     # lift: a touch warm, blacks stay black
cb.inputs[8].default_value = (1.03, 1.0, 0.96, 1)       # gain: warm highlights
hs = C('CompositorNodeHueSat')
hs.inputs['Saturation'].default_value = 1.08
gout = C('NodeGroupOutput')
# fx [{t, dark, flash}]: a night tint (before the glow, so lights still bloom through it) and a
# white flash, keyed over the timeline
def sock(coll, ident):
    """A socket by identifier (the mix node's names repeat per data type)."""
    return next(x for x in coll if x.identifier == ident)


def mixer(blend, color):
    n = C('ShaderNodeMix'); n.data_type = 'RGBA'; n.blend_type = blend
    sock(n.inputs, 'B_Color').default_value = color
    sock(n.inputs, 'Factor_Float').default_value = 0.0
    return n
dark = mixer('MULTIPLY', (0.06, 0.07, 0.2, 1))
flash = mixer('MIX', (1, 0.97, 0.92, 1))
ng.links.new(rl.outputs['Image'], sock(dark.inputs, 'A_Color'))
ng.links.new(sock(dark.outputs, 'Result_Color'), glare.inputs['Image'])
ng.links.new(glare.outputs['Image'], cb.inputs['Image'])
ng.links.new(cb.outputs['Image'], hs.inputs['Image'])
ng.links.new(hs.outputs['Image'], sock(flash.inputs, 'A_Color'))
ng.links.new(sock(flash.outputs, 'Result_Color'), gout.inputs[0])
for fx in meta.get('fx') or []:
    f = scene.frame_start + round(fx['t'] * scene.render.fps)
    for node, k in ((dark, 'dark'), (flash, 'flash')):
        if k in fx:
            sock(node.inputs, 'Factor_Float').default_value = fx[k]
            sock(node.inputs, 'Factor_Float').keyframe_insert('default_value', frame=f)


# --- render ---------------------------------------------------------------------------------------

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(DIR, 'scene.blend'))
scene.render.image_settings.file_format = 'PNG'
os.makedirs(os.path.join(DIR, 'frames'), exist_ok=True)
if STILL is not None:
    scene.frame_set(scene.frame_start + STILL)
    scene.render.filepath = os.path.join(DIR, f'still_{STILL:04d}.png')
    bpy.ops.render.render(write_still=True)
else:
    scene.render.filepath = os.path.join(DIR, 'frames', '')
    bpy.ops.render.render(animation=True)
print('UMASTUDIO DONE')
