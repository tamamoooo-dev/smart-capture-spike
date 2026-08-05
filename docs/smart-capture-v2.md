# Smart Capture v2 — design

**v1 is reclassified as a research prototype.** It earned its keep by revealing
the constraints below, all of which were discovered by measurement and none of
which were knowable in advance. It is not the production architecture.

## What v1 taught us, and what each lesson costs v2

| Measured | Consequence for v2 |
|---|---|
| Frame delivered 3024×4032; `getSettings()` disagreed with `videoWidth` | Never trust a single dimension source. Measure the frame the analysis actually receives. |
| Peak page width 2898 px vs predicted 2915 (0.6% over 909 samples) | The geometric model is sound. Errors were in the *rules*, not the maths. |
| Margins at peak: 67/59 horizontal, 731/1193 vertical, coverage 50.1% | Forcing the sheet to look landscape discarded 25% of the sensor. |
| ArUco detection is rotation-invariant (68.6/68.4/68.2% at 0/90/270°) | Orientation is a free variable. Never constrain it. |
| Detection collapses below ~2 px/module, plateaus ~2.9–4.5, non-monotonic above | More resolution is not better. There is a band, not a floor. |
| Regional exposure predicts row success at AUC 0.940; marker coverage at 0.449 | Lighting is the binding quality variable, not sharpness or coverage. |
| `.diag{display:none}` matched `body.diag` and hid the page | Diagnosability must not depend on the thing being diagnosed. |

## The failure class v2 must make impossible

v1 issued **contradictory instructions**: "show all four corners" while also
demanding a page width geometry proved unreachable. Every remedy for one made
the other worse.

The root cause was structural, not a bad threshold: **v1 evaluated checks in
priority order and reported the first failure.** A checklist cannot notice that
its requirements are mutually unsatisfiable.

### v2 computes the feasible set before it says anything

```
feasible = constraints.solve(frameGeometry)

  empty     ->  report which constraint is infeasible, and the single
                action that changes it. Never issue guidance.
  non-empty ->  guide toward the nearest point inside it.
```

An instruction is only ever emitted for a target that provably exists.

## Principles

**1. The teacher's workflow is the fixed point.** They hold the phone however
they hold it and frame the whole sheet. The app adapts. Orientation is never
required; the sheet's long axis is matched to the frame's long axis in
software, or the image is rotated after capture at zero cost.

**2. No rule is enforced until validated against real captures.** Every
threshold ships in `observe` mode: measured, displayed, recorded — not
enforced. A rule is promoted to `enforce` only once real captures show it is
both *satisfiable* and *discriminative* of grading success. v1's 3000 px floor
was derived from a sweep and then enforced without ever checking a teacher
could reach it.

**3. Every capture records its metric vector.** Acceptance rules are validated
offline by correlating recorded metrics against grading outcomes from `bench/`,
not by argument.

**4. Corner visibility is inviolable.** It is never traded for resolution. If
the two conflict, the configuration is infeasible and is reported as such.

**5. Diagnosability is independent of the feature being diagnosed.** Debug
output uses its own ids, its own stylesheet scope, and is always present.

## Rule status register

Rules carry an explicit status, and only `enforce` rules can block a capture.

| Rule | Status | Basis |
|---|---|---|
| corner visibility | **enforce** | Hard requirement; violation makes registration impossible |
| page detected | **enforce** | Nothing can be measured without it |
| axes aligned | **observe** | Free variable — recorded to confirm it never needs enforcing |
| page long axis ≥ N px | **observe** | N is unvalidated. The sweep showed 2400 px analysis width already cleared the 40% detection gate, so 3000 was likely conservative. |
| regional exposure | **observe** | Strongest predictor measured (AUC 0.940), but no threshold has been validated against grading outcomes |
| sharpness | **observe** | Uncalibrated; preview sharpness may not predict capture sharpness |
| stability | **enforce** | Motion blur is unrecoverable by any observation |

Promotions require a recorded measurement, cited in this table.

## What v2 deliberately does not do

- No auto-capture until the enforce set is validated. Manual capture with live
  advisory metrics comes first.
- No ArUco in the live loop. Registration is a commit-stage concern; detection
  is non-monotonic in resolution and cannot steer a teacher.
- No threshold tuning without a recorded capture that motivates it.
