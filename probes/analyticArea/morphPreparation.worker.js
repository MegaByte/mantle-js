// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { preparePolynomialMorph } from './morphPreparation.js';
import { prepareRadialPolynomialMorph } from './morphFanPreparation.js';
self.onmessage = ({ data }) => {
  try {
    if (data.declineReason) throw Error(data.declineReason);
    const prepared = data.options?.radialFan
      ? prepareRadialPolynomialMorph(data.sectionsA, data.sectionsB, data.options)
      : preparePolynomialMorph(data.sectionsA, data.sectionsB, data.options);
    self.postMessage({ ok: true, ...prepared });
  } catch (error) {
    self.postMessage({ ok: false, reason: String(error?.message || error) });
  }
};
