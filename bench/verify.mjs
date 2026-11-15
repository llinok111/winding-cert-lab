// Assertion harness. exit 0 = all gates passed, exit 1 = at least one failed.
import { readFileSync } from "node:fs";
import {
  analyze, buildEdgeMap, scaleMesh, applyFlips, signedVolume, inconsistentEdgeCount,
  naiveInconsistentPairs, bruteForceMinFlip, checkOddCycleWitness, residualInconsistentEdges,
  meshStats,
} from "../src/core.mjs";
import { naiveGreedyResult, naiveEdgeCensus } from "../baseline/naive.mjs";

const corpora = JSON.parse(readFileSync(new URL("../data/meshes.json", import.meta.url)));
const reference = JSON.parse(readFileSync(new URL("../data/reference.json", import.meta.url)));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`PASS  ${name}: ${detail}`); }
  else { fail++; console.log(`FAIL  ${name}: ${detail}`); }
};
const certs = {};
for (const [name, mesh] of Object.entries(corpora)) certs[name] = analyze(mesh);

// G4-a reference parity: every published number must be what core actually returns.
for (const [name, ref] of Object.entries(reference)) {
  const c = certs[name], s = c.stats;
  const same = s.vertexCount === ref.vertices && s.faceCount === ref.faces
    && c.counts.manifold === ref.manifoldEdges && c.counts.boundary === ref.boundaryEdges
    && c.counts.nonManifold === ref.nonManifoldEdges && c.counts.inconsistent === ref.inconsistentEdges
    && c.minConsistencyFlipCount === ref.minConsistencyFlipCount && c.flipCount === ref.chosenFlipCount
    && c.nonOrientableComponents === ref.nonOrientableComponents && s.zeroAreaFaces === ref.zeroAreaFaces
    && inconsistentEdgeCount(applyFlips(corpora[name].indices, c.flipSet)) === ref.inconsistentAfterFix;
  ok(`ref-parity/${name}`, same, `V=${s.vertexCount} F=${s.faceCount} incons=${c.counts.inconsistent} minFlip=${c.minConsistencyFlipCount} nonOrient=${c.nonOrientableComponents}`);
}

// G4-b independent oracle: vertex-incidence census in baseline/naive.mjs shares no
// code and no constants with core (string edge keys vs numeric ones).
let oraclePairs = 0;
for (const [name, mesh] of Object.entries(corpora)) {
  const o = naiveEdgeCensus(mesh);
  const c = certs[name].counts;
  oraclePairs += o.edges;
  ok(`oracle/${name}`, o.manifold === c.manifold && o.boundary === c.boundary && o.nonManifold === c.nonManifold && o.inconsistent === c.inconsistent,
    `baseline census manifold=${o.manifold} boundary=${o.boundary} nonManifold=${o.nonManifold} inconsistent=${o.inconsistent} == core`);
}
// second, stronger oracle on the small meshes: literal all-pairs scan, O(F^2).
for (const [name, mesh] of Object.entries(corpora)) {
  if (mesh.indices.length / 3 > 2000 || reference[name].nonManifoldEdges !== 0) continue;
  const o = naiveInconsistentPairs(mesh.indices);
  ok(`oracle-OF2/${name}`, o.inconsistentPairs === certs[name].counts.inconsistent,
    `all-pairs scan says ${o.inconsistentPairs}, certificate says ${certs[name].counts.inconsistent} (compared ${o.comparedPairs} vertex-sharing face pairs)`);
}
console.log(`      baseline census walked ${oraclePairs} distinct edges in total`);

// G4-c non-manifold edges must be classified, never repaired.
{
  const name = "nonmanifold-fan", mesh = corpora[name], em = buildEdgeMap(mesh.indices);
  let over2 = 0;
  for (const arr of em.values()) if ((arr.length >> 1) > 2) over2++;
  ok("nonmanifold/classification", over2 === certs[name].counts.nonManifold && over2 === 4,
    `edges with >2 faces = ${over2} (core reports ${certs[name].counts.nonManifold}); boundary=${certs[name].counts.boundary}`);
}

// G4-d exact minimum: exhaustive 2^k on every component with <=20 faces.
let exhaustiveFaces = 0;
for (const [name, mesh] of Object.entries(corpora)) {
  const c = certs[name];
  const byComp = new Map();
  for (let f = 0; f < mesh.indices.length / 3; f++) {
    const l = byComp.get(c.componentOfFace[f]); if (l) l.push(f); else byComp.set(c.componentOfFace[f], [f]);
  }
  for (const [id, faces] of byComp) {
    if (faces.length > 20) continue;
    exhaustiveFaces += faces.length;
    const bf = bruteForceMinFlip(mesh.indices, faces);
    const comp = c.components.find((x) => x.id === id);
    ok(`minimality/${name}#c${id}`, bf === comp.minConsistencyFlipCount,
      `2^${faces.length} exhaustive minimum = ${bf}, certificate = ${comp.minConsistencyFlipCount} (orientable=${comp.orientable})`);
  }
}
console.log(`      exhaustive search covered ${exhaustiveFaces} faces`);

// G4-e minimality has a real cost impact: greedy root-0 repair vs proven minimum.
{
  const name = "sphere-inverted88", mesh = corpora[name];
  const g = naiveGreedyResult(mesh);
  const min = certs[name].minConsistencyFlipCount;
  const c = certs[name];
  // Greedy claims fewer flips (960 < 1024) which is IMPOSSIBLE for a valid labelling
  // of a connected orientable component (solutions are exactly L and its complement,
  // sizes 5120 and 1024). So greedy must not have produced a solution at all.
  ok("minimality/greedy-not-a-repair", g.flips === 960 && g.inconsistentAfter > 0 && min === 1024,
    `greedy root-0 flips ${g.flips} faces and leaves ${g.inconsistentAfter} inconsistent edges (no repair); certificate flips ${min} and proves 0 residual, exact minimum`);
  ok("minimality/exact", Math.min(c.components[0].zeroCount, c.components[0].oneCount) === 1024 && c.components[0].zeroCount + c.components[0].oneCount === 6144,
    `component labelings have sizes ${c.components[0].zeroCount} and ${c.components[0].oneCount}; minimum = ${min}`);
}

// G4-f non-orientable components: 1-minimal odd-cycle witness, and provable impossibility.
for (const name of ["mobius-small", "mobius", "mixed-3comp"]) {
  const c = certs[name];
  const w = checkOddCycleWitness(corpora[name].indices, c.witness.faces);
  const simple = new Set(c.witness.faces).size === c.witness.faces.length;
  ok(`witness/${name}`, c.unresolved && w.ok && simple && c.nonOrientableComponents === 1,
    `odd cycle of ${c.witness.faces.length} faces, parity check ok=${w.ok} (${w.reason}), simple=${simple} => 1-minimal`);
}
{
  const bf = bruteForceMinFlip(corpora["mobius-small"].indices, [...Array(8).keys()]);
  ok("witness/mobius-impossible", bf === null, `all 2^8 labellings of mobius-small fail (brute force = ${bf})`);
}

// G4-g residual inconsistency must be confined to non-orientable components.
for (const [name, mesh] of Object.entries(corpora)) {
  const c = certs[name];
  const res = residualInconsistentEdges(mesh.indices, c);
  const bad = res.filter((r) => r.components.some((id) => c.components.find((x) => x.id === id).orientable));
  const expected = c.nonOrientableComponents > 0 ? res.length : 0;
  ok(`residual/${name}`, bad.length === 0 && res.length === reference[name].inconsistentAfterFix && expected === res.length,
    `${res.length} residual inconsistent edges, ${bad.length} outside non-orientable components`);
}

// G4-h outward orientation after applying the certificate.
{
  const name = "cube-inverted", mesh = corpora[name], c = certs[name];
  const alt = name;
  void alt;
  const flipped = applyFlips(mesh.indices, c.flipSet);
  const all = [...Array(mesh.indices.length / 3).keys()];
  const vol = signedVolume(mesh.positions, flipped, all);
  const comp = c.components[0];
  ok("outward/cube", comp.closed && comp.outwardDefined && comp.invertedIfMinimal === true && Math.abs(vol - 1) < 1e-12,
    `all-flipped cube: consistency min=${comp.minConsistencyFlipCount} leaves it inside-out (invertedIfMinimal=${comp.invertedIfMinimal}), certificate flips ${comp.chosenFlipCount}, signed volume after fix=${vol}`);
}
for (const [name, mesh] of Object.entries(corpora)) {
  const c = certs[name];
  for (const comp of c.components) {
    if (!comp.outwardDefined) continue;
    const faces = []; for (let f = 0; f < mesh.indices.length / 3; f++) if (c.componentOfFace[f] === comp.id) faces.push(f);
    const vol = signedVolume(mesh.positions, applyFlips(mesh.indices, c.flipSet), faces);
    ok(`outward/${name}#c${comp.id}`, vol > 0, `signed volume after certificate = ${vol.toExponential(6)} > 0 (closed=${comp.closed})`);
  }
}

// G4-i scale invariance 1e-6 .. 1e6: every combinatorial decision must be identical.
{
  const scales = [1e-6, 1e-3, 1, 1e3, 1e6];
  let fields = 0, bad = 0;
  for (const [name, mesh] of Object.entries(corpora)) {
    const base = certs[name];
    for (const s of scales) {
      const c = analyze(scaleMesh(mesh, s));
      const t = [c.counts.manifold === base.counts.manifold, c.counts.boundary === base.counts.boundary,
        c.counts.nonManifold === base.counts.nonManifold, c.counts.inconsistent === base.counts.inconsistent,
        c.minConsistencyFlipCount === base.minConsistencyFlipCount, c.flipCount === base.flipCount,
        c.nonOrientableComponents === base.nonOrientableComponents, c.stats.zeroAreaFaces === base.stats.zeroAreaFaces,
        JSON.stringify(c.components.map((x) => [x.faces, x.orientable, x.minConsistencyFlipCount, x.closed, x.outwardDefined]))
          === JSON.stringify(base.components.map((x) => [x.faces, x.orientable, x.minConsistencyFlipCount, x.closed, x.outwardDefined]))];
      fields += t.length; bad += t.filter((x) => !x).length;
    }
  }
  ok("scale-invariance", bad === 0, `scales 1e-6|1e-3|1|1e3|1e6: ${fields} compared fields, ${bad} drifting`);
}
{
  const s = meshStats(corpora["sphere-band12"]);
  ok("relative-threshold", Math.abs(s.areaEps - 1e-12 * s.bboxDiag ** 2) / s.areaEps < 1e-12 && Math.abs(s.bboxDiag - 2 * Math.sqrt(3)) < 1e-6,
    `AREA_EPS_REL=1e-12, bboxDiag=${s.bboxDiag.toFixed(6)} (=2*sqrt(3)), areaEps=${s.areaEps.toExponential(6)} = 1e-12*bboxDiag^2 (relative, not absolute)`);
}

// G4-j degenerate inputs are counted, not crashed on.
{
  const a = certs["degenerate-2faces"].stats, b = certs["nonmanifold-fan"].stats;
  ok("degenerate/counts", a.repeatedIndexFaces === 2 && a.zeroAreaFaces === 0 && b.zeroAreaFaces === 1 && b.repeatedIndexFaces === 0,
    `degenerate-2faces: repeated-index=${a.repeatedIndexFaces} zeroArea=${a.zeroAreaFaces}; nonmanifold-fan: zeroArea=${b.zeroAreaFaces} (collinear grid tri), repeated-index=${b.repeatedIndexFaces}`);
}

console.log(`\nRESULT ${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
