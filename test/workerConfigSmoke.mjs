// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// workerConfigSmoke.mjs - the worker policy.
//
// configureWorkers({ enabled:false }) starts no worker and the work still completes on the main thread; a custom
// URL or factory is honored; bad options throw; and the error text for a failed worker load is readable (not
// "[object Event]"). GL-free: a fake Worker class records every construction.

import {
  configureWorkers,
  terminateWorkers,
  registerWorkerPool,
  spawnWorker,
  describeWorkerError,
  workersEnabled,
} from '../src/renderer/workerConfig.js';
import { requestOccupancyBuild } from '../src/renderer/occupancyWorkerPool.js';

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

const made = [];
class FakeWorker {
  constructor(url, opts) {
    this.url = String(url);
    this.opts = opts;
    this.terminated = false;
    made.push(this);
  }
  postMessage() {}
  terminate() {
    this.terminated = true;
  }
}
globalThis.Worker = FakeWorker;

const job = [{ base: 0, G: 2, segs: new Float32Array(0), bbox: [0, 0, 1, 1], evenOdd: false }];
const settle = (fn) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 1500);
    fn((r) => {
      clearTimeout(t);
      resolve(r);
    });
  });

// Disabled: no construction, and the request still answers.
configureWorkers({ enabled: false });
workersEnabled() === false ? ok('enabled:false is recorded') : fail('policy not recorded');
{
  const r = await settle((done) => requestOccupancyBuild(job, [], done));
  r !== 'timeout' && made.length === 0
    ? ok('disabled: the occupancy build ran on the main thread, 0 workers constructed')
    : fail(
        `disabled: result=${r === 'timeout' ? 'timeout' : 'ok'}, workers constructed=${made.length}`,
      );
}

// Enabled again, default source: the pool constructs a module worker at its own script.
configureWorkers({ enabled: true });
{
  requestOccupancyBuild(job, [], () => {});
  const w = made[made.length - 1];
  w && /occupancy\.worker\.js$/.test(w.url) && w.opts && w.opts.type === 'module'
    ? ok('default: constructs occupancy.worker.js as a module worker')
    : fail('default worker not constructed as expected: ' + (w && w.url));
}

// A custom URL replaces the default; a factory is called.
configureWorkers({ occupancy: 'https://example.test/w/occupancy.js' });
{
  const before = made.length;
  requestOccupancyBuild(job, [], () => {});
  const w = made[made.length - 1];
  made.length === before + 1 && w.url === 'https://example.test/w/occupancy.js'
    ? ok('custom URL is used')
    : fail('custom URL ignored: ' + (w && w.url));
}
{
  let called = 0;
  configureWorkers({
    occupancy: () => {
      called++;
      return new FakeWorker('factory://x', { type: 'module' });
    },
  });
  requestOccupancyBuild(job, [], () => {});
  called === 1 && made[made.length - 1].url === 'factory://x'
    ? ok('factory is called once and its worker used')
    : fail('factory not honored, called=' + called);
}
configureWorkers({ occupancy: null });
{
  const w0 = made.length;
  spawnWorker('lb', () => new FakeWorker('default-lb', {}));
  made.length === w0 + 1 && made[made.length - 1].url === 'default-lb'
    ? ok('null restores the default')
    : fail('null did not restore the default');
}

// Reconfiguring stops running workers.
{
  const live = made.filter((w) => !w.terminated).length;
  configureWorkers({ enabled: false });
  const stillLive = made.filter((w) => !w.terminated && w.url !== 'default-lb').length;
  stillLive === 0
    ? ok(`disabling terminated the running pool workers (${live} had been live)`)
    : fail(stillLive + ' worker(s) still running after enabled:false');
}
configureWorkers({ enabled: true });

// Bad input throws.
for (const [bad, re] of [
  [{ enabld: false }, /unknown option 'enabld'/],
  [{ enabled: 'no' }, /enabled must be/],
  [{ lb: 5 }, /lb must be/],
  [null, /options object/],
]) {
  try {
    configureWorkers(bad);
    fail('accepted ' + JSON.stringify(bad));
  } catch (e) {
    re.test(e.message) ? ok('rejects ' + JSON.stringify(bad)) : fail('wrong error: ' + e.message);
  }
}

// Error text.
{
  const t1 = describeWorkerError({ type: 'error', message: '', filename: '' });
  const t2 = describeWorkerError({ message: 'boom', filename: 'http://x/w.js', lineno: 3 });
  !/\[object/.test(t1) && /worker-src/.test(t1) && /configureWorkers/.test(t1)
    ? ok('empty ErrorEvent reads: ' + t1.slice(0, 60) + '...')
    : fail('unreadable: ' + t1);
  t2 === 'boom at http://x/w.js:3' ? ok('message and location are kept') : fail('t2=' + t2);
}

// terminateWorkers stops every pool, keeps the policy, and the next request starts a fresh worker.
{
  configureWorkers({ enabled: true });
  const live = [];
  const pools = ['t1', 't2'].map((k) => {
    const p = { stops: 0 };
    registerWorkerPool(k, () => {
      p.stops++;
    });
    return p;
  });
  const n = terminateWorkers();
  n >= 2 && pools.every((p) => p.stops === 1)
    ? ok('terminateWorkers asked every pool to stop (' + n + ')')
    : fail('pool stops ' + pools.map((p) => p.stops) + ' of ' + n);
  terminateWorkers();
  pools.every((p) => p.stops === 2)
    ? ok('terminateWorkers is repeatable')
    : fail('second call stops ' + pools.map((p) => p.stops));
  workersEnabled() ? ok('terminateWorkers leaves the policy unchanged') : fail('policy changed');
  const before = made.length;
  const w = await settle((done) => {
    requestOccupancyBuild(job, [], done);
  });
  made.length > before && made[made.length - 1].terminated === false
    ? ok('a request after terminateWorkers starts a fresh worker')
    : fail(
        'no fresh worker after terminate: ' +
          made.length +
          ' vs ' +
          before +
          ' ' +
          JSON.stringify(w),
      );
  terminateWorkers();
  made[made.length - 1].terminated
    ? ok('terminateWorkers terminates a live worker')
    : fail('live worker not terminated');
}

configureWorkers({ enabled: true });
if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('workerConfigSmoke: PASS');
process.exit(0);
