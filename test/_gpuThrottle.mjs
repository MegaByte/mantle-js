// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _gpuThrottle.mjs -- the GPU throttle every timing harness takes.
//
// WHY. An unthrottled WebGL timing loop -- hundreds of draws per sample, samples back to back, a fresh Chrome per
// config -- can take down the macOS WindowServer and freeze the machine. Chromium's GPU process on Metal shares the GPU
// with the compositor, and a harness that keeps it busy 100% of the time starves the display.
//
// THE RULE. After a timed sample that kept the GPU busy for `busy` ms, idle for busy * (1 - duty) / duty ms, plus a fixed
// rest. The idle starts after the sample's clock has stopped, so it changes no reading, only the wall time. A sample that
// would run long is split into bursts of at most MANTLE_GPU_BURST_MS, each followed by its own idle, so no single burst
// holds the GPU for seconds.
//
//   MANTLE_GPU_DUTY            target duty cycle, 0 < d <= 1 (default 0.5: idle as long as the sample took)
//   MANTLE_GPU_SAMPLE_REST_MS  fixed rest after every sample, ms (default 16, one display frame)
//   MANTLE_GPU_BURST_MS        the longest a harness may keep the GPU busy without an idle, ms (default 250)
//   MANTLE_GPU_WALL_MS         wall-clock cap for one probe run, ms (default 300000); past it the probe says so, closes
//                              its browser and exits with code 3
//
// A harness installs the page half once per page (installGpuThrottle(page)) and calls window.__gpuIdle(busyMs) after each
// timed sample, OUTSIDE the timed region; window.__gpuFrames(n, drawOne, sync) times n frames in bursts. The node half is
// capWallTime(label, stop) and gpuThrottleBanner(), which every harness prints so its output says it was throttled.

const num = (v, d) => {
  const x = +v;
  return Number.isFinite(x) ? x : d;
};
export const GPU_DUTY = Math.min(1, Math.max(0.05, num(process.env.MANTLE_GPU_DUTY, 0.5)));
export const GPU_SAMPLE_REST_MS = Math.max(0, num(process.env.MANTLE_GPU_SAMPLE_REST_MS, 16));
export const GPU_BURST_MS = Math.max(10, num(process.env.MANTLE_GPU_BURST_MS, 250));
export const GPU_WALL_MS = Math.max(1000, num(process.env.MANTLE_GPU_WALL_MS, 300000));

/** The idle owed after a sample that kept the GPU busy for `busyMs`. */
export const gpuIdleMsAfter = (busyMs) =>
  (Math.max(0, busyMs) * (1 - GPU_DUTY)) / GPU_DUTY + GPU_SAMPLE_REST_MS;

/** Node-side idle, for a harness whose timed sample is one page.evaluate. */
export const gpuIdle = (busyMs) => new Promise((r) => setTimeout(r, gpuIdleMsAfter(busyMs)));

export function gpuThrottleBanner() {
  return (
    `gpu throttle: duty <= ${GPU_DUTY} (idle = busy * ${((1 - GPU_DUTY) / GPU_DUTY).toFixed(2)} + ${GPU_SAMPLE_REST_MS} ms after ` +
    `every sample, outside the timed region), bursts <= ${GPU_BURST_MS} ms, wall cap ${(GPU_WALL_MS / 1000).toFixed(0)} s`
  );
}

/// The page half, as source: evaluate it in the page (installGpuThrottle) or paste it into a module script.
///   window.__gpuIdle(busyMs)   the idle owed after a sample; resolves when it is over
///   window.__gpuFrames(n, drawOne, sync, opt)
///                              time n frames in bursts of at most GPU_BURST_MS: drawOne(i) issues frame i, sync() awaits
///                              the GPU (a fence or a 1-px readback); each burst is followed by its idle. Returns
///                              { ms, bursts }, where ms is the SUM of the bursts' own times (no idle in it). opt is a
///                              number (minBurst) or { minBurst, firstBurst, begin, end }:
///                                firstBurst  frames in the first burst, which learns the per-frame cost (default 4);
///                                            later bursts are sized from it
///                                minBurst    no burst shorter than this (a renderer that counts consecutive fast
///                                            frames needs them unbroken) -- but only while that many frames fit in
///                                            4 x GPU_BURST_MS: a slow frame never counts as a fast one, and 64 frames
///                                            of 117 ms would hold the GPU for 7.5 s. Never applied to the first burst
///                                begin(b)    called before burst b's clock starts (e.g. beginQuery)
///                                end(ms, k)  awaited after burst b's clock stopped and before its idle (e.g. read
///                                            the query); neither is timed
///   window.__gpuDuty()         { busy, idle } totals so far, for the harness to print its real duty
///   window.__gpuFence(gl, maxMs)
///                              flush, then wait on a fence until the GPU has retired everything issued, polling with a
///                              MessageChannel yield and giving up after maxMs (default 15000); resolves true when it
///                              signaled. NOT a setTimeout poll: once a harness idles on a timer every later poll is a
///                              nested timer, which Chrome clamps to 4 ms, and a burst-split sample pays that per burst.
///   window.__gpuYield()        the MessageChannel yield itself
export function gpuThrottlePageSource() {
  return `(() => {
  const DUTY = ${GPU_DUTY}, REST = ${GPU_SAMPLE_REST_MS}, BURST = ${GPU_BURST_MS};
  let busyT = 0, idleT = 0;
  window.__gpuIdle = (busy) => { const ms = Math.max(0, busy) * (1 - DUTY) / DUTY + REST; busyT += Math.max(0, busy); idleT += ms;
    return new Promise((r) => setTimeout(r, ms)); };
  window.__gpuDuty = () => ({ busy: busyT, idle: idleT });
  const mc = new MessageChannel(), waiting = [];
  mc.port1.onmessage = () => { const r = waiting.shift(); if (r) r(); };
  window.__gpuYield = () => new Promise((r) => { waiting.push(r); mc.port2.postMessage(0); });
  window.__gpuFence = async (gl, maxMs) => {
    const f = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
    if (!f) { gl.finish(); return false; }
    const tEnd = performance.now() + (maxMs > 0 ? maxMs : 15000); let ok = false;
    for (;;) {
      const st = gl.clientWaitSync(f, 0, 0);
      if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) { ok = true; break; }
      if (st === gl.WAIT_FAILED || performance.now() > tEnd) break;
      await window.__gpuYield();
    }
    gl.deleteSync(f);
    return ok;
  };
  window.__gpuBurstMs = BURST;
  window.__gpuFrames = async (n, drawOne, sync, opt) => {
    const o = typeof opt === 'number' ? { minBurst: opt } : (opt || {});
    const minBurst = o.minBurst | 0, first = o.firstBurst > 0 ? o.firstBurst | 0 : 4;
    let done = 0, total = 0, bursts = 0;
    while (done < n) {
      const per = done ? total / done : 0;
      let k = done ? Math.floor(BURST / Math.max(per, 0.01)) : first;
      if (done && minBurst > k && per * minBurst <= 4 * BURST) k = minBurst;
      k = Math.max(1, Math.min(n - done, k));
      if (o.begin) o.begin(bursts);
      const t0 = performance.now();
      for (let i = 0; i < k; i++) drawOne(done + i);
      await sync();
      const ms = performance.now() - t0;
      total += ms; done += k; bursts++;
      if (o.end) await o.end(ms, k);
      await window.__gpuIdle(ms);
    }
    return { ms: total, bursts };
  };
})();`;
}

/** Install the page half into a puppeteer page (after navigation). */
export async function installGpuThrottle(page) {
  await page.evaluate(gpuThrottlePageSource());
}

/// The wall-clock cap. `stop` closes what the harness opened (browser, server); past GPU_WALL_MS the probe prints why,
/// runs it, and exits 3. The timer is unref'd, so a probe that finishes early exits normally; call clear() when done.
export function capWallTime(label, stop, capMs = GPU_WALL_MS) {
  const t = setTimeout(async () => {
    console.error(
      `\n${label}: WALL CAP ${(capMs / 1000).toFixed(0)} s reached (MANTLE_GPU_WALL_MS) -- stopping; results above are complete, the rest was not run`,
    );
    // Closing the browser rejects whatever the probe was awaiting; exit 3 on that, not a stack trace and exit 1.
    process.on('unhandledRejection', () => process.exit(3));
    process.on('uncaughtException', () => process.exit(3));
    try {
      await Promise.race([stop(), new Promise((r) => setTimeout(r, 10000))]);
    } catch {
      /* closing anyway */
    }
    process.exit(3);
  }, capMs);
  if (t.unref) t.unref();
  return { clear: () => clearTimeout(t) };
}
