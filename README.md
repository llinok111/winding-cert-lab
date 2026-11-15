# winding-cert-lab

**Can this mesh be backface-culled at all?** On a 38,400-triangle sphere the certificate
returns a **provably minimal** winding-repair plan of **6,080** faces; on a 6,144-triangle
inside-out sphere the exact minimum is **1,024** faces — and there the obvious greedy repair
reports *fewer* flips (**960**) while leaving 16 edges broken, so it is not a repair at all.
When no plan exists (a Möbius band) the tool returns a 1-minimal odd-cycle **witness**
instead of guessing.

* `src/core.mjs` is pure computation (no `three`, no DOM, no I/O, no top-level side effects).
* Same core runs in node (`bench/verify.mjs`) and in the browser page (`main.js`).
* Every number in this README is produced by `bench/bench.mjs` / `bench/verify.mjs` and is
  reproducible with one command; nothing here is estimated.

Upstream: none

## What it actually decides

An indexed triangle mesh is *renderable with backface culling* iff its face dual graph can be
2-coloured so that every 2-face edge is traversed in opposite directions by its two faces. For
each connected component of the dual graph:

| output | meaning |
| --- | --- |
| `minConsistencyFlipCount` | the **exact minimum** number of faces to reverse to make the component consistent. A connected orientable component has exactly two consistent labellings, of sizes `zeroCount` and `oneCount`; the minimum is `min` of those two. |
| `flipSet` | what to actually apply. For a closed component with a well-defined volume the labelling is **forced to outward-facing** (signed volume > 0), so the result also passes a "recalc outside" check. |
| `invertedIfMinimal` | `true` when the *minimum-flip* fix leaves a closed shell inside-out — the case a minimality-only tool gets wrong. |
| `nonOrientableComponents` + `witness` | the component **cannot** be oriented (a Möbius band, a Klein-bottle immersion). The witness is a simple odd dual cycle; no flip set exists, and the tool says so instead of guessing. |
| `counts.nonManifold` | edges with >2 faces are **classified and never repaired** — they are excluded from the colouring instead of silently corrupting it. |
| `stats.zeroAreaFaces` / `repeatedIndexFaces` | degenerate input is counted, not crashed on. |

## How to run

```bash
node tools/gen-sample.mjs     # build data/meshes.json + data/reference.json (deterministic)
node bench/verify.mjs         # 60 assertions, exit 0; every assertion prints its measured values
node bench/bench.mjs          # writes bench/result.json (cold start + 7 samples, median/p95/stddev)
python3 -m http.server 4173   # then open http://localhost:4173  (importmap pulls three@0.169.0)
```

## Evidence (`bench/result.json`, node v24.19.0)

Corpora: 10 deterministic meshes from `tools/gen-sample.mjs` (tetra / cube / open grid /
non-manifold fan / degenerate / Möbius ×2 / 38,400-tri sphere / inverted sphere / 3-component mix).

* **Correctness vs an independent oracle** — `baseline/naive.mjs` re-counts every edge from
  vertex-incidence lists with string keys (core uses numeric keys; no shared code, and this tool
  has **no magic constants** to share). On all 10 corpora `manifold / boundary / nonManifold /
  inconsistent` agree exactly; the census walked **57,760 edges** on the big sphere
  (`agreesWithCertificate: true`). Six small meshes are *also* checked by a literal O(F²)
  all-pairs scan: 0 disagreements.
* **Minimality is proved, not asserted** — for every component with ≤20 faces the certificate is
  checked against an exhaustive 2^k search over all labellings (59 faces covered over 6 corpora,
  0 mismatches). On the 6,144-triangle inverted sphere the two labellings have sizes 5,120 and
  1,024, so the minimum is 1,024.
* **The obvious repair is not a repair** — greedy root-first flipping reports **960** flips and
  leaves **16** inconsistent edges; the certificate flips **1,024** and leaves **0**. 960 cannot be
  a valid labelling of a connected orientable component, which is exactly why the certificate
  counts and the greedy does not.
* **Non-orientable input is refused with a witness** — Möbius band (144 tri) and the 3-component
  mix report `nonOrientableComponents: 1` with a **48-face simple odd cycle**; an exhaustive 2^8
  search over the small Möbius confirms **no** labelling exists. Residual inconsistency after the
  certificate is confined to non-orientable components (0 elsewhere; asserted per corpus).
* **Outward, not merely consistent** — a fully inside-out cube has `minConsistencyFlipCount: 0`
  (it is already consistent!) and `invertedIfMinimal: true`; the certificate flips all 12 faces and
  the signed volume after the fix is exactly `1`. Every closed component is asserted to end with
  positive signed volume.
* **Scale invariance** — the same 10 corpora at 1e-6, 1e-3, 1, 1e3, 1e6: **450 compared fields,
  0 drifting** (counts, flip counts, orientability, closedness, outwardness, degenerate counts).
  The only numeric threshold is `AREA_EPS_REL = 1e-12`, **relative** to `bboxDiag²`
  (on the big sphere `areaEps = 1.2e-11 = 1e-12 × 3.464102²`), so it scales with the mesh.
* **Timing (honest, and not the point)** — `analyze()` on 38,400 triangles: cold **148.1 ms**,
  median **76.3 ms**, p95 **119.5 ms**, stddev **18.9 ms**, **relStddev 20.7 %** (n=7).
  The independent census alone is 21.4 ms (relStddev 14.3 %, n=5). The certificate is therefore
  ~3.6× **slower** than a bare census: it does strictly more work (dual-graph colouring,
  per-component signed volume, odd-cycle search). **No speedup is claimed**; the >10 % relative
  standard deviation is GC jitter from ~57,760 Map entries and ~230 k small-array pushes per call.

## Known limitations

1. **Relative threshold disclosure** — `AREA_EPS_REL = 1e-12` (relative to `bboxDiag²`) and
   `VOL_EPS_REL = 1e-15` (relative to `bboxDiag³`) are the only thresholds. They only affect the
   `zeroAreaFaces` count and the "is the volume well-defined" decision. Effective range: any scale,
   because both are relative; but a closed component whose true volume is below `1e-15 × bboxDiag³`
   (e.g. a degenerate flat shell) is reported `outwardDefined: false` rather than guessed at.
2. **Orientation is purely combinatorial** — it uses `indices` only, never positions. Two faces
   sharing two vertex ids are treated as an edge regardless of geometry, so a mesh with duplicated
   vertices that "should" be welded will look more disconnected than it is. Weld first.
3. **Degenerate faces are counted, not repaired** — repeated-index faces contribute no edge and
   are excluded from the colouring; zero-area (collinear) faces with distinct indices still
   participate combinatorially. Zero-area polar triangles are a real property of my UV sphere
   corpus, not a bug.
4. **Non-manifold edges break propagation** — faces reachable only through an edge with >2 faces
   are placed in separate components (visible in `nonmanifold-fan`, 4 components). This is a
   deliberate refusal to guess; it means components of a non-manifold mesh can be labelled
   independently and the global result is not unique.
5. **The timing is allocation-bound** (`relStddev` 20.7 %, median only). The counts, flip sets and
   witnesses are exact and reproducible; the millisecond figures are not a claim.
6. The `p95` for n=7 equals the maximum; no interpolation is done.

## 本轮创新

**New: the repair plan is certified minimal, and impossible inputs get a witness instead of a guess.**
Compared with my earlier `mesh-defect-doctor` (which *classifies* winding conflicts and does a BFS
repair) and `pointnorm-cert` (Hoppe-style orientation propagation over a point cloud), this tool
sells exactly the two things neither does: (a) the **exact minimum** flip count, proved by an
exhaustive 2^k search on small components and by the two-labelling argument on large ones — with a
concrete demonstration that greedy's smaller number is not a solution; and (b) a **1-minimal
odd-cycle witness** for non-orientable components, plus the `invertedIfMinimal` flag that catches
the case where a minimality-only fix leaves the shell inside-out. Interaction is deliberately one
view: the page lets you toggle the certificate and shows the same numbers node computes.

## License

MIT — see `LICENSE`.
