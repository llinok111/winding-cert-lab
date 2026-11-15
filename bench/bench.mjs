// Timing harness. warmup 1 + >=5 repeats, reports min/median/p95/stddev and the
// cold-start (very first call in this process) separately. Writes bench/result.json.
import { readFileSync, writeFileSync } from "node:fs";
import { analyze } from "../src/core.mjs";
import { naiveEdgeCensus, naiveGreedyResult } from "../baseline/naive.mjs";

const corpora = JSON.parse(readFileSync(new URL("../data/meshes.json", import.meta.url)));
const reference = JSON.parse(readFileSync(new URL("../data/reference.json", import.meta.url)));

function timed(fn) { const t0 = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t0) / 1e6; }
function stats(ms) {
  const s = [...ms].sort((a, b) => a - b);
  const n = s.length, mean = s.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { samples: n, min: s[0], median: s[Math.floor(n / 2)], p95: s[Math.min(n - 1, Math.ceil(0.95 * n) - 1)], max: s[n - 1], mean, stddev: sd, relStddev: sd / mean };
}
const r3 = (x) => Math.round(x * 1000) / 1000;

const BIG = "sphere-band12";       // 38,400 triangles
const MID = "sphere-inverted88";    // 6,144 triangles
const bigMesh = corpora[BIG], midMesh = corpora[MID];

// cold start must be the very first analyze() call of this process
const coldMs = timed(() => analyze(bigMesh));
timed(() => analyze(bigMesh)); // warmup

const coreMs = [];
for (let i = 0; i < 7; i++) coreMs.push(timed(() => analyze(bigMesh)));
const core = stats(coreMs);

const censusMs = [];
timed(() => naiveEdgeCensus(bigMesh)); // warmup
for (let i = 0; i < 5; i++) censusMs.push(timed(() => naiveEdgeCensus(bigMesh)));
const census = stats(censusMs);

const greedy = naiveGreedyResult(midMesh);
const certMin = analyze(midMesh).minConsistencyFlipCount;
const oracle = naiveEdgeCensus(bigMesh);

const result = {
  env: { node: process.version, platform: process.platform, arch: process.arch, date: new Date().toISOString().slice(0, 10) },
  coreAnalyze: {
    mesh: BIG, faces: reference[BIG].faces, vertices: reference[BIG].vertices,
    coldMs: r3(coldMs), min: r3(core.min), median: r3(core.median), p95: r3(core.p95), max: r3(core.max),
    stddev: r3(core.stddev), relStddev: Number(core.relStddev.toFixed(4)), samples: core.samples,
  },
  baselineCensus: {
    mesh: BIG, what: "baseline/naive.mjs naiveEdgeCensus (independent string-key edge census)",
    min: r3(census.min), median: r3(census.median), p95: r3(census.p95), stddev: r3(census.stddev),
    relStddev: Number(census.relStddev.toFixed(4)), samples: census.samples,
    edgesWalked: oracle.edges, agreesWithCertificate: oracle.inconsistent === reference[BIG].inconsistentEdges,
  },
  minimality: {
    mesh: MID,
    greedyFlips: greedy.flips,
    greedyInconsistentAfter: greedy.inconsistentAfter,
    certificateMinimumFlips: certMin,
    certificateResidual: reference[MID].inconsistentAfterFix,
    note: "a connected orientable component has exactly two consistent labellings (sizes 5120 and 1024); greedy's 960 cannot be one, and it leaves edges broken",
  },
  corpora: Object.fromEntries(Object.entries(reference).map(([k, v]) => [k, {
    vertices: v.vertices, faces: v.faces, inconsistentEdges: v.inconsistentEdges,
    nonManifoldEdges: v.nonManifoldEdges, boundaryEdges: v.boundaryEdges,
    minConsistencyFlipCount: v.minConsistencyFlipCount, chosenFlipCount: v.chosenFlipCount,
    nonOrientableComponents: v.nonOrientableComponents, witnessFaces: v.witnessFaces,
    inconsistentAfterFix: v.inconsistentAfterFix, digest: v.digest,
  }])),
};

writeFileSync(new URL("result.json", import.meta.url), JSON.stringify(result, null, 1));
console.log(`cold ${r3(coldMs)} ms | analyze(${BIG}) median ${r3(core.median)} ms (min ${r3(core.min)}, p95 ${r3(core.p95)}, stddev ${r3(core.stddev)}, relStddev ${(core.relStddev * 100).toFixed(1)}%, n=${core.samples})`);
console.log(`baseline census(${BIG}) median ${r3(census.median)} ms (relStddev ${(census.relStddev * 100).toFixed(1)}%, n=${census.samples}, ${oracle.edges} edges)`);
console.log(`minimality(${MID}): greedy ${greedy.flips} flips leaves ${greedy.inconsistentAfter} inconsistent; certificate min ${certMin} with ${reference[MID].inconsistentAfterFix} residual`);
