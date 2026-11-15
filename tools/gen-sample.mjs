// Deterministic sample-data generator. `node tools/gen-sample.mjs` writes
// data/meshes.json + data/reference.json. Same input -> same bytes (fixed seeds).
import { writeFileSync, mkdirSync } from "node:fs";
import { analyze, inconsistentEdgeCount, applyFlips } from "../src/core.mjs";

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r6 = (v) => Math.round(v * 1e6) / 1e6;

// ---- builders -------------------------------------------------------------

function sphere(nu, nlat, flippedRows) {
  const pos = [], idx = [];
  for (let i = 0; i <= nlat; i++) {
    const th = (Math.PI * i) / nlat;
    for (let j = 0; j < nu; j++) {
      const ph = (2 * Math.PI * j) / nu;
      pos.push(r6(Math.sin(th) * Math.cos(ph)), r6(Math.sin(th) * Math.sin(ph)), r6(Math.cos(th)));
    }
  }
  const id = (i, j) => i * nu + (j % nu);
  for (let i = 0; i < nlat; i++) for (let j = 0; j < nu; j++) {
    const a = id(i, j), b = id(i + 1, j), c = id(i + 1, j + 1), d = id(i, j + 1);
    const flip = flippedRows.some(([lo, hi]) => i >= lo && i < hi);
    const t0 = [a, b, c], t1 = [a, c, d];
    idx.push(...(flip ? [t0[0], t0[2], t0[1]] : t0), ...(flip ? [t1[0], t1[2], t1[1]] : t1));
  }
  return { positions: pos, indices: idx };
}

function grid(nu, nv, flippedRows) {
  const pos = [], idx = [];
  for (let i = 0; i <= nv; i++) for (let j = 0; j <= nu; j++) pos.push(r6(j / nu), 0, r6(i / nv));
  const id = (i, j) => i * (nu + 1) + j;
  for (let i = 0; i < nv; i++) for (let j = 0; j < nu; j++) {
    const a = id(i, j), b = id(i + 1, j), c = id(i + 1, j + 1), d = id(i, j + 1);
    const flip = flippedRows.some(([lo, hi]) => i >= lo && i < hi);
    const t0 = [a, b, c], t1 = [a, c, d];
    idx.push(...(flip ? [t0[0], t0[2], t0[1]] : t0), ...(flip ? [t1[0], t1[2], t1[1]] : t1));
  }
  return { positions: pos, indices: idx };
}

function cube(flipAll) {
  const P = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const pos = P.flat();
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const idx = [];
  for (const [a, b, c, d] of quads) {
    // outward-facing winding per face (checked by signed volume in verify)
    const t0 = [a, b, c], t1 = [a, c, d];
    idx.push(...(flipAll ? [t0[0], t0[2], t0[1]] : t0), ...(flipAll ? [t1[0], t1[2], t1[1]] : t1));
  }
  return { positions: pos, indices: idx };
}

// Möbius band: the u=2pi seam is glued to u=0 with v mirrored, which makes the
// dual graph carry an odd cycle. One boundary component, zero non-manifold edges.
function mobius(nu, nv) {
  const pos = [], idx = [];
  const V = (i, j) => {
    const u = (2 * Math.PI * i) / nu, v = -1 + (2 * j) / nv;
    const rr = 1 + (v / 2) * Math.cos(u / 2);
    return [r6(rr * Math.cos(u)), r6(rr * Math.sin(u)), r6((v / 2) * Math.sin(u / 2))];
  };
  for (let i = 0; i < nu; i++) for (let j = 0; j <= nv; j++) pos.push(...V(i, j));
  const id = (i, j) => i * (nv + 1) + j;
  const nxt = (i, j) => (i + 1 < nu ? id(i + 1, j) : id(0, nv - j)); // seam mirror
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = id(i, j), b = nxt(i, j), c = nxt(i, j + 1), d = id(i, j + 1);
    idx.push(a, b, c, a, c, d);
  }
  return { positions: pos, indices: idx };
}

function tetra(flipFaces) {
  const pos = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
  const faces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]; // outward
  const idx = [];
  faces.forEach((f, i) => { const flip = flipFaces.includes(i); idx.push(...(flip ? [f[0], f[2], f[1]] : f)); });
  return { positions: pos, indices: idx };
}

function concat(a, b) {
  const off = a.positions.length / 3;
  return { positions: a.positions.concat(b.positions), indices: a.indices.concat(b.indices.map((v) => v + off)) };
}

// A grid plus extra faces glued onto existing edges -> edges with 3 and 4 faces.
function nonmanifoldFan() {
  const g = grid(4, 4, []);
  const pos = g.positions.slice(), idx = g.indices.slice();
  const extra = [[1, 0, 5], [1, 0, 6], [1, 0, 7]];
  for (const f of extra) idx.push(...f);
  // collinear (exactly zero-area) triangle using three collinear grid vertices
  idx.push(2, 3, 4); // (x=0,1,2 at z=0) -> collinear
  return { positions: pos, indices: idx };
}

function degenerateCorpus() {
  const g = grid(3, 3, []);
  const pos = g.positions.slice(), idx = g.indices.slice();
  idx.push(0, 0, 1);          // repeated index
  idx.push(4, 4, 4);          // fully repeated
  return { positions: pos, indices: idx };
}

// ---- corpora --------------------------------------------------------------

const corpora = {
  "tetra-2flip": tetra([1, 2]),
  "cube-inverted": cube(true),
  "grid-open-1band": grid(8, 8, [[3, 4]]),
  "nonmanifold-fan": nonmanifoldFan(),
  "degenerate-2faces": degenerateCorpus(),
  "mobius-small": mobius(4, 1),
  "mobius": mobius(24, 3),
  "sphere-band12": sphere(160, 120, [[40, 59]]),          // ~15.8% of faces in a band
  "sphere-inverted88": sphere(64, 48, [[0, 40]]),          // face 0 flipped on purpose
  "mixed-3comp": concat(concat(sphere(32, 24, [[8, 12]]), mobius(24, 3)), cube(true)),
};

// canonical digest: stable, position-independent, recomputable in the browser.
function digest(mesh, cert) {
  let h = 2166136261 >>> 0;
  const feed = (x) => { h ^= (Math.round(x) | 0) >>> 0; h = Math.imul(h, 16777619) >>> 0; };
  for (const f of mesh.indices) feed(f + 7);
  for (const [k, v] of Object.entries(cert.counts)) feed(v);
  feed(cert.minConsistencyFlipCount); feed(cert.flipCount); feed(cert.nonOrientableComponents);
  for (const c of cert.components) { feed(c.faces); feed(c.orientable ? 1 : 0); feed(c.minConsistencyFlipCount ?? -1); }
  for (const f of cert.minConsistencyFlipSet) feed(f * 31 + 1);
  return h.toString(16).padStart(8, "0");
}

const reference = {};
for (const [name, mesh] of Object.entries(corpora)) {
  const cert = analyze(mesh);
  const applied = applyFlips(mesh.indices, cert.flipSet);
  reference[name] = {
    vertices: cert.stats.vertexCount, faces: cert.stats.faceCount,
    manifoldEdges: cert.counts.manifold, boundaryEdges: cert.counts.boundary,
    nonManifoldEdges: cert.counts.nonManifold, inconsistentEdges: cert.counts.inconsistent,
    minConsistencyFlipCount: cert.minConsistencyFlipCount,
    chosenFlipCount: cert.flipCount,
    outwardOnlyFlipCount: cert.outwardOnlyFlipCount,
    nonOrientableComponents: cert.nonOrientableComponents,
    witnessFaces: cert.witness ? cert.witness.faces.length : 0,
    unresolved: cert.unresolved,
    zeroAreaFaces: cert.stats.zeroAreaFaces,
    repeatedIndexFaces: cert.stats.repeatedIndexFaces,
    inconsistentAfterFix: inconsistentEdgeCount(applied),
    digest: digest(mesh, cert),
  };
}

mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
const out = new URL("../data/", import.meta.url);
writeFileSync(new URL("meshes.json", out), JSON.stringify(corpora));
writeFileSync(new URL("reference.json", out), JSON.stringify(reference, null, 1));
console.log(`wrote ${Object.keys(corpora).length} corpora`);
for (const [k, v] of Object.entries(reference)) {
  console.log(`${k.padEnd(20)} V=${String(v.vertices).padStart(6)} F=${String(v.faces).padStart(6)} incons=${String(v.inconsistentEdges).padStart(6)} minFlip=${String(v.minConsistencyFlipCount).padStart(6)} chosen=${String(v.chosenFlipCount).padStart(6)} nonOrient=${v.nonOrientableComponents} afterFix=${v.inconsistentAfterFix} dig=${v.digest}`);
}
