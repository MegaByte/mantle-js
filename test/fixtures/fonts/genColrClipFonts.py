# Builds the committed COLRv1 ClipList fixtures with fontTools.colorLib (an independent writer of the COLR tables).
#   python3 genColrClipFonts.py <outdir>      writes colrSpecClip.ttf and colrSpecClipVar.ttf
# colrSpecClip.ttf (upem 1000): every color glyph paints the 600x600 box outline (100,0)-(700,600).
#   A  PaintGlyph(box, red)                 ClipBox (200,100)-(500,400)
#   B  PaintTranslate(100,-50, ColrGlyph A)  no clip of its own: A's box applies, moved with the translate
#   C  PaintGlyph(box, blue)                 no ClipBox (control: the whole box paints)
#   D  ColrGlyph A                           own ClipBox (250,150)-(650,500): both boxes apply -> (250,150)-(500,400)
#   E  PaintGlyph(box, green)                ClipBox (150,50)-(450,350)  } one Clip record, glyph range E..F
#   F  PaintGlyph(box, red)                  same ClipBox                }
#   G  PaintRotate(30, ColrGlyph A)          no clip of its own: A's box rotates with the paint
# colrSpecClipVar.ttf (fvar wght 0..1): A has a ClipBox format 2 (var), deltas at wght=1: xMin -50, yMin -50, xMax +100, yMax +100.
import sys, os
os.environ.setdefault('SOURCE_DATE_EPOCH', '0')
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.colorLib.builder import buildCOLR, buildCPAL
from fontTools.ttLib.tables import otTables as ot
from fontTools.varLib import builder as vb

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
PAL = [(1, 0, 0, 1), (0, 0.4, 1, 1), (0, 0.7, 0, 1)]
solid = lambda i: {"Format": ot.PaintFormat.PaintSolid, "PaletteIndex": i, "Alpha": 1.0}
box = lambda i: {"Format": ot.PaintFormat.PaintGlyph, "Glyph": 'box', "Paint": solid(i)}
ref = lambda g: {"Format": ot.PaintFormat.PaintColrGlyph, "Glyph": g}

def build(path, paints, clips, varStore=None, fvar=False):
    names = ['.notdef', 'box'] + list(paints.keys())
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap({65 + i: g for i, g in enumerate(paints.keys())})
    gl = {}
    for g in names:
        p = TTGlyphPen(None)
        if g == '.notdef':
            p.moveTo((50, 0)); p.lineTo((50, 700)); p.lineTo((550, 700)); p.lineTo((550, 0)); p.closePath()
        else:   # box and every color base glyph: the same square (the base outline is the primary silhouette)
            p.moveTo((100, 0)); p.lineTo((100, 600)); p.lineTo((700, 600)); p.lineTo((700, 0)); p.closePath()
        gl[g] = p.glyph()
    fb.setupGlyf(gl)
    fb.setupHorizontalMetrics({g: (800, 50 if g == '.notdef' else 100) for g in names})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({'familyName': os.path.basename(path), 'styleName': 'Regular'})
    fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    fb.setupPost()
    if fvar:
        fb.setupFvar([('wght', 0, 0, 1, 'Weight')], [])
    fb.font['CPAL'] = buildCPAL([PAL])
    fb.font['COLR'] = buildCOLR(paints, version=1, glyphMap=fb.font.getReverseGlyphMap(), varStore=varStore, clipBoxes=clips)
    fb.save(path)

paints = {
    'A': box(0),
    'B': {"Format": ot.PaintFormat.PaintTranslate, "Paint": ref('A'), "dx": 100, "dy": -50},
    'C': box(1),
    'D': ref('A'),
    'E': box(2),
    'F': box(0),
    'G': {"Format": ot.PaintFormat.PaintRotate, "Paint": ref('A'), "angle": 30.0},
}
clips = {'A': (200, 100, 500, 400), 'D': (250, 150, 650, 500), 'E': (150, 50, 450, 350), 'F': (150, 50, 450, 350)}
build(os.path.join(out, 'colrSpecClip.ttf'), paints, clips)

rl = vb.buildVarRegionList([{'wght': (0, 1.0, 1.0)}], ['wght'])
vd = vb.buildVarData([0], [[-50], [-50], [100], [100]], optimize=False)
vs = vb.buildVarStore(rl, [vd])
build(os.path.join(out, 'colrSpecClipVar.ttf'), {'A': box(0)}, {'A': (200, 100, 500, 400, 0)}, varStore=vs, fvar=True)
print('ok')
