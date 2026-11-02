# SPDX-FileCopyrightText: 2026 Aaron Kaluszka
# SPDX-License-Identifier: Apache-2.0
# Original FontTools fixture (the AAT tables are raw bytes written here): glyphs a, b with BOTH OpenType and AAT data, so a layout
# shows which table set shapes the font. Advances are 600 units.
#   GSUB liga: a -> a.gsub        morx noncontextual: a -> a.morx
#   GPOS kern: b b -100           kerx format 0:     b b -200
# Output: aatPrefer.ttf.
import os, struct
os.environ.setdefault('SOURCE_DATE_EPOCH', '0')
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.ttLib.tables.DefaultTable import DefaultTable

names = ['.notdef', 'a', 'b', 'a.gsub', 'a.morx']
fb = FontBuilder(1000, isTTF=True)
fb.setupGlyphOrder(names)
fb.setupCharacterMap({0x61: 'a', 0x62: 'b'})
glyphs = {}
for n in names:
    pen = TTGlyphPen(None)
    pen.moveTo((100, 0)); pen.lineTo((500, 0)); pen.lineTo((500, 700)); pen.lineTo((100, 700)); pen.closePath()
    glyphs[n] = pen.glyph()
fb.setupGlyf(glyphs)
fb.setupHorizontalMetrics({n: (600, 100) for n in names})
fb.setupHorizontalHeader(ascent=800, descent=-200)
fb.setupNameTable({'familyName': 'Mantle AAT Prefer Fixture', 'styleName': 'Regular'})
fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
fb.setupPost()
fb.setupMaxp()
addOpenTypeFeaturesFromString(fb.font, """
languagesystem DFLT dflt;
feature liga { sub a by a.gsub; } liga;
feature kern { pos b b -100; } kern;
""")

def raw(tag, data):
    t = DefaultTable(tag); t.data = bytes(data); fb.font[tag] = t

# kerx: version 2, one format 0 subtable, one pair (b=2, b=2) -> -200
pairs = struct.pack('>HHh', 2, 2, -200)
sub = struct.pack('>III', 12 + 16 + len(pairs), 0, 0) + struct.pack('>IIII', 1, 12, 0, 0) + pairs
raw('kerx', struct.pack('>HHI', 2, 0, 1) + sub)

# morx: one chain, one noncontextual subtable (type 4) with a format 6 lookup: glyph 1 -> glyph 4
lookup = struct.pack('>HHHHHH', 6, 4, 2, 8, 1, 0) + struct.pack('>HH', 1, 4) + struct.pack('>HH', 0xFFFF, 0)
sub = struct.pack('>III', 12 + len(lookup), 4, 1) + lookup
sub += b'\0' * (-len(sub) % 4)
chain = struct.pack('>IIII', 1, 16 + len(sub), 0, 1) + sub
raw('morx', struct.pack('>HHI', 2, 0, 1) + chain)

here = os.path.dirname(os.path.abspath(__file__))
fb.font.save(os.path.join(here, 'aatPrefer.ttf'))
