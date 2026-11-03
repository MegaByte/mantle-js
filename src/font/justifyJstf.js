// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// justifyJstf.js — OpenType JSTF justification of one laid-out line.
//
// The JSTF table lists, per script and language system, prioritized suggestions for lengthening ("extension") or shortening
// ("shrinkage") a line: GSUB and GPOS lookups to enable or disable, and JstfMax lookups that give the most a glyph may move.
// Each priority stands alone, and every one is applied to an unmodified glyph string, so a priority is tried by shaping the
// line again from its source text with that priority's changes (GsubReader/GposReader.setJustification) and measuring it.
//
//   extension (slack > 0): the first priority whose lookup changes reach the target width, or whose changes plus a share of
//     its JstfMax values do (the share is solved for: JstfMax adds linearly, so the share is exact), is applied. Priorities that
//     overshoot are skipped. When none reaches the target, the one that gets closest without overshooting is applied and the
//     rest of the slack goes to the extender glyphs and the spaces.
//   shrinkage (slack < 0): the same, toward a narrower line.
//
// Ref: https://learn.microsoft.com/en-us/typography/opentype/spec/jstf

const EPS = 1e-6;

/// The JSTF script tag, as a string, and the language system tag of a line, or null when no font in the line has priorities.
export function jstfSelectionFor(line, layout, scriptTagsOf) {
  let font = null,
    slot = null;
  for (const s of line)
    if (s.font && s.font.jstf && s.font.jstf.hasAnyPriorities) {
      font = s.font;
      slot = s;
      break;
    }
  if (!font) return null;
  const cps = line.map((s) => s.codepoint || 0);
  const perCp = scriptTagsOf ? scriptTagsOf(cps) : null;
  const tags = perCp ? perCp[line.indexOf(slot)] || perCp.find(Boolean) : null;
  const candidates = (tags || []).map(tagName);
  candidates.push('DFLT', 'latn');
  const lang = layout.language
    ? (String(layout.language).trim().toUpperCase() + '    ').slice(0, 4)
    : '';
  for (const name of candidates) {
    if (font.jstf.getPriorities(name, lang)) return { script: name, lang, font };
  }
  return null;
}

function tagName(t) {
  return String.fromCharCode(t >>> 24, (t >>> 16) & 255, (t >>> 8) & 255, t & 255);
}

/// The GSUB and GPOS modifications of `font` for one justification trial, or null when the font has none for it.
/// cfg: { script, lang, priority, mode: 'extend' | 'shrink', scale }.
export function jstfModsFor(font, cfg) {
  if (!font || !font.jstf || !font.jstf.hasJstf) return null;
  const list = font.jstf.getPriorities(cfg.script, cfg.lang);
  const priority = list && list[cfg.priority];
  if (!priority) return null;
  const part = cfg.mode === 'extend' ? priority.extend : priority.shrink;
  // Readers cache resolved lookups under this id. A priority number means nothing without its script and language system.
  const id = `${cfg.script}|${cfg.lang}|${cfg.priority}|${cfg.mode}|${Math.round(cfg.scale * 1e4)}`;
  const gsub =
    part.gsubEnable.length || part.gsubDisable.length
      ? { id, enable: part.gsubEnable, disable: new Set(part.gsubDisable) }
      : null;
  const gpos =
    part.gposEnable.length || part.gposDisable.length || part.max.length
      ? {
          id,
          enable: part.gposEnable,
          disable: new Set(part.gposDisable),
          maxLookups: part.max,
          maxScale: cfg.scale,
          range: font.jstf.range,
        }
      : null;
  return { gsub, gpos };
}

/// Install the trial's lookup changes on every font's readers; returns the function that removes them.
export function installJstf(fonts, cfg) {
  const done = [];
  for (const font of fonts) {
    if (!font || done.includes(font)) continue;
    done.push(font);
    const mods = jstfModsFor(font, cfg);
    font.gsub.setJustification && font.gsub.setJustification(mods ? mods.gsub : null);
    font.gpos.setJustification && font.gpos.setJustification(mods ? mods.gpos : null);
  }
  return () => {
    for (const font of done) {
      font.gsub.setJustification && font.gsub.setJustification(null);
      font.gpos.setJustification && font.gpos.setJustification(null);
    }
  };
}

const widthOf = (slots) => {
  let lo = Infinity,
    hi = -Infinity;
  for (const s of slots) {
    lo = Math.min(lo, s.penX);
    hi = Math.max(hi, s.penX + s.advance);
  }
  return slots.length ? hi - lo : 0;
};

/// Justify one line against its JSTF priorities. `ctx`: { spans, text (the spans' text joined), spanStarts, relayout(subSpans,
/// cfg, paragraphRtl) -> slots, scriptTagsOf }. `line`: the line's slots in visual order; `slack`: usable width minus the line's advance.
/// Returns { slots, delta } (the re-shaped line and its width change), or null to leave the line alone.
export function justifyLineWithJstf(ctx, line, layout, slack, paragraphRtl) {
  if (!line.length || !Number.isFinite(slack) || Math.abs(slack) < EPS) return null;
  const selection = jstfSelectionFor(line, layout, ctx.scriptTagsOf);
  if (!selection) return null;
  // The source text of the line: from its first cluster to the end of its last one.
  let lo = Infinity,
    hi = -1;
  for (const s of line) {
    if (s.sourceCluster === undefined || s.sourceClusterEnd === undefined) return null;
    lo = Math.min(lo, s.sourceCluster);
    hi = Math.max(hi, s.sourceClusterEnd);
  }
  const spans = [];
  for (let i = 0; i < ctx.spans.length; i++) {
    const span = ctx.spans[i];
    if (span.directive || !span.text) continue;
    const a = ctx.spanStarts[i],
      b = a + span.text.length;
    if (b <= lo || a >= hi) continue;
    const from = Math.max(lo, a) - a,
      to = Math.min(hi, b) - a;
    spans.push({ ...span, text: span.text.slice(from, to) });
  }
  if (!spans.length) return null;
  // Trial layouts start at zero; published slots retain paragraph source offsets.
  const result = (slots, delta) => ({
    slots: slots.map((s) => ({
      ...s,
      ...(s.sourceCluster === undefined ? {} : { sourceCluster: s.sourceCluster + lo }),
      ...(s.sourceClusterEnd === undefined ? {} : { sourceClusterEnd: s.sourceClusterEnd + lo }),
    })),
    delta,
  });
  const mode = slack > 0 ? 'extend' : 'shrink';
  const trial = (priority, scale) =>
    ctx.relayout(
      spans,
      { script: selection.script, lang: selection.lang, priority, mode, scale },
      paragraphRtl,
    );
  const base = ctx.relayout(spans, null, paragraphRtl);
  const w0 = widthOf(base);
  const list = selection.font.jstf.getPriorities(selection.script, selection.lang);
  let best = null; // { slots, delta, priority }
  const consider = (slots, delta) => {
    // closer to the target without overshooting
    const over = slack > 0 ? delta > slack + EPS : delta < slack - EPS;
    if (over || (slack > 0 ? delta <= 0 : delta >= 0)) return;
    if (!best || Math.abs(slack - delta) < Math.abs(slack - best.delta)) best = { slots, delta };
  };
  for (let p = 0; p < list.length; p++) {
    const r0 = trial(p, 0),
      d0 = widthOf(r0) - w0;
    const overshoot0 = slack > 0 ? d0 > slack + EPS : d0 < slack - EPS;
    if (overshoot0) continue;
    if (Math.abs(slack - d0) <= EPS) return result(r0, d0);
    const part = mode === 'extend' ? list[p].extend : list[p].shrink;
    if (part.max.length) {
      const r1 = trial(p, 1),
        d1 = widthOf(r1) - w0;
      const reaches = slack > 0 ? d1 >= slack - EPS : d1 <= slack + EPS;
      if (reaches && Math.abs(d1 - d0) > EPS) {
        const f = Math.min(1, Math.max(0, (slack - d0) / (d1 - d0)));
        const r = trial(p, f),
          d = widthOf(r) - w0;
        return result(r, d);
      }
      consider(r1, d1);
    }
    consider(r0, d0);
  }
  return best ? result(best.slots, best.delta) : null;
}
