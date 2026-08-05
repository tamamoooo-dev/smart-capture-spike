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

**5. Diagnosability is independent of the feature being diagnosed, and off by
default.** Debug output uses its own ids and its own stylesheet scope, so it can
never be hidden by the thing it exists to explain — but it is emitted only under
`?debug=1`. The teacher's screen carries one instruction and nothing else.

Recording is not display. Every capture records its metric vector regardless of
the flag; the flag governs what is rendered, not what is measured. Offline
validation depends on the record, so gating the record would gate the only
mechanism that retires a rule.

**6. Simplicity is a requirement, not a preference.** New architecture is
introduced only where it removes a *demonstrated* failure mode. The feasible-set
solver earned its place by removing contradictory instructions, which v1
produced repeatedly. Nothing else is entitled to that presumption: the default
is to reuse the measurement code v1 already validated and delete the rule logic
wrapped around it.

## Status: VS-1 executed, one contradiction measured

VS-1 ran on 2026-08-05: 39 captures, iPhone, 3024×4032 delivered, frozen
cycle-1 form, 15 minutes.

### Result: orientation is not a free variable within a frame

| Group | n | max pageLongAxis | reached 3000 |
|---|---|---|---|
| axes aligned | 20 | 3352 | 19/20 |
| axes unaligned | 19 | **2957** | **0/19** |

The engine reported a ceiling of 3887 px for every capture and issued
`MOVE_CLOSER` accordingly. But 3887 assumes the sheet's long side can lie along
the frame's long side. It cannot, in any single frame, unless the teacher
rotates: an unaligned sheet is bounded by the frame's *short* axis, 3024 px, and
the best unaligned capture in the session reached 2957. v1 measured 2898 against
a predicted 2915 under the same constraint — three independent measurements of
the same ceiling, which v2 then computed as 3887 by assuming it away.

So captures 0001–0020 were guided toward a target that did not exist in the
teacher's current hold. They oscillated between `MOVE_CLOSER` and
`SHOW_ALL_CORNERS` — 9 alternations across 20 captures, 19 of them unaligned —
for 14 of the session's 15 minutes. At 0021 the phone was rotated and `READY`
followed within seconds.

**This is the failure class v2 was built to make impossible.** The feasible set
was computed correctly for the wrong configuration space: orientation was
treated as free across the whole session, when within a frame it is fixed by how
the teacher is holding the phone. The remedy the engine never had was the one
action that would have worked — rotate — because principle 1 forbade requiring
orientation, and that was read as never mentioning it.

Principle 1 is not wrong: rotation is free *downstream*, ArUco is rotation
invariant, and the teacher must not be forced into a grip. What VS-1 falsifies
is the inference drawn from it — that orientation therefore never needs to enter
the feasible-set calculation.

### What VS-1 could not decide

Grading outcomes were not part of this session, so no rule was tested for
discriminativeness. `exposure`, `sharpness` and the 3000 px requirement remain
undecided until the 39 images are graded through `bench/`.

## Rule status register

Rules carry an explicit status, and only `enforce` rules can block a capture.

| Rule | Status | Verdict due | Basis |
|---|---|---|---|
| corner visibility | **enforce** | — | Hard requirement; violation makes registration impossible |
| page detected | **enforce** | — | Nothing can be measured without it |
| stability | **enforce** | — | Motion blur is unrecoverable by any observation |
| axes aligned | **observe — basis falsified, decision required** | VS-1 ran | Recorded to confirm it never needs enforcing. VS-1 showed the opposite: 0/19 unaligned captures reached the target, 19/20 aligned ones did. It cannot stay `observe` and cannot be deleted. |
| page long axis ≥ N px | **observe** | grading | VS-1 proved 3000 px *satisfiable* — 19/39 reached it, max 3352 against a 3887 ceiling. v1 never showed this. Discriminativeness still unmeasured. |
| regional exposure | **observe** | grading | Strongest predictor measured (AUC 0.940). VS-1 range 0.786–0.955, no capture below v1's old 0.74 floor, so the session cannot separate good from bad on it. |
| sharpness | **observe** | grading | Uncalibrated. VS-1 range 3499–11168 with no outcome to correlate against. |

Promotions require a recorded measurement, cited in this table.

## Rule lifecycle: promote or delete

`observe` is a queue, not a resting place. A rule that sits there indefinitely is
a threshold nobody has to justify and nobody can remove.

Every `observe` rule names the validation session that must decide it. **VS-1**
is one session on the target device against the existing frozen form. When it
closes, each rule listed against it takes exactly one of two outcomes:

- **promote** to `enforce`, with the measurement cited in the register — the
  rule must be shown both *satisfiable* on real captures and *discriminative* of
  grading success in `bench/`;
- **delete** — code, metric, and row removed.

There is no third outcome. "Needs more data" means delete; a rule that could not
be decided by a session of real captures is not blocking anything worth blocking,
and it can be reintroduced later with the measurement that motivates it. Adding
an `observe` rule without naming its session is not permitted.

### Known measurement limit, for VS-1 to account for

Found while building the VS-1 path, not by argument: the paper threshold is
adaptive (`p55 + 12`, clamped to 105–205), so a shadow darker than the threshold
is **excluded from the page mask** rather than measured on it. A severe
localised shadow therefore shrinks the detected page — it shows up as a geometry
anomaly, not as low regional exposure.

Consequence for the exposure rule: it is discriminative over mild and moderate
shading, which is the range the AUC 0.940 result was measured on, and blind at
the severe end where the page box distorts instead. VS-1 must read the two
together, and a promotion of `regional exposure` on its own would be reading a
metric outside the range where it holds. Not fixed here — the architecture is
frozen, and the fix would be an unvalidated threshold change.

## When Smart Capture is done

Capture is a supporting subsystem, not the objective. So the stop condition is
not a capture-quality threshold at all:

> **Smart Capture stops when further capture improvements no longer produce a
> measurable improvement in grading accuracy.**

A retake-rate target was rejected as the stop condition, and the reason
generalises: every capture-side metric — retake rate, page width, exposure,
utilisation — can be improved to its limit by an assistant that never changes a
single grade. Only the grading outcome can tell capture work when to stop.

### What counts as evidence

After VS-1, a Smart Capture change ships only with a paired `bench/` run —
same corpus, same labels, pipeline before and after — moving at least one of:

- **`false_accept_rate`** down. A wrong grade committed silently is the only
  failure that damages trust, so this dominates.
- **`correct_accepts / rows_scored`** up. Deliberately measured over *labelled
  rows*, not over accepted rows: a change that rescues sheets which previously
  failed to register earns credit here, while a change that buys accuracy by
  grading fewer rows does not.

Capture-side metrics may be *reported* in that run, but they never constitute
the justification. "The page is bigger" is not a result.

### What counts as measurable

The delta must exceed what the corpus can resolve. Over N labelled rows the
finest resolvable difference is one row in N, so a change moving fewer rows than
that has not been measured — it has been hoped for. Enlarging the corpus is a
legitimate way to resolve a smaller effect; asserting the effect is not.

A change that measures flat is not neutral. It is evidence that capture is no
longer the binding constraint, and work returns to the extraction model.

## What v2 deliberately does not do

- No auto-capture until the enforce set is validated. Manual capture with live
  advisory metrics comes first.
- No ArUco in the live loop. Registration is a commit-stage concern; detection
  is non-monotonic in resolution and cannot steer a teacher.
- No threshold tuning without a recorded capture that motivates it.
- No new capture feature whose justification is an argument rather than a
  measurement, and after VS-1 no capture change at all without a paired
  `bench/` run showing it moved grading accuracy.
- No diagnostic surface on the default screen.
