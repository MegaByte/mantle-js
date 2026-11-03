from pathlib import Path
import tarfile,json,hashlib,math,collections,sys
metaPath=Path(sys.argv[1]);repo=metaPath.parent;name=metaPath.stem;meta=json.load(open(metaPath));archive=repo/meta['archive']['file'];H=lambda b:hashlib.sha256(b).hexdigest()
assert H(archive.read_bytes())==meta['archive']['sha256'];checked=0
with tarfile.open(archive)as t:
 manifest=json.load(t.extractfile('MANIFEST.json'));members={m.name:m for m in t.getmembers()};assert len(members)==meta['archive']['members']==len(manifest['members'])+1
 cache={}
 for n,s in manifest['members'].items():
  data=t.extractfile(n).read();assert len(data)==s['bytes']and H(data)==s['sha256'],n;cache[n]=data
 def raw(n):return cache[n]
 def read(n):return json.loads(raw(n))
 def sources(j,view):
  for n,h in j.items():assert H(raw('source/'+view+'/'+n))==h,n
 final=read('depth/gpu-final.json');both=read('depth/gpu-qualified.json');glob=read('global/pieces-gpu-qualified.json');assert final['passed']and both['passed']and glob['passed']
 sources(final['sourceHashes']['candidate'],'fixed-final');sources(both['sourceHashes']['candidate'],'fixed-before-comment');sources(both['sourceHashes']['baseline'],'baseline');sources(glob['sourceHashes']['candidate'],'global-half-byte-final');sources(glob['sourceHashes']['baseline'],'baseline')
 assert H(raw('harness/fixed-final/test/translucentDepthClaimGpuSmoke.mjs'))==final['testHash']==both['testHash'];assert H(raw('harness/global-final/test/fillSubbytePiecesGpuSmoke.mjs'))==glob['testHash']
 changedSource=[n for n in final['sourceHashes']['candidate'] if raw('source/fixed-final/'+n)!=raw('source/baseline/'+n)];assert changedSource==['src/renderer/unifiedFillDraw.js'],changedSource
 fullImageComparisons=0;baselineWrong=0;target=0
 baselineBy={json.dumps(r['spec'],sort_keys=True):r for r in both['rows']if r['version']=='baseline'}
 for job in [both,final]:
  assert job['sourceStable']and job['harnessStable']
  for r in job['rows']:
   assert 'M2 Pro'in r['device']and'Metal'in r['device'];assert r['first']==r['later']==r['restored'];fullImageComparisons+=2048
   s=r['spec'];fills=[e for e in r['events']if e['phase']in['first','later','restored']and any('#define MANTLE_LB_FILL\n'in shader for shader in r['sources'][str(e['program'])])];assert fills
   if s['alpha']<1 and r['version']=='candidate':assert all(e['depth']and e['depthFunc']==513 and e['depthWrite']for e in fills);assert r['first']==r['claimed'];fullImageComparisons+=1024
   if s['alpha']==1 and r['version']=='candidate':assert r['first']==baselineBy[json.dumps(s,sort_keys=True)]['first'];fullImageComparisons+=1024
   expected=round(255*s['alpha'])
   for y in range(10,22):
    for x in range(10,22):
     i=((31-y)*32+x)*4;actual=r['first'][i:i+4]
     if r['version']=='candidate':assert actual==[expected]*4
     elif actual!=[expected]*4:baselineWrong+=1
   if job is final:target+=144
 assert baselineWrong==408
 globalCenters=0
 for r in glob['rows']:
  assert 'M2 Pro'in r['device']and'Metal'in r['device']and r['glError']==0;assert r['first']==r['later']==r['restored'];fullImageComparisons+=2048
  s=r['spec'];expected=[255]*4 if s.get('control')=='opaque'else[0]*4 if s.get('control')=='belowHalf'or r['version']=='baseline'else[1,0,1,2]if s.get('control')=='colored'else[3 if s['grouped']else 5]*4
  assert r['center']==expected
  if s.get('morph'):assert r['gpuLerp']==(not s['cpuLerp'])
  globalCenters+=1
 opaquePerf=0;perfTarget=0;perfPixels=0
 for z in range(4):
  j=read(f'depth/perf{z}.json');assert j['sourceStable']and j['harnessStable'];assert 'M2 Pro'in j['device']['renderer']and'Metal'in j['device']['renderer'];sources(j['sourceHashes'],'fixed-final');sources({'src/'+n.split('/src/',1)[1]:h for n,h in j['baseline']['sourceHashes'].items()},'baseline')
  for n,h in j['harnessHashes'].items():assert H(raw('harness/global-final/probes/analyticArea/'+n))==h,n
  for r in j['rows']:
   assert r['glError']==r['steadyCompiles']==0;arms={a['name']:a for a in r['arms']}
   for a in arms.values():assert len(a['rawGpuMs'])==24;assert H(bytes(a['rgba']))==a['imageHash']==a['finalImageHash'];perfPixels+=r['size']**2
   assert arms['baseline']['rgba']==arms['baselineAA']['rgba'];assert arms['candidate']['rgba']==arms['candidateAA']['rgba'];fullImageComparisons+=2*r['size']**2
   if '-opaque-'in r['name']:assert arms['baseline']['rgba']==arms['candidate']['rgba'];fullImageComparisons+=r['size']**2;opaquePerf+=1
   rgba=arms['candidate']['rgba'];expected=254 if '-paint-'in r['name']else 1 if '-draw-'in r['name']else 255
   for gy in range(8):
    for gx in range(8):
     coords=[(gx*4+2,gy*4+2)]if r['size']==32 else[(gx*64+32+dx,gy*64+32+dy)for dy in range(-15,15)for dx in range(-15,15)]
     for x,y in coords:
      # Verify the entire pixel lies in the independently authored radius-3 disc.
      scale=r['size']/64;cx=(gx*8+4)*scale;cy=(gy*8+4)*scale;radius=3*scale
      assert max(math.hypot(xx-cx,yy-cy)for xx in[x,x+1]for yy in[y,y+1])<radius
      i=((r['size']-1-y)*r['size']+x)*4;assert rgba[i:i+4]==[expected]*4;perfTarget+=1
 pilot=read('global/wide-pilot.json');assert not pilot.get('sourceStable');sources(pilot['sourceHashes'],'global-half-byte-before-build');assert H(raw('global/pilot-gpuPage.js'))==pilot['harnessHashes']['gpuPage.js']
 refined=read('global/pilot-reference-refined.json');assert len(refined['rows'])==4;refs=sum(r['checked']for r in refined['rows']);assert refs==45;assert all(p['drift']==0 for r in refined['rows']for p in r['points']);worse=sum(p['fixedError']>p['releaseError']for r in refined['rows']for p in r['points']);assert worse==9
 assert b'RENDER-SMOKES PASS (12/12)'in raw('depth/render-affected.log');assert b'SMOKES PASS (5/5)'in raw('depth/node-affected.log');assert b'PUBLIC-TYPES PASS'in raw('depth/public-types.log');assert b'RENDERER TYPE-CHECK PASS'in raw('depth/renderer-types.log');assert read('depth/package.json')[0]['entryCount']==743
out=dict(archive=meta['archive'],membersVerified=len(members),fixedRuntimeChanges=changedSource,finalGpuCases=len(final['rows']),baselineFixedCases=len(both['rows']),baselineWrongFullyCoveredPixels=baselineWrong,independentInteriorPixels=target+perfTarget,completePixelComparisons=fullImageComparisons,performanceFullPixels=perfPixels,performanceCells=12,opaquePerformanceImagePairs=opaquePerf,globalHeld=dict(targetedCases=globalCenters,independentArtworkPixels=refs,refinementDrift=0,worsenedPixels=worse,pilotTimingValid=False),scope='Independent archive hashes, source/harness identities, actual device/depth state, complete RGBA comparisons and authored full-coverage pixel contracts. Sparse artwork oracle is a rejection control; no full-artwork oracle or broad/cold performance claim.')
(repo/(name+'-verified.json')).write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))
