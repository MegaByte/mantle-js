#!/usr/bin/env python3
"""Verify fill-only cover GPU evidence, retaining its performance/composition negatives."""
import gzip, hashlib, json, math, statistics, sys, tarfile
from pathlib import Path

archive = Path(sys.argv[1])
meta = json.load(open(archive.with_suffix('').with_suffix('.json')))
assert archive.stat().st_size == meta['bytes']
h = hashlib.sha256()
with archive.open('rb') as f:
    while chunk := f.read(4 * 1024 * 1024):
        h.update(chunk)
assert h.hexdigest() == meta['sha256']
data = {}
with tarfile.open(archive, 'r|xz') as tf:
    index = json.load(tf.extractfile(next(iter(tf))))
    for member in tf:
        if member.name == 'INDEX.json':
            continue
        assert member.isfile()
        raw = tf.extractfile(member).read()
        entry = index['files'][member.name]
        assert len(raw) == entry['bytes'] and hashlib.sha256(raw).hexdigest() == entry['sha256']
        data[member.name] = raw
assert set(data) == set(index['files'])

def read(name):
    raw = data[name]
    return json.loads(gzip.decompress(raw) if name.endswith('.gz') else raw)

inputs = {hashlib.sha256(raw).hexdigest() for name, raw in data.items() if name.endswith('-input.json')}
cases = images = source_checks = 0
wide, morphs = {}, []
for proof in index['proofReports']:
    d = read(proof['file'])
    assert d['finished'] and d['sourceStable'] and d['harnessStable']
    assert 'Apple M2 Pro' in d['device']['renderer'] and 'Metal' in d['device']['renderer']
    assert d['inputHash'] in inputs
    maps = [(proof['source'], d['sourceHashes'])]
    if proof['baseline']:
        prefix = '../' + Path(d['baseline']['root']).name + '/'
        assert all(n.startswith(prefix) for n in d['baseline']['sourceHashes'])
        maps.append((proof['baseline'], {n[len(prefix):]: v for n, v in d['baseline']['sourceHashes'].items()}))
    for label, values in maps:
        for n, sha in values.items():
            assert index['files']['sources/' + label + '/' + n]['sha256'] == sha
            source_checks += 1
    for n, sha in d['harnessHashes'].items():
        assert index['files']['sources/' + proof['source'] + '/probes/analyticArea/' + n]['sha256'] == sha
    assert len(d['rows']) == proof['cases']
    for r in d['rows']:
        cases += 1
        assert r['glError'] == 0 and r['steadyCompiles'] == 0
        arms = {a['name']: a for a in r['arms']}
        for a in arms.values():
            assert a['pin']['ledger'].get('aac', 0) > 0
            assert a['imageHash'] == a['finalImageHash']
            if 'rgba' in a:
                assert hashlib.sha256(bytes(a['rgba'])).hexdigest() == a['imageHash']
                images += len(a['rgba']) // 4
        if '/fill-rows-wide' in proof['file']:
            assert arms['baseline']['rgba'] == arms['baselineAA']['rgba']
            assert arms['candidate']['rgba'] == arms['candidateAA']['rgba']
            c = next(c for c in d['config']['cases'] if (c['name'], c['size']) == (r['name'], r['size']))
            assert len(c['sampleOrders']) == 24 and len({tuple(o) for o in c['sampleOrders']}) == 24
            n = r['size']; changed = {}
            for at in range(0, n * n * 4, 4):
                a, b = arms['baseline']['rgba'][at:at + 4], arms['candidate']['rgba'][at:at + 4]
                if max(abs(x - y) for x, y in zip(a, b)) > 1:
                    changed[at // 4 % n, n - 1 - at // 4 // n] = (a, b)
            signal = [(math.log(a) + math.log(b) - math.log(c) - math.log(e)) / 2 for a, b, c, e in zip(
                arms['candidate']['rawGpuMs'], arms['candidateAA']['rawGpuMs'],
                arms['baseline']['rawGpuMs'], arms['baselineAA']['rawGpuMs'])]
            wide[r['name'], n] = (changed, math.exp(statistics.median(signal)))
        if '/fill-rows-morph' in proof['file']:
            for name in ['morphGpu', 'morphGpuAA']:
                assert arms[name]['morph']['usesGpuCurveLerp'] and arms[name]['morph']['matched'] > 0
                assert not arms[name]['morph']['areaMonotone']
            assert not arms['morphCpu']['morph']['usesGpuCurveLerp']
            assert arms['morphGpu']['rgba'] == arms['morphGpuAA']['rgba']
            assert all(a['colorQuality']['maxByte'] <= 1 for a in arms.values())
            assert all(q['maxByte'] <= 1 for q in r['comparisons'])
            morphs.append(r['name'])
assert cases == index['proofCases'] == meta['proofCases'] and len(wide) == 32 and len(morphs) == 3
timing = read('evidence/fill-rows-qualified-timing-summary.json')
assert len(timing['rows']) == 32
verdicts = []
for r in timing['rows']:
    assert abs(wide[r['case'], r['size']][1] - r['ratio']) < 1e-12
    floor = max(abs(math.log(x)) for bound in r['aaCI95'] for x in bound)
    verdict = 'faster' if math.log(r['ratioCI95'][1]) < -floor else 'slower' if math.log(r['ratioCI95'][0]) > floor else 'inconclusive'
    assert verdict == r['verdict']; verdicts.append(verdict)
assert verdicts.count('inconclusive') == 31 and verdicts.count('slower') == 1
refs = read('evidence/fill-rows-all-reference.json')['rows']; points = worse = 0
assert sum(len(c) for c, _ in wide.values()) == 39
for r in refs:
    changed = wide[r['name'], r['size']][0]
    assert len(changed) == len(r['points'])
    for p in r['points']:
        assert changed[p['x'], p['y']] == (p['baseRGBA'], p['actualRGBA'])
        assert p['drift'] <= 1
        old = max(abs(a-b) for a, b in zip(p['baseRGBA'], p['referenceRGBA']))
        new = max(abs(a-b) for a, b in zip(p['actualRGBA'], p['referenceRGBA']))
        assert (old, new) == (p['releaseError'], p['fixedError'])
        if new > old:
            assert r['name'] == 'train_b018' and r['size'] == 512
            assert (p['x'], p['y'], new) in [(354, 187, 3), (365, 184, 2)]
            worse += 1
        points += 1
assert points == 39 and worse == 2
native = read('evidence/train-blue-native.json')['rows']
assert next(r for r in native if r['name'] == 'train-blue-354-187-168')['points'][0]['fixedError'] == 0
overlap = read('evidence/train-paint-overlap-proof.json')['rows']
for r in overlap:
    assert r['earlierFullyCovered'] and abs(r['area168'] - r['area172']) < 1e-9
    a = r['area168']; assert abs(r['maxCompositionGap'] - 255*a*(1-a)) < 1e-8
assert 3.22 < overlap[0]['maxCompositionGap'] < 3.23
identity = read('evidence/fill-rows-non-aac-identity.json')
assert len(identity['checks']) == 40
assert read('evidence/preserved-held-state.json')['unchanged']
assert 'aacCoverReachGpuSmoke PASS' in data['evidence/fill-rows-gate-retry.log'].decode()
out = dict(scope='Archive/source/image integrity; includes the measured slowdown and two completed-SVG composition negatives. No release-ready claim.',
           members=len(data)+1, reports=len(index['proofReports']), cases=cases, sourceChecks=source_checks,
           renderedPixels=images, timingCells=32, inconclusive=31, slower=1, morphPoses=3,
           nativeChangedPixels=points, compositionNegatives=worse, nonAacStages=40)
print(json.dumps(out, indent=2))
