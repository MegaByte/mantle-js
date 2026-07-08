// lbEarcut.js — Morton-indexed ear clipping with hole bridging.
//
// A port of mapbox/earcut (https://github.com/mapbox/earcut), ISC License,
// Copyright (c) 2016, Mapbox — adapted to Mantle's typed-array rims. The
// copyright and permission notice are preserved in the repository NOTICE
// file; see PROVENANCE.md §2a. Pure geometry: no imports, no module state.
// Consumed by the rim assembler (buildLoopBlinnMesh / refreshLoopBlinnMesh).

// ---- small geometry helpers ------------------------------------------------
const cross3 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);


// ---- O(n log n) z-order ear-clip triangulation (handles holes) -----
// Ear-clipping accelerated by a Morton (z-order) hash so the ear-containment
// test scans only points in the ear's z-range instead of all of them:
// O(n log n) overall vs the naive O(n²). Holes are bridged natively
// (eliminateHoles). Doubly-linked-list nodes carry the original vertex index
// `i` so the triangle output indexes back into the flat coords. Robustness:
// cure local self-intersections, then recursive split.
function Node(i, x, y) {
  return { i, x, y, prev: null, next: null, z: 0, prevZ: null, nextZ: null, steiner: false };
}
function llInsert(i, x, y, last) {
  const p = Node(i, x, y);
  if (!last) { p.prev = p; p.next = p; }
  else { p.next = last.next; p.prev = last; last.next.prev = p; last.next = p; }
  return p;
}
function llRemove(p) {
  p.next.prev = p.prev; p.prev.next = p.next;
  if (p.prevZ) p.prevZ.nextZ = p.nextZ;
  if (p.nextZ) p.nextZ.prevZ = p.prevZ;
}
// Build a linked-list ring from coords[start..end) (each entry [x,y]) in the
// orientation earcut needs (outer convex vertices test as area<0). `ccw` is
// earcut's `clockwise` param: true for the outer ring, false for holes. Insert
// FORWARD when `ccw === (signedArea>0)`, else REVERSE (matches earcut.js).
function buildRing(coords, start, end, ccw, last) {
  let area = 0;
  for (let i = start, j = end - 1; i < end; j = i++) {
    area += (coords[j][0] - coords[i][0]) * (coords[i][1] + coords[j][1]);
  }
  if (ccw === (area > 0)) {
    for (let i = start; i < end; i++) last = llInsert(i, coords[i][0], coords[i][1], last);
  } else {
    for (let i = end - 1; i >= start; i--) last = llInsert(i, coords[i][0], coords[i][1], last);
  }
  if (last && eqNode(last, last.next)) { const n = last.next; llRemove(last); last = n; }
  return last;
}
const eqNode = (a, b) => a.x === b.x && a.y === b.y;
function triArea(a, b, c) { return (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y); }
function pInTri(ax, ay, bx, by, cx, cy, px, py) {
  return (cx - px) * (ay - py) - (ax - px) * (cy - py) >= 0 &&
         (ax - px) * (by - py) - (bx - px) * (ay - py) >= 0 &&
         (bx - px) * (cy - py) - (cx - px) * (by - py) >= 0;
}
function zOrder(x, y, minX, minY, invSize) {
  x = (x - minX) * invSize | 0; y = (y - minY) * invSize | 0;
  x = (x | (x << 8)) & 0x00FF00FF; x = (x | (x << 4)) & 0x0F0F0F0F; x = (x | (x << 2)) & 0x33333333; x = (x | (x << 1)) & 0x55555555;
  y = (y | (y << 8)) & 0x00FF00FF; y = (y | (y << 4)) & 0x0F0F0F0F; y = (y | (y << 2)) & 0x33333333; y = (y | (y << 1)) & 0x55555555;
  return x | (y << 1);
}
function indexCurve(start, minX, minY, invSize) {
  let p = start;
  do { if (p.z === 0) p.z = zOrder(p.x, p.y, minX, minY, invSize); p.prevZ = p.prev; p.nextZ = p.next; p = p.next; } while (p !== start);
  p.prevZ.nextZ = null; p.prevZ = null;
  sortLinked(p);
}
function sortLinked(list) {           // merge sort the z-linked list
  let inSize = 1, numMerges;
  do {
    let p = list, e; list = null; let tail = null; numMerges = 0;
    while (p) {
      numMerges++; let q = p, pSize = 0;
      for (let i = 0; i < inSize; i++) { pSize++; q = q.nextZ; if (!q) break; }
      let qSize = inSize;
      while (pSize > 0 || (qSize > 0 && q)) {
        if (pSize !== 0 && (qSize === 0 || !q || p.z <= q.z)) { e = p; p = p.nextZ; pSize--; }
        else { e = q; q = q.nextZ; qSize--; }
        if (tail) tail.nextZ = e; else list = e;
        e.prevZ = tail; tail = e;
      }
      p = q;
    }
    tail.nextZ = null; inSize *= 2;
  } while (numMerges > 1);
  return list;
}
function isEar(ear) {
  const a = ear.prev, b = ear, c = ear.next;
  if (triArea(a, b, c) >= 0) return false;     // reflex
  let p = ear.next.next;
  while (p !== ear.prev) {
    if (pInTri(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) && triArea(p.prev, p, p.next) >= 0) return false;
    p = p.next;
  }
  return true;
}
function isEarHashed(ear, minX, minY, invSize) {
  const a = ear.prev, b = ear, c = ear.next;
  if (triArea(a, b, c) >= 0) return false;
  const minTX = Math.min(a.x, b.x, c.x), minTY = Math.min(a.y, b.y, c.y);
  const maxTX = Math.max(a.x, b.x, c.x), maxTY = Math.max(a.y, b.y, c.y);
  const minZ = zOrder(minTX, minTY, minX, minY, invSize), maxZ = zOrder(maxTX, maxTY, minX, minY, invSize);
  let p = ear.prevZ, n = ear.nextZ;
  while (p && p.z >= minZ && n && n.z <= maxZ) {
    if (p !== a && p !== c && pInTri(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) && triArea(p.prev, p, p.next) >= 0) return false;
    p = p.prevZ;
    if (n !== a && n !== c && pInTri(a.x, a.y, b.x, b.y, c.x, c.y, n.x, n.y) && triArea(n.prev, n, n.next) >= 0) return false;
    n = n.nextZ;
  }
  while (p && p.z >= minZ) {
    if (p !== a && p !== c && pInTri(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) && triArea(p.prev, p, p.next) >= 0) return false;
    p = p.prevZ;
  }
  while (n && n.z <= maxZ) {
    if (n !== a && n !== c && pInTri(a.x, a.y, b.x, b.y, c.x, c.y, n.x, n.y) && triArea(n.prev, n, n.next) >= 0) return false;
    n = n.nextZ;
  }
  return true;
}
function earcutLinked(ear, tris, minX, minY, invSize, pass) {
  if (!ear) return;
  if (!pass && invSize) indexCurve(ear, minX, minY, invSize);
  let stop = ear, prev, next;
  while (ear.prev !== ear.next) {
    prev = ear.prev; next = ear.next;
    if (invSize ? isEarHashed(ear, minX, minY, invSize) : isEar(ear)) {
      tris.push(prev.i, ear.i, next.i);
      llRemove(ear);
      ear = next.next; stop = next.next;
      continue;
    }
    ear = next;
    if (ear === stop) {                 // no ear found — escalate fixups
      if (!pass) earcutLinked(filterPoints(ear), tris, minX, minY, invSize, 1);
      else if (pass === 1) { ear = cureLocal(filterPoints(ear), tris); earcutLinked(ear, tris, minX, minY, invSize, 2); }
      else if (pass === 2) splitEarcut(ear, tris, minX, minY, invSize);
      break;
    }
  }
}
function filterPoints(start, end) {
  if (!start) return start;
  if (!end) end = start;
  let p = start, again;
  do {
    again = false;
    if (!p.steiner && (eqNode(p, p.next) || triArea(p.prev, p, p.next) === 0)) {
      llRemove(p); p = end = p.prev;
      if (p === p.next) break;
      again = true;
    } else p = p.next;
  } while (again || p !== end);
  return end;
}
function cureLocal(start, tris) {       // cut off self-intersecting ear pairs
  let p = start;
  do {
    const a = p.prev, b = p.next.next;
    if (!eqNode(a, b) && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      tris.push(a.i, p.i, b.i);
      llRemove(p); llRemove(p.next);
      p = start = b;
    }
    p = p.next;
  } while (p !== start);
  return filterPoints(p);
}
function splitEarcut(start, tris, minX, minY, invSize) {
  let a = start;
  do {
    let b = a.next.next;
    while (b !== a.prev) {
      if (a.i !== b.i && splitOK(a, b)) {
        let c = splitPolygon(a, b);
        a = filterPoints(a, a.next); c = filterPoints(c, c.next);
        earcutLinked(a, tris, minX, minY, invSize, 0);
        earcutLinked(c, tris, minX, minY, invSize, 0);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
}
function splitOK(a, b) {
  return a.next.i !== b.i && a.prev.i !== b.i && !intersectsPolygon(a, b) &&
         (locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) &&
          (triArea(a.prev, a, b.prev) !== 0 || triArea(a, b.prev, b) !== 0) ||
          eqNode(a, b) && triArea(a.prev, a, a.next) > 0 && triArea(b.prev, b, b.next) > 0);
}
function splitPolygon(a, b) {
  const a2 = Node(a.i, a.x, a.y), b2 = Node(b.i, b.x, b.y), an = a.next, bp = b.prev;
  a.next = b; b.prev = a; a2.next = an; an.prev = a2; b2.next = a2; a2.prev = b2; bp.next = b2; b2.prev = bp;
  return b2;
}
const sign = v => v > 0 ? 1 : v < 0 ? -1 : 0;
function onSeg(p, q, r) { return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y); }
function intersects(p1, q1, p2, q2) {
  const o1 = sign(triArea(p1, q1, p2)), o2 = sign(triArea(p1, q1, q2)), o3 = sign(triArea(p2, q2, p1)), o4 = sign(triArea(p2, q2, q1));
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSeg(p1, p2, q1)) return true;
  if (o2 === 0 && onSeg(p1, q2, q1)) return true;
  if (o3 === 0 && onSeg(p2, p1, q2)) return true;
  if (o4 === 0 && onSeg(p2, q1, q2)) return true;
  return false;
}
function intersectsPolygon(a, b) {
  let p = a;
  do {
    if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && intersects(p, p.next, a, b)) return true;
    p = p.next;
  } while (p !== a);
  return false;
}
function locallyInside(a, b) {
  return triArea(a.prev, a, a.next) < 0
    ? triArea(a, b, a.next) >= 0 && triArea(a, a.prev, b) >= 0
    : triArea(a, b, a.prev) < 0 || triArea(a, a.next, b) < 0;
}
function middleInside(a, b) {
  let p = a, inside = false; const px = (a.x + b.x) / 2, py = (a.y + b.y) / 2;
  do {
    if (((p.y > py) !== (p.next.y > py)) && p.next.y !== p.y && (px < (p.next.x - p.x) * (py - p.y) / (p.next.y - p.y) + p.x)) inside = !inside;
    p = p.next;
  } while (p !== a);
  return inside;
}
// bridge each hole ring into the outer ring (rightmost-point visibility).
function eliminateHoles(coords, holeStarts, outerNode) {
  const queue = [];
  for (let h = 0; h < holeStarts.length; h++) {
    const start = holeStarts[h], end = h + 1 < holeStarts.length ? holeStarts[h + 1] : coords.length;
    const list = buildRing(coords, start, end, false, null);
    if (list === list.next) list.steiner = true;
    queue.push(getLeftmost(list));
  }
  queue.sort((a, b) => a.x - b.x);
  for (const hole of queue) outerNode = eliminateHole(hole, outerNode);
  return outerNode;
}
function getLeftmost(start) { let p = start, leftmost = start; do { if (p.x < leftmost.x || (p.x === leftmost.x && p.y < leftmost.y)) leftmost = p; p = p.next; } while (p !== start); return leftmost; }
function eliminateHole(hole, outerNode) {
  const bridge = findHoleBridge(hole, outerNode);
  if (!bridge) return outerNode;
  const b2 = splitPolygon(bridge, hole);
  filterPoints(b2, b2.next);
  return filterPoints(bridge, bridge.next);
}
function findHoleBridge(hole, outerNode) {
  let p = outerNode, qx = -Infinity, m = null;
  const hx = hole.x, hy = hole.y;
  do {                                  // find the rightmost outer edge left of the hole
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + (hy - p.y) / (p.next.y - p.y) * (p.next.x - p.x);
      if (x <= hx && x > qx) { qx = x; m = p.x < p.next.x ? p : p.next; }
    }
    p = p.next;
  } while (p !== outerNode);
  if (!m) return null;
  const stop = m; let tanMin = Infinity; const mx = m.x, my = m.y;
  p = m;
  do {                                  // pick the bridge vertex with min tangent inside the cone
    if (hx >= p.x && p.x >= mx && hx !== p.x &&
        pInTri(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) {
      const tan = Math.abs(hy - p.y) / (hx - p.x);
      if (locallyInside(p, hole) && (tan < tanMin || (tan === tanMin && (p.x > m.x || (p.x === m.x && sectorContains(m, p)))))) { m = p; tanMin = tan; }
    }
    p = p.next;
  } while (p !== stop);
  return m;
}
function sectorContains(m, p) {
  return triArea(m.prev, m, p.prev) < 0 && triArea(p.next, m, m.next) < 0;
}
// Triangulate flat [x,y] coords with optional hole start indices →
// flat triangle index array.
export function earcut(coords, holeStarts) {
  const outerEnd = holeStarts && holeStarts.length ? holeStarts[0] : coords.length;
  let outerNode = buildRing(coords, 0, outerEnd, true, null);
  const tris = [];
  if (!outerNode || outerNode.next === outerNode.prev) return tris;
  if (holeStarts && holeStarts.length) outerNode = eliminateHoles(coords, holeStarts, outerNode);
  let minX, minY, invSize = 0;
  if (coords.length > 80) {
    minX = Infinity; minY = Infinity; let maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < coords.length; i++) { const x = coords[i][0], y = coords[i][1]; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
    invSize = Math.max(maxX - minX, maxY - minY); invSize = invSize !== 0 ? 32767 / invSize : 0;
  }
  earcutLinked(outerNode, tris, minX, minY, invSize, 0);
  return tris;
}

export function pointInTri(p, a, b, c) {
  const d1 = cross3(p, a, b), d2 = cross3(p, b, c), d3 = cross3(p, c, a);
  const neg = (d1 < 0) || (d2 < 0) || (d3 < 0), pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(neg && pos);
}
