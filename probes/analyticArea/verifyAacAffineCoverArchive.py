#!/usr/bin/env python3
"""Verify a private AAC diagnosis, including the numerical failures preventing promotion."""
import gzip, hashlib, json, math, statistics, sys, tarfile
from pathlib import Path

archive = Path(sys.argv[1])
metadata = json.load(open(archive.with_suffix('').with_suffix('.json')))
h = hashlib.sha256()
with archive.open('rb') as f:
    while chunk := f.read(4 * 1024 * 1024):
        h.update(chunk)
assert h.hexdigest() == metadata['sha256'] and archive.stat().st_size == metadata['bytes']
members = set()
cases = rendered = source_checks = gate_cases = instanced_cases = 0
map_rows = []
wide_rows = []
artwork_changed = {}
timing_rows = {}
reports = []
with tarfile.open(archive, 'r|xz') as tf:
    first = next(iter(tf))
    assert first.name == 'INDEX.json'
    index = json.load(tf.extractfile(first))
    entries = index['files']
    proofs = {p['file']: p for p in index['proofReports']}
    inputs = {e['sha256'] for n, e in entries.items() if n.endswith('-input.json') or n.endswith('.input.json')}
    for m in tf:
        if m.name == 'INDEX.json':
            continue
        assert m.isfile()
        raw = tf.extractfile(m).read()
        e = entries[m.name]
        assert len(raw) == e['bytes'] and hashlib.sha256(raw).hexdigest() == e['sha256'], m.name
        members.add(m.name)
        if m.name in proofs:
            p = proofs[m.name]
            j = json.loads(gzip.decompress(raw) if m.name.endswith('.gz') else raw)
            assert j['finished'] and j['sourceStable'] and j['harnessStable']
            assert 'Apple M2 Pro' in j['device']['renderer'] and 'Metal' in j['device']['renderer']
            assert j['inputHash'] in inputs, m.name
            maps = [(p['source'], j['sourceHashes'])]
            if p['baseline']:
                prefix = '../' + Path(j['baseline']['root']).name + '/'
                assert all(n.startswith(prefix) for n in j['baseline']['sourceHashes'])
                maps.append((p['baseline'], {n[len(prefix):]: v for n, v in j['baseline']['sourceHashes'].items()}))
            for label, values in maps:
                for n, digest in values.items():
                    assert entries['sources/' + label + '/' + n]['sha256'] == digest, (m.name, label, n)
                    source_checks += 1
            for n, digest in j['harnessHashes'].items():
                assert entries['sources/' + p['source'] + '/probes/analyticArea/' + n]['sha256'] == digest
            assert len(j['rows']) == p['cases']
            for r in j['rows']:
                cases += 1
                assert r['glError'] == 0 and r['steadyCompiles'] == 0
                arms = {a['name']: a for a in r['arms']}
                for a in arms.values():
                    assert a['pin']['ledger'].get(a['engine'], 0) > 0
                    assert hashlib.sha256(bytes(a['rgba'])).hexdigest() == a['imageHash'] == a['finalImageHash']
                    rendered += len(a['rgba']) // 4
                if '/gate-gpu/' in m.name:
                    gate_cases += 1
                    assert all(a['colorQuality']['maxByte'] <= 1 for a in arms.values())
                    assert all(q['maxByte'] == 0 for q in r['comparisons'])
                if p['source'] == 'fan':
                    if 'fast' in arms:
                        instanced_cases += 1
                        assert arms['fast']['pin']['instancedDraws'] > 0 and arms['fastAA']['pin']['instancedDraws'] > 0
                        assert not arms['loop']['pin'].get('instancedDraws', 0)
                        assert all(a['rgba'] == arms['loop']['rgba'] for a in arms.values())
                    if r['name'].startswith('map-'):
                        map_rows.append(r)
                    if 'fan-selective-wide-' in m.name:
                        wide_rows.append(r)
                if 'integration-artwork' in m.name:
                    assert arms['baseline']['rgba'] == arms['baselineAA']['rgba']
                    assert arms['candidate']['rgba'] == arms['candidateAA']['rgba']
                    c = next(c for c in j['config']['cases'] if (c['name'], c['size']) == (r['name'], r['size']))
                    assert len(c['sampleOrders']) == 24 and len({tuple(o) for o in c['sampleOrders']}) == 24
                    n = r['size']
                    changed = {}
                    for at in range(0, n * n * 4, 4):
                        a, b = arms['baseline']['rgba'][at:at + 4], arms['candidate']['rgba'][at:at + 4]
                        if max(abs(x - y) for x, y in zip(a, b)) > 1:
                            changed[(at // 4 % n, n - 1 - at // 4 // n)] = (a, b)
                    artwork_changed[r['name'], n] = changed
                    signal = [(math.log(x) + math.log(y) - math.log(z) - math.log(w)) / 2 for x, y, z, w in zip(
                        arms['candidate']['rawGpuMs'], arms['candidateAA']['rawGpuMs'],
                        arms['baseline']['rawGpuMs'], arms['baselineAA']['rawGpuMs'])]
                    timing_rows[r['name'], n] = math.exp(statistics.median(signal))
            reports.append({'file': m.name, 'source': p['source'], 'cases': len(j['rows'])})
        elif m.name == 'reference/map-independent-reference.json':
            map_ref = json.loads(raw)
        elif m.name == 'reference/wide-independent.json':
            wide_ref = json.loads(raw)
        elif m.name == 'evidence/artwork-reference-64-128.json':
            artwork_ref = json.loads(raw)
        elif m.name == 'evidence/integration-artwork-qualified-timing-summary.json':
            timing = json.loads(raw)
assert members == set(entries) and cases == index['proofCases'] == 120
assert len(reports) == metadata['proofReports'] == 49 and gate_cases == 12 and instanced_cases == 8
# Recompute independent affine/wide references; retain projective failures.
map_count = wide_count = 0
for r in map_rows:
    ref = next(q for q in map_ref['rows'] if q['name'] == r['name'])
    n = r['size']
    for a in r['arms']:
        if a['name'] == 'baseline':
            continue
        worst = max(abs(a['rgba'][((n - 1 - p['y']) * n + p['x']) * 4 + 3] - math.floor(255 * p['coverage'] + .5)) for p in ref['pixels'])
        assert worst == 255 if ref['projective'] else worst <= 1
    map_count += len(ref['pixels'])
for r in wide_rows:
    ref = next(q for q in wide_ref['cases'] if q['name'] == r['name'])
    n = r['size']
    a = next(a for a in r['arms'] if a['name'] == 'candidate')
    for p in ref['pixels']:
        at = ((n - 1 - p['y']) * n + p['x']) * 4
        assert max(abs(x - math.floor(y + .5)) for x, y in zip(a['rgba'][at:at + 4], p['rgba'])) <= 1
    wide_count += len(ref['pixels'])
assert len(map_rows) == 14 and len(wide_rows) == 16
# Every wider change over one byte was independently checked. Failures must remain visible.
reference_count = 0
worsening = {}
for r in artwork_ref['rows']:
    changed = artwork_changed[r['name'], r['size']]
    assert set(changed) == {(p['x'], p['y']) for p in r['points']}
    delta = 0
    for p in r['points']:
        a, b = changed[p['x'], p['y']]
        assert (a, b) == (p['baseRGBA'], p['actualRGBA'])
        assert p['drift'] <= 1
        before = max(abs(x - y) for x, y in zip(a, p['referenceRGBA']))
        after = max(abs(x - y) for x, y in zip(b, p['referenceRGBA']))
        assert (before, after) == (p['releaseError'], p['fixedError'])
        delta = max(delta, after - before)
    reference_count += len(r['points'])
    worsening[r['name'] + ':' + str(r['size'])] = delta
assert reference_count == 133 and worsening['tiger:512'] == 9 and worsening['train_b018:512'] == 8
assert all(not v or any((q['name'], q['size']) == k for q in artwork_ref['rows']) for k, v in artwork_changed.items())
assert len(timing['rows']) == 32
for r in timing['rows']:
    assert abs(r['ratio'] - timing_rows[r['case'], r['size']]) < 1e-12
slower = [r['case'] + ':' + str(r['size']) for r in timing['rows'] if r['verdict'] == 'slower']
assert sorted(slower) == ['text_cff_12:32', 'tiger:32', 'train_b018:32']
out = dict(scope=index['scope'], archiveSha256=metadata['sha256'], members=len(members) + 1,
           reports=reports, sourceChecks=source_checks, gpuCases=cases, completeRenderedPixels=rendered,
           independentMapPixels=map_count, independentWidePixels=wide_count, actualInstancedCases=instanced_cases,
           scopedGpuGateCases=gate_cases, nativeSvgChangedPixels=reference_count, nativeSvgWorsening=worsening,
           widerSlowerCells=slower, runtimePromoted=False)
if len(sys.argv) > 2:
    Path(sys.argv[2]).write_text(json.dumps(out, indent=2) + '\n')
print(json.dumps({k: v for k, v in out.items() if k != 'reports'}, indent=2))
