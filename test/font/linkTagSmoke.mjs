// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// linkTagSmoke.mjs — <link=id> tag.
//
// <link> propagates an opaque id through Style.linkId on every span
// emitted between <link=id> and </link>. Spans outside the tag carry
// null. The id is parser-opaque (URL, route, tooltip id, …); downstream
// hit-test code does the mapping.

import { parseMarkup, defaultStyle } from '../../src/font/markupParser.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// ---- T1: <link=id> sets linkId on inner span ----
{
  const spans = parseMarkup('<link=foo>X</link>', defaultStyle());
  if (spans.length !== 1) fail(`T1 span count ${spans.length}`);
  if (spans[0].style.linkId !== 'foo') fail(`T1 linkId "${spans[0].style.linkId}"`);
  ok(`T1 <link=foo> → linkId="foo"`);
}

// ---- T2: outer text is unaffected ----
{
  const spans = parseMarkup('a<link=foo>b</link>c', defaultStyle());
  if (spans.length !== 3) fail(`T2 span count ${spans.length}`);
  if (spans[0].style.linkId !== null) fail(`T2 outer-left linkId ${spans[0].style.linkId}`);
  if (spans[1].style.linkId !== 'foo') fail(`T2 inner linkId ${spans[1].style.linkId}`);
  if (spans[2].style.linkId !== null) fail(`T2 outer-right linkId ${spans[2].style.linkId}`);
  ok(`T2 link scope contains only inner span`);
}

// ---- T3: <link="quoted"> strips surrounding quotes ----
{
  const spans = parseMarkup('<link="https://example.com">X</link>', defaultStyle());
  if (spans[0].style.linkId !== 'https://example.com')
    fail(`T3 quoted linkId "${spans[0].style.linkId}"`);
  ok(`T3 quoted link value`);
}

// ---- T4: nested links — inner shadows outer, restoration on close ----
{
  const spans = parseMarkup('<link=a>X<link=b>Y</link>Z</link>', defaultStyle());
  if (spans.length !== 3) fail(`T4 span count ${spans.length}`);
  if (spans[0].style.linkId !== 'a') fail(`T4 outer X linkId ${spans[0].style.linkId}`);
  if (spans[1].style.linkId !== 'b') fail(`T4 inner Y linkId ${spans[1].style.linkId}`);
  if (spans[2].style.linkId !== 'a') fail(`T4 restored Z linkId ${spans[2].style.linkId}`);
  ok(`T4 nested links push/pop correctly`);
}

// ---- T5: linkId composes with other styles ----
{
  const spans = parseMarkup('<link=x><b><color=red>X</color></b></link>', defaultStyle());
  if (spans[0].style.linkId !== 'x') fail(`T5 linkId ${spans[0].style.linkId}`);
  if (!spans[0].style.bold) fail('T5 bold');
  if (spans[0].style.color[0] !== 1) fail('T5 color.r');
  ok(`T5 link composes with bold + color`);
}

// ---- T6: <link> with no value passes through verbatim ----
{
  const spans = parseMarkup('a<link>b', defaultStyle());
  // Open tag without value: the bare '<link>' substring is appended into
  // the buffer, then 'b' continues; the parser flushes on '<' so we get
  // separate buffer chunks. The contract is "no link gets attached",
  // which we check by ensuring no span carries linkId.
  for (const sp of spans)
    if (sp.style.linkId !== null) fail(`T6 unexpected linkId "${sp.style.linkId}"`);
  ok(`T6 valueless <link> is no-op (passes through)`);
}

// ---- T7: dangling </link> with no open is a pass-through, not a pop ----
{
  const spans = parseMarkup('hello</link>world', defaultStyle());
  for (const sp of spans)
    if (sp.style.linkId !== null) fail(`T7 unexpected linkId "${sp.style.linkId}"`);
  ok(`T7 dangling </link> is pass-through`);
}

console.log();
console.log(failures === 0 ? 'LINK-TAG PASS' : `LINK-TAG FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
