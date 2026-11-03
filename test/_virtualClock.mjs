// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _virtualClock.mjs -- page time for the driver-model smokes: the wall clock, plus the time the page would have spent idle waiting for its next timer.
//
// The driver model (test/_pendingGl.mjs) completes links, pipeline builds and fences on performance.now(), and the renderer and the smokes wait
// for them on timers (a poll every few ms, a sleep between frames). On the wall clock such a smoke spends nearly all of its run asleep. Importing
// this module puts those timers on a clock the process owns: whenever the event loop has nothing left to do but wait for the next timer, the
// clock jumps to that timer's due time and runs it. A window keeps its length in page time -- a 120 ms pipeline is 120 ms of performance.now(),
// sleep(15000) lets 15 s of timers fire in order -- and the waiting costs no wall time. CPU work still moves the clock at the real rate, so a
// time budget (a loading step's 8 ms slice, a morph pass's budget) means what it means on a page.
//
// It replaces performance.now, Date.now, setTimeout / clearTimeout and setInterval / clearInterval, process-wide, when it is first imported.
// As in Node, each timer callback runs in its own macrotask with the microtask queue drained in between, a delay below 1 ms is 1 ms, timers that
// come due together run in due order and then in the order they were set, and an unref'd timer keeps nothing alive: while only unref'd timers
// are pending they run on the wall clock, so they fire only if something else keeps the process running.
//
// The jump is sound because nothing else can happen while the loop waits: in Node the renderer's worker pools run their work on the main thread
// (there is no Worker global), and the driver-model smokes read no file or socket asynchronously. A smoke that did wait on a worker thread, a child
// process or a socket would see its timers run ahead of that work.
//
// MANTLE_REAL_CLOCK=1 leaves everything on the wall clock, to compare a smoke's two runs.

const G = /** @type {any} */ (globalThis);
const KEY = Symbol.for('mantle.test.virtualClock');

function install() {
  if (typeof process !== 'undefined' && process.env && process.env.MANTLE_REAL_CLOCK === '1')
    return;
  const realPerfNow = performance.now.bind(performance),
    realDateNow = Date.now.bind(Date),
    realSetTimeout = G.setTimeout,
    realClearTimeout = G.clearTimeout,
    realSetImmediate = G.setImmediate;
  let ahead = 0; // the idle time skipped so far
  const now = () => realPerfNow() + ahead;
  performance.now = now;
  Date.now = () => Math.floor(realDateNow() + ahead);

  // The pending timers: a binary heap of entries ordered by (due, seq). A cleared or refreshed timer leaves its entry behind, marked stale by `gen`.
  const heap = [];
  let seq = 0,
    nextId = 1,
    refs = 0; // live timers that keep the process alive
  const less = (a, b) => a.due < b.due || (a.due === b.due && a.seq < b.seq);
  const push = (e) => {
    heap.push(e);
    for (let i = heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0],
      last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  const stale = (e) => !e.t.live || e.gen !== e.t.gen;
  const peek = () => {
    while (heap.length && stale(heap[0])) pop();
    return heap[0];
  };

  class Timeout {
    constructor(fn, args, ms, repeat) {
      this.id = nextId++;
      this.fn = fn;
      this.args = args;
      this.ms = ms;
      this.repeat = repeat;
      this.live = true;
      this.refed = true;
      this.gen = 0;
      refs++;
      this.schedule();
    }
    schedule() {
      push({ due: now() + this.ms, seq: seq++, t: this, gen: ++this.gen });
    }
    ref() {
      if (!this.refed && this.live) refs++;
      this.refed = true;
      arm();
      return this;
    }
    unref() {
      if (this.refed && this.live) refs--;
      this.refed = false;
      arm();
      return this;
    }
    hasRef() {
      return this.refed;
    }
    refresh() {
      if (!this.live) {
        // (as in Node: a timer that has fired runs again)
        this.live = true;
        if (this.refed) refs++;
        byId.set(this.id, this);
      }
      this.schedule();
      arm();
      return this;
    }
    close() {
      clear(this);
      return this;
    }
    [Symbol.toPrimitive]() {
      return this.id;
    }
  }
  const byId = new Map();
  const delay = (ms) => {
    const d = Number(ms);
    return d >= 1 && d <= 2147483647 ? d : 1;
  };
  const start = (fn, ms, args, repeat) => {
    if (typeof fn !== 'function')
      throw new TypeError('The "callback" argument must be of type function');
    const t = new Timeout(fn, args, delay(ms), repeat);
    byId.set(t.id, t);
    arm();
    return t;
  };
  const clear = (t) => {
    if (t == null) return;
    if (!(t instanceof Timeout)) {
      const own = byId.get(Number(t));
      if (!own) {
        if (typeof t === 'object') realClearTimeout(t); // a wall-clock timer set before this module loaded
        return;
      }
      t = own;
    }
    if (!t.live) return;
    t.live = false;
    if (t.refed) refs--;
    byId.delete(t.id);
    arm();
  };

  // One timer per macrotask turn. A turn runs from setImmediate, after the microtasks and the I/O poll: if the earliest timer is not due yet,
  // nothing else is going to happen before it, and the clock moves to it.
  let turnHandle = null,
    wallHandle = null;
  function arm() {
    const e = peek();
    if (turnHandle) {
      if (refs > 0) turnHandle.ref();
      else turnHandle.unref();
      return; // the turn already queued re-arms
    }
    if (wallHandle) {
      realClearTimeout(wallHandle);
      wallHandle = null;
    }
    if (!e) return;
    if (refs > 0 || e.due <= now()) {
      turnHandle = realSetImmediate(turn);
      if (refs === 0) turnHandle.unref();
    } else {
      // only unref'd timers are pending: they run on the wall clock and keep nothing alive
      wallHandle = realSetTimeout(turn, Math.max(1, Math.ceil(e.due - now())));
      wallHandle.unref();
    }
  }
  function turn() {
    turnHandle = null;
    wallHandle = null;
    const e = peek();
    if (!e) return;
    const t0 = now();
    if (e.due > t0) {
      if (refs === 0) {
        arm();
        return;
      }
      ahead += e.due - t0;
    }
    pop();
    const t = e.t;
    if (t.repeat) t.schedule();
    else {
      t.live = false;
      if (t.refed) refs--;
      byId.delete(t.id);
    }
    arm();
    t.fn.apply(t, t.args);
  }

  G.setTimeout = (fn, ms, ...args) => start(fn, ms, args, false);
  G.setInterval = (fn, ms, ...args) => start(fn, ms, args, true);
  G.clearTimeout = clear;
  G.clearInterval = clear;
}

if (!G[KEY]) {
  G[KEY] = true;
  install();
}
