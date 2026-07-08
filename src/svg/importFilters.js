// svg/importFilters.js — filter graph + filterTab emission.

/// Build filterTab, filterGraphs, and kernelTab from claimed filter records.
export function buildFilterSections(filtersUsed) {
  const filterFloats = [];
  const kernelFloats = [];  // 25 floats per kind=6 entry (5×5 max kernel)
  let convolveRow = 0;
  // Parallel CPU-only array of filter graphs. Entry N corresponds to
  // filterId N+1 (matching filtersUsed[N]). Null when the filter uses
  // the single-kind fast path. The renderer prefers filterGraphId
  // when set; the filter table entry is a no-op fallback in that case.
  const filterGraphsArr = [];
  for (let fi = 0; fi < filtersUsed.length; fi++) {
    const f = filtersUsed[fi];
    const m = f.matrix;
    // Capture graph if present; emit a no-op (identity color-matrix)
    // into the kind table so existing indexing still works. The
    // renderer's filterGraphId branch fires before the kind branch.
    if (f.kind === 'graph') {
      filterGraphsArr.push(f.graph);
      // identity 4×5 matrix
      filterFloats.push(1, 0, 0, 0);   // t0
      filterFloats.push(0, 1, 0, 0);   // t1
      filterFloats.push(0, 0, 1, 0);   // t2
      filterFloats.push(0, 0, 0, 1);   // t3
      filterFloats.push(0, 0, 0, 0);   // t4 offsets
      filterFloats.push(0, 0, 0, 0);   // t5 kind=0 identity
      continue;
    }
    filterGraphsArr.push(null);
    // Layout per filter (6 texels = 24 floats):
    //   t5 = (kind, sigmaX, sigmaY, _pad). kind:
    //          0 = color matrix only
    //          1 = Gaussian blur (then color matrix)
    //          5 = morphology (erode / dilate)
    //          6 = convolveMatrix
    //   (multi-pass effects like drop-shadow run as composable fe-graphs.)
    //
    // For kinds 0/1 (kind <= 1), texels 0..3 are the color matrix,
    // texel 4 is the matrix offset column.
    // For kind=5 (morphology):
    //   t0 = (operator, _, _, _) — operator: 0=erode, 1=dilate
    //   t1..t4 = reserved (zero)
    //   t5.yz reuses sigma slots for (radiusX, radiusY) in em units.
    // For kind=6 (convolveMatrix):
    //   t0 = (orderX, orderY, targetX, targetY)
    //   t1 = (divisor, bias, edgeMode, preserveAlpha)
    //   t2 = (kernelRow, _, _, _)
    //   t3..t4 = reserved (zero)
    let kind = 0;
    if (f.kind === 'blur')            kind = 1;
    else if (f.kind === 'morphology') kind = 5;
    else if (f.kind === 'convolve')   kind = 6;
    if (kind === 5) {
      filterFloats.push(f.operator || 0, 0, 0, 0);   // t0 (operator)
      filterFloats.push(0, 0, 0, 0);                 // t1
      filterFloats.push(0, 0, 0, 0);                 // t2
      filterFloats.push(0, 0, 0, 0);                 // t3
      filterFloats.push(0, 0, 0, 0);                 // t4
      // t5: (kind, radiusX, radiusY, _pad)
      filterFloats.push(kind, f.radiusX || 0, f.radiusY || 0, 0);
    } else if (kind === 6) {
      // Stash the kernel row index in t2.x; kernel itself goes into
      // kernelFloats (one 25-float entry per convolve filter).
      filterFloats.push(f.orderX || 3, f.orderY || 3, f.targetX || 0, f.targetY || 0); // t0
      filterFloats.push(f.divisor || 1, f.bias || 0, f.edgeMode || 0, f.preserveAlpha || 0); // t1
      filterFloats.push(convolveRow, 0, 0, 0);  // t2
      filterFloats.push(0, 0, 0, 0);             // t3
      filterFloats.push(0, 0, 0, 0);             // t4
      filterFloats.push(kind, 0, 0, 0);          // t5
      // Append the 25 kernel floats (parser padded to 25 already).
      for (let i = 0; i < 25; i++) kernelFloats.push(f.kernel[i] || 0);
      convolveRow++;
    } else {
      for (let r = 0; r < 4; r++) {
        filterFloats.push(m[r*5+0], m[r*5+1], m[r*5+2], m[r*5+3]);
      }
      filterFloats.push(m[0*5+4], m[1*5+4], m[2*5+4], m[3*5+4]);
      filterFloats.push(kind, f.sigmaX || 0, f.sigmaY || 0, 0);
    }
  }
  const filtersB = new Uint8Array(new Float32Array(filterFloats).buffer);
  const kernelTab = kernelFloats.length
    ? new Float32Array(kernelFloats).buffer.slice(0)
    : null;
  return {
    filtersB,
    filterGraphsArr,
    kernelTab,
  };
}
