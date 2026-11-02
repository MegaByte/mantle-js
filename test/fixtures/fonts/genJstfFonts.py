# Builds jstfPriorities.ttf and jstfCursive.ttf with fontTools (an independent writer from the layout code under test).
#   usage: python3 genJstfFonts.py OUT_DIR
# jstfPriorities.ttf (upem 1000, every letter 500 wide unless listed):
#   glyphs  space 300, a b d 500, f 400, i 300, fi 500 (the ligature), x 600, x.narrow 500, a.wide 700, e 500, ext 250
#   GSUB    0 Ligature f i -> fi        (feature liga, default on: shortens "fi" by 200)
#           1 Single x -> x.narrow      (in no feature)
#           2 Single a -> a.wide        (in no feature)
#   GPOS    0 PairPos a b -100          (feature kern, default on)
#           1 SinglePos a b x -50 advance (in no feature)
#   JSTF 'latn', default language system, three priorities:
#     0  extension: disable GSUB 0 (undo the ligature, +200 per "fi")      shrinkage: enable GSUB 1 (x -100)
#     1  extension: disable GPOS 0 (+100 per "ab"), enable GSUB 2 (a +200)  shrinkage: enable GPOS 1 (-50 per a b x)
#     2  extension: JstfMax SinglePos space +400                           shrinkage: JstfMax SinglePos space -200
#   language system 'TRK ': one priority, extension JstfMax space +100 only.
# jstfCursive.ttf: Arabic letters beh (D, 600), lam (D, 500), alef (R, 400), space 300, tatweel U+0640 (300) as the 'arab'
#   ExtenderGlyph, no other JSTF data; vertical advances (vmtx) 1000 for every glyph except tatweel 400.
import sys, os
os.environ.setdefault('SOURCE_DATE_EPOCH', '0')
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables import otTables as ot
from fontTools.otlLib import builder as ob
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString

out = sys.argv[1]

def box(w):
    p = TTGlyphPen(None)
    p.moveTo((50, 0)); p.lineTo((50, 600)); p.lineTo((max(w - 50, 100), 600)); p.lineTo((max(w - 50, 100), 0)); p.closePath()
    return p.glyph()

def base_font(names, cmap, widths, family):
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf({g: box(widths.get(g, 500)) for g in names})
    fb.setupHorizontalMetrics({g: (widths.get(g, 500), 50) for g in names})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular'})
    fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    fb.setupPost()
    return fb

def lookup_of(ltype, subs):
    lk = ot.Lookup(); lk.LookupType = ltype; lk.LookupFlag = 0; lk.SubTable = subs; lk.SubTableCount = len(subs)
    return lk

def single_pos_adv(font, glyphs, adv):
    st = ob.buildSinglePosSubtable({g: ob.buildValue({'XAdvance': adv}) for g in glyphs}, font.getReverseGlyphMap())
    return lookup_of(1, [st])

def mod_list(cls, attr, indices):
    if not indices: return None
    m = cls(); m.LookupCount = len(indices); setattr(m, attr, list(indices)); return m

def jstf_max(lookups):
    if not lookups: return None
    m = ot.JstfMax(); m.LookupCount = len(lookups); m.Lookup = lookups; return m

def priority(font, gsub_shrink_en=(), gsub_shrink_dis=(), gpos_shrink_en=(), gpos_shrink_dis=(), shrink_max=None,
             gsub_ext_en=(), gsub_ext_dis=(), gpos_ext_en=(), gpos_ext_dis=(), ext_max=None):
    p = ot.JstfPriority()
    p.ShrinkageEnableGSUB = mod_list(ot.JstfGSUBModList, 'GSUBLookupIndex', gsub_shrink_en)
    p.ShrinkageDisableGSUB = mod_list(ot.JstfGSUBModList, 'GSUBLookupIndex', gsub_shrink_dis)
    p.ShrinkageEnableGPOS = mod_list(ot.JstfGPOSModList, 'GPOSLookupIndex', gpos_shrink_en)
    p.ShrinkageDisableGPOS = mod_list(ot.JstfGPOSModList, 'GPOSLookupIndex', gpos_shrink_dis)
    p.ShrinkageJstfMax = jstf_max(shrink_max)
    p.ExtensionEnableGSUB = mod_list(ot.JstfGSUBModList, 'GSUBLookupIndex', gsub_ext_en)
    p.ExtensionDisableGSUB = mod_list(ot.JstfGSUBModList, 'GSUBLookupIndex', gsub_ext_dis)
    p.ExtensionEnableGPOS = mod_list(ot.JstfGPOSModList, 'GPOSLookupIndex', gpos_ext_en)
    p.ExtensionDisableGPOS = mod_list(ot.JstfGPOSModList, 'GPOSLookupIndex', gpos_ext_dis)
    p.ExtensionJstfMax = jstf_max(ext_max)
    return p

def lang_sys(priorities):
    ls = ot.JstfLangSys(); ls.JstfPriorityCount = len(priorities); ls.JstfPriority = priorities
    return ls

def script_record(tag, extenders, default_ls, langs):
    sr = ot.JstfScriptRecord(); sr.JstfScriptTag = tag
    s = ot.JstfScript()
    if extenders:
        e = ot.ExtenderGlyph(); e.GlyphCount = len(extenders); e.ExtenderGlyph = extenders; s.ExtenderGlyph = e
    else: s.ExtenderGlyph = None
    s.DefJstfLangSys = default_ls
    recs = []
    for ltag, ls in langs:
        r = ot.JstfLangSysRecord(); r.JstfLangSysTag = ltag; r.JstfLangSys = ls; recs.append(r)
    s.JstfLangSysCount = len(recs); s.JstfLangSysRecord = recs
    sr.JstfScript = s
    return sr

def jstf_table(records):
    t = newTable('JSTF'); j = ot.JSTF(); j.Version = 0x00010000
    j.JstfScriptCount = len(records); j.JstfScriptRecord = records
    t.table = j
    return t

# ---- jstfPriorities.ttf
names = ['.notdef', 'space', 'a', 'b', 'd', 'e', 'f', 'i', 'fi', 'x', 'x.narrow', 'a.wide', 'ext']
cmap = {0x20: 'space', 0x61: 'a', 0x62: 'b', 0x64: 'd', 0x65: 'e', 0x66: 'f', 0x69: 'i', 0x78: 'x'}
widths = {'space': 300, 'f': 400, 'i': 300, 'fi': 500, 'x': 600, 'x.narrow': 500, 'a.wide': 700, 'ext': 250}
fb = base_font(names, cmap, widths, 'jstfPriorities')
addOpenTypeFeaturesFromString(fb.font, '''
languagesystem DFLT dflt;
languagesystem latn dflt;
lookup LK_liga { sub f i by fi; } LK_liga;
lookup LK_narrow { sub x by x.narrow; } LK_narrow;
lookup LK_wide { sub a by a.wide; } LK_wide;
lookup LK_kern { pos a b -100; } LK_kern;
lookup LK_tight { pos [a b x] <0 0 -50 0>; } LK_tight;
feature liga { lookup LK_liga; } liga;
feature kern { lookup LK_kern; } kern;
''')
f = fb.font
space_plus = lambda v: lookup_of(1, [ob.buildSinglePosSubtable({'space': ob.buildValue({'XAdvance': v})}, f.getReverseGlyphMap())])
p0 = priority(f, gsub_shrink_en=[1], gsub_ext_dis=[0])
p1 = priority(f, gpos_shrink_en=[1], gpos_ext_dis=[0], gsub_ext_en=[2])
p2 = priority(f, shrink_max=[space_plus(-200)], ext_max=[space_plus(400)])
trk = priority(f, ext_max=[space_plus(100)])
f['JSTF'] = jstf_table([script_record('latn', ['ext'], lang_sys([p0, p1, p2]), [('TRK ', lang_sys([trk]))])])
f.save(os.path.join(out, 'jstfPriorities.ttf'))

# ---- jstfCursive.ttf
names = ['.notdef', 'space', 'beh', 'lam', 'alef', 'tatweel']
cmap = {0x20: 'space', 0x628: 'beh', 0x644: 'lam', 0x627: 'alef', 0x640: 'tatweel'}
widths = {'space': 300, 'beh': 600, 'lam': 500, 'alef': 400, 'tatweel': 300}
fb = base_font(names, cmap, widths, 'jstfCursive')
f = fb.font
f['vhea'] = newTable('vhea'); vh = f['vhea']
vh.tableVersion = 0x00011000; vh.ascent = 500; vh.descent = -500; vh.lineGap = 0; vh.advanceHeightMax = 1000
vh.minTopSideBearing = 0; vh.minBottomSideBearing = 0; vh.yMaxExtent = 600; vh.caretSlopeRise = 0; vh.caretSlopeRun = 1
vh.caretOffset = 0; vh.reserved0 = vh.reserved1 = vh.reserved2 = vh.reserved3 = vh.reserved4 = 0; vh.metricDataFormat = 0; vh.numberOfVMetrics = len(names)
f['vmtx'] = newTable('vmtx'); f['vmtx'].metrics = {g: (400 if g == 'tatweel' else 1000, 0) for g in names}
f['JSTF'] = jstf_table([script_record('arab', ['tatweel'], None, [])])
f.save(os.path.join(out, 'jstfCursive.ttf'))
print('wrote jstfPriorities.ttf jstfCursive.ttf')
