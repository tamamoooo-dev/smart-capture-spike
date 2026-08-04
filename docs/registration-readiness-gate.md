# Registration-Readiness Gate

Status: design complete; implementation intentionally fail-closed.

## Target

The gate answers exactly one question:

> Can the production registration algorithm register this frame successfully?

It does not estimate whether the image merely looks acceptable. Whole-image sharpness, page coverage, and outline geometry may be retained as diagnostics, but they cannot authorize automatic capture.

## Architectural rule

The preview gate must run the same registration engine used after capture, or a bit-equivalent native/WASM build of it. A separate JavaScript proxy model is not an acceptable source of truth.

The current static GitHub Pages spike has no OpenCV ArUco engine. It therefore reports `registration_ready: false` and cannot auto-capture. Manual capture remains available for engineering inspection.

## Registration probe

The probe runs on the full-resolution preview frame and returns evidence, not a weighted heuristic score.

1. Detect a valid page quadrilateral with the production page detector.
2. Rectify the page and solve the known 40 × 30 grid using the production grid detector.
3. Project deterministic cell and marker regions through the solved homography.
4. Measure marker sampling at spatially stratified locations across the page.
5. Decode expected ArUco IDs in those regions with the production dictionary and decoder.
6. Fit or refine page geometry from decoded marker corners.
7. validate spatial coverage, ID-to-grid consistency, and reprojection residual.

The gate opens only when the registration solution itself is valid. Failure or absence of any required result keeps it closed.

## Evidence contract

```json
{
  "registration_ready": false,
  "blocker": "grid_not_solved",
  "page": {
    "detected": false,
    "quad": null
  },
  "grid": {
    "detected": false,
    "homography": null,
    "reprojection_residual_px": null
  },
  "sampling": {
    "projected_cell_width_px_p10": null,
    "projected_cell_height_px_p10": null,
    "projected_marker_side_px_p10": null,
    "pixels_per_encoded_module_p10": null
  },
  "marker_quality": {
    "local_edge_response_p10": null,
    "modulation_p10": null,
    "quiet_zone_clearance_p10": null,
    "decoder_margin_p10": null
  },
  "decoder": {
    "attempted": 0,
    "decoded_expected_ids": 0,
    "spatial_regions_covered": 0,
    "id_grid_mismatches": 0
  },
  "registration_confidence": null
}
```

## Metric definitions

- **Projected cell size:** cell dimensions after applying the actual page/grid homography, reported at the 10th percentile so one good region cannot hide a weak edge.
- **Marker resolution:** projected printed marker side in source pixels. The ArUco symbol contains 7 data modules plus a one-module border on every side; sampling must be evaluated in pixels per encoded module, with quiet-zone clearance reported separately.
- **Local sharpness:** edge response measured inside projected marker regions and aligned to expected module transitions. Whole-page Laplacian variance is forbidden as an acceptance signal.
- **Modulation:** separation between expected black and white marker modules after local normalization, not global page contrast.
- **Decoder margin:** distance from the observed marker sample to the production decoder's failure boundary, evaluated with the real decoder rather than inferred from page appearance.
- **Geometry validity:** consistency between decoded IDs, deterministic grid addresses, marker corners, and the solved homography.

## Confidence policy

No percentage is reported yet. A percentage would imply an empirically calibrated probability of registration success. It may be introduced only after the probe is implemented and evaluated against labeled physical frames. Until then the output is the conservative boolean `registration_ready` plus explicit evidence and blocker.

## Auto-capture rule

Automatic capture requires `registration_ready: true` for consecutive preview frames. The stabilizing frame count may prevent transient solutions, but it cannot convert a failed registration probe into a pass.

## Stop condition

No threshold tuning or further image experiment starts until the production registration probe is available in the preview runtime. If the production engine cannot run fast enough on preview frames, this Smart Capture direction stops rather than falling back to proxy metrics.
