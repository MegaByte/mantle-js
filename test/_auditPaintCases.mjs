// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import * as M from '../src/index.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const PAIRS = [
  {
    id: 'plus-lighter',
    name: 'plus-lighter-group-visible',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="white" opacity=".6"/><g opacity=".35" style="mix-blend-mode:plus-lighter"><rect width="64" height="64" fill="white"/></g></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="white" opacity=".95"/></svg>',
  },
  {
    id: 'plus-lighter',
    name: 'plus-lighter-group-alpha',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><mask id="m" mask-type="alpha"><rect width="64" height="64" fill="white" opacity=".6"/><g opacity=".35" style="mix-blend-mode:plus-lighter"><rect width="64" height="64" fill="white"/></g></mask></defs><rect width="64" height="64" fill="white" mask="url(#m)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="white" opacity=".95"/></svg>',
  },
  {
    id: 'plus-lighter',
    name: 'plus-lighter-leaf-visible',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="white" opacity=".6"/><rect width="64" height="64" fill="white" opacity=".35" style="mix-blend-mode:plus-lighter"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="white" opacity=".95"/></svg>',
  },
  {
    id: 'plus-lighter',
    name: 'plus-lighter-leaf-alpha',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><mask id="m" mask-type="alpha"><rect width="64" height="64" fill="white" opacity=".6"/><rect width="64" height="64" fill="white" opacity=".35" style="mix-blend-mode:plus-lighter"/></mask></defs><rect width="64" height="64" fill="white" mask="url(#m)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="white" opacity=".95"/></svg>',
  },
  {
    id: 'non-scaling-stroke',
    name: 'nss-pixel-unit-reference',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M8 0H24" transform="matrix(2 0 0 1 0 32.25)" fill="none" stroke="red" stroke-width="8" vector-effect="non-scaling-stroke" stroke-dasharray="8 4"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M16 32.25H48" fill="none" stroke="red" stroke-width="4" stroke-dasharray="4 2"/></svg>',
  },
  {
    id: 'resource-validity',
    name: 'partial-recursive-pattern',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><pattern id="p" width="64" height="64" patternUnits="userSpaceOnUse"><rect width="32" height="64" fill="red"/><rect x="32" width="32" height="64" fill="url(#p)"/></pattern></defs><rect width="64" height="64" fill="url(#p)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="32" height="64" fill="red"/></svg>',
  },
  {
    id: 'resource-validity',
    name: 'pattern-carrier-opacity',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><pattern id="p" width="64" height="64" patternUnits="userSpaceOnUse"><rect width="64" height="64" fill="red"/></pattern></defs><rect width="64" height="64" fill="url(#p)" opacity=".4"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="red" opacity=".4"/></svg>',
  },
  {
    id: 'non-scaling-stroke',
    name: 'nss-uniform-0-direct',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g style="stroke-dasharray:8 4;stroke-dashoffset:0"><path d="M8 0H24" transform="matrix(2 0 0 2 0 32.25)" fill="none" stroke="white" stroke-width="8" vector-effect="non-scaling-stroke"/></g></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g style="stroke-dasharray:8 4;stroke-dashoffset:0"><path d="M16 32.25H48" transform="matrix(1 0 0 1 0 0)" fill="none" stroke="white" stroke-width="8" vector-effect="non-scaling-stroke"/></g></svg>',
  },
  {
    id: 'non-scaling-stroke',
    name: 'nss-uniform-3-pattern',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><pattern id="p" width="64" height="64" patternUnits="userSpaceOnUse"><g style="stroke-dasharray:8 4;stroke-dashoffset:3"><path d="M8 0H24" transform="matrix(2 0 0 2 0 32.25)" fill="none" stroke="white" stroke-width="8" vector-effect="non-scaling-stroke"/></g></pattern></defs><rect width="64" height="64" fill="url(#p)" opacity=".6"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><pattern id="p" width="64" height="64" patternUnits="userSpaceOnUse"><g style="stroke-dasharray:8 4;stroke-dashoffset:3"><path d="M16 32.25H48" transform="matrix(1 0 0 1 0 0)" fill="none" stroke="white" stroke-width="8" vector-effect="non-scaling-stroke"/></g></pattern></defs><rect width="64" height="64" fill="url(#p)" opacity=".6"/></svg>',
  },
  {
    id: 'non-scaling-stroke',
    name: 'nss-horizontal-0-direct',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g style="stroke-dasharray:8 4;stroke-dashoffset:0"><path d="M8 0H24" transform="matrix(2 0 0 1 0 32.25)" fill="none" stroke="white" stroke-width="8" vector-effect="non-scaling-stroke"/></g></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g style="stroke-dasharray:8 4;stroke-dashoffset:0"><path d="M16 32.25H48" transform="matrix(1 0 0 1 0 0)" fill="none" stroke="white" stroke-width="8" vector-effect="non-scaling-stroke"/></g></svg>',
  },
  {
    id: 'non-scaling-stroke',
    name: 'nss-horizontal--3-mask',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><mask id="m" mask-type="alpha"><g style="stroke-dasharray:8 4;stroke-dashoffset:-3"><path d="M8 0H24" transform="matrix(2 0 0 1 0 32.25)" fill="none" stroke="white" stroke-width="8" vector-effect="non-scaling-stroke"/></g></mask></defs><rect width="64" height="64" fill="red" opacity=".6" mask="url(#m)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><mask id="m" mask-type="alpha"><g style="stroke-dasharray:8 4;stroke-dashoffset:-3"><path d="M16 32.25H48" transform="matrix(1 0 0 1 0 0)" fill="none" stroke="white" stroke-width="8" vector-effect="non-scaling-stroke"/></g></mask></defs><rect width="64" height="64" fill="red" opacity=".6" mask="url(#m)"/></svg>',
  },
  {
    id: 'non-scaling-stroke',
    name: 'nss-vertical-0-direct',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g style="stroke-dasharray:8 4;stroke-dashoffset:0"><path d="M0 8V24" transform="matrix(1 0 0 2 32.25 0)" fill="none" stroke="white" stroke-width="8" vector-effect="non-scaling-stroke"/></g></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g style="stroke-dasharray:8 4;stroke-dashoffset:0"><path d="M32.25 16V48" transform="matrix(1 0 0 1 0 0)" fill="none" stroke="white" stroke-width="8" vector-effect="non-scaling-stroke"/></g></svg>',
  },
  {
    id: 'non-scaling-stroke',
    name: 'nss-reflected-0-direct',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g style="stroke-dasharray:8 4;stroke-dashoffset:0"><path d="M8 0H24" transform="matrix(-2 0 0 1 64 32.25)" fill="none" stroke="white" stroke-width="8" vector-effect="non-scaling-stroke"/></g></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g style="stroke-dasharray:8 4;stroke-dashoffset:0"><path d="M48 32.25H16" transform="matrix(1 0 0 1 0 0)" fill="none" stroke="white" stroke-width="8" vector-effect="non-scaling-stroke"/></g></svg>',
  },
  {
    id: 'resource-validity',
    name: 'empty-direct',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><pattern id="p" width="64" height="64" patternUnits="userSpaceOnUse"></pattern></defs><rect width="64" height="64" fill="url(#p)"/></svg>',
    control: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>',
  },
  {
    id: 'resource-validity',
    name: 'hidden-direct',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><pattern id="p" width="64" height="64" patternUnits="userSpaceOnUse"><rect width="64" height="64" display="none"/></pattern></defs><rect width="64" height="64" fill="url(#p)"/></svg>',
    control: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>',
  },
  {
    id: 'resource-validity',
    name: 'cyclic-mask',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><pattern id="p" width="64" height="64" patternUnits="userSpaceOnUse"><rect width="64" height="64" fill="url(#p)"/></pattern></defs><defs><mask id="m" mask-type="alpha"><rect width="64" height="64" fill="url(#p)"/></mask></defs><rect width="64" height="64" fill="red" mask="url(#m)"/></svg>',
    control: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>',
  },
  {
    id: 'resource-validity',
    name: 'conditional-pattern',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><pattern id="p" width="64" height="64" patternUnits="userSpaceOnUse"><switch><rect width="64" height="64" requiredExtensions="urn:unsupported"/></switch></pattern></defs><defs><pattern id="q" width="64" height="64" patternUnits="userSpaceOnUse"><rect width="64" height="64" fill="url(#p)"/></pattern></defs><rect width="64" height="64" fill="url(#q)"/></svg>',
    control: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>',
  },
  {
    id: 'singular-transform',
    name: 'singular-y',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M8 0H24" transform="matrix(2 0 0 0 0 32.25)" fill="none" stroke="red" stroke-width="8"/></svg>',
    control: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>',
  },
  {
    id: 'singular-transform',
    name: 'singular-y-mask',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><mask id="m" mask-type="alpha"><path d="M8 0H24" transform="matrix(2 0 0 0 0 32.25)" fill="none" stroke="white" stroke-width="8"/></mask></defs><rect width="64" height="64" fill="red" mask="url(#m)"/></svg>',
    control: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>',
  },
  {
    id: 'singular-transform',
    name: 'singular-y-pattern',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><pattern id="p" patternUnits="userSpaceOnUse" width="64" height="64"><path d="M8 0H24" transform="matrix(2 0 0 0 0 32.25)" fill="none" stroke="red" stroke-width="8"/></pattern></defs><rect width="64" height="64" fill="url(#p)"/></svg>',
    control: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>',
  },
  {
    id: 'singular-transform',
    name: 'singular-y-marker',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><marker id="tip" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" refX="0" refY="0" overflow="visible"><path d="M0 -4V4" fill="none" stroke="red" stroke-width="8"/></marker></defs><path d="M8 0H24" transform="matrix(2 0 0 0 0 32.25)" fill="none" stroke="red" stroke-width="8" marker-end="url(#tip)"/></svg>',
    control: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>',
  },
  {
    id: 'singular-transform',
    name: 'singular-x',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M0 8V24" transform="matrix(0 0 0 2 32.25 0)" fill="none" stroke="red" stroke-width="8"/></svg>',
    control: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>',
  },
  {
    id: 'singular-transform',
    name: 'thin-y',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M8 0H24" transform="matrix(2 0 0 .00000001 0 32.25)" fill="none" stroke="red" stroke-width="8"/></svg>',
    control: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>',
  },
  {
    id: 'singular-transform',
    name: 'thin-y-mask',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><mask id="m" mask-type="alpha"><path d="M8 0H24" transform="matrix(2 0 0 .00000001 0 32.25)" fill="none" stroke="white" stroke-width="8"/></mask></defs><rect width="64" height="64" fill="red" mask="url(#m)"/></svg>',
    control: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>',
  },
  {
    id: 'singular-transform',
    name: 'thin-y-pattern',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><pattern id="p" patternUnits="userSpaceOnUse" width="64" height="64"><path d="M8 0H24" transform="matrix(2 0 0 .00000001 0 32.25)" fill="none" stroke="red" stroke-width="8"/></pattern></defs><rect width="64" height="64" fill="url(#p)"/></svg>',
    control: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>',
  },
  {
    id: 'singular-transform',
    name: 'thin-y-marker',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><marker id="tip" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" refX="0" refY="0" overflow="visible"><path d="M0 -4V4" fill="none" stroke="red" stroke-width="8"/></marker></defs><path d="M8 0H24" transform="matrix(2 0 0 .00000001 0 32.25)" fill="none" stroke="red" stroke-width="8" marker-end="url(#tip)"/></svg>',
    control: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>',
  },
  {
    id: 'singular-transform',
    name: 'thin-x',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M0 8V24" transform="matrix(.00000001 0 0 2 32.25 0)" fill="none" stroke="red" stroke-width="8"/></svg>',
    control: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>',
  },
  {
    id: 'partial-ellipse',
    name: 'partial-ellipse-positive-direct',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><clipPath id="window"><rect x="32" y="32" width=".5" height=".5"/></clipPath></defs><g clip-path="url(#window)" opacity=".6"><path d="M45.99585061057188,37.643255885923004 A16 4 17.188733853924695 0 1 16.342460857055862,26.978075518692272" fill="none" stroke="red" stroke-width="10"/></g></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="32" y="32" width=".5" height=".5" fill="red" opacity=".6"/></svg>',
  },
  {
    id: 'partial-ellipse',
    name: 'partial-ellipse-positive-mask',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><clipPath id="window"><rect x="32" y="32" width=".5" height=".5"/></clipPath><mask id="m" mask-type="alpha"><path d="M45.99585061057188,37.643255885923004 A16 4 17.188733853924695 0 1 16.342460857055862,26.978075518692272" fill="none" stroke="white" stroke-width="10"/></mask></defs><rect width="64" height="64" fill="red" clip-path="url(#window)" mask="url(#m)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="32" y="32" width=".5" height=".5" fill="red" opacity="1"/></svg>',
  },
  {
    id: 'partial-ellipse',
    name: 'partial-ellipse-positive-pattern',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><clipPath id="window"><rect x="32" y="32" width=".5" height=".5"/></clipPath><pattern id="p" patternUnits="userSpaceOnUse" width="64" height="64"><path d="M45.99585061057188,37.643255885923004 A16 4 17.188733853924695 0 1 16.342460857055862,26.978075518692272" fill="none" stroke="red" stroke-width="10"/></pattern></defs><rect width="64" height="64" fill="url(#p)" clip-path="url(#window)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="32" y="32" width=".5" height=".5" fill="red" opacity="1"/></svg>',
  },
  {
    id: 'partial-ellipse',
    name: 'partial-ellipse-negative-direct',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><clipPath id="window"><rect x="32" y="32" width=".5" height=".5"/></clipPath></defs><g clip-path="url(#window)" opacity=".6"><path d="M16.342460857055862,26.978075518692272 A16 4 17.188733853924695 0 0 45.99585061057188,37.643255885923004" fill="none" stroke="red" stroke-width="10"/></g></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="32" y="32" width=".5" height=".5" fill="red" opacity=".6"/></svg>',
  },
  {
    id: 'partial-ellipse',
    name: 'partial-ellipse-negative-mask',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><clipPath id="window"><rect x="32" y="32" width=".5" height=".5"/></clipPath><mask id="m" mask-type="alpha"><path d="M16.342460857055862,26.978075518692272 A16 4 17.188733853924695 0 0 45.99585061057188,37.643255885923004" fill="none" stroke="white" stroke-width="10"/></mask></defs><rect width="64" height="64" fill="red" clip-path="url(#window)" mask="url(#m)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="32" y="32" width=".5" height=".5" fill="red" opacity="1"/></svg>',
  },
  {
    id: 'partial-ellipse',
    name: 'partial-ellipse-negative-pattern',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><clipPath id="window"><rect x="32" y="32" width=".5" height=".5"/></clipPath><pattern id="p" patternUnits="userSpaceOnUse" width="64" height="64"><path d="M16.342460857055862,26.978075518692272 A16 4 17.188733853924695 0 0 45.99585061057188,37.643255885923004" fill="none" stroke="red" stroke-width="10"/></pattern></defs><rect width="64" height="64" fill="url(#p)" clip-path="url(#window)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="32" y="32" width=".5" height=".5" fill="red" opacity="1"/></svg>',
  },
  {
    id: 'gradient-geometry',
    name: 'linearGradient-M8 32H56-',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="base"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><linearGradient id="g" href="#base"/></defs><g stroke="url(#g)" stroke-width="8" fill="none"><path d="M8 32H56" transform=""/></g></svg>',
    control: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"/>',
  },
  {
    id: 'gradient-geometry',
    name: 'linearGradient-M32 8V56-rotate(30 32 32)',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="base"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><linearGradient id="g" href="#base"/></defs><g stroke="url(#g)" stroke-width="8" fill="none"><path d="M32 8V56" transform="rotate(30 32 32)"/></g></svg>',
    control: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"/>',
  },
  {
    id: 'gradient-geometry',
    name: 'linearGradient-pattern',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g"><stop stop-color="white"/><stop offset="1" stop-color="white"/></linearGradient><pattern id="p" patternUnits="userSpaceOnUse" width="64" height="64"><path d="M8 32H56" fill="none" stroke="url(#g)" stroke-width="8"/></pattern></defs><rect width="64" height="64" fill="url(#p)"/></svg>',
    control: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"/>',
  },
  {
    id: 'gradient-geometry',
    name: 'radialGradient-mask',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><radialGradient id="g"><stop stop-color="white"/><stop offset="1" stop-color="white"/></radialGradient><mask id="m" mask-type="alpha"><path d="M8 32H56" fill="none" stroke="url(#g)" stroke-width="8"/></mask></defs><rect width="64" height="64" fill="red" mask="url(#m)"/></svg>',
    control: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"/>',
  },
  {
    id: 'gradient-geometry',
    name: 'radialGradient-pattern',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><radialGradient id="g"><stop stop-color="white"/><stop offset="1" stop-color="white"/></radialGradient><pattern id="p" patternUnits="userSpaceOnUse" width="64" height="64"><path d="M8 32H56" fill="none" stroke="url(#g)" stroke-width="8"/></pattern></defs><rect width="64" height="64" fill="url(#p)"/></svg>',
    control: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"/>',
  },
  {
    id: 'gradient-geometry',
    name: 'diagonal-positive-control',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g"><stop stop-color="red"/><stop offset="1" stop-color="red"/></linearGradient></defs><path d="M8 8L56 56" fill="none" stroke="url(#g)" stroke-width="8"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M8 8L56 56" fill="none" stroke="red" stroke-width="8"/></svg>',
  },
  {
    id: 'mask-pattern-composition',
    name: 'ungrouped-mask-world-interior',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><mask id="m" mask-type="alpha"><rect x="8" y="8" width="24" height="48" fill="white"/><rect x="44" y="8" width="12" height="48" fill="white"/></mask></defs><rect width="64" height="64" fill="#286bb0" opacity=".6" mask="url(#m)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g opacity=".6"><rect x="8" y="8" width="24" height="48" fill="#286bb0"/><rect x="44" y="8" width="12" height="48" fill="#286bb0"/></g></svg>',
    drawOpts: { worldMatrix: [0.8, 0.2, 0, -0.1, 0.9, 0, 0.1, -0.2, 1] },
  },
  {
    id: 'mask-pattern-composition',
    name: 'axis-pattern-corner',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><pattern id="p" patternUnits="userSpaceOnUse" width="32" height="32" patternTransform="translate(.25 .25)"><rect width="16" height="32" fill="#286bb0" opacity=".25"/></pattern></defs><rect width="128" height="128" fill="url(#p)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><g fill="#286bb0" fill-opacity=".25"><rect x="0.25" width="16" height="128"/><rect x="32.25" width="16" height="128"/><rect x="64.25" width="16" height="128"/><rect x="96.25" width="16" height="128"/></g></svg>',
  },
  {
    id: 'mask-pattern-composition',
    name: 'nested-pattern-stripes-rotate(25 64 64)',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><pattern id="inner" patternUnits="userSpaceOnUse" width="32" height="32"><g opacity=".5"><rect width="16" height="32" fill="#286bb0"/></g></pattern><pattern id="p" patternUnits="userSpaceOnUse" width="64" height="64" patternTransform="rotate(25 64 64)"><g opacity=".5"><rect width="64" height="64" fill="url(#inner)"/></g></pattern></defs><rect width="128" height="128" fill="url(#p)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><pattern id="p" patternUnits="userSpaceOnUse" width="32" height="32" patternTransform="rotate(25 64 64)"><rect width="16" height="32" fill="#286bb0" opacity=".25"/></pattern></defs><rect width="128" height="128" fill="url(#p)"/></svg>',
  },
  {
    id: 'mask-pattern-composition',
    name: 'nested-pattern-large-parent-space',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><pattern id="inner" patternUnits="userSpaceOnUse" width="1000" height="1000"><g opacity=".5"><rect width="500" height="1000" fill="#286bb0"/></g></pattern><pattern id="p" patternUnits="userSpaceOnUse" width="1000" height="1000" patternTransform="scale(.1)"><g opacity=".5"><rect width="1000" height="1000" fill="url(#inner)"/></g></pattern></defs><rect width="128" height="128" fill="url(#p)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><pattern id="p" patternUnits="userSpaceOnUse" width="1000" height="1000" patternTransform="scale(.1)"><rect width="500" height="1000" fill="#286bb0" opacity=".25"/></pattern></defs><rect width="128" height="128" fill="url(#p)"/></svg>',
  },
  {
    id: 'radial-focus',
    name: 'focus-4-direct-False',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="32.25" cy="32.25" r="4" spreadMethod="repeat"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></radialGradient></defs><rect x="32" y="32" width=".5" height=".5" fill="url(#g)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="32.25" cy="32.25" r="4" spreadMethod="pad"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></radialGradient></defs><rect x="32" y="32" width=".5" height=".5" fill="url(#g)"/></svg>',
  },
  {
    id: 'radial-focus',
    name: 'focus-8-pattern-False',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="32.25" cy="32.25" r="8" spreadMethod="repeat"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></radialGradient><pattern id="p" patternUnits="userSpaceOnUse" width="64" height="64"><rect x="32" y="32" width=".5" height=".5" fill="url(#g)"/></pattern></defs><rect width="64" height="64" fill="url(#p)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="32.25" cy="32.25" r="8" spreadMethod="pad"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></radialGradient><pattern id="p" patternUnits="userSpaceOnUse" width="64" height="64"><rect x="32" y="32" width=".5" height=".5" fill="url(#g)"/></pattern></defs><rect width="64" height="64" fill="url(#p)"/></svg>',
  },
  {
    id: 'radial-focus',
    name: 'focus-32-mask-True',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="32.25" cy="32.25" r="32" spreadMethod="repeat"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></radialGradient><mask id="m" mask-type="luminance"><rect x="32" y="32" width=".5" height=".5" fill="url(#g)" opacity=".6"/></mask></defs><rect width="64" height="64" fill="#286bb0" mask="url(#m)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="32.25" cy="32.25" r="32" spreadMethod="pad"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></radialGradient><mask id="m" mask-type="luminance"><rect x="32" y="32" width=".5" height=".5" fill="url(#g)" opacity=".6"/></mask></defs><rect width="64" height="64" fill="#286bb0" mask="url(#m)"/></svg>',
  },
  {
    id: 'mask-pattern-composition',
    name: 'half-overlap',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><mask id="m" mask-type="alpha"><g opacity=".5"><rect width="64" height="64" fill="white" opacity=".5"/><rect width="64" height="64" fill="white" opacity=".5"/></g></mask></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" mask="url(#m)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><mask id="m" mask-type="alpha"><rect width="64" height="64" fill="white" opacity="0.375"/></mask></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" mask="url(#m)"/></svg>',
  },
  {
    id: 'mask-pattern-composition',
    name: 'nested',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><mask id="m" mask-type="alpha"><g opacity=".5"><g opacity=".5"><rect width="64" height="64" fill="white"/></g></g></mask></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" mask="url(#m)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><mask id="m" mask-type="alpha"><rect width="64" height="64" fill="white" opacity="0.25"/></mask></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" mask="url(#m)"/></svg>',
  },
  {
    id: 'mask-pattern-composition',
    name: 'pattern-half-overlap',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><pattern id="p" patternUnits="userSpaceOnUse" width="64" height="64"><g opacity=".5"><rect width="64" height="64" fill="#286bb0" opacity=".5"/><rect width="64" height="64" fill="#286bb0" opacity=".5"/></g></pattern></defs><rect width="128" height="128" fill="url(#p)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" fill="#286bb0" opacity="0.375"/></svg>',
  },
  {
    id: 'mask-pattern-composition',
    name: 'pattern-inside-mask',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><pattern id="p" patternUnits="userSpaceOnUse" width="64" height="64"><g opacity=".5"><rect width="64" height="64" fill="white"/></g></pattern><mask id="m" mask-type="alpha"><g opacity=".5"><rect width="128" height="128" fill="url(#p)"/></g></mask></defs><rect width="128" height="128" fill="#286bb0" mask="url(#m)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" fill="#286bb0" opacity=".25"/></svg>',
  },
  {
    id: 'mask-pattern-composition',
    name: 'pattern-leaf-multiply',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><pattern id="p" patternUnits="userSpaceOnUse" width="64" height="64"><rect width="64" height="64" fill="red"/><rect width="64" height="64" fill="blue" style="mix-blend-mode:multiply" opacity=".5"/></pattern></defs><rect width="128" height="128" fill="url(#p)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" fill="#800000"/></svg>',
  },
  {
    id: 'mask-pattern-composition',
    name: 'pattern-stroke-seam',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><pattern id="p" patternUnits="userSpaceOnUse" width="64" height="64"><g opacity=".5"><path d="M0 0V64" fill="none" stroke="#286bb0" stroke-width="6"/></g></pattern></defs><rect width="128" height="128" fill="url(#p)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><g fill="#286bb0" opacity=".5"><rect x="0" width="3" height="128"/><rect x="61" width="6" height="128"/><rect x="125" width="3" height="128"/></g></svg>',
  },
  {
    id: 'stroke-css-var',
    name: 'stroke-3',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M8 32 L100 32" fill="none" stroke="#286bb0" opacity=".6" style="--s:10%;stroke-width:var(--s);stroke-dasharray:calc(4 + 4) min(6,4);stroke-dashoffset:calc(2% + 1)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="M8 32 L100 32" fill="none" stroke="#286bb0" opacity=".6" stroke-width="12" stroke-dasharray="8 4" stroke-dashoffset="3.4"/></svg>',
  },
  {
    id: 'clip-units',
    name: 'clipPath-unit-square',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><clipPath id="r" clipPathUnits="objectBoundingBox"><rect width="50%" height="100%" fill="white"/></clipPath></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" clip-path="url(#r)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><clipPath id="r" clipPathUnits="objectBoundingBox"><rect width=".5" height="1" fill="white"/></clipPath></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" clip-path="url(#r)"/></svg>',
  },
  {
    id: 'clip-units',
    name: 'definition-transform',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><clipPath id="r" transform="translate(8 4)"><rect width="24" height="40"/></clipPath></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" clip-path="url(#r)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><clipPath id="r" ><rect transform="translate(8 4)" width="24" height="40"/></clipPath></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" clip-path="url(#r)"/></svg>',
  },
  {
    id: 'radial-focus',
    name: 'focus-mask',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="32.25" cy="32.25" r="16"><stop stop-color="white"/><stop offset="1" stop-color="white"/></radialGradient><mask id="m" mask-type="alpha"><rect width="64" height="64" fill="url(#g)"/></mask></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" mask="url(#m)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" /></svg>',
  },
  {
    id: 'degenerate-gradient',
    name: 'degenerate-linearGradient-repeat',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1=".5" y1=".5" x2=".5" y2=".5" spreadMethod="repeat"><stop stop-color="red"/><stop offset="1" stop-color="green"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" fill-opacity=".5" style="fill:url(#g)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" fill-opacity=".5" style="fill:blue"/></svg>',
  },
  {
    id: 'half-plane',
    name: 'rim-half-plane',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><radialGradient id="g" gradientUnits="userSpaceOnUse" cx="32.25" cy="32.25" fx="48.25" fy="32.25" r="16"><stop stop-color="white"/><stop offset="1" stop-color="white"/></radialGradient><mask id="m" mask-type="alpha"><rect width="64" height="64" fill="url(#g)"/></mask></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" mask="url(#m)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><clipPath id="c"><rect width="48.25" height="64"/></clipPath></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" clip-path="url(#c)"/></svg>',
  },
  {
    id: 'mask-region',
    name: 'empty-region-width="0"',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><mask id="m" width="0"><rect width="64" height="64" fill="white"/></mask></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" mask="url(#m)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><mask id="m"><rect width="64" height="64" fill="none"/></mask></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" mask="url(#m)"/></svg>',
  },
  {
    id: 'silhouette',
    name: 'silhouette-fill="none"',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><pattern id="p" width="8" height="8" patternUnits="userSpaceOnUse"><rect x="-100" y="-100" width="200" height="200"/></pattern><clipPath id="c"><circle cx="32" cy="32" r="16" fill="none"/></clipPath></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" clip-path="url(#c)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><clipPath id="c"><circle cx="32" cy="32" r="16"/></clipPath></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" clip-path="url(#c)"/></svg>',
  },
  {
    id: 'mask-css',
    name: 'mask-css-39',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>#m {mask-type:luminance!important}</style><defs><mask id="m" style="mask-type:alpha!important"><rect width="64" height="64" fill="black"/></mask></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" mask="url(#m)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><mask id="m" mask-type="alpha"><rect width="64" height="64" fill="black"/></mask></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" mask="url(#m)"/></svg>',
  },
  {
    id: 'empty-clip',
    name: 'empty-clipPath-24',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><clipPath id="m"></clipPath></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" clip-path="url(#m)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><mask id="m"><rect width="64" height="64" fill="none"/></mask></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" mask="url(#m)"/></svg>',
  },
  {
    id: 'mask-region',
    name: 'nested-region-0-True',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>path {display:none}</style><defs><mask id="inner" mask-type="alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="0" height="64"><rect width="64" height="64" fill="white"/></mask><mask id="outer" mask-type="alpha"><rect width="64" height="64" fill="white" mask="url(#inner)"/></mask></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" mask="url(#outer)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>path {display:none}</style><defs><mask id="outer" mask-type="alpha"><rect width="0" height="64" fill="white"/></mask></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" mask="url(#outer)"/></svg>',
  },
  {
    id: 'clip-units',
    name: 'nested-region-50%-True',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>path {display:none}</style><defs><mask id="inner" mask-type="alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="50%" height="64"><rect width="64" height="64" fill="white"/></mask><mask id="outer" mask-type="alpha"><rect width="64" height="64" fill="white" mask="url(#inner)"/></mask></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" mask="url(#outer)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>path {display:none}</style><defs><mask id="outer" mask-type="alpha"><rect width="32" height="64" fill="white"/></mask></defs><rect x="8" y="8" width="48" height="48" fill="#286bb0" opacity=".6" mask="url(#outer)"/></svg>',
  },
  {
    id: 'pattern-children',
    name: 'pattern-17-children',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><pattern id="p" patternUnits="userSpaceOnUse" width="64" height="64"><rect x="0.0" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="3.764705882352941" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="7.529411764705882" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="11.294117647058822" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="15.058823529411764" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="18.823529411764707" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="22.588235294117645" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="26.352941176470587" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="30.11764705882353" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="33.88235294117647" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="37.64705882352941" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="41.411764705882355" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="45.17647058823529" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="48.94117647058823" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="52.705882352941174" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="56.470588235294116" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="60.23529411764706" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/></pattern></defs><rect width="128" height="128" fill="url(#p)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><g transform="translate(0 0)"><rect x="0.0" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="3.764705882352941" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="7.529411764705882" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="11.294117647058822" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="15.058823529411764" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="18.823529411764707" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="22.588235294117645" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="26.352941176470587" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="30.11764705882353" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="33.88235294117647" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="37.64705882352941" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="41.411764705882355" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="45.17647058823529" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="48.94117647058823" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="52.705882352941174" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="56.470588235294116" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="60.23529411764706" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/></g><g transform="translate(64 0)"><rect x="0.0" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="3.764705882352941" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="7.529411764705882" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="11.294117647058822" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="15.058823529411764" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="18.823529411764707" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="22.588235294117645" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="26.352941176470587" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="30.11764705882353" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="33.88235294117647" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="37.64705882352941" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="41.411764705882355" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="45.17647058823529" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="48.94117647058823" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="52.705882352941174" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="56.470588235294116" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="60.23529411764706" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/></g><g transform="translate(0 64)"><rect x="0.0" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="3.764705882352941" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="7.529411764705882" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="11.294117647058822" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="15.058823529411764" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="18.823529411764707" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="22.588235294117645" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="26.352941176470587" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="30.11764705882353" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="33.88235294117647" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="37.64705882352941" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="41.411764705882355" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="45.17647058823529" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="48.94117647058823" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="52.705882352941174" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="56.470588235294116" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="60.23529411764706" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/></g><g transform="translate(64 64)"><rect x="0.0" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="3.764705882352941" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="7.529411764705882" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="11.294117647058822" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="15.058823529411764" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="18.823529411764707" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="22.588235294117645" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="26.352941176470587" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="30.11764705882353" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="33.88235294117647" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="37.64705882352941" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="41.411764705882355" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="45.17647058823529" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="48.94117647058823" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/><rect x="52.705882352941174" y="0.0" width="3.764705882352941" height="64.0" fill="#7461b8" fill-opacity=".6"/><rect x="56.470588235294116" y="0.0" width="3.764705882352941" height="64.0" fill="#e84232" fill-opacity=".6"/><rect x="60.23529411764706" y="0.0" width="3.764705882352941" height="64.0" fill="#2597c4" fill-opacity=".6"/></g></svg>',
  },
  {
    id: 'pattern-children',
    name: 'pattern-split-18-rows',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><pattern id="p" patternUnits="userSpaceOnUse" width="64" height="64"><rect x="3" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="9" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="15" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="21" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="27" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="33" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="39" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="45" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="51" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/></pattern></defs><rect width="128" height="128" fill="url(#p)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><g transform="translate(0 0)"><rect x="3" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="9" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="15" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="21" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="27" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="33" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="39" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="45" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="51" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/></g><g transform="translate(64 0)"><rect x="3" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="9" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="15" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="21" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="27" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="33" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="39" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="45" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="51" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/></g><g transform="translate(0 64)"><rect x="3" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="9" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="15" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="21" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="27" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="33" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="39" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="45" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="51" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/></g><g transform="translate(64 64)"><rect x="3" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="9" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="15" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="21" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="27" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="33" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="39" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="45" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/><rect x="51" y="8" width="4" height="40" fill="#2597c4" fill-opacity=".45" stroke="#e84232" stroke-opacity=".6" stroke-width="2"/></g></svg>',
  },
  {
    id: 'pattern-children',
    name: 'pattern-translucent-order-24',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><pattern id="p" patternUnits="userSpaceOnUse" width="64" height="64"><rect x="0" y="0" width="64" height="64" fill="#e84232" fill-opacity=".12"/><rect x="1" y="1" width="62" height="62" fill="#2597c4" fill-opacity=".12"/><rect x="2" y="2" width="60" height="60" fill="#e84232" fill-opacity=".12"/><rect x="3" y="3" width="58" height="58" fill="#2597c4" fill-opacity=".12"/><rect x="4" y="4" width="56" height="56" fill="#e84232" fill-opacity=".12"/><rect x="5" y="5" width="54" height="54" fill="#2597c4" fill-opacity=".12"/><rect x="6" y="6" width="52" height="52" fill="#e84232" fill-opacity=".12"/><rect x="7" y="7" width="50" height="50" fill="#2597c4" fill-opacity=".12"/><rect x="8" y="8" width="48" height="48" fill="#e84232" fill-opacity=".12"/><rect x="9" y="9" width="46" height="46" fill="#2597c4" fill-opacity=".12"/><rect x="10" y="10" width="44" height="44" fill="#e84232" fill-opacity=".12"/><rect x="11" y="11" width="42" height="42" fill="#2597c4" fill-opacity=".12"/><rect x="12" y="12" width="40" height="40" fill="#e84232" fill-opacity=".12"/><rect x="13" y="13" width="38" height="38" fill="#2597c4" fill-opacity=".12"/><rect x="14" y="14" width="36" height="36" fill="#e84232" fill-opacity=".12"/><rect x="15" y="15" width="34" height="34" fill="#2597c4" fill-opacity=".12"/><rect x="16" y="16" width="32" height="32" fill="#e84232" fill-opacity=".12"/><rect x="17" y="17" width="30" height="30" fill="#2597c4" fill-opacity=".12"/><rect x="18" y="18" width="28" height="28" fill="#e84232" fill-opacity=".12"/><rect x="19" y="19" width="26" height="26" fill="#2597c4" fill-opacity=".12"/><rect x="20" y="20" width="24" height="24" fill="#e84232" fill-opacity=".12"/><rect x="21" y="21" width="22" height="22" fill="#2597c4" fill-opacity=".12"/><rect x="22" y="22" width="20" height="20" fill="#e84232" fill-opacity=".12"/><rect x="23" y="23" width="18" height="18" fill="#2597c4" fill-opacity=".12"/></pattern></defs><rect width="128" height="128" fill="url(#p)"/></svg>',
    control:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><g transform="translate(0 0)"><rect x="0" y="0" width="64" height="64" fill="#e84232" fill-opacity=".12"/><rect x="1" y="1" width="62" height="62" fill="#2597c4" fill-opacity=".12"/><rect x="2" y="2" width="60" height="60" fill="#e84232" fill-opacity=".12"/><rect x="3" y="3" width="58" height="58" fill="#2597c4" fill-opacity=".12"/><rect x="4" y="4" width="56" height="56" fill="#e84232" fill-opacity=".12"/><rect x="5" y="5" width="54" height="54" fill="#2597c4" fill-opacity=".12"/><rect x="6" y="6" width="52" height="52" fill="#e84232" fill-opacity=".12"/><rect x="7" y="7" width="50" height="50" fill="#2597c4" fill-opacity=".12"/><rect x="8" y="8" width="48" height="48" fill="#e84232" fill-opacity=".12"/><rect x="9" y="9" width="46" height="46" fill="#2597c4" fill-opacity=".12"/><rect x="10" y="10" width="44" height="44" fill="#e84232" fill-opacity=".12"/><rect x="11" y="11" width="42" height="42" fill="#2597c4" fill-opacity=".12"/><rect x="12" y="12" width="40" height="40" fill="#e84232" fill-opacity=".12"/><rect x="13" y="13" width="38" height="38" fill="#2597c4" fill-opacity=".12"/><rect x="14" y="14" width="36" height="36" fill="#e84232" fill-opacity=".12"/><rect x="15" y="15" width="34" height="34" fill="#2597c4" fill-opacity=".12"/><rect x="16" y="16" width="32" height="32" fill="#e84232" fill-opacity=".12"/><rect x="17" y="17" width="30" height="30" fill="#2597c4" fill-opacity=".12"/><rect x="18" y="18" width="28" height="28" fill="#e84232" fill-opacity=".12"/><rect x="19" y="19" width="26" height="26" fill="#2597c4" fill-opacity=".12"/><rect x="20" y="20" width="24" height="24" fill="#e84232" fill-opacity=".12"/><rect x="21" y="21" width="22" height="22" fill="#2597c4" fill-opacity=".12"/><rect x="22" y="22" width="20" height="20" fill="#e84232" fill-opacity=".12"/><rect x="23" y="23" width="18" height="18" fill="#2597c4" fill-opacity=".12"/></g><g transform="translate(64 0)"><rect x="0" y="0" width="64" height="64" fill="#e84232" fill-opacity=".12"/><rect x="1" y="1" width="62" height="62" fill="#2597c4" fill-opacity=".12"/><rect x="2" y="2" width="60" height="60" fill="#e84232" fill-opacity=".12"/><rect x="3" y="3" width="58" height="58" fill="#2597c4" fill-opacity=".12"/><rect x="4" y="4" width="56" height="56" fill="#e84232" fill-opacity=".12"/><rect x="5" y="5" width="54" height="54" fill="#2597c4" fill-opacity=".12"/><rect x="6" y="6" width="52" height="52" fill="#e84232" fill-opacity=".12"/><rect x="7" y="7" width="50" height="50" fill="#2597c4" fill-opacity=".12"/><rect x="8" y="8" width="48" height="48" fill="#e84232" fill-opacity=".12"/><rect x="9" y="9" width="46" height="46" fill="#2597c4" fill-opacity=".12"/><rect x="10" y="10" width="44" height="44" fill="#e84232" fill-opacity=".12"/><rect x="11" y="11" width="42" height="42" fill="#2597c4" fill-opacity=".12"/><rect x="12" y="12" width="40" height="40" fill="#e84232" fill-opacity=".12"/><rect x="13" y="13" width="38" height="38" fill="#2597c4" fill-opacity=".12"/><rect x="14" y="14" width="36" height="36" fill="#e84232" fill-opacity=".12"/><rect x="15" y="15" width="34" height="34" fill="#2597c4" fill-opacity=".12"/><rect x="16" y="16" width="32" height="32" fill="#e84232" fill-opacity=".12"/><rect x="17" y="17" width="30" height="30" fill="#2597c4" fill-opacity=".12"/><rect x="18" y="18" width="28" height="28" fill="#e84232" fill-opacity=".12"/><rect x="19" y="19" width="26" height="26" fill="#2597c4" fill-opacity=".12"/><rect x="20" y="20" width="24" height="24" fill="#e84232" fill-opacity=".12"/><rect x="21" y="21" width="22" height="22" fill="#2597c4" fill-opacity=".12"/><rect x="22" y="22" width="20" height="20" fill="#e84232" fill-opacity=".12"/><rect x="23" y="23" width="18" height="18" fill="#2597c4" fill-opacity=".12"/></g><g transform="translate(0 64)"><rect x="0" y="0" width="64" height="64" fill="#e84232" fill-opacity=".12"/><rect x="1" y="1" width="62" height="62" fill="#2597c4" fill-opacity=".12"/><rect x="2" y="2" width="60" height="60" fill="#e84232" fill-opacity=".12"/><rect x="3" y="3" width="58" height="58" fill="#2597c4" fill-opacity=".12"/><rect x="4" y="4" width="56" height="56" fill="#e84232" fill-opacity=".12"/><rect x="5" y="5" width="54" height="54" fill="#2597c4" fill-opacity=".12"/><rect x="6" y="6" width="52" height="52" fill="#e84232" fill-opacity=".12"/><rect x="7" y="7" width="50" height="50" fill="#2597c4" fill-opacity=".12"/><rect x="8" y="8" width="48" height="48" fill="#e84232" fill-opacity=".12"/><rect x="9" y="9" width="46" height="46" fill="#2597c4" fill-opacity=".12"/><rect x="10" y="10" width="44" height="44" fill="#e84232" fill-opacity=".12"/><rect x="11" y="11" width="42" height="42" fill="#2597c4" fill-opacity=".12"/><rect x="12" y="12" width="40" height="40" fill="#e84232" fill-opacity=".12"/><rect x="13" y="13" width="38" height="38" fill="#2597c4" fill-opacity=".12"/><rect x="14" y="14" width="36" height="36" fill="#e84232" fill-opacity=".12"/><rect x="15" y="15" width="34" height="34" fill="#2597c4" fill-opacity=".12"/><rect x="16" y="16" width="32" height="32" fill="#e84232" fill-opacity=".12"/><rect x="17" y="17" width="30" height="30" fill="#2597c4" fill-opacity=".12"/><rect x="18" y="18" width="28" height="28" fill="#e84232" fill-opacity=".12"/><rect x="19" y="19" width="26" height="26" fill="#2597c4" fill-opacity=".12"/><rect x="20" y="20" width="24" height="24" fill="#e84232" fill-opacity=".12"/><rect x="21" y="21" width="22" height="22" fill="#2597c4" fill-opacity=".12"/><rect x="22" y="22" width="20" height="20" fill="#e84232" fill-opacity=".12"/><rect x="23" y="23" width="18" height="18" fill="#2597c4" fill-opacity=".12"/></g><g transform="translate(64 64)"><rect x="0" y="0" width="64" height="64" fill="#e84232" fill-opacity=".12"/><rect x="1" y="1" width="62" height="62" fill="#2597c4" fill-opacity=".12"/><rect x="2" y="2" width="60" height="60" fill="#e84232" fill-opacity=".12"/><rect x="3" y="3" width="58" height="58" fill="#2597c4" fill-opacity=".12"/><rect x="4" y="4" width="56" height="56" fill="#e84232" fill-opacity=".12"/><rect x="5" y="5" width="54" height="54" fill="#2597c4" fill-opacity=".12"/><rect x="6" y="6" width="52" height="52" fill="#e84232" fill-opacity=".12"/><rect x="7" y="7" width="50" height="50" fill="#2597c4" fill-opacity=".12"/><rect x="8" y="8" width="48" height="48" fill="#e84232" fill-opacity=".12"/><rect x="9" y="9" width="46" height="46" fill="#2597c4" fill-opacity=".12"/><rect x="10" y="10" width="44" height="44" fill="#e84232" fill-opacity=".12"/><rect x="11" y="11" width="42" height="42" fill="#2597c4" fill-opacity=".12"/><rect x="12" y="12" width="40" height="40" fill="#e84232" fill-opacity=".12"/><rect x="13" y="13" width="38" height="38" fill="#2597c4" fill-opacity=".12"/><rect x="14" y="14" width="36" height="36" fill="#e84232" fill-opacity=".12"/><rect x="15" y="15" width="34" height="34" fill="#2597c4" fill-opacity=".12"/><rect x="16" y="16" width="32" height="32" fill="#e84232" fill-opacity=".12"/><rect x="17" y="17" width="30" height="30" fill="#2597c4" fill-opacity=".12"/><rect x="18" y="18" width="28" height="28" fill="#e84232" fill-opacity=".12"/><rect x="19" y="19" width="26" height="26" fill="#2597c4" fill-opacity=".12"/><rect x="20" y="20" width="24" height="24" fill="#e84232" fill-opacity=".12"/><rect x="21" y="21" width="22" height="22" fill="#2597c4" fill-opacity=".12"/><rect x="22" y="22" width="20" height="20" fill="#e84232" fill-opacity=".12"/><rect x="23" y="23" width="18" height="18" fill="#2597c4" fill-opacity=".12"/></g></svg>',
  },
];

export async function paint(gl, r, bundle, overrides, drawOpts = {}) {
  const draw = () => {
    r.beginFrame([0, 0, 0, 1]);
    r.drawBundle(bundle, { ...drawOpts, overrides });
    r.endFrame();
  };
  const warmed = await r.warmScene([{ draw }], { maxPasses: 16, fenceTimeoutMs: 60000 });
  if (!warmed.complete) throw Error('Audit scene did not finish warming');
  draw();
  const pixels = new Uint8Array(128 * 128 * 4);
  gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  if (gl.getError() !== gl.NO_ERROR) throw Error('Audit draw GL error');
  return pixels;
}
export const delta = (a, b) =>
  a.reduce((max, value, i) => Math.max(max, Math.abs(value - b[i])), 0);
const documentOf = (body) =>
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' + body + '</svg>';
export function viewport(gl, r) {
  gl.canvas.width = 128;
  gl.canvas.height = 128;
  r.setViewport(128, 128);
}

export async function runPaintCases(gl, r) {
  viewport(gl, r);
  r.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  const results = [];
  for (const fixture of PAIRS) {
    const images = [];
    for (const source of [fixture.svg, fixture.control]) {
      const b = M.createBundle(gl, await M.importSvg(source, { preserveViewport: true }));
      images.push(await paint(gl, r, b, undefined, fixture.drawOpts));
      b.dispose();
    }
    results.push({ name: fixture.name, maxByte: delta(...images) });
  }
  return results;
}

export async function runImageCases(gl, r) {
  viewport(gl, r);
  r.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  const results = [];
  for (const masked of [false, true])
    for (const kind of [0, 1, 3]) {
      const source = masked
        ? '<defs><mask id="m" mask-type="alpha"><rect width="64" height="64" fill="white"/></mask></defs><rect width="64" height="64" fill="white" mask="url(#m)"/>'
        : '<rect width="64" height="64" fill="white"/>';
      const section = await M.importSvg(documentOf(source), { preserveViewport: true });
      const meta = parseMetaBin(section.meta, section.metaFloatsPerShape),
        f = meta.metaFloats;
      const row = masked ? Math.round(f[31]) - 1 : 0,
        o = row * meta.floatsPerShape;
      f[o + 35] = 1;
      f[o + 44] = 0;
      f.set([16, 16, 16, 16, 0, 2, 1, kind | 4], o + 36);
      if (masked) {
        f[o + 27] |= (1 << 9) | (1 << 10);
        f[o + 31] = row + 1;
      }
      section.imageAtlas = Uint8Array.from([255, 255, 255, 0, 255, 255, 255, 255]).buffer;
      section.imageAtlasDim = [2, 1];
      const b = M.createBundle(gl, section),
        pixels = await paint(gl, r, b);
      const want =
        kind === 0 ? [0, 1, 0, 0, 0, 0] : kind === 1 ? [0, 1, 0, 1, 0, 1] : [0, 1, 1, 0, 1, 0];
      let maxByte = 0;
      [20.25, 28.25, 36.25, 44.25, 4.25, 12.25].forEach((x, i) => {
        const at = ((127 - Math.floor(20.25 * 2)) * 128 + Math.floor(x * 2)) * 4;
        maxByte = Math.max(maxByte, Math.abs(pixels[at] - want[i] * 255));
        if (
          masked &&
          M.fillHitShape(section, x, 20.25, { mode: M.HitMode.Coverage, minAlpha: 0.2 }) >= 0 !==
            !!want[i]
        )
          throw Error('Image mask hit disagrees with decoded alpha');
      });
      results.push({ masked, kind, maxByte });
      b.dispose();
    }
  {
    const section = await M.importSvg(documentOf('<rect width="64" height="64" fill="white"/>'), {
      preserveViewport: true,
    });
    const f = parseMetaBin(section.meta, section.metaFloatsPerShape).metaFloats;
    f[35] = 1;
    f[44] = 0;
    f.set([16, 16, 16, 16, 1, 2, 1, 3], 36);
    const atlas = new Uint8Array(4 * 3 * 4);
    for (let i = 0; i < atlas.length; i += 4) atlas.set([255, 255, 255, 255], i);
    atlas[19] = 0;
    atlas[27] = 0;
    section.imageAtlas = atlas.buffer;
    section.imageAtlasDim = [4, 3];
    const b = M.createBundle(gl, section),
      pixels = await paint(gl, r, b);
    const at = ((127 - Math.floor(20.25 * 2)) * 128 + Math.floor(31.75 * 2)) * 4;
    results.push({ atlasBoundary: true, maxByte: Math.abs(pixels[at] - 255) });
    b.dispose();
  }
  return results;
}

export async function runClipCases(gl, r) {
  viewport(gl, r);
  r.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  const results = [];
  for (const resource of ['clipPath', 'mask'])
    for (const morphing of [false, true]) {
      const attribute = resource === 'mask' ? 'mask' : 'clip-path';
      const defs =
        '<defs>' +
        ['c', 'd']
          .map(
            (id) =>
              `<${resource} id="${id}" mask-type="alpha"><rect id="same" width="16" height="16" fill="white"/></${resource}>`,
          )
          .join('') +
        '</defs>';
      const body = ['c', 'd', 'c']
        .map(
          (id, i) =>
            `<g transform="translate(${8 + 16 * i} ${i === 1 ? 40 : 8})" ${attribute}="url(#${id})"><rect id="v${i}" width="24" height="16" fill="white" opacity=".6"/></g>`,
        )
        .join('');
      const source = M.createBundle(
        gl,
        await M.importSvg(documentOf(defs + body), { preserveViewport: true }),
      );
      const morph = morphing ? M.createShapeMorph(gl, source, source) : null;
      if (morph) morph.setT(0.5);
      const b = morph ? morph.bundle : source,
        overrides = morph ? morph.overrides : M.createOverrideTable(gl, b);
      const before = await paint(gl, r, b, overrides);
      if (!overrides.setClipper('c', { localPosition: [4, 0] })) throw Error('Named clip missing');
      const moved = await paint(gl, r, b, overrides);
      overrides.clearClipper('c');
      const cleared = await paint(gl, r, b, overrides);
      const literal = defs.replace('width="16" height="16"', 'x="4" width="16" height="16"');
      const control = M.createBundle(
        gl,
        await M.importSvg(documentOf(literal + body), { preserveViewport: true }),
      );
      const expected = await paint(gl, r, control);
      results.push({
        resource,
        morphing,
        maxByte: delta(moved, expected),
        clearMax: delta(before, cleared),
      });
      control.dispose();
      if (morph) morph.dispose();
      else overrides.dispose();
      source.dispose();
    }
  return results;
}

// Prepared meshes must keep the raw curves used by resource bakes current.
export async function runPreparedResourceCases() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
  const r = M.createRenderer(
    gl,
    await M.loadShaders(new URL('../src/shaders/', import.meta.url).href),
    { variantFirst: true },
  );
  await r.ready;
  viewport(gl, r);
  const results = [];
  const fixture = (kind, t) => {
    const children =
      '<g opacity="' +
      (0.25 + 0.5 * t) +
      '"><rect x="' +
      (8 + 16 * t) +
      '" y="8" width="24" height="48" fill="' +
      (kind === 'mask' ? 'white' : '#286bb0') +
      '"/><rect x="' +
      (8 + 16 * t) +
      '" y="8" width="24" height="48" fill="' +
      (kind === 'mask' ? 'white' : '#286bb0') +
      '"/></g>';
    const resource =
      kind === 'mask'
        ? '<mask id="m" mask-type="alpha">' + children + '</mask>'
        : '<pattern id="p" patternUnits="userSpaceOnUse" width="64" height="64">' +
          children +
          '</pattern>';
    return documentOf(
      '<defs>' +
        resource +
        '</defs><rect width="64" height="64" fill="' +
        (kind === 'mask' ? '#286bb0' : 'url(#p)') +
        '"' +
        (kind === 'mask' ? ' mask="url(#m)"' : '') +
        '/>',
    );
  };
  try {
    for (const engine of ['lb', 'cpatch'])
      for (const kind of ['mask', 'pattern']) {
        r.setFillEngine({ route: engine, kernel: 'aac', primitives: 'off' });
        const a = M.createBundle(
          gl,
          await M.importSvg(fixture(kind, 0), { preserveViewport: true }),
        );
        const b = M.createBundle(
          gl,
          await M.importSvg(fixture(kind, 1), { preserveViewport: true }),
        );
        try {
          for (const gpu of [false, true]) {
            const morph = M.createShapeMorph(gl, a, b, { cpuLerp: !gpu });
            morph.bundle._morphSrc.gpuSmallPlanes = gpu;
            try {
              r.prepareBundle(morph.bundle);
              if (!(await r.awaitEngine(morph.bundle, engine, 60000)))
                throw Error('Resource morph preparation failed');
              for (const t of [0, 0.5, 1]) {
                morph.setT(t);
                const before = r.debugStats.engines?.draws?.[engine] || 0;
                const actual = await paint(gl, r, morph);
                const served = (r.debugStats.engines?.draws?.[engine] || 0) > before;
                const literal = M.createBundle(
                  gl,
                  await M.importSvg(fixture(kind, t), { preserveViewport: true }),
                );
                try {
                  const expected = await paint(gl, r, literal);
                  results.push({
                    name: 'prepared-resource-' + engine + '-' + kind + '-' + gpu + '-' + t,
                    maxByte: delta(actual, expected),
                    served,
                  });
                  if (!served && !(engine === 'lb' && kind === 'pattern'))
                    throw Error('Prepared resource route did not serve');
                } finally {
                  literal.dispose();
                }
              }
            } finally {
              morph.dispose();
            }
          }
        } finally {
          a.dispose();
          b.dispose();
        }
      }
  } finally {
    r.dispose();
    gl.getExtension('WEBGL_lose_context').loseContext();
  }
  return results;
}
