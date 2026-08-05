# Extraction baseline on the frozen capture

Smart Capture is frozen (`748e82d`) and is now only the input source. This
records what the extraction model does with that input, measured on the first
auto-captured frame (`vs-1-0001.jpg`, 965 of 1200 markers).

## The chain runs

| stage | result |
|---|---|
| `rectify` @16 px/mm | 965 markers, p50 0.280 mm, p95 0.920 mm → 4752×3360 |
| `PageStats.from_page` | paper 227.0, print 62.0, chroma_cut 7.50 |
| `extract_sheet` | (40, 30, 10) in ~13 s |
| `sheet_quality` | 6 planes; exposure 0.745–0.973 |
| `infer_sheet` | 40 scores |

`SelfCalibratingLLR`, `AdaptiveSwitch` and `SingleFeature(chroma_area)` all
return the **same 40 scores**. The scores are robust to the choice of fusion
model. The confidence attached to them is not.

## Finding: the confidence signal is degenerate

`infer_row` documents `margin` as "the only confidence signal the review gate
needs". Measured on this capture:

| model | cells saturated at ±CLIP | margin range | distinct margins over 40 rows |
|---|---|---|---|
| `SelfCalibratingLLR` | 0.0% | 10.43 – 38.59 | 36 |
| `AdaptiveSwitch` (ADR-0004 baseline) | **100.0%** | 4.00 – 4.00 | **1** |
| `SingleFeature(chroma_area)` | **100.0%** | 4.00 – 4.00 | **1** |

Cause, not guess: the two-mode split of `chroma_area` on this capture is
mu0 0.0016 (s0 0.0175) against mu1 0.4762 (s1 0.0964) — **8.3 sigma apart**. A
Gaussian LLR between modes that separated exceeds `CLIP = 4.0` at every cell, so
the log-odds field is ±4.0 everywhere and the thermometer prefix margin is
exactly CLIP for every row.

So under the frozen baseline the review gate receives one value for all 40 rows.
It cannot triage, and `bench/metrics.py` names the failure this exposes: a false
accept is "the only failure that damages trust".

The LLR is not obviously better placed. Its margins are graded, but they run
10.4–38.6, so no row would be flagged either. **0 of 40 rows would be reviewed
by either model.**

This says nothing yet about whether the scores are right. It says that if any of
them is wrong, nothing in the current pipeline would raise a hand.

## Measured against verified ground truth, 2026-08-05

Teacher-verified labels for `vs-1-0001` (40 of 40 predictions confirmed, zero
corrections). Metrics computed through `bench/metrics.py`, not by hand:

| metric | measured | target |
|---|---|---|
| row accuracy | **40/40 = 100.0%** | — |
| false accept rate | 0.0000 | < 0.001 |
| false reject rate | 0.0000 | — |
| review rate | 0.0000 | < 0.03 |
| retake rate | 0.0000 | < 0.05 |
| max absolute error | 0 | — |
| `meets_targets()` | **True** | — |

### Why this does not mean the targets are met

`meets_targets()` returns True because zero divided by forty is below any
threshold. With zero failures in 40 rows, the 95% upper bound on the true false
accept rate is **7.2%** — **72× the 0.001 target**. This sample cannot
distinguish a model that errs once in a thousand rows from one that errs once in
fourteen.

Bounding the rate below 0.001 with 95% confidence needs on the order of
**3,000 labelled rows — about 75 sheets**.

### Consequence for extraction work

There are no grading errors to attribute, so there is no largest error source to
identify, and no extraction change can be justified: any modification would move
row accuracy from 100% to at most 100%, which is unmeasurable. Under the
project's own rule — a change must produce a measured improvement in grading
accuracy or be discarded — **no extraction change is currently admissible.**

The binding constraint is corpus size, not model quality. The next useful work
is labelled sheets that contain errors to learn from, not edits to the model.

Supporting evidence that this is not a fluke of one capture: the phone capture
(965 markers) and the 300 dpi flatbed scan (823 markers) produce **identical
scores on all 40 rows**, MAE 0.000, through the same pipeline.

## What this needs next

Ground-truth scores for these 40 rows. Everything above is measurable without
labels; accuracy is not, and accuracy is the objective. Predicted scores for
`vs-1-0001`, students 1–40:

```
 4 10 18  9 11  7  7  8 10 12
 2  6  3  1  7  0  0  1  5  3
 2  4  1  1 23  2  2  5  3  6
 2 10  0  2  6  5  5  3  2  6
```
