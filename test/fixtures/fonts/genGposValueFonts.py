# Builds gposValues.ttf with fontTools (independent writer): GPOS value records beyond the x advance and a
# mark anchor with variation Device tables. upem 1000, fvar wght 400..900, GDEF 1.3 with a one-region store.
#   usage: python3 genGposValueFonts.py out.ttf
# Glyphs (one empty-ish box each, advance 600): A B C V T o and the mark m (U+20D7, GDEF class mark, advance 0).
# 'kern' lookups, all in script DFLT:
#   L0 SinglePos fmt1  A        xPla +30  yPla -20  yAdv +15
#   L1 SinglePos fmt2  B        xPla +10 with a VariationIndex xPla delta (+7 at wght 900)     (Value per glyph)
#                      C        yPla +5, yAdv +8 and a ppem Device on yPla (size 12..16: -1 +0 +2 +1 +0 pixels)
#   L2 PairPos fmt1    V A      Value1 xPla +12 yPla +8 xAdv -40 yAdv +6, xPla VariationIndex (-6 at wght 900)
#                               Value2 xPla -9 yPla +4 xAdv +11 yAdv -3, yPla VariationIndex (+3 at wght 900)
#   L3 PairPos fmt2    T o      Value1 xPla +20 with ppem Device (size 10..13, 8-bit: 2 -1 3 0 px), xAdv -25 with
#                               VariationIndex (+10 at wght 900); Value2 yPla -12
# 'mark' lookup: MarkBasePos fmt1 m on A: base anchor (300, 700) with xy VariationIndex Device tables (+20 / -30 at wght 900),
#   mark anchor (0, 0).
import sys, os
os.environ.setdefault('SOURCE_DATE_EPOCH', '0')
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables import otTables as ot
from fontTools.otlLib import builder as ob
from fontTools.varLib import builder as vb

out = sys.argv[1]
names = ['.notdef', 'A', 'B', 'C', 'V', 'T', 'o', 'm']
cmap = {0x41: 'A', 0x42: 'B', 0x43: 'C', 0x56: 'V', 0x54: 'T', 0x6F: 'o', 0x20D7: 'm'}
fb = FontBuilder(1000, isTTF=True)
fb.setupGlyphOrder(names)
fb.setupCharacterMap(cmap)
gl = {}
for g in names:
    p = TTGlyphPen(None)
    p.moveTo((50, 0)); p.lineTo((50, 600)); p.lineTo((450, 600)); p.lineTo((450, 0)); p.closePath()
    gl[g] = p.glyph()
fb.setupGlyf(gl)
fb.setupHorizontalMetrics({g: (0 if g == 'm' else 600, 50) for g in names})
fb.setupHorizontalHeader(ascent=800, descent=-200)
fb.setupNameTable({'familyName': 'gposValues', 'styleName': 'Regular'})
fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
fb.setupPost()
fb.setupFvar([('wght', 400, 400, 900, 'Weight')], [])

# VariationIndex slots in GDEF's store: item i has the delta below at wght = 900
DELTAS = [7, -6, 3, 10, 20, -30]
IDX = {'B_xPla': 0, 'VA_xPla1': 1, 'VA_yPla2': 2, 'To_xAdv1': 3, 'mark_x': 4, 'mark_y': 5}
vdev = lambda k: vb.buildVarDevTable((0 << 16) | IDX[k])

FIELDS = (('XPlacement', 0x1), ('YPlacement', 0x2), ('XAdvance', 0x4), ('YAdvance', 0x8))
DEV = (('XPlaDevice', 0x10), ('YPlaDevice', 0x20), ('XAdvDevice', 0x40), ('YAdvDevice', 0x80))
def vr(fields, devs=None):
    """ValueRecord and its ValueFormat bits (fields: dict of the four ints; devs: dict of Device tables)."""
    v = ob.buildValue(fields)
    bits = 0
    for k, b in FIELDS:
        if k in fields: bits |= b
    for k, b in DEV:
        if devs and k in devs:
            setattr(v, k, devs[k]); bits |= b
    return v, bits
def merge_fmt(*bs):
    r = 0
    for b in bs: r |= b
    return r
def lookup(ltype, subs):
    lk = ot.Lookup(); lk.LookupType = ltype; lk.LookupFlag = 0; lk.SubTable = subs; lk.SubTableCount = len(subs)
    return lk
def cov(gs):
    c = ot.Coverage(); c.glyphs = gs; return c

# L0 SinglePos fmt1
sp0 = ot.SinglePos(); sp0.Format = 1; sp0.Coverage = cov(['A'])
sp0.Value, sp0.ValueFormat = vr({'XPlacement': 30, 'YPlacement': -20, 'YAdvance': 15})
# L1 SinglePos fmt2 (B then C, coverage order)
vB, fB = vr({'XPlacement': 10}, {'XPlaDevice': vdev('B_xPla')})
ppemY = ob.buildDevice({12: -1, 13: 0, 14: 2, 15: 1, 16: 0})
vC, fC = vr({'YPlacement': 5, 'YAdvance': 8}, {'YPlaDevice': ppemY})
fmt = merge_fmt(fB, fC)
def pad(v, bits, want):   # records of one SinglePos fmt2 share one ValueFormat: fill the missing fields with 0 / null
    r = ot.ValueRecord()
    for k, b in FIELDS:
        if want & b: setattr(r, k, getattr(v, k, 0) if (bits & b) else 0)
    for k, b in DEV:
        if want & b: setattr(r, k, getattr(v, k, None) if (bits & b) else None)
    return r
sp1 = ot.SinglePos(); sp1.Format = 2; sp1.Coverage = cov(['B', 'C']); sp1.ValueFormat = fmt
sp1.Value = [pad(vB, fB, fmt), pad(vC, fC, fmt)]; sp1.ValueCount = 2
# L2 PairPos fmt1: V A
v1, f1 = vr({'XPlacement': 12, 'YPlacement': 8, 'XAdvance': -40, 'YAdvance': 6}, {'XPlaDevice': vdev('VA_xPla1')})
v2, f2 = vr({'XPlacement': -9, 'YPlacement': 4, 'XAdvance': 11, 'YAdvance': -3}, {'YPlaDevice': vdev('VA_yPla2')})
pp1 = ot.PairPos(); pp1.Format = 1; pp1.Coverage = cov(['V']); pp1.ValueFormat1 = f1; pp1.ValueFormat2 = f2
ps = ot.PairSet(); pvr = ot.PairValueRecord(); pvr.SecondGlyph = 'A'; pvr.Value1 = pad(v1, f1, f1); pvr.Value2 = pad(v2, f2, f2)
ps.PairValueRecord = [pvr]; ps.PairValueCount = 1; pp1.PairSet = [ps]; pp1.PairSetCount = 1
# L3 PairPos fmt2: T -> o
ppemX = ob.buildDevice({10: 2, 11: -1, 12: 3, 13: 0})
w1, g1 = vr({'XPlacement': 20, 'XAdvance': -25}, {'XPlaDevice': ppemX, 'XAdvDevice': vdev('To_xAdv1')})
w2, g2 = vr({'YPlacement': -12})
pp2 = ot.PairPos(); pp2.Format = 2; pp2.Coverage = cov(['T']); pp2.ValueFormat1 = g1; pp2.ValueFormat2 = g2
cd1 = ot.ClassDef(); cd1.classDefs = {'T': 1}; pp2.ClassDef1 = cd1
cd2 = ot.ClassDef(); cd2.classDefs = {'o': 1}; pp2.ClassDef2 = cd2
pp2.Class1Count = 2; pp2.Class2Count = 2
recs = []
for c1 in range(2):
    r = ot.Class1Record(); r.Class2Record = []
    for c2 in range(2):
        c = ot.Class2Record()
        if (c1, c2) == (1, 1): c.Value1, c.Value2 = pad(w1, g1, g1), pad(w2, g2, g2)
        else: c.Value1, c.Value2 = pad(vr({})[0], 0, g1), pad(vr({})[0], 0, g2)
        r.Class2Record.append(c)
    recs.append(r)
pp2.Class1Record = recs
# mark lookup: m on A
def anchor(x, y, xd=None, yd=None):
    a = ot.Anchor(); a.XCoordinate = x; a.YCoordinate = y
    if xd is not None or yd is not None:
        a.Format = 3; a.XDeviceTable = xd; a.YDeviceTable = yd
    else: a.Format = 1
    return a
mbp = ot.MarkBasePos(); mbp.Format = 1; mbp.MarkCoverage = cov(['m']); mbp.BaseCoverage = cov(['A']); mbp.ClassCount = 1
ma = ot.MarkArray(); mr = ot.MarkRecord(); mr.Class = 0; mr.MarkAnchor = anchor(0, 0); ma.MarkRecord = [mr]; ma.MarkCount = 1
mbp.MarkArray = ma
ba = ot.BaseArray(); br = ot.BaseRecord(); br.BaseAnchor = [anchor(300, 700, vdev('mark_x'), vdev('mark_y'))]; ba.BaseRecord = [br]; ba.BaseCount = 1
mbp.BaseArray = ba

gpos = newTable('GPOS')
g = ot.GPOS(); g.Version = 0x00010000
sl = ot.ScriptList(); sr = ot.ScriptRecord(); sr.ScriptTag = 'DFLT'
sc = ot.Script(); ls = ot.LangSys(); ls.LookupOrder = None; ls.ReqFeatureIndex = 0xFFFF; ls.FeatureIndex = [0, 1]; ls.FeatureCount = 2
sc.DefaultLangSys = ls; sc.LangSysRecord = []; sc.LangSysCount = 0
sr.Script = sc; sl.ScriptRecord = [sr]; sl.ScriptCount = 1
fl = ot.FeatureList()
def feat(tag, idxs):
    fr = ot.FeatureRecord(); fr.FeatureTag = tag
    f = ot.Feature(); f.FeatureParams = None; f.LookupListIndex = idxs; f.LookupCount = len(idxs)
    fr.Feature = f; return fr
fl.FeatureRecord = [feat('kern', [0, 1, 2, 3]), feat('mark', [4])]; fl.FeatureCount = 2
ll = ot.LookupList()
ll.Lookup = [lookup(1, [sp0]), lookup(1, [sp1]), lookup(2, [pp1]), lookup(2, [pp2]), lookup(4, [mbp])]; ll.LookupCount = 5
g.ScriptList = sl; g.FeatureList = fl; g.LookupList = ll
gpos.table = g
fb.font['GPOS'] = gpos

rl = vb.buildVarRegionList([{'wght': (0, 1.0, 1.0)}], ['wght'])
vd = vb.buildVarData([0], [[d] for d in DELTAS], optimize=False)
vs = vb.buildVarStore(rl, [vd])
gdef = newTable('GDEF')
gd = ot.GDEF(); gd.Version = 0x00010003
cdef = ot.ClassDef(); cdef.classDefs = {n: (3 if n == 'm' else 1) for n in names if n != '.notdef'}
gd.GlyphClassDef = cdef; gd.AttachList = None; gd.LigCaretList = None; gd.MarkAttachClassDef = None; gd.MarkGlyphSetsDef = None
gd.VarStore = vs
gdef.table = gd
fb.font['GDEF'] = gdef
fb.save(out)
print('ok')
