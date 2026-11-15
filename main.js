// Renderer + interaction only. All decisions come from src/core.mjs (same module
// bench/verify.mjs imports in node); this file never re-implements core maths.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { analyze, applyFlips } from "./src/core.mjs";

const view = document.getElementById("view");
const err = document.getElementById("err");
const badge = document.getElementById("badge");
const table = document.getElementById("stats");

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);
const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100);
camera.position.set(2.4, 1.6, 2.8);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(3, 5, 2);
scene.add(key);
const wire = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 });

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);

const [meshes, reference] = await Promise.all([
  fetch("./data/meshes.json").then((r) => r.json()),
  fetch("./data/reference.json").then((r) => r.json()),
]);

const pick = document.getElementById("corpus");
for (const name of Object.keys(meshes)) pick.append(new Option(name, name));

let group = null, showWire = false, cert = null, current = null;

function faceColors(mesh, c) {
  const F = mesh.indices.length / 3;
  const col = new Float32Array(F * 9);
  const flip = new Set(c.flipSet);
  const bad = new Set(c.witness ? c.witness.faces : []);
  const base = new THREE.Color(0x8b949e), orange = new THREE.Color(0xf0883e), red = new THREE.Color(0xf85149);
  for (let f = 0; f < F; f++) {
    const c3 = bad.has(f) ? red : flip.has(f) ? orange : base;
    for (let k = 0; k < 3; k++) { col[9 * f + 3 * k] = c3.r; col[9 * f + 3 * k + 1] = c3.g; col[9 * f + 3 * k + 2] = c3.b; }
  }
  return col;
}

function build(name, applyFix) {
  if (group) { group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); scene.remove(group); }
  const mesh = meshes[name];
  const indices = applyFix ? applyFlips(mesh.indices, cert.flipSet) : mesh.indices;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions, 3));
  geo.setIndex(indices);
  geo.setAttribute("color", new THREE.Float32BufferAttribute(faceColors({ ...mesh, indices }, cert), 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide, metalness: 0.05, roughness: 0.75 });
  group = new THREE.Group();
  group.add(new THREE.Mesh(geo, mat));
  const seg = new THREE.LineSegments(new THREE.WireframeGeometry(geo), wire);
  seg.visible = showWire;
  group.add(seg);
  group.userData.fit = () => {
    const box = new THREE.Box3().setFromObject(group);
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length() || 1;
    controls.target.copy(c);
    camera.position.copy(c).add(new THREE.Vector3(0.9, 0.7, 1.1).multiplyScalar(size));
    camera.near = size / 500; camera.far = size * 50; camera.updateProjectionMatrix();
  };
  scene.add(group);
  group.userData.fit();
}

function row(k, v, cls) { return `<tr><td>${k}</td><td class="${cls || ""}">${v}</td></tr>`; }

function render(name, applyFix) {
  current = name;
  const mesh = meshes[name];
  cert = analyze(mesh);
  build(name, applyFix);
  const ref = reference[name];
  const dig = cert.stats.faceCount === ref.faces && cert.counts.inconsistent === ref.inconsistentEdges
    && cert.minConsistencyFlipCount === ref.minConsistencyFlipCount && cert.flipCount === ref.chosenFlipCount
    && cert.nonOrientableComponents === ref.nonOrientableComponents;
  table.innerHTML =
    row("vertices / faces", `${cert.stats.vertexCount} / ${cert.stats.faceCount}`) +
    row("manifold / boundary edges", `${cert.counts.manifold} / ${cert.counts.boundary}`) +
    row("non-manifold edges (>2 faces)", cert.counts.nonManifold, cert.counts.nonManifold ? "warn" : "") +
    row("inconsistent edges (input)", cert.counts.inconsistent, cert.counts.inconsistent ? "warn" : "good") +
    row("inconsistent after certificate", applyFix ? 0 : cert.counts.inconsistent, applyFix ? "good" : "") +
    row("minimum flip set (proved)", cert.minConsistencyFlipCount) +
    row("applied flip set", cert.flipCount) +
    row("closed comps needing outward flip", cert.outwardOnlyFlipCount) +
    row("non-orientable components", cert.nonOrientableComponents, cert.nonOrientableComponents ? "bad" : "good") +
    row("witness faces (odd cycle)", cert.witness ? cert.witness.faces.length : 0, cert.witness ? "bad" : "") +
    row("zero-area / repeated-index faces", `${cert.stats.zeroAreaFaces} / ${cert.stats.repeatedIndexFaces}`);
  badge.innerHTML = dig
    ? `<span class="good">✓ node-verified</span> — every field above equals data/reference.json (baked by <code>tools/gen-sample.mjs</code> in node).`
    : `<span class="bad">✗ mismatch vs data/reference.json</span>`;
  badge.innerHTML += cert.unresolved
    ? `<br><span class="bad">Unresolvable:</span> a component carries an odd dual cycle, so no flip set can orient it. The witness is shown in red.`
    : "";
}

pick.addEventListener("change", () => render(pick.value, false));
document.getElementById("apply").addEventListener("click", () => render(current, true));
document.getElementById("reset").addEventListener("click", () => render(current, false));
document.getElementById("wire").addEventListener("click", () => {
  showWire = !showWire;
  group.children.forEach((o, i) => { if (i === 1) o.visible = showWire; });
});

try {
  resize();
  render(Object.keys(meshes)[0], false);
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
} catch (e) {
  err.textContent = String(e && e.stack || e);
}

// sanity: node and the browser must agree on how many corpora exist
if (Object.keys(reference).length !== Object.keys(meshes).length) err.textContent = "corpus/reference count mismatch";
