import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
const D = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer') + '/';
// Every module that reads/writes R (keep in sync with the contract-smoke
// MODULES list + renderer.js). A stale list drops members used only across the
// newer modules — e.g. _autoNodeClip / _recordBundleDraw — breaking check:types.
const mods=['renderer','shaderPrograms','drawImages','instancedFill','morphDraw','drawSprites','cacheDraw','staticCache','filterDraw','clipDraw','bundleHandle','maskBake','fillPass','frameLoop','drawDispatch'];
const all=mods.map(m=>readFileSync(D+m+'.js','utf8')).join('\n');
const strip=(s)=>s.replace(/\/\*[\s\S]*?\*\//g,' ').replace(/\/\/[^\n]*/g,' ');
const src=strip(all);
const mem=new Set();
// reads + R.x = writes
for(const m of src.matchAll(/\bR\.(\w+)\b/g)) mem.add(m[1]);
// brace-matched extraction of a { } block starting at index i (i points at '{')
function block(s,i){let d=0;for(let j=i;j<s.length;j++){if(s[j]==='{')d++;else if(s[j]==='}'){d--;if(!d)return s.slice(i+1,j);}}return '';}
// top-level keys of an object-literal body: `key:` or shorthand `key,`/`key}`
function keys(body){const k=new Set();let d=0,buf='';const flush=()=>{const t=buf.trim();const m=t.match(/^([A-Za-z_$]\w*)\s*[:,]?/);if(m&&!/^(get|set)$/.test(m[1]))k.add(m[1]);buf='';};for(const c of body){if('{[('.includes(c))d++;else if('}])'.includes(c))d--;if(c===','&&d===0){flush();continue;}buf+=c;}flush();return k;}
// const R = { ... }
let i=src.search(/\bconst R\s*=\s*\{/); if(i>=0){const b=src.indexOf('{',i);for(const k of keys(block(src,b))) mem.add(k);}
// Object.assign(R, { ... })
for(const m of src.matchAll(/Object\.assign\(R,\s*\{/g)){const b=src.indexOf('{',m.index+m[0].length-1);for(const k of keys(block(src,b))) mem.add(k);}
// Object.defineProperty(R, 'x'|"x", ...)
for(const m of src.matchAll(/Object\.defineProperty\(R,\s*['"](\w+)['"]/g)) mem.add(m[1]);
const names=[...mem].sort();
const typeOf=(n)=> n==="gl" ? "WebGL2RenderingContext" : (/Prog$/.test(n) && !/ensure/i.test(n)) ? "WebGLProgram" : "any";
const body=names.map(n=>` * ${n}?: ${typeOf(n)},`).join('\n');
const out=`// rendererContext.js — the TYPE of the renderer's shared context object \`R\`.
//
// The monolith->module split turned one closure into modules that share state
// through a single \`R\` object passed to each \`attach*(R)\`. The module params
// were untyped (\`any\`), so checkJs could not see \`R.<typo>\` or \`R.<import>\`
// (Class C) bugs. This typedef gives \`R\` an explicit member contract: any
// access to a name NOT listed here is a compile error (TS2339) — so a stray
// \`R.decodeImageHref\` / \`R.mantleDebugFlag\` is caught statically.
//
// Members are the UNION of every key written to R (the \`const R = {…}\` literal,
// \`R.x =\`, \`Object.assign(R,{…})\`, \`Object.defineProperty(R,…)\`) and every
// \`R.x\` read — all OPTIONAL, because R is built incrementally so a partial
// literal must satisfy the type (strictNullChecks is OFF → no null-noise).
// Types are precise only where collision-free (gl, *Prog); the rest are \`any\`
// because MEMBERSHIP, not the member's type, is what catches the split classes —
// a wrongly-precise type would be a false positive. Adding a new \`R.x\` REQUIRES
// adding it here; regenerate from the surface when it drifts.
//
// JSDoc-only (no runtime import). Modules reference it via
//   /** @param {import('./rendererContext.js').RendererContext} R */
/**
 * @typedef {{
${body}
 * }} RendererContext
 */
export {};
`;
writeFileSync(D+'rendererContext.js', out);
console.log('members:', names.length);
