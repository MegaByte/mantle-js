"""Independently verify source identities, complete images and authored interiors."""
from pathlib import Path
import collections
import hashlib
import json
import math
import statistics
import sys
import tarfile

meta_path = Path(sys.argv[1])
meta = json.loads(meta_path.read_text())
archive = meta_path.parent / meta['archive']['file']
digest = lambda data: hashlib.sha256(data).hexdigest()
assert archive.stat().st_size == meta['archive']['bytes']
assert digest(archive.read_bytes()) == meta['archive']['sha256']
with tarfile.open(archive) as tar:
    manifest = json.load(tar.extractfile('MANIFEST.json'))
    members = tar.getmembers()
    assert len(members) == meta['archive']['members'] == len(manifest['members']) + 1
    cache = {}
    for name, identity in manifest['members'].items():
        data = tar.extractfile(name).read()
        assert len(data) == identity['bytes'] and digest(data) == identity['sha256'], name
        cache[name] = data

read = lambda name: json.loads(cache[name])
def check_sources(hashes, version):
    for name, identity in hashes.items():
        assert digest(cache['source/' + version + '/' + name]) == identity, name

final = read('reports/gpu-final.json')
mutable = read('reports/gpu-mutable.json')
qualified = read('reports/gpu-qualified.json')
test_hash = digest(cache['harness/fixed/test/colorMatrixDepthClaimGpuSmoke.mjs'])
assert test_hash == final['testHash'] == mutable['testHash']
assert digest(cache['reports/qualified-before-state-test.mjs']) == qualified['testHash']
changed = [name for name in final['sourceHashes']['candidate']
           if cache['source/fixed/' + name] != cache['source/baseline/' + name]]
assert changed == ['src/renderer/unifiedFillDraw.js'], changed
comparisons = interiors = wrong_baseline = rgb_pairs = 0
for job_name, job in [('qualified', qualified), ('mutable', mutable), ('final', final)]:
    assert job['passed'] and job['sourceStable'] and job['harnessStable']
    for version, hashes in job['sourceHashes'].items():
        check_sources(hashes, 'fixed' if version == 'candidate' else 'baseline')
    baseline = {json.dumps(r['spec'], sort_keys=True): r for r in job['rows'] if r['version'] == 'baseline'}
    for row in job['rows']:
        assert 'M2 Pro' in row['device'] and 'Metal' in row['device']
        assert row['first'] == row['later'] == row['restored']
        comparisons += 2048
        spec = row['spec']
        is_rgb = spec['mode'] == 'rgbControl'
        fill = [e for e in row['events'] if e['phase'] in ['first', 'later', 'restored']
                and any('#define MANTLE_LB_FILL\n' in shader for shader in row['sources'][str(e['program'])])]
        assert fill
        assert not any(e['phase'] in ['first', 'later', 'other-state', 'forced-ownership', 'restored'] for e in row['shaderEvents'])
        if row['version'] == 'candidate' and spec['alpha'] < 1 and not is_rgb:
            assert all(e['depth'] and e['depthFunc'] == 513 and e['depthWrite'] for e in fill)
            assert row['first'] == row['claimed']
            comparisons += 1024
        if is_rgb or spec['alpha'] == 1:
            assert all(not e['depth'] or e['depthFunc'] != 513 for e in fill)
            if row['version'] == 'candidate' and baseline:
                assert row['first'] == baseline[json.dumps(spec, sort_keys=True)]['first']
                comparisons += 1024
                if job_name == 'mutable': rgb_pairs += 1
        frames = [('first', spec['alpha'])]
        if 'other' in row: frames.append(('other', row['otherAlpha']))
        for frame, alpha in frames:
            expected = [round(255 * alpha), 255, 255, 255] if is_rgb else [round(255 * alpha)] * 4
            for y in range(10, 22):
                for x in range(10, 22):
                    index = ((31-y)*32+x)*4
                    actual = row[frame][index:index+4]
                    if row['version'] == 'candidate':
                        assert actual == expected, (job_name, spec, frame, x, y, actual, expected)
                        interiors += 1
                    elif job_name == 'mutable' and frame == 'first' and actual != expected:
                        wrong_baseline += 1
        draws = row['ledger']['draws']
        assert draws['lb'] > 0 if spec['route'] == 'lb' else draws['cpatch'] > 0 or spec['kind'] == 'line' and draws['lb'] > 0
assert wrong_baseline == 1360
assert len(final['rows']) == 120 and len(mutable['rows']) == len(qualified['rows']) == 240

summary = {r['name']: r for r in read('reports/summary.json')['rows']}
perf_interiors = perf_pixels = perf_rgb_pairs = 0
for batch in range(4):
    job = read(f'reports/perf{batch}.json')
    inputs = read(f'reports/perf{batch}-input.json')
    assert job['sourceStable'] and job['harnessStable']
    assert digest(cache[f'reports/perf{batch}-input.json']) == job['inputHash']
    assert 'M2 Pro' in job['device']['renderer'] and 'Metal' in job['device']['renderer']
    check_sources(job['sourceHashes'], 'fixed')
    check_sources({'src/'+n.split('/src/',1)[1]: h for n,h in job['baseline']['sourceHashes'].items()}, 'baseline')
    for name, identity in job['harnessHashes'].items():
        prefix = 'harness/performance/' if name == 'gpuPage.js' else 'harness/fixed/'
        assert digest(cache[prefix+'probes/analyticArea/'+name]) == identity, name
    for row, case in zip(job['rows'], inputs['cases'], strict=True):
        assert row['name'] == case['name'] and row['batch'] == 16
        assert row['glError'] == row['steadyCompiles'] == 0
        orders = case['sampleOrders']
        names = {'baseline', 'baselineAA', 'candidate', 'candidateAA'}
        assert len(orders) == len({tuple(o) for o in orders}) == 24
        assert all(set(o) == names for o in orders)
        assert all(collections.Counter(o[position] for o in orders) == dict.fromkeys(names, 6) for position in range(4))
        arms = {a['name']: a for a in row['arms']}
        for arm in arms.values():
            assert len(arm['rawGpuMs']) == 24 and all(t > 0 for t in arm['rawGpuMs'])
            assert digest(bytes(arm['rgba'])) == arm['imageHash'] == arm['finalImageHash']
            perf_pixels += row['size']**2
        assert arms['baseline']['rgba'] == arms['baselineAA']['rgba']
        assert arms['candidate']['rgba'] == arms['candidateAA']['rgba']
        comparisons += 2*row['size']**2
        if '-rgbControl-' in row['name']:
            assert arms['baseline']['rgba'] == arms['candidate']['rgba']
            comparisons += row['size']**2
            perf_rgb_pairs += 1
        differences = [(math.log(arms['candidate']['rawGpuMs'][i]) + math.log(arms['candidateAA']['rawGpuMs'][i])
                        - math.log(arms['baseline']['rawGpuMs'][i]) - math.log(arms['baselineAA']['rawGpuMs'][i]))/2 for i in range(24)]
        stat = summary[row['name']]
        assert math.isclose(math.exp(statistics.median(differences)), stat['paired']['median'], rel_tol=1e-12)
        lo, hi = map(math.log, stat['paired']['ci95'])
        assert lo <= stat['aaFloorLog'] and hi >= -stat['aaFloorLog'] and stat['verdict'] == 'inconclusive'
        expected = [1]*4 if '-matrix-' in row['name'] else [254]*4 if '-offset-' in row['name'] else [64,255,255,255]
        rgba = arms['candidate']['rgba']
        for gy in range(8):
            for gx in range(8):
                coords = [(gx*4+2, gy*4+2)] if row['size'] == 32 else [(gx*64+32+dx, gy*64+32+dy) for dy in range(-15,15) for dx in range(-15,15)]
                scale = row['size']/64
                for x, y in coords:
                    assert max(math.hypot(xx-(gx*8+4)*scale, yy-(gy*8+4)*scale) for xx in [x,x+1] for yy in [y,y+1]) < 3*scale
                    index = ((row['size']-1-y)*row['size']+x)*4
                    assert rgba[index:index+4] == expected
                    perf_interiors += 1
assert perf_interiors == 345984 and perf_rgb_pairs == 4
assert b'RENDER-SMOKES PASS (9/9)' in cache['reports/render-affected.log']
assert b'SMOKES PASS (5/5)' in cache['reports/node-affected.log']
assert b'PUBLIC-TYPES PASS' in cache['reports/public-types.log']
assert b'RENDERER TYPE-CHECK PASS' in cache['reports/renderer-types.log']
assert read('reports/pack.json')[0]['entryCount'] == 743
out = dict(archive=meta['archive'], membersVerified=len(members), fixedRuntimeChanges=changed,
           baselineWrongFullyCoveredPixels=wrong_baseline, completePixelComparisons=comparisons,
           independentTargetPixels=interiors, independentBenchmarkInteriorPixels=perf_interiors,
           performanceFullPixels=perf_pixels, unchangedTargetOpaqueRgbPairs=rgb_pairs,
           unchangedPerformanceRgbPairs=perf_rgb_pairs, performanceCells=12,
           scope='Source/harness hashes, physical GPU/depth state, full images, mutable matrix restoration, authored interiors and paired median statistics. Boundary accuracy, broad transparency, CPU submission and cold compilation remain unproved.')
meta_path.with_name(meta_path.stem+'-verified.json').write_text(json.dumps(out, indent=2)+'\n')
print(json.dumps(out, indent=2))
