// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Helper of exitDeadlockRunnerSmoke: never returns from process.exit, as Node's exit deadlock does. The code it asks for comes from EXIT_FIXTURE_CODE.
const code = Number(process.env.EXIT_FIXTURE_CODE || 0);
process.on('exit', () => {
  const t = Date.now();
  while (Date.now() - t < 120000) {
    /* never returns in time */
  }
});
process.exit(code);
