// Interactive STL viewer (three.js + OrbitControls). Loaded on demand by 3D file nodes.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

export interface StlView {
  setWire(on: boolean): void;
  reset(): void;
  snapshot(): string | null;
  dispose(): void;
  info: { tris: number };
}

export function mountStl(canvas: HTMLCanvasElement, buf: ArrayBuffer, color = '#C9CCD2'): StlView {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor('#0B0C0E');
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 10000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x222428, 1.1));
  const dir = new THREE.DirectionalLight(0xffffff, 1.4);
  dir.position.set(1, 1.4, 2);
  scene.add(dir);

  const geo = new STLLoader().parse(buf);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const center = bb.getCenter(new THREE.Vector3());
  geo.translate(-center.x, -center.y, -center.z);
  const size = bb.getSize(new THREE.Vector3()).length() || 1;
  const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.15, roughness: 0.55, flatShading: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  scene.add(mesh);
  const grid = new THREE.GridHelper(size * 1.6, 16, 0x2a2d33, 0x1a1c21);
  grid.position.y = -(bb.max.z - bb.min.z) / 2 - 0.5;
  scene.add(grid);

  const controls = new OrbitControls(cam, canvas);
  controls.enableDamping = true;
  const home = () => {
    cam.position.set(size * 0.75, size * 0.55, size * 0.95);
    cam.near = size / 100; cam.far = size * 20; cam.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.update();
  };
  home();

  let raf = 0, w = 0, h = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (cw && ch && (cw !== w || ch !== h)) {
      w = cw; h = ch;
      renderer.setSize(w, h, false);
      cam.aspect = w / h; cam.updateProjectionMatrix();
    }
    controls.update();
    renderer.render(scene, cam);
  };
  loop();
  const tris = (geo.attributes.position?.count || 0) / 3;
  return {
    info: { tris },
    setWire: (on) => { mat.wireframe = on; },
    reset: home,
    snapshot: () => { try { renderer.render(scene, cam); return canvas.toDataURL('image/png'); } catch { return null; } },
    dispose: () => {
      cancelAnimationFrame(raf);
      controls.dispose();
      geo.dispose(); mat.dispose();
      renderer.dispose();
      try { renderer.forceContextLoss(); } catch { /* */ }
    },
  };
}
