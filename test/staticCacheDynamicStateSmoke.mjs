// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// staticCacheDynamicStateSmoke.mjs — state-machine coverage for content
// invalidation that does not require WebGL.
import {
  createStaticCache,
  borrowSharedGroupTarget,
  Level,
  Reason,
  Strategy,
} from '../src/renderer/staticCache.js';

let failures = 0;
const fail = (message) => {
  failures++;
  console.error('FAIL', message);
};
const ok = (message) => console.log('ok', message);

const forced = createStaticCache({ strategy: Strategy.ForceWholeAsset });
forced.tick({ hasAsset: true, dynamicContent: true });
if (
  forced.resolvedLevel !== Level.None ||
  forced.resolvedReason !== Reason.AnimatorActive ||
  forced.isCacheValid
) {
  fail('dynamic content did not demote a forced cache to live rendering');
} else {
  ok('dynamic content demotes a forced cache');
}
forced.tick({ hasAsset: true });
if (forced.resolvedLevel !== Level.WholeAsset) {
  fail('a stable forced cache did not resume after dynamic content');
} else {
  ok('stable content resumes the forced cache');
}

const scope = {};
const key = 'dynamic-content-key';
const owner = createStaticCache({
  strategy: Strategy.ForceSharedGroup,
  instanceGroupKey: key,
  groupScope: scope,
});
const peer = createStaticCache({
  strategy: Strategy.ForceSharedGroup,
  instanceGroupKey: key,
  groupScope: scope,
});
const allocate = (w, h) => ({ tex: {}, fbo: {}, rb: {}, rtW: w, rtH: h });
borrowSharedGroupTarget(key, owner._cacheState, 64, 64, allocate);
owner.markBaked(1, null, 'geometry:override-a');
if (!peer.isGroupCacheValid('geometry:override-a')) {
  fail('matching shared content did not adopt the group cache');
} else {
  ok('matching shared content adopts the group cache');
}
if (peer.isGroupCacheValid('geometry:override-b')) {
  fail('different override state incorrectly adopted the group cache');
} else {
  ok('different shared content stays live');
}

forced.dispose();
owner.dispose();
peer.dispose();

// Auto cost heuristic: small-footprint / cheap assets stay live (no cadence probe).
const auto = createStaticCache({ strategy: Strategy.Auto, stabilityPromoteFrames: 1 });
for (let i = 0; i < 2; i++) {
  auto.tick({
    hasAsset: true,
    footprintW: 200,
    footprintH: 200,
    viewportW: 1920,
    viewportH: 1080,
    liveComplexity: 12,
  });
}
if (auto.resolvedLevel !== Level.None || auto.resolvedReason !== Reason.LiveCheaper) {
  fail(
    `Auto small card should stay live (got level=${auto.resolvedLevel} reason=${auto.resolvedReason})`,
  );
} else {
  ok('Auto demotes small/cheap assets via LiveCheaper heuristic');
}
for (let i = 0; i < 2; i++) {
  auto.tick({
    hasAsset: true,
    footprintW: 1800,
    footprintH: 1000,
    viewportW: 1920,
    viewportH: 1080,
    liveComplexity: 96,
  });
}
if (auto.resolvedLevel !== Level.WholeAsset) {
  fail(`Auto dense fullscreen asset should promote (got level=${auto.resolvedLevel})`);
} else {
  ok('Auto promotes dense high-coverage assets');
}
auto.dispose();

if (failures) process.exit(1);
console.log('staticCacheDynamicStateSmoke: PASS');
