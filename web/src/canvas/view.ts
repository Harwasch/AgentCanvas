// Canvas camera (pan/zoom). Kept outside React state so panning does not
// re-render nodes; components subscribe to derived booleans only.
import { createStore, useStore } from '../store';

export interface ViewState { x: number; y: number; z: number; w: number; h: number }
export const view = createStore<ViewState>({ x: 40, y: 80, z: 0.7, w: 1, h: 1 });
export const useView = <R,>(sel: (v: ViewState) => R) => useStore(view, sel);

export const LIVE_ZOOM = 0.55;
export const MIN_Z = 0.08, MAX_Z = 2.5;
export const clampZ = (z: number) => Math.min(MAX_Z, Math.max(MIN_Z, z));

export function zoomAt(factor: number, cx: number, cy: number) {
  const v = view.get();
  const z = clampZ(v.z * factor);
  const k = z / v.z;
  view.set({ z, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k });
}

let anim = 0;
export function animateTo(target: { x: number; y: number; z: number }, ms = 320) {
  cancelAnimationFrame(anim);
  const from = view.get();
  const t0 = performance.now();
  const step = (t: number) => {
    const p = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - p, 3);
    view.set({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, z: from.z + (target.z - from.z) * e });
    if (p < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}

export function fitBox(b: { x: number; y: number; w: number; h: number }, pad = 60, maxZ = 1, animate = true) {
  const v = view.get();
  const z = clampZ(Math.min((v.w - pad * 2) / Math.max(b.w, 1), (v.h - pad * 2 - 60) / Math.max(b.h, 1), maxZ));
  const x = (v.w - b.w * z) / 2 - b.x * z;
  const y = (v.h - 60 - b.h * z) / 2 - b.y * z + 10;
  if (animate) animateTo({ x, y, z }); else view.set({ x, y, z });
}

export function centerOn(b: { x: number; y: number; w: number; h: number }, minZ = 0.8) {
  const v = view.get();
  let z = Math.max(v.z, minZ);
  z = Math.min(z, (v.w - 32) / Math.max(b.w, 1), (v.h - 90) / Math.max(b.h, 1), 1.2);
  z = clampZ(z);
  animateTo({ x: v.w / 2 - (b.x + b.w / 2) * z, y: (v.h - 50) / 2 - (b.y + b.h / 2) * z, z });
}

// debugging / test hook
(globalThis as unknown as { __view?: typeof view }).__view = view;
