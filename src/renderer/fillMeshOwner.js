// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Track which engine owns a bundle's shared fill meshes.
// Routing selects the engine; a live claim must be released before transfer.

/// Engines that can own a bundle's fill meshes.
export const MESH_OWNER = { LB: 'lb', CPATCH: 'cpatch', STREAM: 'stream' };

///
/// The only refusal is an engine overwriting a LIVE claim held by a different engine — live
/// meaning the holder actually produced geometry. A null/empty claim is free to take, which is
/// what makes an ordinary decline-and-fall-through work unchanged.
export function canClaimFillMeshes(bundle, owner) {
  if (!bundle) return false;
  const held = bundle._fillMeshOwner;
  if (!held || held === owner) return true;
  if (held === MESH_OWNER.CPATCH) return !((bundle._cpatchBuilt | 0) > 0);
  return !(bundle._lbMeshes && bundle._lbMeshes.length);
}

///
/// Returns true when the write happened. A refusal increments `_fillMeshStomps` and records the
/// pair that collided in `_fillMeshStompBy`, so a fight shows up in debugStats instead of as a
/// blank shape or an engine's timings filed under another engine's name.
export function claimFillMeshes(bundle, owner, meshes) {
  if (!bundle) return false;
  if (!canClaimFillMeshes(bundle, owner)) {
    bundle._fillMeshStomps = (bundle._fillMeshStomps | 0) + 1;
    bundle._fillMeshStompBy = owner + ' over ' + bundle._fillMeshOwner;
    return false;
  }
  bundle._lbMeshes = meshes;
  bundle._fillMeshOwner = meshes ? owner : null;
  return true;
}

/// Give up this engine's claim, so another may take the bundle. Called where an engine decides it
/// cannot serve the bundle — a decline is not a stomp, and must not be blocked like one.
export function releaseFillMeshes(bundle, owner) {
  if (!bundle) return;
  if (!bundle._fillMeshOwner || bundle._fillMeshOwner === owner) {
    if (owner === MESH_OWNER.CPATCH) {
      // Releasing CPatch also invalidates its success and attempt metadata,
      // so a later pin or automatic policy can prepare this generation again.
      bundle._cpatchAutoBuilt = false;
      bundle._cpatchAutoTriedGen = undefined;
      bundle._cpatchBuilt = 0;
      bundle._lbGen = -1;
    }
    bundle._lbMeshes = null;
    bundle._fillMeshOwner = null;
  }
}
