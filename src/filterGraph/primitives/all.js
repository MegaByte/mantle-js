// primitives/all.js — import every SVG filter primitive, registering all
// handlers, for the full <filter> set. Feature-splitting consumers
// instead import only the primitive modules their assets exercise.
//
// Side-effect-only module: each import below calls registerSvgFilter().

import './blur.js';
import './morphology.js';
import './offset.js';
import './colorMatrix.js';
import './lighting.js';          // feDiffuseLighting + feSpecularLighting
import './displacementMap.js';
import './turbulence.js';
import './tile.js';
import './blend.js';
import './composite.js';
import './merge.js';
import './componentTransfer.js';
import './flood.js';
import './convolve.js';
import './image.js';
