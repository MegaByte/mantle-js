let failures = 0;
function check(label, condition) {
  if (condition) console.log('ok', label);
  else { console.error('FAIL', label); failures++; }
}

class FailingWorker {
  static instances = [];
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this.messages = [];
    FailingWorker.instances.push(this);
  }
  postMessage(message) { this.messages.push(message); }
  terminate() {}
}

const previousWorker = globalThis.Worker;
const previousWarn = console.warn;
globalThis.Worker = FailingWorker;
console.warn = () => {};

try {
  const occlusion = await import(`../src/renderer/occlusionWorkerPool.js?fallback=${Date.now()}`);
  const occlusionCalls = [];
  const job = {
    cv: new Float32Array(0),
    ranges: [{ begin: 0, end: 0 }, { begin: 0, end: 0 }],
    meta: new Float32Array(96),
    n: 2,
    stride: 48,
  };
  occlusion.requestOcclusionCull(job, (result) => occlusionCalls.push(result));
  occlusion.requestOcclusionCull(job, (result) => occlusionCalls.push(result));
  const occlusionWorker = FailingWorker.instances.at(-1);
  occlusionWorker.onerror({ message: 'expected failure' });
  await new Promise(resolve => setTimeout(resolve, 20));
  check('occlusion worker failure replays every queued callback once',
        occlusionCalls.length === 2);
  occlusion.disposeOcclusionWorker();

  const occupancy = await import(`../src/renderer/occupancyWorkerPool.js?fallback=${Date.now() + 1}`);
  const occupancyCalls = [];
  const occ = [{ base: 0, G: 1, segs: [], bbox: [0, 0, 1, 1], evenOdd: false }];
  occupancy.requestOccupancyBuild(occ, [], (result) => occupancyCalls.push(result));
  occupancy.requestOccupancyBuild(occ, [], (result) => occupancyCalls.push(result));
  const occupancyWorker = FailingWorker.instances.at(-1);
  occupancyWorker.onerror({ message: 'expected failure' });
  await new Promise(resolve => setTimeout(resolve, 20));
  check('occupancy worker failure replays every queued callback once',
        occupancyCalls.length === 2);
  occupancy.disposeOccupancyWorker();
} finally {
  console.warn = previousWarn;
  if (previousWorker === undefined) delete globalThis.Worker;
  else globalThis.Worker = previousWorker;
}

console.log();
if (failures) {
  console.error(`WORKER-FALLBACK FAIL (${failures})`);
  process.exit(1);
}
console.log('WORKER-FALLBACK PASS');
