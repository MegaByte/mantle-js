// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _laneBudget.mjs — how long a test may wait, given the lane's own per-test cap.
//
// SEPARATE FROM _launch.mjs ON PURPOSE, and the node lane is what forces it: `_launch` imports
// puppeteer, and `testLaneBackendSmoke` requires that no node-lane test can start a browser. The
// guard that checks this budget (renderTimeoutBudgetSmoke) runs in the NODE lane, because it reads
// source rather than rendering anything -- so the helper it verifies has to be importable without
// dragging a browser in behind it.
/// THE LONGEST A TEST MAY WAIT IN-PAGE, so that it outlives its wait and can say what went wrong.
///
/// `runRenderSmokes` SIGKILLs a test at `RENDER_TEST_TIMEOUT_MS` (180s by default) and passes that
/// value down. A test whose own `waitForFunction` timeout is LONGER than the cap can never reach
/// its catch branch: the kill lands first, the branch that prints the page's console errors never
/// runs, and the lane reports a bare "HUNG" with no cause.
///
/// The reserve is what the test needs AFTER the wait gives up: print the logs, close the browser,
/// close the server, exit. 20s is far more than that and still leaves 160s of waiting at the
/// default cap.
///
/// Standalone (no cap in the environment) it returns `fallback`, so running a test directly keeps
/// its own generous wait.
export function pageTimeoutFor(fallback = 280000, reserveMs = 20000) {
  const cap = +process.env.RENDER_TEST_TIMEOUT_MS;
  if (!(cap > 0)) return fallback;
  return Math.max(10000, cap - reserveMs);
}
