// jstfKashidaSmoke.mjs — JSTF Arabic kashida justification.
//
// Arial ships a JSTF table whose 'arab' script lists kashida (tatweel)
// extender glyphs. When an Arabic line is justified, the layout inserts
// those connectors at cursive joins to fill slack, instead of only
// stretching spaces. We assert the extenders are exposed and that a
// justified Arabic line emits tatweel (U+0640) glyphs a left-aligned one
// does not. Uses Arial (CI-portable).

import { readFileSync, existsSync } from 'fs';
import { MantleFontAsset, buildStyled } from '../../src/font/index.js';
import { defaultStyle } from '../../src/font/markupParser.js';

const p = '/System/Library/Fonts/Supplemental/Arial.ttf';
if (!existsSync(p)) { console.log('Skip jstf: no Arial'); process.exit(0); }

let failures = 0;
const fail = (m) => { console.error('FAIL', m); failures++; };
const ok = (m) => console.log('ok', m);

const font = new MantleFontAsset(new Uint8Array(readFileSync(p)));

// ---- T1: Arabic extender glyphs exposed; Latin has none ----
const arab = font.jstf.getExtenderGlyphs('arab');
if (!font.jstf.hasJstf) fail('T1 Arial should have JSTF');
else if (!arab || arab.length === 0) fail('T1 arab extenders missing');
else if (font.jstf.getExtenderGlyphs('latn')) fail('T1 latn should have no extenders');
else ok(`T1 arab kashida extenders: [${arab}]`);

// ---- T2: justified Arabic inserts kashida (U+0640); left-aligned doesn't ----
const text = 'العربية الخط العربي المتصل الحروف تتصل ببعضها';
const style = { ...defaultStyle(), color: [0, 0, 0, 1] };
const kashidaCount = async (align) => {
  const b = await buildStyled([{ text, style }], font, { maxWidthEm: 12, align, lastLineAlign: 'justify' });
  return (b.shapeIds || []).filter((s) => s.includes('u0640')).length;
};
const left = await kashidaCount('left');
const justified = await kashidaCount('justify');
if (left !== 0) fail(`T2 left-aligned should insert no kashida, got ${left}`);
else if (justified <= 0) fail('T2 justified Arabic should insert kashida connectors');
else ok(`T2 justify inserts ${justified} kashida; left-align inserts 0`);

console.log(failures ? `\nJSTF-KASHIDA FAIL (${failures})` : '\nJSTF-KASHIDA PASS');
process.exit(failures ? 1 : 0);
