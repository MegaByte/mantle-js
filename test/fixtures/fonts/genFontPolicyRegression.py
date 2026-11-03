# SPDX-FileCopyrightText: 2026 Aaron Kaluszka
# SPDX-License-Identifier: Apache-2.0
"""Generate small table-priority and STAT naming test fonts, without rewriting existing fixtures."""
import argparse,base64,copy,io,json,os,pathlib
os.environ.setdefault('SOURCE_DATE_EPOCH','0')
from fontTools.ttLib import TTFont
p=argparse.ArgumentParser();p.add_argument('--source-dir',type=pathlib.Path,default=pathlib.Path(__file__).resolve().parent);p.add_argument('--output-dir',type=pathlib.Path,default=pathlib.Path(__file__).resolve().parent);a=p.parse_args();a.output_dir.mkdir(parents=True,exist_ok=True)
source=(a.source_dir/'genAatPreferFont.py').read_text();old='feature kern { pos b b -100; } kern;';assert source.count(old)==1
source=source.replace(old,'feature kern { pos b <25 30 40 0>; pos b <15 20 -100 0> b <35 45 -25 0>; } kern;')
old="fb.font.save(os.path.join(here, 'aatPrefer.ttf'))";assert source.count(old)==1;source=source.replace(old,'fb.font.save(str(DEST))')
exec(compile(source,'owned-aat-position-fixture','exec'),{'__file__':str(a.source_dir/'genAatPreferFont.py'),'DEST':a.output_dir/'aatPosition.ttf'})
f=TTFont(a.output_dir/'aatPosition.ttf');del f['morx'];f.save(a.output_dir/'aatPositionNoMorx.ttf')
font=TTFont(io.BytesIO(base64.b64decode(json.loads((a.source_dir/'statSelection.json').read_bytes())['fontA'])))
mac=copy.deepcopy(font);english={r.nameID:r.toUnicode()for r in mac['name'].names if(r.platformID,r.platEncID,r.langID)==(3,1,0x409)};mac['name'].names=[]
for key,value in english.items():mac['name'].setName(value,key,1,0,0)
mac.save(a.output_dir/'statRibbiMac.ttf')
dup=copy.deepcopy(font);av=next(v for v in dup['STAT'].table.AxisValueArray.AxisValue if v.Format in[1,3]and v.Value==700);other=copy.deepcopy(dup['name'].getName(av.ValueNameID,3,1,0x409));other.string='Condensed'.encode('utf-16-be');dup['name'].names.append(other);dup.save(a.output_dir/'statRibbiDuplicate.ttf')
zero=copy.deepcopy(font);av=next(v for v in zero['STAT'].table.AxisValueArray.AxisValue if v.Format==4);av.AxisValueRecord=[];av.AxisCount=0;zero.save(a.output_dir/'statRibbiEmptyF4.ttf')
elidable=copy.deepcopy(font);next(v for v in elidable['STAT'].table.AxisValueArray.AxisValue if v.Format==4).Flags|=2;elidable.save(a.output_dir/'statRibbiElidableF4.ttf')

# Contextual kerning and mark attachment have distinct feature-toggle behavior.
import struct
from fontTools.ttLib.tables.DefaultTable import DefaultTable
U=lambda *v:struct.pack('>'+'H'*len(v),*v);I=lambda *v:struct.pack('>'+'I'*len(v),*v);S=lambda *v:struct.pack('>'+'h'*len(v),*v)
lookup=U(6,4,2,8,1,0,1,4,2,5)
state=U(0,0,0,0,1,0,0,0,0,0,1,2)
entry=U(0,0,0xffff,1,0x8000,0xffff,0,0,0)
for fmt in [1,4]:
 extra=84 if fmt==1 else 0x80000000|84;tail=S(-150)if fmt==1 else S(300,100,0,0)
 data=I(6,20,40,64,extra)+lookup;data+=bytes(40-len(data));data+=state;data+=entry;data+=bytes(84-len(data));data+=tail;data+=bytes(-len(data)%4)
 sub=I(12+len(data),fmt,0)+data
 f=TTFont(a.output_dir/'aatPosition.ttf')
 for t in ['morx','GSUB','GPOS']:del f[t]
 raw=DefaultTable('kerx');raw.data=I(0x00020000,1)+sub;f['kerx']=raw;f.save(a.output_dir/f'aatContext{fmt}.ttf')

# Legacy Apple contextual kerning obeys the kern feature toggle.
data=U(6,10,18,30,42)+U(1,2)+bytes([4,5,0,0])+bytes([0,0,0,0,1,0,0,0,0,0,0,2])+U(18,0,24,0x8000,18,42)+S(-149)
assert len(data)==44
f=TTFont(a.output_dir/'aatPosition.ttf')
for t in ['morx','GSUB','GPOS','kerx']:del f[t]
raw=DefaultTable('kern');raw.data=I(0x10000,1,8+len(data))+U(1,0)+data;f['kern']=raw;f.save(a.output_dir/'aatLegacyContext.ttf')
