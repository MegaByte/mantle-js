# pathBoolean — exact Bezier path boolean for Mantle

Status: **IN PROGRESS** (started 2026-05-27).

Used by the per-bundle silhouette extraction feature
(`importSvg({ computeSilhouette: true })`) + `opts.outline` on
`drawBundle`. Computes the **outer silhouette** of the union of all
filled paths in a bundle, preserving native SEG_LINE / SEG_QUAD /
SEG_CUBIC / SEG_ARC primitives through the operation.

No approximations, no sampling — every intersection is found
analytically.

## Architecture

```
union(paths) → outer-silhouette segments
   │
   ├─ subdivide each segment at its y-extrema (sweep needs y-monotone segs)
   ├─ run sweep-line over y, finding intersections between active segs
   │    └─ intersect/dispatch — 10 primitive-pair kernels
   ├─ build planar subdivision (DCEL: vertices, half-edges, faces)
   ├─ evaluate fill rule per face → "inside" set
   └─ traverse outer boundary of "inside" set → silhouette
```

## Files

- `intersect/lineLine.js` — 1 intersection, closed form.
- `intersect/lineQuad.js` — up to 2 (quadratic in t).
- `intersect/lineCubic.js` — up to 3 (cubic in t).
- `intersect/lineArc.js` — up to 2.
- `intersect/quadQuad.js` — up to 4 (resultant theory).
- `intersect/quadCubic.js` — up to 6.
- `intersect/quadArc.js` — up to 4.
- `intersect/cubicCubic.js` — up to 9 (Bezier clipping / fat-line).
- `intersect/cubicArc.js` — up to 6.
- `intersect/arcArc.js` — up to 4.
- `intersect/index.js` — type-pair dispatcher.

- `subdivide.js` — split at y-extrema + tangent-x points.

- `planar/halfEdge.js` — DCEL vertex/half-edge/face structures.
- `planar/sweep.js` — Bentley-Ottmann-style event loop with curved
  predicates (segment-above-segment via current-y evaluation).
- `planar/faces.js` — face traversal + fill-rule evaluation.

- `union.js` — entry point: `unionPaths(filledPaths) → silhouetteContour`.

## Build order (sliced for commits)

Each slice commits independently and is testable in isolation:

1. lineLine / lineQuad / lineCubic / lineArc kernels + smokes.
2. quadQuad / quadCubic / quadArc kernels + smokes.
3. cubicCubic via Bezier clipping + smokes.
4. cubicArc / arcArc kernels + smokes.
5. y-monotone subdivision preprocessor.
6. DCEL construction from intersection set.
7. Fill-rule evaluation + outer-boundary extraction.
8. Bundle-level wiring: `computeSilhouette` flag, storage.
9. Draw-time wiring: `opts.outline`.
10. Integration smoke on train SVG.

## Numerical notes

- All intersection kernels return `{ tA, tB, x, y }` records.
- Endpoint coincidences (`tA == 0/1` or `tB == 0/1`) are detected via
  the kernel and tagged so the sweep can short-circuit.
- The sweep uses an `EPS = 1e-9` for "same point" detection; this is
  expressed in em-space units. Bundles in unusual scales (very small
  em viewBox) may need an adjustable epsilon — TBD.
