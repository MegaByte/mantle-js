# Original FontTools fixture: one-em CJK advances and 0.1-em left ink bearing.
# Only geometry/metrics are synthetic; word-start expectations come from Intl.
import os
import sys
os.environ.setdefault('SOURCE_DATE_EPOCH', '0')
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

cps = sorted(set(map(ord, 'A今日は良い天気')) | {32})
names = ['.notdef'] + ['u%04X' % cp for cp in cps]
fb = FontBuilder(1000, isTTF=True)
fb.setupGlyphOrder(names)
fb.setupCharacterMap(dict(zip(cps, names[1:])))
glyphs = {}
for name in names:
    pen = TTGlyphPen(None)
    if name != 'u0020':
        pen.moveTo((100, 0))
        pen.lineTo((700, 0))
        pen.lineTo((700, 800))
        pen.lineTo((100, 800))
        pen.closePath()
    glyphs[name] = pen.glyph()
fb.setupGlyf(glyphs)
fb.setupHorizontalMetrics({name: (1000, 0 if name == 'u0020' else 100) for name in names})
fb.setupHorizontalHeader(ascent=800, descent=-200)
fb.setupNameTable({'familyName': 'Mantle Word Boundary Fixture', 'styleName': 'Regular'})
fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
fb.setupPost()
fb.setupMaxp()
fb.font.recalcTimestamp = False
fb.font['head'].created = fb.font['head'].modified = 2082844800
fb.save(sys.argv[1])
