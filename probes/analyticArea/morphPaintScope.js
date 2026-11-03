// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// The piece resolver composites the original paints before this one outer
// opacity. More than one compositing scope needs a different resolve plan.
export function flatMorphPaintSvg(svg) {
  if (/<(?:mask|clipPath|filter|image|use|style)\b/.test(svg))
    throw Error('Morph prototype requires flat solid fills without CSS scopes');
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml'),
    root = doc.documentElement;
  const children = Array.from(root.childNodes).filter((n) => n.nodeType === 1);
  const outer = children.length === 1 && children[0].localName === 'g' ? children[0] : null;
  let alpha = 1,
    changed = false;
  if (outer?.hasAttribute('opacity')) {
    alpha = +outer.getAttribute('opacity');
    outer.removeAttribute('opacity');
    changed = true;
  }
  if (!(alpha >= 0 && alpha <= 1)) throw Error('Invalid whole-group opacity');
  for (const node of [root, ...Array.from(doc.getElementsByTagName('g'))]) {
    if (
      (node.hasAttribute('opacity') && +node.getAttribute('opacity') !== 1) ||
      /(?:^|;)\s*opacity\s*:/.test(node.getAttribute('style') || '')
    )
      throw Error('Nested/subset/root opacity needs another resolve');
  }
  return { svg: changed ? new XMLSerializer().serializeToString(doc) : svg, alpha, changed };
}
export function morphPieceDrawScope(options) {
  if (options && Object.keys(options).some((k) => k !== 'alpha' && k !== 'worldMatrix'))
    throw Error('Morph pieces support alpha and affine worldMatrix only');
  const M = options?.worldMatrix;
  if (
    M &&
    (M.length !== 9 || M.some((v) => !Number.isFinite(v)) || M[2] !== 0 || M[5] !== 0 || M[8] !== 1)
  )
    throw Error('Morph pieces require an affine worldMatrix');
}
