# Builds small fonts for test/font/textShapingRegressSmoke.mjs and test/font/fontBudgetSmoke.mjs with fontTools (an independent
# writer from the layout code under test). The expected glyph strings in the smokes come from hb-shape over these same files.
#   usage: python3 genShapingRegressFonts.py OUT_DIR
import os, struct, sys, copy
os.environ.setdefault('SOURCE_DATE_EPOCH', '0')
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.colorLib.builder import buildCPAL
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables import otTables as ot
from fontTools.ttLib.tables.DefaultTable import DefaultTable

out = sys.argv[1]

def box():
    p = TTGlyphPen(None)
    p.moveTo((50, 0)); p.lineTo((450, 0)); p.lineTo((450, 500)); p.lineTo((50, 500)); p.closePath()
    return p.glyph()

def build(name, glyphs, cmap, fea, save=True):
    order = ['.notdef'] + glyphs
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf({g: box() for g in order})
    fb.setupHorizontalMetrics({g: (500, 50) for g in order})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({'familyName': name, 'styleName': 'Regular'})
    fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    fb.setupPost()
    addOpenTypeFeaturesFromString(fb.font, fea)
    if save: fb.font.save(os.path.join(out, name + '.ttf'))
    return fb.font

ARAB = ['beh', 'beh.init', 'beh.medi', 'beh.fina', 'yeh', 'yeh.init', 'yeh.medi', 'yeh.fina', 'hamza', 'yehhamza', 'space']
ARAB_CMAP = {0x628: 'beh', 0x64A: 'yeh', 0x654: 'hamza', 0x626: 'yehhamza', 0x20: 'space'}

# calt keeps the font on the full default-feature stage, and it maps nothing past Latin: a fallback font takes the rest.
build('shapeDefaultStage', ['c', 'd', 'x'], {0x63: 'c', 0x64: 'd'}, 'feature calt { sub c d\' by x; } calt;')
# RTL pair kerning: x advance on the logically first glyph of (beh, yeh).
build('shapeRtlKern', ARAB, ARAB_CMAP, '''languagesystem DFLT dflt; languagesystem arab dflt;
feature kern { pos beh yeh -80; } kern;''')
# ccmp splits a dual-joining letter: the mark it leaves must not break the joining.
build('shapeArabCcmp', ARAB, ARAB_CMAP, '''languagesystem DFLT dflt; languagesystem arab dflt;
feature ccmp { sub yehhamza by yeh hamza; } ccmp;
feature init { sub beh by beh.init; sub yeh by yeh.init; } init;
feature medi { sub beh by beh.medi; sub yeh by yeh.medi; } medi;
feature fina { sub beh by beh.fina; sub yeh by yeh.fina; } fina;''')
# Positional forms that are not single substitutions: multiple (Noto Nastaliq) and alternate (Noto Sans Hanifi Rohingya).
build('shapeArabMulti', ARAB, ARAB_CMAP, '''languagesystem DFLT dflt; languagesystem arab dflt;
feature init { sub beh by beh.init space; sub yeh by yeh.init; } init;
feature medi { sub beh by beh.medi hamza; sub yeh by yeh.medi; } medi;
feature fina { sub beh from [beh.fina yeh.fina]; sub yeh by yeh.fina; } fina;''')
# A requested feature whose lookup changes the glyph count.
build('shapeDlig', ['a', 'b', 'c', 'dl'], {0x61: 'a', 0x62: 'b', 0x63: 'c'}, 'feature dlig { sub a b by dl; } dlig;')
# Sequence lookup records after a length change: the second record's index counts the sequence as the first left it.
NEST = ['a', 'b', 'c', 'd', 'x', 'y', 'Y', 'B', 'C', 'lig', 'Z']
NEST_CMAP = {0x61: 'a', 0x62: 'b', 0x63: 'c', 0x64: 'd'}
build('shapeNestMulti', NEST, NEST_CMAP, '''lookup MUL { sub a by x y; } MUL;
lookup SGL { sub y by Y; sub b by B; sub c by C; } SGL;
feature calt { sub a' lookup MUL b' lookup SGL c; } calt;''')
build('shapeNestLiga', NEST, NEST_CMAP, '''lookup LIG { sub a b by lig; } LIG;
lookup SGL { sub b by B; sub c by C; sub d by Z; sub lig by Y; } SGL;
feature calt { sub a' lookup LIG b' c' lookup SGL d' lookup SGL; } calt;''')
# Cursive chains, the lookup's RightToLeft bit on and off: offsets add up along the chain from its root.
CURS = '''feature curs { %s pos cursive a <anchor NULL> <anchor 500 100>; pos cursive b <anchor 0 0> <anchor 500 150>; pos cursive c <anchor 0 20> <anchor NULL>; } curs;'''
build('shapeCursRtl', ['a', 'b', 'c'], {0x61: 'a', 0x62: 'b', 0x63: 'c'}, CURS % 'lookupflag RightToLeft;')
build('shapeCursLtr', ['a', 'b', 'c'], {0x61: 'a', 0x62: 'b', 0x63: 'c'}, CURS % '')
# Devanagari i-matra with a half form ahead of the base.
build('shapeDevaMatra', ['ka', 'ta', 'virama', 'imatra', 'ka.half', 'ra', 'ra.reph'],
  {0x915: 'ka', 0x924: 'ta', 0x94D: 'virama', 0x93F: 'imatra', 0x930: 'ra'}, '''languagesystem DFLT dflt; languagesystem dev2 dflt;
feature rphf { sub ra virama by ra.reph; } rphf;
feature half { sub ka virama by ka.half; } half;''')
# A vowel sign with an advance of its own: a mark in GDEF, in a script whose marks keep theirs.
build('shapeKnda', ['ka', 'ksign'], {0xC95: 'ka', 0xCC3: 'ksign'}, '''table GDEF { GlyphClassDef [ka],,[ksign],; } GDEF;''')
# ccmp splits sara am.
build('shapeThaiAm', ['ko', 'am', 'nik', 'aa'], {0xE01: 'ko', 0xE33: 'am', 0xE4D: 'nik', 0xE32: 'aa'}, '''languagesystem DFLT dflt; languagesystem thai dflt;
feature ccmp { sub am by nik aa; } ccmp;''')
# Shadda with a vowel: typed in canonical order (fatha first), a font's lookups read shadda first.
build('shapeShadda', ['beh', 'fatha', 'shadda', 'shaddafatha'], {0x628: 'beh', 0x64E: 'fatha', 0x651: 'shadda'}, '''languagesystem DFLT dflt; languagesystem arab dflt;
feature rlig { sub shadda fatha by shaddafatha; } rlig;''')
# A reverse chain covering a glyph its IgnoreMarks flag skips.
build('shapeRsubMark', ['a', 'b', 'm', 'm.alt', 'a.alt'], {0x61: 'a', 0x62: 'b', 0x6D: 'm'}, '''table GDEF { GlyphClassDef [a b a.alt],,[m m.alt],; } GDEF;
feature rclt { lookupflag IgnoreMarks; rsub [a m]' b by [a.alt m.alt]; } rclt;''')

def context_lookup(records):
    st = ot.ContextSubst(); st.Format = 3
    c = ot.Coverage(); c.glyphs = ['a']; st.Coverage = [c]; st.GlyphCount = 1
    recs = []
    for index in records:
        r = ot.SubstLookupRecord(); r.SequenceIndex = 0; r.LookupListIndex = index; recs.append(r)
    st.SubstLookupRecord = recs; st.SubstCount = len(recs)
    lk = ot.Lookup(); lk.LookupType = 5; lk.LookupFlag = 0; lk.SubTable = [st]; lk.SubTableCount = 1
    return lk

# 64 records that each run the lookup again: 64^4 nested calls per glyph, in a 1 KB font.
f = build('shapeBombRecurse', ['a', 'b', 'x'], {0x61: 'a', 0x62: 'b'}, 'feature calt { sub a by x; } calt;', save=False)
g = f['GSUB'].table
g.LookupList.Lookup = [context_lookup([0] * 64)]; g.LookupList.LookupCount = 1
f.save(os.path.join(out, 'shapeBombRecurse.ttf'))
# 2000 records that each multiply the glyph by 400.
f = build('shapeBombGrow', ['a', 'b', 'x'], {0x61: 'a', 0x62: 'b'}, 'feature calt { sub a by x; } calt;', save=False)
g = f['GSUB'].table
m = ot.MultipleSubst(); m.mapping = {'a': ['a'] * 400}
grow = ot.Lookup(); grow.LookupType = 2; grow.LookupFlag = 0; grow.SubTable = [m]; grow.SubTableCount = 1
g.LookupList.Lookup = [context_lookup([1] * 2000), grow]; g.LookupList.LookupCount = 2
f.save(os.path.join(out, 'shapeBombGrow.ttf'))

# COLRv1: 40 PaintComposite levels whose source and backdrop are the same next paint, 2^40 edges in 320 bytes. Written by hand:
# fontTools' builder walks the tree it is given.
f = build('colrPaintBomb', ['a', 'b'], {0x61: 'a', 0x62: 'b'}, 'feature liga { sub a b by a; } liga;', save=False)
f['CPAL'] = buildCPAL([[(1, 0, 0, 1)]])
header = struct.pack('>HHIIHIIIII', 1, 0, 0, 0, 0, 34, 0, 0, 0, 0)
base_list = struct.pack('>I', 1) + struct.pack('>HI', f.getGlyphID('a'), 10)
paints = b''.join(bytes([32]) + (8).to_bytes(3, 'big') + bytes([3]) + (8).to_bytes(3, 'big') for _ in range(40))
paints += bytes([2]) + struct.pack('>HH', 0, 0x4000)
colr = DefaultTable('COLR'); colr.data = header + base_list + paints
f['COLR'] = colr
f.save(os.path.join(out, 'colrPaintBomb.ttf'))

# JSTF: the same priority number means different things under two scripts. 'latn' priority 0 extends by disabling the ligature;
# 'cyrl' priority 0 extends by other GSUB and GPOS changes and leaves the ligature alone. U+0436 draws x.
f = TTFont(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'jstfPriorities.ttf'))
for t in f['cmap'].tables: t.cmap[0x436] = 'x'
jstf = f['JSTF'].table
latn = next(r for r in jstf.JstfScriptRecord if r.JstfScriptTag == 'latn')
cyrl = copy.deepcopy(latn); cyrl.JstfScriptTag = 'cyrl'
cyrl.JstfScript.DefJstfLangSys.JstfPriority = cyrl.JstfScript.DefJstfLangSys.JstfPriority[1:2]
cyrl.JstfScript.DefJstfLangSys.JstfPriorityCount = 1
jstf.JstfScriptRecord = [cyrl, latn]; jstf.JstfScriptCount = 2
f.save(os.path.join(out, 'jstfTwoScripts.ttf'))

# Kerning a glyph pair the font states through a mark: IgnoreMarks steps over it. Glyph order: 1 a, 2 b, 3 m.
build('shapeKernMark', ['a', 'b', 'm'], {0x61: 'a', 0x62: 'b', 0x301: 'm'}, '''table GDEF { GlyphClassDef [a b],,[m],; } GDEF;
markClass m <anchor 0 0> @TOP;
feature mark { position base [a b] <anchor 250 500> mark @TOP; } mark;
feature kern { lookupflag IgnoreMarks; position a b -100; } kern;''')
# 'dist' pair adjustment, under Kannada's script. Glyph order: 1 ka, 2 pa.
build('shapeDist', ['ka', 'pa'], {0xC95: 'ka', 0xCAA: 'pa'}, '''languagesystem DFLT dflt; languagesystem knd2 dflt;
feature dist { position ka pa -77; } dist;''')
# Right to left: a mark stacked on a mark, over a base that carries a pair placement. Glyph order: 1 beh, 2 yeh, 3 fatha, 4 shadda.
build('shapeRtlStack', ['beh', 'yeh', 'fatha', 'shadda'], {0x628: 'beh', 0x64A: 'yeh', 0x64E: 'fatha', 0x651: 'shadda'}, '''languagesystem DFLT dflt; languagesystem arab dflt;
table GDEF { GlyphClassDef [beh yeh],,[fatha shadda],; } GDEF;
markClass [fatha shadda] <anchor 100 0> @A;
markClass [fatha shadda] <anchor 100 0> @B;
feature mark { position base [beh yeh] <anchor 250 500> mark @A; } mark;
feature mkmk { position mark [fatha shadda] <anchor 100 300> mark @B; } mkmk;
feature kern { lookupflag IgnoreMarks; position beh <-30 0 -30 0> yeh <0 0 0 0>; } kern;''')
# A font whose 'medi' lookup covers a mark as well as letters. Glyph order: 1 beh, 2 beh.init, 3 beh.medi, 4 beh.fina, 5 fatha, 6 fatha.medi.
build('shapeArabMarkForm', ['beh', 'beh.init', 'beh.medi', 'beh.fina', 'fatha', 'fatha.medi'], {0x628: 'beh', 0x64E: 'fatha'}, '''languagesystem DFLT dflt; languagesystem arab dflt;
table GDEF { GlyphClassDef [beh beh.init beh.medi beh.fina],,[fatha fatha.medi],; } GDEF;
feature init { sub beh by beh.init; } init;
feature medi { sub beh by beh.medi; sub fatha by fatha.medi; } medi;
feature fina { sub beh by beh.fina; } fina;''')
# SCALED_COMPONENT_OFFSET: a half-scale component offset by (200, 100), once with the flag and once without. Glyph order: 1 box, 2 scaled, 3 unscaled.
f = build('glyfScaledOffset', ['box', 'scaled', 'unscaled'], {0x61: 'scaled', 0x62: 'unscaled'}, 'feature kern { position box box 0; } kern;', save=False)
from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphComponent
def component(flags):
    c = GlyphComponent(); c.glyphName = 'box'; c.x = 200; c.y = 100; c.flags = flags; c.transform = [[0.5, 0], [0, 0.5]]
    g = Glyph(); g.numberOfContours = -1; g.components = [c]; return g
f['glyf']['scaled'] = component(0x0800); f['glyf']['unscaled'] = component(0x1000)
f.save(os.path.join(out, 'glyfScaledOffset.ttf'))
