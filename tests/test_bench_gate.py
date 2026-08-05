"""Stage 1 gate contract, and the P4 mechanism-ownership rule."""
import numpy as np
import pytest

from bench.gate import (
    CaptureQualityGate, classify_mechanism, is_recoverable,
    oracle_errors,
)

NAMES = ("exposure", "sharpness")


def q(exposure, sharpness, shape=(40, 30)):
    return np.stack([np.full(shape, exposure), np.full(shape, sharpness)], axis=-1)


def clean_set():
    return [(q(0.90, 0.80), NAMES), (q(0.88, 0.78), NAMES)]


def test_gate_must_be_calibrated_before_use():
    with pytest.raises(RuntimeError):
        CaptureQualityGate().assess(q(0.9, 0.8), NAMES)


def test_gate_needs_a_clean_control():
    with pytest.raises(ValueError):
        CaptureQualityGate().calibrate([])


def test_clean_capture_is_accepted():
    g = CaptureQualityGate().calibrate(clean_set())
    assert g.assess(q(0.90, 0.80), NAMES).accepted


def test_uniformly_degraded_capture_is_rejected():
    g = CaptureQualityGate().calibrate(clean_set())
    d = g.assess(q(0.30, 0.20), NAMES)
    assert not d.accepted
    assert d.inadequate_fraction == 1.0


def test_localised_degradation_below_tolerance_is_accepted():
    """A few bad rows must not condemn the whole page."""
    g = CaptureQualityGate().calibrate(clean_set())
    bad = q(0.90, 0.80)
    bad[:4] = 0.10                      # 10% of rows
    d = g.assess(bad, NAMES)
    assert d.accepted
    assert d.rows_rejected == 4


def test_localised_degradation_above_tolerance_is_rejected():
    g = CaptureQualityGate().calibrate(clean_set())
    bad = q(0.90, 0.80)
    bad[:20] = 0.10                     # 50% of rows
    assert not g.assess(bad, NAMES).accepted


def test_gate_reports_which_metric_failed():
    g = CaptureQualityGate().calibrate(clean_set())
    d = g.assess(q(0.10, 0.80), NAMES)
    assert d.worst_metric == "exposure"
    assert d.per_metric_fraction["sharpness"] == 0.0


def test_row_granularity_matches_the_unit_of_failure():
    g = CaptureQualityGate().calibrate(clean_set())
    bad = q(0.90, 0.80)
    bad[7] = 0.05
    d = g.assess(bad, NAMES)
    assert d.row_accepted is not None
    assert not d.row_accepted[7]
    assert d.row_accepted.sum() == 39


# --- recoverability: the oracle bound ------------------------------------

def test_oracle_takes_the_best_observation_per_row():
    errs = np.array([[0, 5, 3], [4, 0, 3], [9, 9, 2]])
    assert list(oracle_errors(errs)) == [0, 0, 2]


def test_perfect_information_is_recoverable():
    ok, stats = is_recoverable(np.zeros((3, 40)))
    assert ok and stats["oracle_exact_rate"] == 1.0


def test_destroyed_information_is_not_recoverable():
    ok, stats = is_recoverable(np.full((3, 40), 7))
    assert not ok and stats["oracle_max_error"] == 7


def test_a_single_unrecoverable_row_blocks_recoverability():
    """max_error > 1 means at least one row no observation can reach."""
    errs = np.zeros((2, 40))
    errs[:, 3] = 6
    ok, _ = is_recoverable(errs)
    assert not ok


def test_recoverability_uses_the_oracle_not_any_single_model():
    """Two mediocre observations that fail on different rows are jointly fine."""
    a = np.array([0, 0, 5, 5]); b = np.array([5, 5, 0, 0])
    ok, _ = is_recoverable(np.stack([a, b]))
    assert ok


# --- P4 ------------------------------------------------------------------

def test_p4_quadrants():
    assert classify_mechanism(True, True) == "observation_model"
    assert classify_mechanism(True, False) == "observation_model_global"
    assert classify_mechanism(False, True) == "capture_gate"
    assert classify_mechanism(False, False) == "DANGER_undetected_loss"


def test_danger_quadrant_is_information_loss_the_gate_cannot_see():
    """The only quadrant that yields silent wrong grades in production."""
    assert classify_mechanism(recoverable=False, gate_detected=False).startswith("DANGER")
