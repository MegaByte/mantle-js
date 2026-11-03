# Builds cffSubrBomb.otf (fontTools, independent writer) for cffCharStringBudgetSmoke: a CFF font whose glyph 'A' is a subroutine bomb.
# Subr i calls subr i+1 B times (B=16, depth 9 stays under the interpreter's depth cap of 10), so the glyph costs
# B^8 = 4.3e9 operators without a work budget. Glyph 'B' is an ordinary square and must still render.
#   python3 genCffBombFont.py out.otf [B]
import sys, os
os.environ.setdefault('SOURCE_DATE_EPOCH', '0')   # fixed head timestamps: regenerating gives the same bytes
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.misc.psCharStrings import T2CharString
from fontTools.cffLib import SubrsIndex

out = sys.argv[1]; B = int(sys.argv[2]) if len(sys.argv) > 2 else 16
names = ['.notdef', 'A', 'B']
fb = FontBuilder(1000, isTTF=False)
fb.setupGlyphOrder(names)
fb.setupCharacterMap({0x41: 'A', 0x42: 'B'})
def square():
    p = T2CharStringPen(600, None)
    p.moveTo((50, 0)); p.lineTo((50, 600)); p.lineTo((450, 600)); p.lineTo((450, 0)); p.closePath()
    return p.getCharString()
cs = {g: square() for g in names}
fb.setupCFF('cffSubrBomb', {'FullName': 'cffSubrBomb'}, cs, {})
cff = fb.font['CFF '].cff; top = cff.topDictIndex[0]; priv = top.Private
bias = 107
N = 9
subrs = SubrsIndex()
for i in range(N):
    prog = []
    if i < N - 1:
        for _ in range(B): prog += [(i + 1) - bias, 'callsubr']
    prog.append('return')
    c = T2CharString(program=prog, private=priv, globalSubrs=cff.GlobalSubrs); subrs.append(c)
priv.Subrs = subrs
a = top.CharStrings['A']
a.program = [600, 0 - bias, 'callsubr', 'endchar']   # width, then the bomb
a.bytecode = None
a.private = priv
fb.setupHorizontalMetrics({g: (600, 50) for g in names})
fb.setupHorizontalHeader(ascent=800, descent=-200)
fb.setupNameTable({'familyName': 'cffSubrBomb', 'styleName': 'Regular'})
fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
fb.setupPost()
fb.font.recalcBBoxes = False
fb.save(out)
print('ok')
