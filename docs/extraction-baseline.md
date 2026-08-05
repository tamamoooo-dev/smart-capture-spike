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
