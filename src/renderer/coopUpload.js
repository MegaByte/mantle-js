// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// coopUpload -- the loading call's big vertex uploads, made cooperative.
//
// A bufferData of a few MB goes through the command buffer's transfer ring; while the GPU process is busy building a pipeline the ring does not drain and the call
// holds the page for the build's length (on the order of 100 ms on a loading screen). In the loading call (setCoopUploads on) an upload of at least MIN_COOP_BYTES
// only ALLOCATES the buffer (bufferData with a size) and queues the fill; the loading driver pumps the queue between its steps, one SLICE_BYTES bufferSubData at a
// time, and only while the GPU thread is clear (the same gate as every other loading query), and drains it before the loading call ends. Outside the loading
// call (off), every upload is a plain bufferData. ARRAY_BUFFER only: the element-array binding is VAO state.
const queues = new WeakMap();
export const SLICE_BYTES = 8 * 1024; // (well under what a busy GPU process leaves of the command ring: 16 KB is where the driver model starts to wait)
export const MIN_COOP_BYTES = 16 * 1024;
const q = (gl) => {
  let s = queues.get(gl);
  if (!s) queues.set(gl, (s = { on: false, gate: null, items: new Map(), bytes: 0 }));
  return s;
};
/// `gate()` answers true when the GPU thread is clear.
export function setCoopUploads(gl, on, gate) {
  const s = q(gl);
  s.on = !!on;
  s.gate = on ? gate || null : null;
}
export function pendingUploadBytes(gl) {
  const s = queues.get(gl);
  return s ? s.bytes : 0;
}
/// Bind `buffer` to ARRAY_BUFFER and give it `view` (as gl.bufferData(gl.ARRAY_BUFFER, view, usage) would), cooperatively when the loading call asked for it.
export function uploadBuffer(gl, buffer, view, usage) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const s = queues.get(gl);
  if (s) {
    const old = s.items.get(buffer);
    if (old) {
      s.bytes -= old.view.byteLength - old.off;
      s.items.delete(buffer);
    }
  }
  if (!s || !s.on || !view || !ArrayBuffer.isView(view) || view.byteLength < MIN_COOP_BYTES) {
    gl.bufferData(gl.ARRAY_BUFFER, view, usage);
    return;
  }
  gl.bufferData(gl.ARRAY_BUFFER, view.byteLength, usage);
  s.items.set(buffer, { view, off: 0 });
  s.bytes += view.byteLength;
}
/// Fill queued buffers, one slice per call to bufferSubData, while the GPU thread is clear and `budgetMs` allows. Returns the bytes still pending.
export function pumpUploads(gl, budgetMs = 3) {
  const s = queues.get(gl);
  if (!s || !s.items.size) return 0;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const t0 = now();
  const saved = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
  try {
    for (const [buf, it] of s.items) {
      if (typeof gl.isBuffer === 'function' && gl.isBuffer(buf) === false) {
        s.bytes -= it.view.byteLength - it.off;
        s.items.delete(buf);
        continue;
      }
      while (it.off < it.view.byteLength) {
        if (s.gate && !s.gate()) return s.bytes;
        if (now() - t0 >= budgetMs) return s.bytes;
        const n = Math.min(SLICE_BYTES, it.view.byteLength - it.off);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          it.off,
          new Uint8Array(it.view.buffer, it.view.byteOffset + it.off, n),
        );
        it.off += n;
        s.bytes -= n;
      }
      s.items.delete(buf);
    }
  } finally {
    gl.bindBuffer(gl.ARRAY_BUFFER, saved);
  }
  return s.bytes;
}
