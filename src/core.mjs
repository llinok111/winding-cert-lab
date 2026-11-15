// winding-cert-lab · pure computational core.
// No `three`, no DOM, no I/O, no top-level side effects: `node -e "import('./src/core.mjs')"` is silent.
//
// Mesh ABI (plain JS, JSON-friendly):
//   mesh = { positions: number[3V] (x,y,z per vertex), indices: number[3F] (triangle corners) }
//
// The orientation certificate is a *combinatorial* property of `indices` only.
// The single numeric tolerance in this file is AREA_EPS_REL, a RELATIVE zero-area
// threshold (area <= AREA_EPS_REL * bboxDiag^2). It is never used for orientation,
// only for the `zeroAreaFaces` side metric; being relative to bboxDiag^2 it is
// invariant under uniform scaling of `positions`.

export const AREA_EPS_REL = 1e-12;
// A closed component is only declared "outside-out" when |signed volume| exceeds
// this RELATIVE bound; volume scales as s^3, so the decision is scale invariant.
export const VOL_EPS_REL = 1e-15;
const BIG = 4294967296; // 2^32; vertex ids must stay below it

export function meshStats(mesh) {
  const P = mesh.positions, I = mesh.indices;
  const V = (P.length / 3) | 0, F = (I.length / 3) | 0;
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let v = 0; v < V; v++) {
    const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
    if (z < mnz) mnz = z; if (z > mxz) mxz = z;
  }
  const bboxDiag = V ? Math.hypot(mxx - mnx, mxy - mny, mxz - mnz) : 0;
  const areaEps = AREA_EPS_REL * bboxDiag * bboxDiag;
  let repeatedIndexFaces = 0, zeroAreaFaces = 0, outOfRange = 0;
  for (let f = 0; f < F; f++) {
    const a = I[3 * f], b = I[3 * f + 1], c = I[3 * f + 2];
    if (a >= V || b >= V || c >= V || a < 0 || b < 0 || c < 0) { outOfRange++; continue; }
    if (a === b || b === c || c === a) { repeatedIndexFaces++; continue; }
    const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
    const wx = P[3 * c] - P[3 * a], wy = P[3 * c + 1] - P[3 * a + 1], wz = P[3 * c + 2] - P[3 * a + 2];
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    if (0.5 * Math.hypot(cx, cy, cz) <= areaEps) zeroAreaFaces++;
  }
  return { vertexCount: V, faceCount: F, bboxDiag, areaEps, repeatedIndexFaces, zeroAreaFaces, outOfRange };
}

// Undirected edge table. Value is a flat array [face0, dir0, face1, dir1, ...];
// dir = +1 when the face visits the smaller vertex id first, -1 otherwise.
export function buildEdgeMap(indices) {
  const F = (indices.length / 3) | 0;
  const map = new Map();
  for (let f = 0; f < F; f++) {
    const a = indices[3 * f], b = indices[3 * f + 1], c = indices[3 * f + 2];
    for (let k = 0; k < 3; k++) {
      const u = k === 0 ? a : k === 1 ? b : c;
      const v = k === 0 ? b : k === 1 ? c : a;
      if (u === v) continue; // repeated index: no undirected edge
      const key = u < v ? u * BIG + v : v * BIG + u;
      const dir = u < v ? 1 : -1;
      const arr = map.get(key);
      if (arr) arr.push(f, dir); else map.set(key, [f, dir]);
    }
  }
  return map;
}

// A 2-face edge demands flip(f) XOR flip(g) === req(f,g).
function edgeReq(d0, d1) { return d0 * d1 === 1 ? 1 : 0; }

export function edgeCounts(edgeMap) {
  let manifold = 0, boundary = 0, nonManifold = 0, inconsistent = 0;
  for (const arr of edgeMap.values()) {
    const n = arr.length >> 1;
    if (n === 1) boundary++;
    else if (n === 2) { manifold++; if (arr[1] + arr[3] !== 0) inconsistent++; }
    else nonManifold++;
  }
  return { manifold, boundary, nonManifold, inconsistent, total: edgeMap.size };
}

function dualAdjacency(edgeMap) {
  const adj = new Map();
  for (const arr of edgeMap.values()) {
    if ((arr.length >> 1) !== 2) continue;
    const req = edgeReq(arr[1], arr[3]);
    addAdj(adj, arr[0], arr[2], req);
    addAdj(adj, arr[2], arr[0], req);
  }
  return adj;
}
function addAdj(adj, k, other, req) {
  const arr = adj.get(k);
  if (arr) arr.push({ other, req }); else adj.set(k, [{ other, req }]);
}

// BFS 2-colouring of the face dual graph. Returns per-face `flip` in {0,1} where
// `flip[f] = 1` means "reverse this face"; a component is orientable iff no BFS
// edge contradicts an already-assigned colour.
function faceComponents(edgeMap, F) {
  const adj = dualAdjacency(edgeMap);
  const comp = new Int32Array(F).fill(-1);
  const flip = new Int8Array(F).fill(-1);
  const comps = [];
  for (let s = 0; s < F; s++) {
    if (comp[s] !== -1) continue;
    const id = comps.length;
    const stack = [s];
    comp[s] = id; flip[s] = 0;
    let zeros = 1, ones = 0, orientable = true, conflict = null;
    while (stack.length) {
      const g = stack.pop();
      for (const e of adj.get(g) || []) {
        const want = flip[g] ^ e.req;
        if (comp[e.other] === -1) {
          comp[e.other] = id; flip[e.other] = want;
          if (want) ones++; else zeros++;
          stack.push(e.other);
        } else if (flip[e.other] !== want && orientable) {
          orientable = false;
          conflict = { faceA: g, faceB: e.other };
        }
      }
    }
    comps.push({ id, zeros, ones, orientable, conflict });
  }
  return { comp, flip, comps };
}

// A standalone, self-contained witness that a component cannot be oriented: a
// simple cycle in the face dual graph carrying an odd number of "must differ" edges.
export function oddCycleWitness(edgeMap, startFace) {
  const adj = dualAdjacency(edgeMap);
  const par = new Map(), parReq = new Map();
  const seen = new Set([startFace]);
  const q = [startFace];
  for (let h = 0; h < q.length; h++) {
    const g = q[h];
    for (const e of adj.get(g) || []) {
      if (!seen.has(e.other)) {
        seen.add(e.other); par.set(e.other, g); parReq.set(e.other, e.req); q.push(e.other);
      } else if (par.get(g) !== e.other && par.get(e.other) !== g) {
        const pa = walkUp(g, par), pb = walkUp(e.other, par);
        const inB = new Set(pb);
        const meet = pa.find((x) => inB.has(x));
        if (meet === undefined) continue;
        const ia = pa.indexOf(meet), ib = pb.indexOf(meet);
        let par1 = 0;
        for (let i = 0; i < ia; i++) par1 ^= parReq.get(pa[i]);
        for (let i = 0; i < ib; i++) par1 ^= parReq.get(pb[i]);
        if ((par1 ^ e.req) === 1) {
          const pathA = pa.slice(0, ia + 1);                    // g ... meet
          const pathB = pb.slice(0, ib).reverse();              // meet-exclusive ... e.other
          return pathA.concat(pathB);                          // closing edge last -> first
        }
      }
    }
  }
  return null;
}
function walkUp(x, par) { const out = [x]; while (par.has(x)) { x = par.get(x); out.push(x); } return out; }

// Independently re-check a witness: consecutive faces share a manifold edge, the
// closing pair too, the cycle is simple, and the XOR of req over it is odd.
export function checkOddCycleWitness(indices, witness) {
  if (!witness || witness.length < 3) return { ok: false, reason: "too-short" };
  if (new Set(witness).size !== witness.length) return { ok: false, reason: "not-simple" };
  const F = (indices.length / 3) | 0;
  const dirOf = (f, u, v) => {
    const a = indices[3 * f], b = indices[3 * f + 1], c = indices[3 * f + 2];
    return [[a, b], [b, c], [c, a]].some(([x, y]) => x === u && y === v) ? 1 : -1;
  };
  const pairReq = (f, g) => {
    const sf = [indices[3 * f], indices[3 * f + 1], indices[3 * f + 2]];
    const sg = [indices[3 * g], indices[3 * g + 1], indices[3 * g + 2]];
    const shared = sf.filter((v) => sg.includes(v));
    if (shared.length !== 2) return null;
    const [u, v] = shared;
    const d0 = dirOf(f, u, v), d1 = dirOf(g, u, v);
    if (d0 === 0 || d1 === 0) return null;
    return { req: d0 * d1 === 1 ? 1 : 0, d0, d1 };
  };
  for (let i = 0; i < witness.length; i++) {
    const f = witness[i], g = witness[(i + 1) % witness.length];
    if (f >= F || g >= F || f === g) return { ok: false, reason: "bad-index" };
    const r = pairReq(f, g);
    if (!r) return { ok: false, reason: `no-shared-manifold-edge@${i}` };
  }
  let odds = 0;
  for (let i = 0; i < witness.length; i++) {
    const r = pairReq(witness[i], witness[(i + 1) % witness.length]);
    odds ^= r.req;
  }
  return { ok: odds === 1, reason: odds === 1 ? "odd-cycle" : "even-cycle", length: witness.length };
}

export function signedVolume(positions, indices, faceIds) {
  let vol = 0;
  for (const f of faceIds) {
    const a = indices[3 * f], b = indices[3 * f + 1], c = indices[3 * f + 2];
    const ax = positions[3 * a], ay = positions[3 * a + 1], az = positions[3 * a + 2];
    const bx = positions[3 * b], by = positions[3 * b + 1], bz = positions[3 * b + 2];
    const cx = positions[3 * c], cy = positions[3 * c + 1], cz = positions[3 * c + 2];
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return vol / 6;
}

export function applyFlips(indices, flipSet) {
  const out = indices.slice();
  for (const f of flipSet) { const b = out[3 * f + 1]; out[3 * f + 1] = out[3 * f + 2]; out[3 * f + 2] = b; }
  return out;
}

// Primary entry point: the orientation certificate.
//   minConsistencyFlipSet / minConsistencyFlipCount : exact minimum over the two
//     complementary labellings of a component (a proven lower bound).
//   flipSet / flipCount : what you actually apply -- for closed components the
//     labelling is forced to outward-facing (signed volume > 0), else the minimum.
//   invertedIfMinimal : the min-flip fix leaves a closed component inside-out.
//   unresolved : some component is non-orientable; no flip set can fix it.
export function analyze(mesh) {
  const I = mesh.indices, P = mesh.positions;
  const F = (I.length / 3) | 0;
  const stats = meshStats(mesh);
  const edgeMap = buildEdgeMap(I);
  const counts = edgeCounts(edgeMap);
  const { comp, flip, comps } = faceComponents(edgeMap, F);

  const facesOf = new Map();
  for (let f = 0; f < F; f++) {
    const l = facesOf.get(comp[f]); if (l) l.push(f); else facesOf.set(comp[f], [f]);
  }
  const edgePerFace = new Map(); // face -> edge keys, for the closed-surface test
  for (const [key, arr] of edgeMap) for (let i = 0; i < arr.length; i += 2) {
    const l = edgePerFace.get(arr[i]); if (l) l.push(key); else edgePerFace.set(arr[i], [key]);
  }
  const components = [];
  const flipSet = [], minSet = [], outwardSet = [];
  let witness = null;
  const volEps = VOL_EPS_REL * stats.bboxDiag ** 3;
  for (const c of comps) {
    const faces = facesOf.get(c.id) || [];
    if (!c.orientable) {
      witness = oddCycleWitness(edgeMap, faces[0]);
      components.push({ id: c.id, faces: faces.length, orientable: false, minConsistencyFlipCount: null, chosenFlipCount: null, closed: false, outwardDefined: false, signedVolume: null, invertedIfMinimal: null, witnessFaces: witness ? witness.length : 0 });
      continue;
    }
    const minOnes = c.ones <= c.zeros;                  // flip the smaller colour class
    const minFacesOnly = faces.filter((f) => (minOnes ? flip[f] === 1 : flip[f] === 0));
    minSet.push(...minFacesOnly);
    // A component is closed only if EVERY edge of EVERY face has exactly 2 faces.
    let closed = true;
    for (const f of faces) for (const k of edgePerFace.get(f) || []) if ((edgeMap.get(k).length >> 1) !== 2) closed = false;
    const volMin = signedVolume(P, applyFlips(I, minFacesOnly), faces);
    const outwardDefined = closed && Math.abs(volMin) > volEps;
    const chosen = !outwardDefined ? minFacesOnly
      : (volMin > 0 ? minFacesOnly : faces.filter((f) => !minFacesOnly.includes(f)));
    flipSet.push(...chosen);
    const invertedIfMinimal = outwardDefined ? volMin < 0 : null;
    if (invertedIfMinimal) outwardSet.push(...faces);
    components.push({
      id: c.id, faces: faces.length, orientable: true,
      zeroCount: c.zeros, oneCount: c.ones,
      minConsistencyFlipCount: Math.min(c.zeros, c.ones),
      chosenFlipCount: chosen.length,
      closed, outwardDefined, signedVolume: volMin, invertedIfMinimal, witnessFaces: 0,
    });
  }
  flipSet.sort((a, b) => a - b);
  minSet.sort((a, b) => a - b);
  outwardSet.sort((a, b) => a - b);
  const nonOrientableComponents = components.filter((c) => !c.orientable).length;
  return {
    stats, counts, components,
    componentOfFace: Array.from(comp),
    minConsistencyFlipSet: minSet, minConsistencyFlipCount: minSet.length,
    flipSet, flipCount: flipSet.length,
    outwardOnlyFlipSet: outwardSet, outwardOnlyFlipCount: outwardSet.length,
    nonOrientableComponents,
    witness: witness ? { faces: witness, odd: true } : null,
    unresolved: nonOrientableComponents > 0,
  };
}

// ---- independent re-check helpers (used by bench/verify.mjs, no shared state) ----

// Count manifold edges whose two faces traverse them in the same direction.
// Deliberately written with string keys and a separate map from core's.
export function inconsistentEdgeCount(indices) {
  const F = (indices.length / 3) | 0;
  const seen = new Map();
  let bad = 0;
  for (let f = 0; f < F; f++) {
    const a = indices[3 * f], b = indices[3 * f + 1], c = indices[3 * f + 2];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      if (u === v) continue;
      const k = u < v ? `${u}_${v}` : `${v}_${u}`;
      const d = u < v ? 1 : -1;
      const rec = seen.get(k);
      if (!rec) { seen.set(k, { n: 1, d }); continue; }
      rec.n++;
      if (rec.n === 2 && rec.d + d !== 0) bad++;
    }
  }
  return bad;
}

// Oracle: brute force over literally every face pair sharing >= 2 vertex ids, O(F^2).
export function naiveInconsistentPairs(indices) {
  const F = (indices.length / 3) | 0;
  const sets = [];
  for (let f = 0; f < F; f++) sets.push(new Set([indices[3 * f], indices[3 * f + 1], indices[3 * f + 2]]));
  const dirOf = (f, u, v) => {
    const a = indices[3 * f], b = indices[3 * f + 1], c = indices[3 * f + 2];
    return [[a, b], [b, c], [c, a]].some(([x, y]) => x === u && y === v) ? 1 : -1;
  };
  let bad = 0, comparedPairs = 0;
  for (let f = 0; f < F; f++) for (let g = f + 1; g < F; g++) {
    const shared = [...sets[f]].filter((v) => sets[g].has(v));
    if (shared.length < 2) continue;
    comparedPairs++;
    const [u, v] = shared;
    if (dirOf(f, u, v) === dirOf(g, u, v)) bad++;
  }
  return { inconsistentPairs: bad, comparedPairs };
}

// Residual 2-face edges that are still inconsistent after applying `cert.flipSet`.
// A correct certificate leaves NONE outside non-orientable components.
export function residualInconsistentEdges(indices, cert) {
  const applied = applyFlips(indices, cert.flipSet);
  const F = (applied.length / 3) | 0;
  const seen = new Map();
  const out = [];
  for (let f = 0; f < F; f++) {
    const a = applied[3 * f], b = applied[3 * f + 1], c = applied[3 * f + 2];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      if (u === v) continue;
      const k = u < v ? `${u}_${v}` : `${v}_${u}`;
      const d = u < v ? 1 : -1;
      const rec = seen.get(k);
      if (!rec) { seen.set(k, { n: 1, d, first: f }); continue; }
      rec.n++;
      if (rec.n === 2 && rec.d + d !== 0) out.push({ u, v, faces: [rec.first, f], components: [cert.componentOfFace[rec.first], cert.componentOfFace[f]] });
    }
  }
  return out;
}

export function popcount(x) { let n = 0; while (x) { x &= x - 1; n++; } return n; }

// Exhaustive exact minimum flip count for a small face set: tries all 2^k labellings.
export function bruteForceMinFlip(indices, faceIds) {
  const k = faceIds.length;
  if (k > 20) return null;
  const inSet = new Set(faceIds);
  for (let mask = 0; mask < (1 << k); mask++) {
    const sub = indices.slice();
    for (let i = 0; i < k; i++) if (mask & (1 << i)) {
      const f = faceIds[i], b = sub[3 * f + 1]; sub[3 * f + 1] = sub[3 * f + 2]; sub[3 * f + 2] = b;
    }
    const seen = new Map();
    let bad = 0;
    for (const f of faceIds) {
      const a = sub[3 * f], b = sub[3 * f + 1], c = sub[3 * f + 2];
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        if (u === v) continue;
        const kk = u < v ? `${u}_${v}` : `${v}_${u}`;
        const d = u < v ? 1 : -1;
        const rec = seen.get(kk);
        if (!rec) { seen.set(kk, { n: 1, d, faces: [f] }); continue; }
        rec.n++; rec.faces.push(f);
        if (rec.n === 2 && rec.d + d !== 0 && inSet.has(rec.faces[0])) bad++;
      }
    }
    if (bad === 0) return popcount(mask);
  }
  return null;
}

export function scaleMesh(mesh, s) {
  return { positions: mesh.positions.map((v) => v * s), indices: mesh.indices.slice() };
}
