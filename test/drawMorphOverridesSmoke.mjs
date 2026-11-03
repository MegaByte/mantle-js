// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Morph draws resolve visibility overrides through the shared dispatcher.
// CPU checks cover the actual resolution rule and both public draw entry points.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = (rel) => readFileSync(path.join(HERE, '..', 'src', rel), 'utf8');
const { attachDrawDispatch } = await import('../src/renderer/drawDispatch.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

/// The smallest renderer context drawBundle / drawBundleInstanced will run against. `bound` is
/// what the draw handed the fill pass — captured inside render(), because the `finally` clears
/// the draw state on the way out and a test reading it afterwards would always see null.
function stubRenderer() {
  const R = {
    opts: {},
    draw: {},
    _lbSlugFallback: true,
    _instancedFastEnabled: false,
    bound: undefined,
    drew: 0,
    setBundle() {},
    render() {
      R.bound = R.draw.overrides;
      R.boundAlpha = R.draw.alpha;
      R.drew++;
    },
    paletteChannelToInt: () => 0,
    _analyticRoute: () => false,
    _canvasUnsized: () => false,
    _autoNodeClip() {},
    // The group-alpha hooks (renderer.js): this test is about the override table, so no draw here needs the group.
    _alphaGroupBegin: () => null,
    _alphaGroupEnd() {},
    _alphaGroupAbort() {},
    _alphaNeedsGroup: () => false,
    _drawDebugOverlays() {},
    mantleDebugFlag: () => false,
    mantleWarn() {},
    _lbWouldServe: () => false,
    _simpleInstanceable: () => false,
    _instancedPrefersSlug: () => true,
    _ensureInstProg: () => false,
  };
  attachDrawDispatch(R);
  return R;
}

const TABLE = { packedBuffer: new Float32Array(8), _tag: 'morph' };
const OTHER = { packedBuffer: new Float32Array(8), _tag: 'caller' };
/// A morph bundle and the handle createShapeMorph returns around it (only the two members the
/// draw path reads: `.bundle`, and the table the morph hung on it).
const morphBundle = () => ({ numShapes: 4, _morphOverrides: TABLE });
const handleFor = (b) => ({
  bundle: b,
  get overrides() {
    return b._morphOverrides;
  },
});

// ===========================================================================
console.log('\n-- drawBundle(handle): the morph table is used when the caller names none --');
{
  const R = stubRenderer();
  const b = morphBundle(),
    h = handleFor(b);

  R.drawBundle(h, {});
  ok(R.bound === TABLE, "drawBundle(morph, {}) binds the morph's own override table");

  R.bound = undefined;
  R.drawBundle(h);
  ok(R.bound === TABLE, 'drawBundle(morph) with no opts at all binds it too');

  R.bound = undefined;
  R.drawBundle(h, { alpha: 0.5 });
  ok(R.bound === TABLE, 'an opts object that simply does not mention overrides still binds it');

  R.bound = undefined;
  R.drawBundle(h, { overrides: OTHER });
  ok(R.bound === OTHER, "a caller-supplied table still wins over the morph's");

  R.bound = undefined;
  R.drawBundle(h, { overrides: null });
  ok(
    R.bound === null,
    'an EXPLICIT overrides: null means NONE — the one spelling for "draw the lerp without the fade"',
  );

  R.bound = undefined;
  R.drawBundle(h, { overrides: undefined });
  ok(
    R.bound === TABLE,
    '...and an explicit undefined is "not named", so a caller spreading an options object ' +
      'with the key absent-but-present is not silently stripped of the fade',
  );
}

// ===========================================================================
console.log('\n-- the fade belongs to the BUNDLE, not to the wrapper it was reached through --');
{
  const R = stubRenderer();
  const b = morphBundle();
  R.drawBundle(b, {});
  ok(
    R.bound === TABLE,
    'a bare morph bundle (no handle) fades as well — the handle is not the carrier',
  );

  R.bound = undefined;
  R.drawBundle({ numShapes: 2 }, {});
  ok(R.bound === null, 'a plain bundle with no morph table binds nothing, as before');

  R.bound = undefined;
  R.drawBundle({ bundle: { numShapes: 2 } }, {});
  ok(R.bound === null, 'and so does a handle around one');
}

// ===========================================================================
console.log('\n-- the draw state does not leak past the draw --');
{
  const R = stubRenderer();
  R.drawBundle(handleFor(morphBundle()), {});
  ok(R.draw.overrides === null, 'clearDrawState still clears the resolved table on the way out');
}

// ===========================================================================
console.log('\n-- drawBundleInstanced: N copies of a morph fade exactly as one does --');
{
  const R = stubRenderer();
  const h = handleFor(morphBundle());
  const n = R.drawBundleInstanced(h, [{}, {}], {});
  ok(n === 2 && R.drew === 2, `both instances drew (${n})`);
  ok(R.bound === TABLE, 'the shared state carries the morph table when `shared` names none');

  R.bound = undefined;
  R.drawBundleInstanced(h, [{}], { overrides: null });
  ok(R.bound === null, 'and an explicit null means none there too');

  R.bound = undefined;
  R.drawBundleInstanced(h, [{}], { overrides: OTHER });
  ok(R.bound === OTHER, 'a caller-supplied shared table still wins');
}

// Alpha is draw state; repeated real dispatches must preserve stored tint.
{
  const R = stubRenderer(),
    packed = new Float32Array(48);
  packed[11] = 0.8;
  packed[35] = 0.3;
  const table = { packedBuffer: packed },
    b = { numShapes: 2, _morphOverrides: table };
  const before = packed.slice();
  for (const alpha of [0.5, 0.1, 0.9, 1, 0, -1, 2]) {
    R.drawBundle(b, { alpha });
    ok(
      R.bound === table && R.boundAlpha === Math.max(0, Math.min(1, alpha)),
      'dispatch forwards clamped alpha ' + alpha,
    );
    ok(
      packed.every((v, i) => v === before[i]),
      'draw preserves override bytes at alpha ' + alpha,
    );
    ok(R.draw.alpha === 1, 'draw alpha is cleared');
  }
}

// ===========================================================================
console.log('\n-- one field name, three modules --');
{
  // A rename that reaches two of these and not the third breaks the draw path silently: the
  // morph would still fade under a hit test and not on screen.
  const morph = SRC('animation/shapeMorph.js');
  ok(
    /bundle\._morphOverrides\s*=\s*overrides/.test(morph),
    'shapeMorph.js writes the table to bundle._morphOverrides',
  );
  ok(
    /_morphOverrides/.test(SRC('hitTest/hitTest.js')),
    'hitTest.js reads the same field (resolveOverridesPacked)',
  );
  const dd = SRC('renderer/drawDispatch.js');
  ok(/bundle\._morphOverrides/.test(dd), 'drawDispatch.js reads it too');
  ok(
    /opts\.overrides\s*!==\s*undefined/.test(dd),
    'and it distinguishes an unset key from an explicit null, rather than testing truthiness',
  );
  // ...and the OTHER draw entry point resolves it the same way. handle.draw is documented as
  // taking drawBundle's options, so a caller moving to a resident handle for speed must not
  // lose the fade; it shares the resolver rather than copying the rule, exactly as the two
  // share resolveDstRect. A GL-free test cannot build a handle, so the wiring is pinned here.
  const bh = SRC('renderer/bundleHandle.js');
  ok(
    /import\s*\{[^}]*\bresolveOverrides\b[^}]*\}\s*from\s*'\.\/drawDispatch\.js'/.test(bh) &&
      /R\.draw\.overrides\s*=\s*resolveOverrides\(h\.bundle,\s*opts\)/.test(bh),
    'bundleHandle.js handle.draw() resolves through the same helper, not a copy of the rule',
  );
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
