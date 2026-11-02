// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// features/frameExport.js — enables renderer.exportFrameSVG(): the recorded frame replayed through the native backend and
// serialized as SVG. Importing this module registers it; the renderer core does not carry it (it pulls in the native scene).
//
//   import '@kontek/mantle/renderer/features/frameExport';

import { exportFrameToSvg } from '../../fallback/frameExport.js';
import { registerRendererFeature } from '../featureRegistry.js';

export function registerFrameExport() {
  registerRendererFeature('frameExport', { exportFrameToSvg });
}
registerFrameExport();

export { exportFrameToSvg };
