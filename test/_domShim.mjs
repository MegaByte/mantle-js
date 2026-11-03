// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Minimal DOM shim over @xmldom/xmldom so the native scene and the frame export run in node
// (querySelectorAll over simple selectors, style, children, remove, contains). Test support only.
const x = await import('@xmldom/xmldom');
const doc0 = new x.DOMParser().parseFromString('<a/>', 'text/xml');
const E = Object.getPrototypeOf(doc0.documentElement),
  N = Object.getPrototypeOf(E);
function walk(el, f) {
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1) {
      f(c);
      walk(c, f);
    }
  }
}
function match(sel, el) {
  if (sel === '*') return true;
  if (sel === '[id]') return el.hasAttribute('id');
  if (/^[A-Za-z][\w:-]*$/.test(sel)) return (el.localName || el.tagName) === sel;
  return false;
}
function qsa(sel) {
  const out = [];
  const sels = sel.split(',').map((s) => s.trim());
  walk(this, (e) => {
    if (sels.some((s) => match(s, e))) out.push(e);
  });
  return out;
}
const def = (o, k, d) => {
  if (!(k in o)) Object.defineProperty(o, k, d);
};
def(E, 'querySelectorAll', { value: qsa, configurable: true });
def(E, 'querySelector', {
  value: function (s) {
    return qsa.call(this, s)[0] || null;
  },
  configurable: true,
});
def(E, 'children', {
  get() {
    const a = [];
    for (let c = this.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) a.push(c);
    return a;
  },
  configurable: true,
});
def(N, 'remove', {
  value: function () {
    if (this.parentNode) this.parentNode.removeChild(this);
  },
  configurable: true,
});
const proto = Object.getPrototypeOf(doc0.createTextNode('t'));
N.childNodes = Object.freeze({
  length: 0,
  item() {
    return null;
  },
});
def(proto, 'childNodes', {
  get() {
    return { length: 0 };
  },
  configurable: true,
});
def(Object.getPrototypeOf(doc0.createComment('t')), 'childNodes', {
  get() {
    return { length: 0 };
  },
  configurable: true,
});
function parseStyle(s) {
  const m = new Map();
  for (const p of (s || '').split(';')) {
    const i = p.indexOf(':');
    if (i > 0) {
      let v = p.slice(i + 1).trim();
      let pr = '';
      if (/!important$/.test(v)) {
        pr = 'important';
        v = v.replace(/\s*!important$/, '');
      }
      m.set(p.slice(0, i).trim(), [v, pr]);
    }
  }
  return m;
}
function wr(el, m) {
  const s = [...m].map(([k, [v, p]]) => `${k}:${v}${p ? ' !important' : ''}`).join(';');
  if (s) el.setAttribute('style', s);
  else el.removeAttribute('style');
}
def(E, 'style', {
  get() {
    const el = this;
    return new Proxy(
      {},
      {
        get(_, k) {
          if (k === 'getPropertyValue')
            return (n) => (parseStyle(el.getAttribute('style')).get(n) || [''])[0];
          if (k === 'getPropertyPriority')
            return (n) => (parseStyle(el.getAttribute('style')).get(n) || ['', ''])[1];
          if (k === 'setProperty')
            return (n, v, p) => {
              const m = parseStyle(el.getAttribute('style'));
              if (v === '' || v == null) m.delete(n);
              else m.set(n, [String(v), p || '']);
              wr(el, m);
            };
          if (k === 'removeProperty')
            return (n) => {
              const m = parseStyle(el.getAttribute('style'));
              m.delete(n);
              wr(el, m);
            };
          const n = String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
          return (parseStyle(el.getAttribute('style')).get(n) || [''])[0];
        },
        set(_, k, v) {
          const n = String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
          const m = parseStyle(el.getAttribute('style'));
          if (v === '' || v == null) m.delete(n);
          else m.set(n, [String(v), '']);
          wr(el, m);
          return true;
        },
      },
    );
  },
  configurable: true,
});
export const xmldom = x;
export const doc = new x.DOMParser().parseFromString(
  '<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>',
  'text/xml',
);
def(N, 'contains', {
  value: function (o) {
    for (let n = o; n; n = n.parentNode) if (n === this) return true;
    return false;
  },
  configurable: true,
});
// browsers return null for an absent attribute; xmldom returns ''
const _ga = E.getAttribute;
E.getAttribute = function (n) {
  return this.hasAttribute(n) ? _ga.call(this, n) : null;
};
