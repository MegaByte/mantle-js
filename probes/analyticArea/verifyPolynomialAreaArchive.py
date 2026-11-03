"""Verify the held polynomial CPatch study without importing Mantle runtime code."""
from pathlib import Path
import collections
import gzip
import hashlib
import json
import math
import statistics
import sys
import tarfile

meta_path = Path(sys.argv[1])
meta = json.loads(meta_path.read_text())
archive = meta_path.parent / meta['archive']['file']
digest = lambda b: hashlib.sha256(b).hexdigest()
assert archive.stat().st_size == meta['archive']['bytes']
assert digest(archive.read_bytes()) == meta['archive']['sha256']
assert meta['status'] == 'HOLD' and not meta['runtimePromoted']
with tarfile.open(archive) as tar:
    manifest = json.load(tar.extractfile('MANIFEST.json'))
    assert len(tar.getmembers()) == meta['archive']['members'] == len(manifest) + 1
    cache = {}
    for name, identity in manifest.items():
        data = tar.extractfile(name).read()
        assert len(data) == identity['bytes'] and digest(data) == identity['sha256'], name
        cache[name] = data

storage = json.loads(cache['REPORT_STORAGE.json'])
for original, identity in storage.items():
    assert digest(cache[identity['stored']]) == identity['rawJsonSha256']

def read(name):
    path = 'evidence/' + name
    data = cache[storage[path]['stored'] if path in storage else path]
    return json.loads(gzip.decompress(data) if data[:2] == b'\x1f\x8b' else data)

study = json.loads(cache['STUDY.json'])
reports = {}
pixels = first_pixels = source_checks = 0
for name in study['gpuReports']:
    job = read(name)
    assert job['finished'] and job['sourceStable'] and job['harnessStable']
    assert 'M2 Pro' in job['device']['renderer'] and 'Metal' in job['device']['renderer']
    assert len(job['sourceHashes']) == 418
    for hashes in [job['sourceHashes'], job.get('baseline', {}).get('sourceHashes', {}), job['harnessHashes']]:
        for identity in hashes.values():
            assert digest(cache['source-blobs/' + identity]) == identity
            source_checks += 1
    reports[name] = job
    for row in job['rows']:
        assert row['glError'] == 0
        if 'steadyCompiles' in row:
            assert row['steadyCompiles'] == 0
        arms = {a['name']: a for a in row['arms']}
        for arm in arms.values():
            assert arm['pin']['ledger'].get(arm['engine'], 0) > 0
            if 'rgba' not in arm:
                continue
            assert digest(bytes(arm['rgba'])) == arm['imageHash']
            if 'finalImageHash' in arm:
                assert arm['imageHash'] == arm['finalImageHash']
            pixels += row['size'] ** 2
            if 'firstReadyRgba' in arm:
                assert arm['firstReadyRgba'] == arm['rgba']
                first_pixels += row['size'] ** 2
            if arm['name'].endswith('AA') and arm['name'][:-2] in arms:
                assert arm['rgba'] == arms[arm['name'][:-2]]['rgba']

round8 = lambda v: math.floor(v + .5)
opaque = {r['name']: r for r in read('opaque-oracles.json')['rows']}
white_points = color_points = 0
continuous_max = 0
continuous_over_one = 0
for k in range(6):
    for row in reports[f'boundedreach-opaque{k}.json.gz']['rows']:
        arm = next(a for a in row['arms'] if a['name'] == 'cpatch')
        assert 'MANTLE_CPATCH_QUADRATIC_AREA_ONLY' in arm['pin']['defines']
        for p in opaque[row['name']]['pixels']:
            at = ((row['size'] - 1 - p['y']) * row['size'] + p['x']) * 4
            actual = arm['rgba'][at:at + 4]
            expected = p['coverage'] * 255
            error = max(abs(v - expected) for v in actual)
            continuous_max = max(continuous_max, error)
            continuous_over_one += error > 1
            assert max(abs(v - round8(expected)) for v in actual) <= 1
            white_points += 1
colored = {r['name']: r for r in read('original-wide-independent.json')['cases']}
for k in range(4):
    for row in reports[f'boundedreach-wide{k}.json.gz']['rows']:
        arm = next(a for a in row['arms'] if a['name'] == 'cpatch')
        for p in colored[row['name']]['pixels']:
            a, b = [v * .5 for v in p['coverage']]
            first = [round8(v * a) for v in [230, 51, 51, 255]]
            second = [round8(v * b + w * (1 - b)) for v, w in zip([51, 102, 204, 255], first)]
            expected = [round8(v * .65) for v in second]
            at = ((row['size'] - 1 - p['y']) * row['size'] + p['x']) * 4
            assert max(abs(v - w) for v, w in zip(arm['rgba'][at:at + 4], expected)) <= 1
            color_points += 1
assert continuous_over_one == 15 and math.isclose(continuous_max, 1.222993402783004)

affine_points = projective_points = 0
maps = {r['name']: r for r in read('map-independent-reference.json')['rows']}
map_stats = []
for k in range(3):
    for row in reports[f'boundedreach-map{k}.json.gz']['rows']:
        reference = maps[row['name']]
        stats = {}
        for arm in row['arms']:
            worst = 0
            for p in reference['pixels']:
                at = ((row['size'] - 1 - p['y']) * row['size'] + p['x']) * 4
                worst = max(worst, max(abs(v - 255 * p['coverage']) for v in arm['rgba'][at:at + 4]))
            stats[arm['name']] = worst
        if reference['projective']:
            assert all(v == 255 for v in stats.values())
            projective_points += len(reference['pixels'])
        else:
            assert stats['cpatch'] <= 1
            affine_points += len(reference['pixels'])
        map_stats.append({'name': row['name'], 'worstContinuousBytes': stats})

faint = reports['boundedreach-faint.json.gz']
for row, case in zip(faint['rows'], faint['config']['cases'], strict=True):
    arms = {a['name']: a for a in row['arms']}
    assert arms['cpatch']['alpha'] == arms['rawAAC']['alpha']
    assert abs(arms['cpatch']['alpha'] - case['expectedInterior']) <= 1
    if any(v in row['name'] for v in ['faint-paint-', 'faint-draw-', 'faint-group-']):
        assert arms['baselineCP']['alpha'] == 0 and arms['cpatch']['alpha'] in [2, 3]

morphs = 0
for k in range(2):
    for row in reports[f'boundedreach-morph{k}.json.gz']['rows']:
        assert len({a['imageHash'] for a in row['arms']}) == 1
        for arm in row['arms']:
            assert arm['morph']['cpatchGpuBlend'] and arm['morph']['cpatchPlanReady']
            assert arm['preparation']['geometry']['quadraticAreaMeshes'] == 0
        morphs += 1
assert morphs == 4

text_regressions = []
for reference in read('tt-boundedreach-independent-reference.json')['rows']:
    size = reference['size']
    job = reports[f'boundedreach-artwork-text_tt_12-{size}.json.gz']
    case = job['config']['cases'][0]
    assert digest(case['svg'].encode()) == reference['svgHash']
    assert case['bbox'] == reference['bbox']
    assert reference['maxCoverageRefinementDrift'] < 1e-10
    arms = {a['name']: a for a in job['rows'][0]['arms']}
    deltas = []
    for p in reference['pixels']:
        at = ((size - 1 - p['y']) * size + p['x']) * 4
        errors = [max(abs(v - w) for v, w in zip(arms[n]['rgba'][at:at + 4], p['rounded']))
                  for n in ['baseline', 'candidate']]
        if p['changed']:
            deltas.append(errors[1] - errors[0])
    if size == 32:
        assert len(deltas) == 27 and sum(d > 0 for d in deltas) == 3 and max(deltas) == 10
    else:
        assert len(deltas) == 168 and sum(d > 0 for d in deltas) == 51 and max(deltas) == 1
    text_regressions.append({'size': size, 'changed': len(deltas),
        'worse': sum(d > 0 for d in deltas), 'maxWorsening': max(deltas)})
isolated = reports['tt-isolated-v8-retry.json.gz']
path199 = next(r for r in isolated['rows'] if r['name'] == 'path-199')
arms = {a['name']: a for a in path199['arms']}
at = ((31 - 13) * 32 + 20) * 4
assert arms['baseline']['rgba'][at + 3] == 20
assert arms['candidate']['rgba'][at + 3] == 10
assert arms['AAC']['rgba'][at + 3] == 10
path200 = next(r for r in isolated['rows'] if r['name'] == 'path-200')
assert {a['name']: a['rgba'][at + 3] for a in path200['arms']} == {'baseline': 0, 'candidate': 0, 'AAC': 18}

prep = read('prep-boundedreach.json')
assert prep['sourceStable']
for hashes in prep['sourceHashes'].values():
    assert len(hashes) == 379
    for identity in hashes.values():
        assert digest(cache['source-blobs/' + identity]) == identity
prep_summary = read('prep-boundedreach-summary.json')
for row, stat in zip(prep['samples'], prep_summary, strict=True):
    assert row['count'] == stat['count']
    for name, values in row['times'].items():
        assert len(values) == 24 and math.isclose(statistics.median(values), stat['medians'][name])
assert b'SMOKES PASS (42/42)' in cache['evidence/node-cpatch-boundedreach.log']
assert b'RENDERER TYPE-CHECK PASS' in cache['evidence/types-boundedreach-complete-project.log']
assert b'buildShaders: 39 shaders' in cache['evidence/shader-build-boundedreach.log']
assert b'glslangValidator: ran' in cache['evidence/shader-build-boundedreach.log']
for stat in read('boundedreach-no-area-token-identity-final.json')['rows']:
    stage = 'frag' if stat['helper'] == '_cpatchCoverage.glsl' else 'vert'
    before = cache[f"evidence/no-area-{stage}-{stat['companion']}-baseline.tokens"]
    after = cache[f"evidence/no-area-{stage}-{stat['companion']}-candidate.tokens"]
    assert before == after and digest(before) == stat['sha256']

timing_cells = 0
for summary in ['area-qualified-timing-summary.json', 'boundedreach-qualified-timing-summary.json']:
    for stat in read(summary)['rows']:
        job = reports[stat['file']]
        row = next(r for r in job['rows'] if r['name'] == stat['case'])
        case = next(c for c in job['config']['cases'] if c['name'] == row['name'])
        arms = {a['name']: a for a in row['arms']}
        orders = case['sampleOrders']
        counts = collections.Counter((name, pos) for order in orders for pos, name in enumerate(order))
        assert len(orders) == 24 and len(set(counts.values())) == 1
        if len(arms) == 4:
            assert len({tuple(o) for o in orders}) == 24
        else:
            adjacent = collections.Counter((a, b) for order in orders for a, b in zip(order, order[1:]))
            assert len(arms) == 8 and len(adjacent) == 56 and set(adjacent.values()) == {3}
        values = [arms[n]['rawGpuMs'] for n in stat['names']]
        assert all(len(v) == 24 and all(t > 0 for t in v) for v in values)
        logs = [(math.log(a) + math.log(b) - math.log(c) - math.log(d)) / 2 for a, b, c, d in zip(*values)]
        assert math.isclose(math.exp(statistics.median(logs)), stat['ratio'], rel_tol=1e-12)
        lo, hi = map(math.log, stat['ratioCI95'])
        floor = math.log1p(stat['conservativeAAFloor'])
        verdict = 'faster' if hi < -floor else 'slower' if lo > floor else 'inconclusive'
        assert verdict == stat['verdict']
        timing_cells += 1

print(json.dumps({'verified': True, 'held': True, 'members': len(manifest) + 1,
    'successfulGpuReports': len(reports), 'sourceHashChecks': source_checks,
    'completeRenderedPixels': pixels, 'firstReadyPixelComparisons': first_pixels,
    'independentWhitePixels': white_points, 'whiteContinuousMax': continuous_max,
    'whiteContinuousOverOne': continuous_over_one, 'independentOrderedPaintPixels': color_points,
    'independentAffinePixels': affine_points, 'retainedProjectiveDiagnosticPixels': projective_points,
    'maps': map_stats, 'morphControls': morphs, 'pairedTimingCells': timing_cells,
    'retainedTextRegressions': text_regressions, 'finalPrep': prep_summary}, indent=2))
