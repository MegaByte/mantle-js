# Builds gposVarKern.ttf with fontTools (independent writer): GPOS kern pairs whose x advance carries a
# VariationIndex device table into GDEF 1.3's ItemVariationStore. Glyphs A V T o; fvar wght 400..900.
#   pair A V   (PairPos fmt 1)  xAdvance -50, delta -30 at wght 900
#   pair T o   (PairPos fmt 2)  xAdvance -20, delta +40 at wght 900
#   single o   (SinglePos fmt 1) xAdvance +10, delta +5 at wght 900
# usage: python3 genGposVarFont.py out.ttf   (set HB=1 to print HarfBuzz's widths for the same strings)
import sys, os
os.environ.setdefault('SOURCE_DATE_EPOCH', '0')   # fixed head timestamps: regenerating gives the same bytes
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables import otTables as ot
from fontTools.otlLib import builder as ob
from fontTools.varLib import builder as vb

out = sys.argv[1]
names = ['.notdef', 'A', 'V', 'T', 'o']
fb = FontBuilder(1000, isTTF=True)
fb.setupGlyphOrder(names)
fb.setupCharacterMap({0x41: 'A', 0x56: 'V', 0x54: 'T', 0x6F: 'o'})
gl = {}
for g in names:
    p = TTGlyphPen(None)
    p.moveTo((50, 0)); p.lineTo((50, 600)); p.lineTo((450, 600)); p.lineTo((450, 0)); p.closePath()
    gl[g] = p.glyph()
fb.setupGlyf(gl)
fb.setupHorizontalMetrics({g: (600, 50) for g in names})
fb.setupHorizontalHeader(ascent=800, descent=-200)
fb.setupNameTable({'familyName': 'gposVarKern', 'styleName': 'Regular'})
fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
fb.setupPost()
fb.setupFvar([('wght', 400, 400, 900, 'Weight')], [])

def vdev(inner):
    return vb.buildVarDevTable((0 << 16) | inner)
def val(adv, inner):
    v = ob.buildValue({'XAdvance': adv})
    v.XAdvDevice = vdev(inner)
    return v

def subtable_pair1():
    st = ot.PairPos(); st.Format = 1
    cov = ot.Coverage(); cov.glyphs = ['A']; st.Coverage = cov
    st.ValueFormat1 = 0x4 | 0x40; st.ValueFormat2 = 0
    ps = ot.PairSet(); pvr = ot.PairValueRecord(); pvr.SecondGlyph = 'V'; pvr.Value1 = val(-50, 0); pvr.Value2 = None
    ps.PairValueRecord = [pvr]; ps.PairValueCount = 1
    st.PairSet = [ps]; st.PairSetCount = 1
    return st

def subtable_pair2():
    st = ot.PairPos(); st.Format = 2
    cov = ot.Coverage(); cov.glyphs = ['T']; st.Coverage = cov
    st.ValueFormat1 = 0x4 | 0x40; st.ValueFormat2 = 0
    cd1 = ot.ClassDef(); cd1.classDefs = {'T': 1}; st.ClassDef1 = cd1
    cd2 = ot.ClassDef(); cd2.classDefs = {'o': 1}; st.ClassDef2 = cd2
    st.Class1Count = 2; st.Class2Count = 2
    recs = []
    for c1 in range(2):
        r = ot.Class1Record(); r.Class2Record = []
        for c2 in range(2):
            c = ot.Class2Record()
            c.Value1 = val(-20, 1) if (c1, c2) == (1, 1) else val(0, 3)   # (T,o) kerns; other cells carry a harmless zero with a delta slot
            c.Value2 = None
            r.Class2Record.append(c)
        recs.append(r)
    st.Class1Record = recs
    return st

def subtable_single():
    st = ot.SinglePos(); st.Format = 1
    cov = ot.Coverage(); cov.glyphs = ['o']; st.Coverage = cov
    st.ValueFormat = 0x4 | 0x40; st.Value = val(10, 2)
    return st

def lookup(ltype, subs):
    lk = ot.Lookup(); lk.LookupType = ltype; lk.LookupFlag = 0; lk.SubTable = subs; lk.SubTableCount = len(subs)
    return lk

gpos = newTable('GPOS')
g = ot.GPOS(); g.Version = 0x00010000
sl = ot.ScriptList(); sr = ot.ScriptRecord(); sr.ScriptTag = 'DFLT'
sc = ot.Script(); ls = ot.LangSys(); ls.LookupOrder = None; ls.ReqFeatureIndex = 0xFFFF; ls.FeatureIndex = [0]; ls.FeatureCount = 1
sc.DefaultLangSys = ls; sc.LangSysRecord = []; sc.LangSysCount = 0
sr.Script = sc; sl.ScriptRecord = [sr]; sl.ScriptCount = 1
fl = ot.FeatureList(); fr = ot.FeatureRecord(); fr.FeatureTag = 'kern'
f = ot.Feature(); f.FeatureParams = None; f.LookupListIndex = [0, 1]; f.LookupCount = 2
fr.Feature = f; fl.FeatureRecord = [fr]; fl.FeatureCount = 1
ll = ot.LookupList(); ll.Lookup = [lookup(2, [subtable_pair1(), subtable_pair2()]), lookup(1, [subtable_single()])]; ll.LookupCount = 2
g.ScriptList = sl; g.FeatureList = fl; g.LookupList = ll
gpos.table = g
fb.font['GPOS'] = gpos

# ItemVariationStore: one region wght peak 1.0; items 0..3 = deltas at wght=900 (item 3 stays 0)
rl = vb.buildVarRegionList([{'wght': (0, 1.0, 1.0)}], ['wght'])
vd = vb.buildVarData([0], [[-30], [40], [5], [0]], optimize=False)
vs = vb.buildVarStore(rl, [vd])
gdef = newTable('GDEF')
gd = ot.GDEF(); gd.Version = 0x00010003
gd.GlyphClassDef = None; gd.AttachList = None; gd.LigCaretList = None; gd.MarkAttachClassDef = None; gd.MarkGlyphSetsDef = None
gd.VarStore = vs
gdef.table = gd
fb.font['GDEF'] = gdef
fb.save(out)

if os.environ.get('HB'):
    import uharfbuzz as hb
    blob = hb.Blob.from_file_path(out); face = hb.Face(blob); font = hb.Font(face)
    for wght in (400, 650, 900):
        font.set_variations({'wght': wght})
        row = []
        for s in ('AV', 'To', 'o', 'AVTo'):
            buf = hb.Buffer(); buf.add_str(s); buf.guess_segment_properties(); hb.shape(font, buf, {'kern': True})
            row.append((s, sum(p.x_advance for p in buf.glyph_positions)))
        print(wght, row)
print('ok')
