# probes/analyticArea

Accuracy studies for the analytic-area fill: scene and case generators, the independent area and
ordered-paint oracles, and the GPU page (`gpu.mjs`, `gpuPage.js`).

## Prepared AAC is not a package route

Prepared static monotone AAC (`analyticArea`, extrema splitting, `MANTLE_AREA_MONOTONE`) and
prepared morph radial-fan AAC (offscreen R16F resolve) lose to raw AAC at the same accuracy under
the balanced protocol, with extra shader-link stalls, import time, and rotation breakage. The live
harness does not inject the monotone variant and does not require the candidate to engage.

The package uses fill normalization (`normalizedFillSegs`, `certifySimplePolynomialPaint`,
native-arc certification) on raw AAC, AAC points, and Slug.

## Results are not tracked

`results/` holds the studies' evidence archives (`*.tar.gz`, `*.tar.xz`) and raw result JSON:
generated output, hundreds of megabytes. Like the other probes' output folders (`/probes/*Out/`), it
is gitignored and regenerated on demand. What is tracked in `results/` is the small verifier scripts
(`*.py`), the held patches and the `*.verified.json` receipts.

The `verify*Archive.py` scripts in this folder check an archive in place once it is in `results/`.
Archives written here stay local.
