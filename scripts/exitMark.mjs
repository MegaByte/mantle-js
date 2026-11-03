// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Preloaded into each node-lane smoke by runNodeChecks: a smoke's process.exit tells the runner its code first, on fd 3.
// Node can deadlock inside process.exit when V8's background threads are mid-work (about 0.5% of runs at 8 at a time): every check has printed and the process sits at 0% CPU.
// The runner then has the smoke's own answer, and ends the process instead of timing it out and retrying.
import { writeSync } from 'node:fs';

const realExit = process.exit;
process.exit = function exit(code) {
  const c = code === undefined ? (process.exitCode ?? 0) : code;
  try {
    writeSync(3, String(c));
  } catch {
    /* run without the runner's pipe */
  }
  return realExit.call(process, c);
};
