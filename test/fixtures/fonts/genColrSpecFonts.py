# Builds the committed COLRv1 spec-layout fixtures with fontTools.colorLib (an INDEPENDENT writer of the OpenType
# COLR tables), so the reader's tests can't agree with a hand-rolled wrong layout.
#   python3 genColrSpecFonts.py <outdir>      writes colrSpecXf.ttf, colrSpecVar.ttf, colrSpecRadial.ttf, colrInterp.ttf and colrInterpVar.ttf
# colrSpecXf.ttf  (upem 1000, no variation): PaintTransform cases, PaintSkew/PaintSkewAroundCenter x and y, base outlines
#                  that are never drawn, a plain PaintGlyph control.
# colrSpecVar.ttf (upem 1000, fvar wght 0..1 default 0): Var* paints whose deltas are the table below at wght=1.
import sys, os
os.environ.setdefault('SOURCE_DATE_EPOCH', '0')   # fixed head timestamps: regenerating gives the same bytes
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.colorLib.builder import buildCOLR, buildCPAL
from fontTools.ttLib.tables import otTables as ot
from fontTools.varLib import builder as vb

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

def sq(pen, x0, y0, x1, y1):
    pen.moveTo((x0, y0)); pen.lineTo((x0, y1)); pen.lineTo((x1, y1)); pen.lineTo((x1, y0)); pen.closePath()

def outlines(names, special):
    gl = {}
    for g in names:
        p = TTGlyphPen(None)
        if g == 'L':
            p.moveTo((100, 0)); p.lineTo((100, 700)); p.lineTo((250, 700)); p.lineTo((250, 150)); p.lineTo((600, 150)); p.lineTo((600, 0)); p.closePath()
        elif g == '.notdef': sq(p, 50, 0, 550, 700)
        elif g in special: sq(p, 100, 0, 700, 600)      # a base outline that the paint graph never draws
        gl[g] = p.glyph()
    return gl

LSB = {'.notdef': 50}
PAL = [(1, 0, 0, 1), (0, 0.4, 1, 1), (0, 0.7, 0, 1), (1, 0.8, 0, 0.5)]
G = lambda g, p: {"Format": ot.PaintFormat.PaintGlyph, "Glyph": g, "Paint": p}
solid = lambda i, a=1.0: {"Format": ot.PaintFormat.PaintSolid, "PaletteIndex": i, "Alpha": a}

def build(path, names, cmap, paints, special, varStore=None, fvar=False):
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(outlines(names, special))
    fb.setupHorizontalMetrics({g: (800, LSB.get(g, 100)) for g in names})   # lsb = xMin: the outline is not shifted by (xMin - lsb)
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({'familyName': os.path.basename(path), 'styleName': 'Regular'})
    fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    fb.setupPost()
    if fvar:
        fb.setupFvar([('wght', 0, 0, 1, 'Weight')], [])
    fb.font['CPAL'] = buildCPAL([PAL])
    fb.font['COLR'] = buildCOLR(paints, version=1, glyphMap=fb.font.getReverseGlyphMap(), varStore=varStore)
    fb.save(path)

# ---- static font ---------------------------------------------------------------------------------------------------
T = lambda p, m: {"Format": ot.PaintFormat.PaintTransform, "Paint": p, "Transform": m}
L1 = G('L', solid(1))
xf = {
    'A': T(L1, (1, 0, 0, 1, 0, 0)),                    # identity
    'B': T(L1, (1, 0, 0, 1, 100, 50)),                 # translate
    'C': T(L1, (0.5, 0, 0, 0.5, 0, 0)),                # scale
    'D': T(L1, (0.866, 0.5, -0.5, 0.866, 0, 0)),       # rotate 30
    'E': T(L1, (1, 0, 0.5, 1, 0, 0)),                  # shear x
    'F': T(L1, (-1, 0, 0, 1, 700, 0)),                 # flip
    'G': T(L1, (0.8, 0.4, -0.3, 0.9, 100, 50)),        # general
    'H': {"Format": ot.PaintFormat.PaintTranslate, "Paint": L1, "dx": 100, "dy": 50},
    'I': {"Format": ot.PaintFormat.PaintScale, "Paint": L1, "scaleX": 0.5, "scaleY": 0.8},
    'J': {"Format": ot.PaintFormat.PaintSkew, "Paint": L1, "xSkewAngle": 20.0, "ySkewAngle": 0.0},
    'K': {"Format": ot.PaintFormat.PaintSkew, "Paint": L1, "xSkewAngle": 0.0, "ySkewAngle": 20.0},
    'M': {"Format": ot.PaintFormat.PaintSkewAroundCenter, "Paint": L1, "xSkewAngle": 20.0, "ySkewAngle": -10.0, "centerX": 350, "centerY": 350},
    'N': {"Format": ot.PaintFormat.PaintRotateAroundCenter, "Paint": L1, "angle": 45.0, "centerX": 350, "centerY": 350},
    'O': G('L', solid(1)),                              # control: a plain PaintGlyph
    'P': T(T(L1, (0.5, 0, 0, 0.5, 0, 0)), (1, 0, 0, 1, 200, 100)),   # nested transform
}
xfNames = ['.notdef', 'L'] + list(xf.keys())
build(os.path.join(out, 'colrSpecXf.ttf'), xfNames, {ord(g): g for g in xf.keys()}, xf, set(xf.keys()))   # U+0041 'A' ... one letter per glyph name

# ---- variable font: Var* paints at wght=1 --------------------------------------------------------------------------
# VarStore: one region (wght peak 1.0 on [0,1]); item i of the single ItemVariationData has delta DELTAS[i] at wght=1.
# Paints take consecutive varIndexBase slots in declaration order.
DELTAS = [
    # PaintVarTransform (VarAffine2x3, Fixed deltas in 1/65536): xx, yx, xy, yy, dx, dy
    -32768, 0, 16384, 0, 50 * 65536, 25 * 65536,
    # PaintVarSolid: alpha delta F2DOT14
    -8192,
    # PaintVarTranslate: dx, dy (FWORD)
    40, -30,
    # PaintVarScale: sx, sy (F2DOT14)
    -8192, -4096,
    # PaintVarRotate: angle (F2DOT14, 180 deg per 1.0)
    4096,
    # PaintVarLinearGradient: x0 y0 x1 y1 x2 y2
    10, 20, 30, 40, 50, 60,
    # PaintVarSkew: xSkew, ySkew (F2DOT14)
    2048, 1024,
]
rl = vb.buildVarRegionList([{'wght': (0, 1.0, 1.0)}], ['wght'])
vd = vb.buildVarData([0], [[d] for d in DELTAS], optimize=False)
vs = vb.buildVarStore(rl, [vd])

base = 0
def nxt(n):
    global base
    b = base; base += n; return b
VT = lambda p, m: {"Format": ot.PaintFormat.PaintVarTransform, "Paint": p, "Transform": dict(zip(("xx", "yx", "xy", "yy", "dx", "dy"), m), VarIndexBase=nxt(6))}
v = {
    'A': VT(L1, (1, 0, 0, 1, 100, 0)),
    'B': G('L', {"Format": ot.PaintFormat.PaintVarSolid, "PaletteIndex": 1, "Alpha": 1.0, "VarIndexBase": nxt(1)}),
    'C': {"Format": ot.PaintFormat.PaintVarTranslate, "Paint": L1, "dx": 100, "dy": 50, "VarIndexBase": nxt(2)},
    'D': {"Format": ot.PaintFormat.PaintVarScale, "Paint": L1, "scaleX": 1.0, "scaleY": 1.0, "VarIndexBase": nxt(2)},
    'E': {"Format": ot.PaintFormat.PaintVarRotate, "Paint": L1, "angle": 10.0, "VarIndexBase": nxt(1)},
    'F': G('L', {"Format": ot.PaintFormat.PaintVarLinearGradient,
                 "ColorLine": {"Extend": "pad", "ColorStop": [{"StopOffset": 0, "PaletteIndex": 0, "Alpha": 1}, {"StopOffset": 1, "PaletteIndex": 1, "Alpha": 1}]},
                 "x0": 0, "y0": 0, "x1": 500, "y1": 0, "x2": 0, "y2": 500, "VarIndexBase": nxt(6)}),
    'G': {"Format": ot.PaintFormat.PaintVarSkew, "Paint": L1, "xSkewAngle": 10.0, "ySkewAngle": 5.0, "VarIndexBase": nxt(2)},
}
assert base == len(DELTAS), (base, len(DELTAS))
vNames = ['.notdef', 'L'] + list(v.keys())
build(os.path.join(out, 'colrSpecVar.ttf'), vNames, {65 + i: g for i, g in enumerate(v.keys())}, v, set(), varStore=vs, fvar=True)

# ---- radial gradients: two-point conical, the cases whose cone has a mirror image beyond the apex ---------------
def rad(stops, c0, r0, c1, r1, ext):
    return {"Format": ot.PaintFormat.PaintRadialGradient, "ColorLine": {"Extend": ext, "ColorStop": [{"StopOffset": o, "PaletteIndex": i, "Alpha": 1} for o, i in stops]},
            "x0": c0[0], "y0": c0[1], "r0": r0, "x1": c1[0], "y1": c1[1], "r1": r1}
ST = [(0, 0), (0.5, 2), (1, 1)]
BOX = lambda p: G('box', p)
radial = {
    'A': BOX(rad(ST, (400, 300), 40, (600, 300), 120, "pad")),
    'B': BOX(rad(ST, (400, 300), 40, (600, 300), 120, "repeat")),
    'C': BOX(rad(ST, (400, 300), 40, (600, 300), 120, "reflect")),
    'D': BOX(rad(ST, (300, 300), 0, (500, 300), 150, "reflect")),
    'E': BOX(rad(ST, (250, 300), 100, (500, 300), 20, "pad")),
    'F': BOX(rad(ST, (300, 300), 50, (500, 300), 50, "pad")),
    'G': BOX(rad(ST, (400, 300), 100, (450, 300), 300, "pad")),
}
rNames = ['.notdef', 'box'] + list(radial.keys())
def radialOutlines():
    gl = {}
    for g in rNames:
        p = TTGlyphPen(None)
        if g == 'box': sq(p, 100, 0, 700, 600)
        elif g == '.notdef': sq(p, 50, 0, 550, 700)
        elif g in radial: sq(p, 100, 0, 700, 600)
        gl[g] = p.glyph()
    return gl
fb = FontBuilder(1000, isTTF=True)
fb.setupGlyphOrder(rNames)
fb.setupCharacterMap({65 + i: g for i, g in enumerate(radial.keys())})
fb.setupGlyf(radialOutlines())
fb.setupHorizontalMetrics({g: (800, LSB.get(g, 100)) for g in rNames})
fb.setupHorizontalHeader(ascent=800, descent=-200)
fb.setupNameTable({'familyName': 'colrSpecRadial', 'styleName': 'Regular'})
fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
fb.setupPost()
fb.font['CPAL'] = buildCPAL([PAL])
fb.font['COLR'] = buildCOLR(radial, version=1, glyphMap=fb.font.getReverseGlyphMap())
fb.save(os.path.join(out, 'colrSpecRadial.ttf'))

# ---- color-line interpolation: the same color lines on linear, radial and sweep paints, a square glyph 1000 units wide ---------------
# colrInterp.ttf: colrInterpolationRenderSmoke's oracle cases, so each letter's stops and geometry are the smoke's table.
# colrInterpVar.ttf: a VarColorLine whose second stop's alpha falls from 1 to 0 as wght goes 0..1.
IPAL = [(1, 0, 0, 1), (0, 1, 0, 1), (0, 0, 1, 1), (1, 1, 1, 1), (0, 0, 0, 1), (32 / 255, 32 / 255, 32 / 255, 1)]
RED, GREEN, BLUE, WHITE, BLACK, DARK, FG = 0, 1, 2, 3, 4, 5, 0xFFFF
def line(stops, ext='pad'):
    return {"Extend": ext, "ColorStop": [{"StopOffset": o, "PaletteIndex": i, "Alpha": a} for o, i, a in stops]}
def lin(stops, x1=1000, ext='pad'):
    return {"Format": ot.PaintFormat.PaintLinearGradient, "ColorLine": line(stops, ext), "x0": 0, "y0": 0, "x1": x1, "y1": 0, "x2": 0, "y2": 1000}
def radl(stops):
    return {"Format": ot.PaintFormat.PaintRadialGradient, "ColorLine": line(stops), "x0": 500, "y0": 500, "r0": 0, "x1": 500, "y1": 500, "r1": 500}
def swp(stops):
    return {"Format": ot.PaintFormat.PaintSweepGradient, "ColorLine": line(stops), "centerX": 500, "centerY": 500, "startAngle": 0, "endAngle": 360}
FIVE = [
    [(0, RED, 1), (1, GREEN, 1)],
    [(0, RED, 1), (1, BLUE, 1)],
    [(0, WHITE, 1), (1, BLACK, 1)],
    [(0, RED, 1), (1, BLUE, 0)],
    [(0, RED, 0), (1, BLUE, 1)],
]
ICASES = {}
for ch, st in zip('ABCDE', FIVE): ICASES[ch] = lin(st)
ICASES['F'] = lin([(0, RED, 1), (1, BLUE, 0.5)])                     # color and alpha both move
ICASES['G'] = lin([(0, BLACK, 1), (1, DARK, 1)])                     # a dark ramp: where 8 bits of linear light would band
ICASES['H'] = lin([(0, RED, 1), (0.25, GREEN, 1), (1, BLUE, 1)])     # three stops, unevenly placed
for ch, st in zip('IJKLM', FIVE): ICASES[ch] = radl(st)
for ch, st in zip('NOPQR', FIVE): ICASES[ch] = swp(st)
ICASES['S'] = lin(FIVE[0], x1=500, ext='repeat')
ICASES['T'] = lin(FIVE[0], x1=500, ext='reflect')
ICASES['U'] = lin([(0, RED, 1), (1, FG, 0.5)])                       # the end stop is the text's own color at alpha 0.5
def square_font(path, family, paints, varStore=None, fvar=False):
    names = ['.notdef', 'sq'] + ['c' + k for k in paints]
    gl = {}
    for g in names:
        p = TTGlyphPen(None); sq(p, 0, 0, 1000, 1000); gl[g] = p.glyph()
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap({ord(k): 'c' + k for k in paints})
    fb.setupGlyf(gl)
    fb.setupHorizontalMetrics({g: (1000, 0) for g in names})
    fb.setupHorizontalHeader(ascent=1000, descent=0)
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular'})
    fb.setupOS2(sTypoAscender=1000, sTypoDescender=0, usWinAscent=1000, usWinDescent=0)
    fb.setupPost()
    if fvar: fb.setupFvar([('wght', 0, 0, 1, 'Weight')], [])
    fb.font['CPAL'] = buildCPAL([IPAL])
    fb.font['COLR'] = buildCOLR({'c' + k: G('sq', v) for k, v in paints.items()}, version=1, glyphMap=fb.font.getReverseGlyphMap(), varStore=varStore)
    fb.save(path)
square_font(os.path.join(out, 'colrInterp.ttf'), 'colrInterp', ICASES)
irl = vb.buildVarRegionList([{'wght': (0, 1.0, 1.0)}], ['wght'])
ivd = vb.buildVarData([0], [[0], [0], [0], [-16384]], optimize=False)   # stop 0 offset, alpha; stop 1 offset, alpha (F2DOT14)
ivar = {'A': {"Format": ot.PaintFormat.PaintVarLinearGradient,
              "ColorLine": {"Extend": "pad", "ColorStop": [
                  {"StopOffset": 0, "PaletteIndex": RED, "Alpha": 1, "VarIndexBase": 0},
                  {"StopOffset": 1, "PaletteIndex": BLUE, "Alpha": 1, "VarIndexBase": 2}]},
              "x0": 0, "y0": 0, "x1": 1000, "y1": 0, "x2": 0, "y2": 1000, "VarIndexBase": 0xFFFFFFFF}}
square_font(os.path.join(out, 'colrInterpVar.ttf'), 'colrInterpVar', ivar, varStore=vb.buildVarStore(irl, [ivd]), fvar=True)
print('ok')
