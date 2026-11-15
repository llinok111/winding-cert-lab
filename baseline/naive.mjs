// Baseline: the obvious way, written so it shares no code and no constants with
// src/core.mjs (it works from vertex-incidence lists and string edge keys, while
// core works from numeric edge keys).
//
//   naiveEdgeCensus(mesh)      -> exhaustive independent re-count of manifold /
//                                 boundary / non-manifold / inconsistent edges.
//   naiveGreedyFlipCount(mesh) -> "repair" by walking faces in index order and
//                                 flipping any face that disagrees with an earlier
//                                 accepted neighbour. Converges on orientable meshes,
//                                 but makes no minimality and no outward claim.
export function naiveEdgeCensus(mesh) {
  const I = mesh.indices, F = (I.length / 3) | 0;
  const census = new Map(); // "u:v" -> [dir, count]
  const push = (u, v, d) => {
    const k = u < v ? `${u}:${v}` : `${v}:${u}`;
    const rec = census.get(k);
    if (rec) { rec[1]++; rec[0] += d; } else census.set(k, [d, 1]);
  };
  for (let f = 0; f < F; f++) {
    const a = I[3 * f], b = I[3 * f + 1], c = I[3 * f + 2];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) if (u !== v) push(u, v, u < v ? 1 : -1);
  }
  let manifold = 0, boundary = 0, nonManifold = 0, inconsistent = 0;
  for (const [dir, n] of census.values()) {
    if (n === 1) boundary++;
    else if (n === 2) { manifold++; if (dir !== 0) inconsistent++; }
    else nonManifold++;
  }
  return { manifold, boundary, nonManifold, inconsistent, edges: census.size };
}

export function naiveGreedyFlipCount(mesh) {
  const I = mesh.indices, F = (I.length / 3) | 0;
  const idx = I.slice();
  const inc = new Map();
  for (let f = 0; f < F; f++) for (const v of [idx[3 * f], idx[3 * f + 1], idx[3 * f + 2]]) {
    const l = inc.get(v); if (l) l.push(f); else inc.set(v, [f]);
  }
  const dirIn = (f, u, v) => {
    const a = idx[3 * f], b = idx[3 * f + 1], c = idx[3 * f + 2];
    if (a === u && b === v) return 1; if (b === u && c === v) return 1; if (c === u && a === v) return 1;
    if (a === v && b === u) return -1; if (b === v && c === u) return -1; if (c === v && a === u) return -1;
    return 0;
  };
  let flips = 0;
  for (let f = 0; f < F; f++) {
    let done = false;
    for (const v of [idx[3 * f], idx[3 * f + 1], idx[3 * f + 2]]) {
      for (const g of inc.get(v) || []) {
        if (g >= f) continue;
        const shared = [idx[3 * f], idx[3 * f + 1], idx[3 * f + 2]]
          .filter((x) => x === idx[3 * g] || x === idx[3 * g + 1] || x === idx[3 * g + 2]);
        if (shared.length !== 2) continue;
        const [u, w] = shared;
        if (dirIn(f, u, w) === dirIn(g, u, w)) {
          const b = idx[3 * f + 1]; idx[3 * f + 1] = idx[3 * f + 2]; idx[3 * f + 2] = b; flips++;
          done = true; break;
        }
      }
      if (done) break;
    }
  }
  return flips;
}

// Same greedy walk, but returns the repaired indices and the number of 2-face edges
// that are STILL inconsistent -- i.e. the honest quality of the "obvious" repair.
export function naiveGreedyResult(mesh) {
  const I = mesh.indices, F = (I.length / 3) | 0;
  const idx = I.slice();
  const inc = new Map();
  for (let f = 0; f < F; f++) for (const v of [idx[3 * f], idx[3 * f + 1], idx[3 * f + 2]]) {
    const l = inc.get(v); if (l) l.push(f); else inc.set(v, [f]);
  }
  const dirIn = (f, u, v) => {
    const a = idx[3 * f], b = idx[3 * f + 1], c = idx[3 * f + 2];
    if (a === u && b === v) return 1; if (b === u && c === v) return 1; if (c === u && a === v) return 1;
    if (a === v && b === u) return -1; if (b === v && c === u) return -1; if (c === v && a === u) return -1;
    return 0;
  };
  let flips = 0;
  for (let f = 0; f < F; f++) {
    let done = false;
    for (const v of [idx[3 * f], idx[3 * f + 1], idx[3 * f + 2]]) {
      for (const g of inc.get(v) || []) {
        if (g >= f) continue;
        const shared = [idx[3 * f], idx[3 * f + 1], idx[3 * f + 2]]
          .filter((x) => x === idx[3 * g] || x === idx[3 * g + 1] || x === idx[3 * g + 2]);
        if (shared.length !== 2) continue;
        const [u, w] = shared;
        if (dirIn(f, u, w) === dirIn(g, u, w)) {
          const b = idx[3 * f + 1]; idx[3 * f + 1] = idx[3 * f + 2]; idx[3 * f + 2] = b; flips++;
          done = true; break;
        }
      }
      if (done) break;
    }
  }
  const census = naiveEdgeCensus({ positions: mesh.positions, indices: idx });
  return { flips, inconsistentAfter: census.inconsistent, indices: idx };
}
