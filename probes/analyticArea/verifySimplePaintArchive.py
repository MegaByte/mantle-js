#!/usr/bin/env python3
"""Verify the saved static polynomial CPatch study; never claim release readiness."""
import hashlib,json,sys,tarfile,math
from pathlib import Path
archive=Path(sys.argv[1]);metadata=json.load(open(archive.with_suffix('').with_suffix('.json')))
h=hashlib.sha256()
with open(archive,'rb')as f:
 while chunk:=f.read(4*1024*1024):h.update(chunk)
assert h.hexdigest()==metadata['sha256'] and archive.stat().st_size==metadata['bytes']
verified=set();cases=0;renderedPixels=0;firstReadyPixels=0;sourceChecks=0;reports=[];sourceMaps=[];accuracy={};refs=None;mapRefs=None;recordedMap=None;textRef=None;textRows=None;timing=None;prep=None;oracleOutput=None;prior=None
with tarfile.open(archive,'r|xz')as tf:
 first=next(iter(tf));assert first.name=='INDEX.json';index=json.load(tf.extractfile(first));entries=index['files'];inputHashes={v['sha256']for k,v in entries.items()if k.endswith('-input.json')}
 for member in tf:
  if member.name=='INDEX.json':continue
  assert member.isfile(),member.name
  raw=tf.extractfile(member).read();entry=entries[member.name];assert len(raw)==entry['bytes'] and hashlib.sha256(raw).hexdigest()==entry['sha256'],member.name;verified.add(member.name)
  name=member.name
  if name in index['qualifiedReports']:
   j=json.loads(raw);assert j['sourceStable']and j['harnessStable']and j['finished'];assert 'Apple M2 Pro'in j['device']['renderer']and'Metal'in j['device']['renderer'];assert j['inputHash']in inputHashes
   for label,values in [('candidate',j['sourceHashes']),('baseline',j['baseline']['sourceHashes'])]:
    for path,digest in values.items():
     if label=='baseline':
      prefix='../'+Path(j['baseline']['root']).name+'/'
      assert path.startswith(prefix),path
      path=path[len(prefix):]
     assert entries[label+'/'+path]['sha256']==digest,(name,label,path);sourceChecks+=1
   for f,digest in j['harnessHashes'].items():assert entries['candidate/probes/analyticArea/'+f]['sha256']==digest
   for r in j['rows']:
    cases+=1;assert r['glError']==0 and r['steadyCompiles']==0
    for a in r['arms']:
     assert a['pin']['ledger'].get(a['engine'],0)>0
     assert hashlib.sha256(bytes(a['rgba'])).hexdigest()==a['imageHash']==a['finalImageHash'];renderedPixels+=len(a['rgba'])//4
     if 'firstReadyRgba'in a:assert a['firstReadyRgba']==a['rgba'];firstReadyPixels+=len(a['rgba'])//4
    arms={a['name']:a for a in r['arms']}
    if name.endswith('text-perf-gpu.json'):
     assert arms['baseline']['rgba']==arms['baselineAA']['rgba']and arms['candidate']['rgba']==arms['candidateAA']['rgba'];c=next(c for c in j['config']['cases']if c['size']==r['size']);orders=c['sampleOrders'];assert len(orders)==24 and len({tuple(o)for o in orders})==24
    if name.endswith('text-v2-gpu.json'):textRows=j['rows'];textCases=j['config']['cases']
    if 'winding'in name:
     if refs is None:refs=[]
     refs.append(r)
    if r.get('morphCycle'):
     assert all(a['rgba']==arms['baseline']['rgba']for a in arms.values());assert all(a['preparation']['geometry']['quadraticAreaMeshes']==0 for a in arms.values())
    if r['name'].startswith('map-'):
     if mapRefs is None:mapRefs=[]
     mapRefs.append(r)
   reports.append(dict(file=name,cases=len(j['rows']),browser=j['browser'],renderer=j['device']['renderer']))
  elif name.endswith('/winding-independent-reference.json'):windingRef=json.loads(raw)
  elif name.endswith('/map-independent-reference.json'):mapRef=json.loads(raw)
  elif name.endswith('/map-independent-summary.json'):recordedMap=json.loads(raw)
  elif name.endswith('/text-independent-summary.json'):textRef=json.loads(raw)
  elif name.endswith('/text-oracle-output.txt'):oracleOutput=raw.decode()
  elif name.endswith('/tt-boundedreach-independent-reference.json'):prior=json.loads(raw)
  elif name.endswith('/text-qualified-timing-summary.json'):timing=json.loads(raw)
  elif name.endswith('/prep-text.json'):prep=json.loads(raw)
assert verified==set(entries) and cases==index['qualifiedCases']==56
# Recompute full polygon-reference comparisons from the archived GPU pixels.
windingCount=0
for r in refs:
 ref=next(p for p in windingRef['rows']if(p['name'],p['size'])==(r['name'],r['size']));a=next(a for a in r['arms']if a['name']=='candidate');n=r['size']
 assert a['preparation']['geometry']['quadraticAreaMeshes']==1
 for y in range(n):
  for x in range(n):
   at=((n-1-y)*n+x)*4;assert max(abs(v-w)for v,w in zip(a['rgba'][at:at+4],ref['rgbaTopDown'][y*n+x]))<=1;windingCount+=1
assert len(refs)==16
# Recompute all archived independent text comparisons and their scope.
parsed={}
for line in oracleOutput.splitlines():
 v=line.split();n,x,y=map(int,v[:3]);parsed.setdefault(n,{})[x,y]=(float(v[3]),list(map(float,v[4:8])),list(map(int,v[8:12])))
textCount=0
for r in textRows:
 n=r['size'];rs=next(t for t in textRef['rows']if t['size']==n);p=parsed[n];assert len(p)==rs['checked'];aa={a['name']:a for a in r['arms']};changed={(i%n,n-1-i//n)for i in range(n*n)if aa['baseline']['rgba'][i*4:i*4+4]!=aa['candidate']['rgba'][i*4:i*4+4]};scope={(x+dx,y+dy)for x,y in changed for dx in [-1,0,1]for dy in [-1,0,1]if 0<=x+dx<n and 0<=y+dy<n}
 if n==32:scope={(x,y)for x in range(n)for y in range(n)}
 assert set(p)==scope
 for a in aa.values():
  worst=0;over=0;total=0
  for(x,y),(_,_,want)in p.items():
   at=((n-1-y)*n+x)*4;err=max(abs(v-w)for v,w in zip(a['rgba'][at:at+4],want));worst=max(worst,err);over+=err>1;total+=err
  s=next(s for s in rs['stats']if s['arm']==a['name']);assert(worst,over,total)==(s['worst']['error'],s['overOne'],s['sumMaxErrors'])
  if a['name']=='candidate':assert worst<=1 and over==0
 textCount+=len(p)
# Recompute affine/projective negatives; no projective PASS is implied.
mapCount=0
for r in mapRefs:
 ref=next(t for t in mapRef['rows']if t['name']==r['name']);n=r['size'];stats=next(t for t in recordedMap if t['name']==r['name'])
 for a in r['arms']:
  errors=[]
  for p in ref['pixels']:
   actual=a['rgba'][((n-1-p['y'])*n+p['x'])*4+3];expect=255*p['coverage'];errors.append((abs(actual-expect),abs(actual-math.floor(expect+.5))))
  s=next(t for t in stats['stats']if t['arm']==a['name']);assert abs(max(v[0]for v in errors)-s['maxContinuousByte'])<1e-12 and max(v[1]for v in errors)==s['maxRoundedByte']
  if a['name']=='cpatch'and not ref['projective']:assert max(v[1]for v in errors)<=1
 mapCount+=len(ref['pixels'])
assert len(timing['rows'])==2 and all(r['verdict']=='faster'for r in timing['rows']);assert prep['sourceStable']and len(prep['rows'])==4
out=dict(scope=index['scope'],archiveSha256=metadata['sha256'],members=len(entries)+1,qualifiedReports=reports,qualifiedGpuCases=cases,sourceChecks=sourceChecks,completeRenderedPixels=renderedPixels,firstReadyComparedPixels=firstReadyPixels,independentTextPixels=textCount,independentPolygonPixels=windingCount,independentMapPixels=mapCount,textAccuracy=textRef['rows'],gpuTiming=timing['rows'],cpuPrepCounts=[r['count']for r in prep['rows']],remaining=['raw AAC fill-rule/affine reach','wider artwork and combined/instance/override qualification','projective/frame eligibility','continuum morph preparation','general cubic/native-conic arrangement ownership','complete release gates/scene-state warming'])
if len(sys.argv)>2:Path(sys.argv[2]).write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({k:v for k,v in out.items()if k not in['qualifiedReports','textAccuracy','gpuTiming']},indent=2))
