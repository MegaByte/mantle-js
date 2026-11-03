from pathlib import Path
import json,hashlib,tarfile,struct,tempfile,sys
from types import SimpleNamespace
D=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parent;m=json.loads((D/'release-big-circle-bounds-2026-10-02.json').read_text());p=D/m['archive']['file'];h=lambda b:hashlib.sha256(b).hexdigest();assert p.stat().st_size==m['archive']['bytes'] and h(p.read_bytes())==m['archive']['sha256']
cache=Path(tempfile.mkdtemp(prefix='mantle-circle-archive-verified-'));entries={}
with tarfile.open(p,'r|gz') as arc:
 for member in arc:
  assert member.isfile() and not member.issym() and member.name not in entries
  assert member.name in m['files'] or member.name=='members.json'
  rel=Path(member.name);assert not rel.is_absolute() and '..' not in rel.parts
  data=arc.extractfile(member).read();assert len(data)==member.size
  dest=cache/rel;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data);entries[member.name]=member.size
class VerifiedCache:
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def getnames(self):return list(entries)
 def getmember(self,name):return SimpleNamespace(size=entries[name],name=name)
 def extractfile(self,name):return (cache/(name if isinstance(name,str) else name.name)).open('rb')
with VerifiedCache() as t:
 names=t.getnames();assert len(names)==len(set(names))==len(m['files'])+1 and set(names)==set(m['files'])|{'members.json'}
 for name,r in m['files'].items():
  x=t.getmember(name);data=t.extractfile(x).read();assert x.size==r['bytes']==len(data) and h(data)==r['sha256'],name
 meta=json.load(t.extractfile('members.json'));assert meta['files']==m['files'] and meta['sourceMaps']==m['sourceMaps']
 for label,sm in m['sourceMaps'].items():
  assert len(sm)==420
  for rel,sha in sm.items():assert h(t.extractfile('runtime/'+label+'/'+rel).read())==sha
 for rel,sha in m['sourceMaps']['final-clean'].items():assert h(t.extractfile('clean-package/'+rel).read())==sha
 for run in m['runs']:
  d=json.load(t.extractfile('artifacts/'+run['file']));assert h(t.extractfile(run['harnessMember']).read())==d['harnessHash']
  for v,labs in run['sourceRoots'].items():assert all(all(m['sourceMaps'][lab].get(k)==sha for k,sha in d['sourceHashes'][v].items()) for lab in labs)
  for ref in d['rows']:
   if 'version'in ref:
    assert 'Apple M2 Pro' in ref['device'] and 'Metal' in ref['device']
    for q in ref['helper']['queries']:assert isinstance(q['gpu'],(int,float))
    for r in ref['renders']:assert len(r['pixels'])==128*128*4 and all(0<=v<=255 for v in r['pixels']) and any(r['pixels'])
   else:
    row=t.extractfile('artifacts/'+run['file']+'.rows/'+ref['file']).read();assert h(row)==ref['sha256'];r=json.loads(row);assert r['workerEventsDuringTiming']==0
    for a in r['arms']:assert any(a['imagePixels']) and a['raw'] and all(v['gpuMs']>0 for v in a['raw'])
 # Independent reclassification of final thin-band GPU witness and reference.
 gpu=json.load(t.extractfile('artifacts/big-circle-final-thin-gpu.json'));area=json.load(t.extractfile('artifacts/big-circle-final-thin-area.json'));base,cand=[next(x for x in gpu['rows']if x['version']==v)for v in ['baseline','candidate']];early=[];declined=legacy=0
 for q,a in zip(cand['helper']['queries'],base['helper']['queries']):
  import math
  reach=.5*max(math.hypot(q['N'][0]+q['N'][2],q['N'][1]+q['N'][3]),math.hypot(q['N'][0]-q['N'][2],q['N'][1]-q['N'][3]));radius=q['R']+(q['hw']if q['kind']=='band' else 0)
  if radius>4096*reach:
   legacy+=int(q['scale']==1);assert struct.pack('<f',q['gpu'])==struct.pack('<f',a['gpu'])
  elif q['guardOuter']==0 and q['guardInner']==0:
   declined+=int(q['scale']==1);assert struct.pack('<f',q['gpu'])==struct.pack('<f',a['gpu'])
  elif q['scale']==1:early.append(q)
 assert (len(early),declined,legacy)==(540,324,96),(len(early),declined,legacy)
 assert area['regressions']==0
 q=json.load(t.extractfile('artifacts/big-circle-final-gpu.json'));assert q['passed'] and q['areaSummary']['renderMax']['candidate']==1 and q['areaSummary']['legacyMaxDifference']==0
 staged=json.load(t.extractfile('artifacts/big-circle-staged-match.json'));assert staged['all420SourcesMatch']==m['sourceMaps']['reviewed']
 for n in ['big-circle-growth-early-gpu.json','big-circle-growth-late-gpu.json']:
  growth=json.load(t.extractfile('artifacts/'+n));assert growth['passed'] and growth['sourceHashes']['candidate']==m['sourceMaps']['reviewed'] and growth['areaSummary']['renderMax']['candidate']==1
 point=json.load(t.extractfile('artifacts/big-circle-final-point-warm-report.json'));assert point['sourceHashes']==m['sourceMaps']['final-clean']
 print(json.dumps({'archiveSha256':m['archive']['sha256'],'membersVerified':len(names),'runtimeFilesPerSnapshot':420,'runsVerified':len(m['runs']),'finalThinCases':{'early':len(early),'declined':declined,'legacy':legacy},'finalActualSceneMaxRGBAByte':q['areaSummary']['renderMax']['candidate'],'pointModes':sum(len(r['rows'])for r in point['rows'])}))
