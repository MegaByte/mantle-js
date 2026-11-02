#!/usr/bin/env python3
"""Verify the targeted tighter-bound trial, including its reproduced GPU cost."""
import gzip, hashlib, json, math, statistics, sys, tarfile
from pathlib import Path

p = Path(sys.argv[1]); m = json.load(open(p.with_suffix('').with_suffix('.json')))
assert p.stat().st_size == m['bytes']
h = hashlib.sha256()
with p.open('rb') as f:
    while chunk := f.read(4*1024*1024): h.update(chunk)
assert h.hexdigest() == m['sha256']
data = {}
with tarfile.open(p, 'r|xz') as tf:
    index = json.load(tf.extractfile(next(iter(tf))))
    for member in tf:
        if member.name == 'INDEX.json': continue
        assert member.isfile()
        raw = tf.extractfile(member).read(); entry = index['files'][member.name]
        assert len(raw) == entry['bytes'] and hashlib.sha256(raw).hexdigest() == entry['sha256']
        data[member.name] = raw
assert set(data) == set(index['files'])
def read(name):
    raw = data[name]
    return json.loads(gzip.decompress(raw) if name.endswith('.gz') else raw)
inputs = {hashlib.sha256(v).hexdigest() for n,v in data.items() if n.endswith('-input.json')}
rows = {}; source_checks = pixels = 0
for proof in index['proofReports']:
    d = read(proof['file'])
    assert d['finished'] and d['sourceStable'] and d['harnessStable'] and d['inputHash'] in inputs
    assert 'Apple M2 Pro' in d['device']['renderer'] and 'Metal' in d['device']['renderer']
    prefix = '../' + Path(d['baseline']['root']).name + '/'
    assert all(n.startswith(prefix) for n in d['baseline']['sourceHashes'])
    maps = [(proof['source'], d['sourceHashes']), ('baseline', {n[len(prefix):]:v for n,v in d['baseline']['sourceHashes'].items()})]
    for root, hashes in maps:
        for n,v in hashes.items():
            assert index['files']['sources/'+root+'/'+n]['sha256'] == v; source_checks += 1
    for n,v in d['harnessHashes'].items():
        assert index['files']['sources/'+proof['source']+'/probes/analyticArea/'+n]['sha256'] == v
    for r in d['rows']:
        assert r['glError'] == r['steadyCompiles'] == 0
        arms = {a['name']:a for a in r['arms']}
        for a in arms.values():
            assert a['pin']['ledger']['aac'] > 0
            assert hashlib.sha256(bytes(a['rgba'])).hexdigest() == a['imageHash'] == a['finalImageHash']
            pixels += len(a['rgba'])//4
        assert arms['baseline']['rgba'] == arms['baselineAA']['rgba']
        assert arms['candidate']['rgba'] == arms['candidateAA']['rgba']
        c = next(c for c in d['config']['cases'] if (c['name'],c['size']) == (r['name'],r['size']))
        assert len(c['sampleOrders']) == 24 and len({tuple(o) for o in c['sampleOrders']}) == 24
        n=r['size']; changed={}
        for at in range(0,n*n*4,4):
            a,b=arms['baseline']['rgba'][at:at+4],arms['candidate']['rgba'][at:at+4]
            if max(abs(x-y) for x,y in zip(a,b))>1:
                changed[at//4%n,n-1-at//4//n]=(a,b)
        signal=[(math.log(a)+math.log(b)-math.log(c)-math.log(e))/2 for a,b,c,e in zip(
            arms['candidate']['rawGpuMs'],arms['candidateAA']['rawGpuMs'],arms['baseline']['rawGpuMs'],arms['baselineAA']['rawGpuMs'])]
        rows[r['name'],n]=(changed,math.exp(statistics.median(signal)))
assert len(rows) == index['proofCases'] == m['proofCases'] == 8
timing=read('evidence/corner-radius-target-timing-summary.json'); verdicts=[]
for r in timing['rows']:
    assert abs(rows[r['case'],r['size']][1]-r['ratio'])<1e-12
    floor=max(abs(math.log(x)) for b in r['aaCI95'] for x in b)
    verdict='faster' if math.log(r['ratioCI95'][1])<-floor else 'slower' if math.log(r['ratioCI95'][0])>floor else 'inconclusive'
    assert verdict==r['verdict'];verdicts.append(verdict)
assert verdicts.count('inconclusive')==7 and verdicts.count('slower')==1
assert sum(len(c) for c,_ in rows.values())==2
native=read('evidence/corner-radius-native.json')['rows'];assert len(native)==1
for q in native[0]['points']:
    assert rows['train_b018',512][0][q['x'],q['y']]==(q['baseRGBA'],q['actualRGBA'])
    assert q['drift']<=1 and q['releaseError']==0 and q['fixedError'] in [2,3]
assert 'aacCoverReachGpuSmoke PASS' in data['evidence/corner-radius-gate.log'].decode()
proof=read('evidence/corner-radius-math-proof.json')
assert proof['matrices']==10000 and proof['edgeChecks']==40000 and proof['maxRelativeFormulaError']<1e-12
print(json.dumps(dict(scope='Source/image integrity and targeted warm GPU comparison; measurable train cost and composition negatives retained. No wider/morph/runtime integration claim.',
    members=len(data)+1,reports=len(index['proofReports']),cases=8,sourceChecks=source_checks,
    renderedPixels=pixels,timingCells=8,inconclusive=7,slower=1,nativeChangedPixels=2),indent=2))
