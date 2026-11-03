"""Verify durable archive bytes and independently recompare complete captured GPU images."""
from pathlib import Path
import sys,json,hashlib,tarfile,math
manifest_path=Path(sys.argv[1]);m=json.loads(manifest_path.read_text());archive=manifest_path.parent/m['archive']['file']
h=lambda bs:hashlib.sha256(bs).hexdigest();assert h(archive.read_bytes())==m['archive']['sha256'] and archive.stat().st_size==m['archive']['bytes']
cache={};seen=set()
with tarfile.open(archive,'r|gz') as t:
 for member in t:
  assert member.isfile() and member.name not in seen;seen.add(member.name);bs=t.extractfile(member).read()
  if member.name=='members.json':
   internal=json.loads(bs);assert all(internal[k]==v for k,v in m.items() if k!='archive');continue
  expected=m['files'][member.name];assert len(bs)==expected['bytes'] and h(bs)==expected['sha256']
  if member.name.startswith('artifacts/') and (member.name.endswith('.json') or member.name.endswith('.rgba')):cache[member.name]=bs
assert seen==set(m['files'])|{'members.json'} and len(seen)==m['archive']['members']
J=lambda name:json.loads(cache['artifacts/'+name]);full=J('cff-full-image-fixed-gpu.json');ref=J('cff-full-area-refined.json');total=0;maxerror=0
for rr in full['rows']:
 bs=cache['artifacts/cff-full-image-fixed-gpu.json.rows/'+rr['file']];assert h(bs)==rr['sha256'];r=json.loads(bs);n=r['size'];truth=next(q for q in ref['rows'] if q['name']==r['name'] and q['n']==8192);img=cache['artifacts/cff-full-area-refined.json.images/'+truth['file']];assert h(img)==truth['sha256']
 coarse=next(q for q in ref['rows'] if q['name']==r['name'] and q['n']==2048);old=cache['artifacts/cff-full-area-refined.json.images/'+coarse['file']];assert max(abs(a-b) for a,b in zip(img,old))<=1
 for arm in r['arms']:
  assert any(arm['imagePixels']) and h(bytes(arm['imagePixels']))==arm['imageHash'] and 'Apple M2 Pro' in arm['device'] and 'Metal' in arm['device']
  for p in arm['pin']['programs']:
   for sha in p['sourceHashes']:assert h(full['compiledSources'][sha].encode())==sha
  if arm['name'].startswith('candidate'):
   assert arm['pin']['ledger'].get('aac')==1;assert any('vColor.a < 0.5 / 255.0' in full['compiledSources'][sha] for p in arm['pin']['programs'] for sha in p['sourceHashes'])
   worst=max(abs(img[(y*n+x)*4+k]-arm['imagePixels'][((n-1-y)*n+x)*4+k]) for y in range(n) for x in range(n) for k in range(4));assert worst<=1;maxerror=max(maxerror,worst)
 assert all(v['diff']['maxByte']==0 and v['glError']==0 for v in r['finalChecks'].values());total+=n*n
assert total==m['totalFullPixels']==163840
prod=J('aac-point-alpha-production-final-gpu.json');assert prod['passed'] and prod['sourceStable'] and prod['harnessStable']
for file,sha in prod['sourceHashes'].items():assert m['files']['runtime/production-fixed/'+file]['sha256']==sha
centers=0
for version in prod['rows']:
 for row in version['rows']:
  assert 'Apple M2 Pro' in row['device'] and 'Metal' in row['device'];assert row['first']==row['later'];a=row['opacity']*row['drawAlpha'];expected=0
  for i in range(3):expected=math.floor(255*a+expected*(1-a)+.5)
  for p in row['centers']:assert p['rgba']==[expected if version['source']=='candidate' else 0]*4;centers+=1
  points=[e for e in row['executed'] if e['key']=='drawArraysInstanced' and e['args'][0]==0];assert len(points)==2
  assert all(any('renderFillAAC' in s for s in e['sources']) for e in points)
for name in ['cff-point-discard-shared-gpu.json','cff-point-discard-shared-repeat-gpu.json']:
 d=J(name);assert d['finished'] and d['sourceStable'] and d['harnessStable'] and not d.get('error')
 for rr in d['rows']:
  bs=cache['artifacts/'+name+'.rows/'+rr['file']];assert h(bs)==rr['sha256'];r=json.loads(bs);assert r['sharedBundleAndContext'] and 'Apple M2 Pro' in r['device'] and 'Metal' in r['device'];assert r['workerEventsDuringTiming']==0 and all(v['maxByte']==0 for v in r['finals'].values());assert all(len(a['raw'])==32 for a in r['arms'])
print(json.dumps({'archiveSha256':m['archive']['sha256'],'membersVerified':len(seen),'fullPixelsCompared':total,'fullFixedMaxRGBAByte':maxerror,'productionCurveCentersCompared':centers,'sharedTimingCasesVerified':8},indent=2))
