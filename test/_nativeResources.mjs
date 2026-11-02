// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { importSvg, createNativeScene } from '../src/index.js';
const NS = 'http://www.w3.org/2000/svg';
const source = (color, opacity = 1) =>
  `<svg xmlns="${NS}" viewBox="0 0 1 1"><path fill="${color}" fill-opacity="${opacity}" d="M0 0H1V1H0Z"/></svg>`;
const clip = `<svg xmlns="${NS}"><rect width="100" height="50"/></svg>`;
const world = new Float32Array([100, 0, 0, 0, 100, 0, 0, 0, 1]);
function pixel(color) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  return canvas;
}
function sceneIn(host, coordinateSpace = 'viewport') {
  const scene = createNativeScene(host, { coordinateSpace });
  scene.setViewport(100, 100);
  return scene;
}
async function raster(root, width, height, points) {
  const image = new Image();
  image.src =
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(new XMLSerializer().serializeToString(root));
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
}

export async function nativeResourcePixels() {
  const red = [255, 0, 0, 255],
    blue = [0, 0, 255, 255],
    white = [255, 255, 255, 255];
  const purple = [Math.round(0.5 * 255), 0, Math.round(0.5 * 255), 255];
  const expected = {
    'clip-in': [red, white, white, blue],
    'clip-out': [white, red, blue, white],
    instances: [red, red, blue, blue],
    'raster-clip': [red, white, white, blue],
    'raster-tint': [red, red, blue, blue],
    empty: [white, white, white, white],
    'bundle-empty': [white, white, white, white],
    'raster-before-vector': [purple, purple, purple, purple],
  };
  const rows = [];
  for (const mode of Object.keys(expected)) {
    const root = document.createElementNS(NS, 'svg');
    root.setAttribute('width', '200');
    root.setAttribute('height', '100');
    document.body.appendChild(root);
    const scenes = [];
    try {
      for (let i = 0; i < 2; i++) {
        const host = document.createElementNS(NS, 'svg');
        host.setAttribute('x', String(100 * i));
        root.appendChild(host);
        const scene = sceneIn(host, mode === 'bundle-empty' ? 'bundle' : 'viewport');
        scenes.push(scene);
        const bundle = await importSvg(
          source(i ? 'blue' : 'red', mode === 'raster-before-vector' ? 0.5 : 1),
          { retainSource: true },
        );
        if (mode.startsWith('clip'))
          scene.setNodeClip(bundle, {
            mode: mode === 'clip-out' ? 'out' : 'in',
            maskSvg: `<svg xmlns="${NS}"><rect y="${i ? 50 : 0}" width="100" height="50"/></svg>`,
          });
        scene.beginFrame([1, 1, 1, 1]);
        if (mode === 'instances')
          scene.drawBundleInstanced(bundle, [{ worldMatrix: world }, { worldMatrix: world }]);
        else if (mode === 'raster-clip')
          scene.drawImage(pixel(i ? 'blue' : 'red'), {
            dstRect: [0, i * 50, 100, 50],
            srcRect: [0, 0, 1, 1],
          });
        else if (mode === 'raster-tint')
          scene.drawImage(pixel('white'), {
            dstRect: [0, 0, 100, 100],
            tint: i ? [0, 0, 1, 1] : [1, 0, 0, 1],
          });
        else if (mode === 'raster-before-vector') {
          scene.drawImage(pixel(i ? 'red' : 'blue'), { dstRect: [0, 0, 100, 100] });
          scene.drawBundle(bundle, { worldMatrix: world });
        } else if (mode !== 'empty' && mode !== 'bundle-empty')
          scene.drawBundle(bundle, { worldMatrix: world });
        scene.endFrame();
      }
      const ids = [...root.querySelectorAll('[id]')].map((el) => el.id);
      const colors = await raster(root, 200, 100, [
        [25, 25],
        [25, 75],
        [125, 25],
        [125, 75],
      ]);
      rows.push({
        mode,
        duplicates: ids.filter((id, i) => ids.indexOf(id) !== i),
        colors,
        wrongPoints: colors.filter((color, i) => color.some((v, k) => v !== expected[mode][i][k]))
          .length,
      });
    } finally {
      for (const scene of scenes) scene.dispose();
      root.remove();
    }
  }
  return rows;
}

export async function nativeResourceLifetime() {
  const base = await importSvg(source('red'), { retainSource: true });
  const make = () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    return sceneIn(host);
  };
  const scene = make(),
    a = { ...base },
    b = { ...base };
  scene.setNodeClip(a, { maskSvg: clip });
  scene.setNodeClip(b, { maskSvg: clip });
  const count = () => scene.svg.querySelectorAll('defs clipPath,defs mask').length;
  scene.beginFrame();
  scene.drawBundle(a, { worldMatrix: world });
  scene.drawBundle(a, { worldMatrix: world });
  scene.endFrame();
  const twice = count();
  scene.beginFrame();
  scene.drawBundle(a, { worldMatrix: world });
  scene.endFrame();
  const once = count();
  const onceBottom = (await raster(scene.svg, 100, 100, [[25, 75]]))[0];
  scene.beginFrame();
  scene.drawBundle(b, { worldMatrix: world });
  scene.endFrame();
  const replaced = count();
  scene.beginFrame();
  scene.endFrame();
  const empty = count();
  const swap = make();
  for (const owner of [a, b]) {
    swap.setNodeClip(owner, { maskSvg: clip });
    swap.beginFrame();
    swap.drawBundle(owner, { worldMatrix: world });
    swap.endFrame();
  }
  const swappedDefs = swap.svg.querySelectorAll('defs clipPath,defs mask').length;
  const templates = make(),
    live = { ...base };
  const instances = () => {
    templates.beginFrame();
    templates.drawBundleInstanced(live, [{ worldMatrix: world }, { worldMatrix: world }]);
    templates.endFrame();
  };
  instances();
  const template = templates.svg.querySelector('defs > g[id^="mantleNativeInstance"]');
  templates.beginFrame();
  templates.endFrame();
  const templatesAfterEmpty = templates.svg.querySelectorAll(
    'defs > g[id^="mantleNativeInstance"]',
  ).length;
  instances();
  const templateReused =
    templates.svg.querySelector('defs > g[id^="mantleNativeInstance"]') === template;
  templates.beginFrame();
  templates.endFrame();
  const rasterScene = make();
  for (const color of ['red', 'blue']) {
    rasterScene.beginFrame();
    rasterScene.drawImage(pixel(color), {
      dstRect: [0, 0, 100, 100],
      srcRect: [0, 0, 1, 1],
      tint: [0.5, 1, 1, 1],
    });
    rasterScene.endFrame();
  }
  const rasterDefsAfterReplace = rasterScene.svg.querySelectorAll(
    'defs > clipPath,defs > filter',
  ).length;
  rasterScene.beginFrame();
  rasterScene.endFrame();
  const rasterDefsAfterTrim = rasterScene.svg.querySelectorAll(
    'defs > clipPath,defs > filter',
  ).length;
  const held = make(),
    refs = { clip: [], template: [] },
    mapSet = Map.prototype.set,
    weakSet = WeakMap.prototype.set;
  const observe = (value) => {
    if (value?.defId?.startsWith('mantleExtClip')) refs.clip.push(new WeakRef(value));
    else if (value?.id?.startsWith('mantleNativeInstance') && value.group)
      refs.template.push(new WeakRef(value));
  };
  Map.prototype.set = function (key, value) {
    observe(value);
    return mapSet.call(this, key, value);
  };
  WeakMap.prototype.set = function (key, value) {
    observe(value);
    return weakSet.call(this, key, value);
  };
  try {
    for (let i = 0; i < 16; i++) {
      const owner = { ...base };
      held.beginFrame();
      held.drawBundleInstanced(owner, [{ worldMatrix: world }, { worldMatrix: world }]);
      held.endFrame();
      held.beginFrame();
      held.endFrame();
      const clipped = { ...base };
      held.setNodeClip(clipped, { maskSvg: clip + '<!--' + i + '-->' });
    }
  } finally {
    Map.prototype.set = mapSet;
    WeakMap.prototype.set = weakSet;
  }
  const colorScene = make();
  (() => {
    const color = new Float64Array(new ArrayBuffer(1048576), 0, 4);
    color.set([0.2, 0.4, 0.6, 1]);
    refs.clearColor = [new WeakRef(color)];
    colorScene.beginFrame(color);
    colorScene.endFrame();
  })();
  const disposed = make();
  (() => {
    const owner = { ...base };
    disposed.setBundle(owner);
    refs.disposed = [new WeakRef(owner)];
  })();
  disposed.dispose();
  window.__nativeLifetime = {
    scenes: [scene, swap, templates, rasterScene, held, colorScene, disposed],
    refs,
  };
  return {
    twice,
    once,
    onceBottom,
    replaced,
    empty,
    swappedDefs,
    templatesAfterEmpty,
    templateReused,
    rasterDefsAfterReplace,
    rasterDefsAfterTrim,
    observed: { clip: refs.clip.length, template: refs.template.length },
    heldTemplateDefs: held.svg.querySelectorAll('defs > g[id^="mantleNativeInstance"]').length,
  };
}
