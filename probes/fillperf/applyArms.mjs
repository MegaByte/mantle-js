// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// applyArms — write one shaderArmAB arm's shader text to a file, for the node proofs of a GPU timing arm.
//
//   node probes/fillperf/applyArms.mjs arms.json armName [in.glsl] out.glsl
//
// Applies the arm's `replace` pairs to a generated shader (default src/shaders/generated/mantle.frag.glsl, the
// `fillFrag` source shaderArmAB edits) with shaderArmAB's own semantics: every occurrence, and a pair that matches
// nothing is an error. The output then goes to kernelIdentity (--base / --cand), _shaderIdentity or validateVariants,
// so the text the GPU times is the text the node proofs held.
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args.length < 3) {
  console.log('usage: node probes/fillperf/applyArms.mjs arms.json armName [in.glsl] out.glsl');
  process.exit(2);
}
const [armsFile, name] = args;
const inFile =
  args.length > 3 ? args[2] : path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl');
const outFile = args[args.length - 1];
const arm = JSON.parse(readFileSync(armsFile, 'utf8')).find((a) => a.name === name);
if (!arm) {
  console.error(`applyArms: no arm named ${name}`);
  process.exit(2);
}
if (arm.sources && !arm.sources.includes('fillFrag')) {
  console.error(`applyArms: arm ${name} does not edit fillFrag`);
  process.exit(2);
}
let text = readFileSync(inFile, 'utf8');
for (const [from, to] of arm.replace || []) {
  if (!text.includes(from)) {
    console.error(`applyArms: arm ${name}: a replacement matched nothing: ${from.slice(0, 80)}`);
    process.exit(1);
  }
  text = text.split(from).join(to);
}
writeFileSync(outFile, text);
console.log(`applyArms: ${name} -> ${outFile} (${(arm.replace || []).length} replacements)`);
