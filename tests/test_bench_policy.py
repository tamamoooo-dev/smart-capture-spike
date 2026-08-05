"""Rejection reasons, asymmetric risk, and mechanism routing."""
import numpy as np
import pytest

from bench.gate import CaptureQualityGate, GateOutcome, RiskModel
from bench.policy import MechanismEvidence, Owner, route

NAMES = ("exposure", "sharpness")


def q(e, s, shape=(40, 30)):
    return np.stack([np.full(shape, e), np.full(shape, s)], axis=-1)


def gate():
    return CaptureQualityGate().calibrate([(q(0.90, 0.80), NAMES), (q(0.88, 0.78), NAMES)])


# --- rejection reasons are actionable ------------------------------------

def test_uniform_darkness_and_partial_shadow_get_different_advice():
    """Opposite remedies: add light vs move out of the light."""
    dark = gate().assess(q(0.30, 0.80), NAMES)
    shadowed = q(0.90, 0.80)
    shadowed[20:, :, 0] = 0.30
    shadow = gate().assess(shadowed, NAMES)
    assert [r.code for r in dark.reasons] == ["INSUFFICIENT_EXPOSURE"]
    assert [r.code for r in shadow.reasons] == ["NON_UNIFORM_ILLUMINATION"]
    assert dark.advice_en() != shadow.advice_en()


def test_blur_is_named_and_carries_both_languages():
    d = gate().assess(q(0.90, 0.05), NAMES)
    r = d.primary_reason
    assert r.code == "EXCESSIVE_BLUR"
    assert r.message_en and r.message_ar
    assert r.observed < r.floor


def test_reasons_are_ordered_by_how_much_of_the_page_they_affect():
    bad = q(0.90, 0.80)
    bad[:, :, 1] = 0.05          # blur everywhere
    bad[35:, :, 0] = 0.10        # darkness on a few rows
    d = gate().assess(bad, NAMES)
    assert d.primary_reason.code == "EXCESSIVE_BLUR"
    assert len(d.advice_en()) >= 2


def test_a_rejected_capture_always_explains_itself():
    """A bare pass/fail leaves the teacher guessing what to change."""
    d = gate().assess(q(0.20, 0.20), NAMES)
    assert not d.accepted and d.reasons and d.advice_ar()


def test_clean_capture_raises_no_reasons():
    assert gate().assess(q(0.90, 0.80), NAMES).reasons == []


def test_trivial_local_failures_do_not_generate_advice():
    bad = q(0.90, 0.80)
    bad[0, :, 0] = 0.10          # one row of 40
    assert gate().assess(bad, NAMES).reasons == []


# --- asymmetric risk ------------------------------------------------------

def test_one_false_accept_outweighs_many_false_rejects():
    r = RiskModel()
    assert r.expected_cost(1, 0) > r.expected_cost(0, 199)


def test_threshold_choice_prefers_rejecting_over_accepting():
    r = RiskModel()
    chosen, _ = r.choose_threshold([(0.10, 0, 8), (0.15, 1, 2), (0.25, 3, 0)])
    assert chosen == 0.10


def test_ties_break_toward_the_stricter_threshold():
    r = RiskModel()
    chosen, _ = r.choose_threshold([(0.10, 0, 5), (0.30, 0, 5)])
    assert chosen == 0.10


def test_outcome_exposes_both_errors_and_no_blended_accuracy():
    o = GateOutcome(captures=14, accepted=9, false_accepts=1, false_rejects=2)
    assert o.false_accept_rate == pytest.approx(1 / 14)
    assert o.false_reject_rate == pytest.approx(2 / 14)
    assert not hasattr(o, "accuracy")


# --- mechanism routing ----------------------------------------------------

def ev(**kw):
    base = dict(mechanism="m", marker_coverage=0.65, registration_p95_mm=0.9,
                oracle_exact_rate=1.0, oracle_max_error=0, oracle_mae=0.0,
                cell_accuracy=0.99, gate_detected=True)
    base.update(kw)
    return MechanismEvidence(**base)


def test_bad_registration_is_routed_upstream_of_observations():
    assert route(ev(marker_coverage=0.20)).owner is Owner.REGISTRATION
    assert route(ev(registration_p95_mm=3.5)).owner is Owner.REGISTRATION


def test_recoverable_and_detected_belongs_to_the_observation_model():
    assert route(ev()).owner is Owner.OBSERVATION_MODEL


def test_destroyed_but_detected_belongs_to_the_capture_gate():
    p = route(ev(oracle_exact_rate=0.30, oracle_max_error=9, oracle_mae=4.1,
                 cell_accuracy=0.60))
    assert p.owner is Owner.CAPTURE_GATE
    assert p.rejectable and not p.recoverable


def test_destroyed_and_undetected_is_a_release_blocker():
    p = route(ev(oracle_exact_rate=0.30, oracle_max_error=9, oracle_mae=4.1,
                 cell_accuracy=0.60, gate_detected=False))
    assert p.owner is Owner.DANGER_UNDETECTED
    assert p.owner.is_blocker


def test_sound_cells_but_wrong_rows_implicates_inference():
    p = route(ev(cell_accuracy=0.99, oracle_exact_rate=0.40, oracle_max_error=6))
    assert p.owner is Owner.TRANSITION_INFERENCE


def test_registration_is_checked_before_everything_else():
    """A bad warp corrupts every observation; fixing observations treats the symptom."""
    p = route(ev(marker_coverage=0.10, oracle_exact_rate=0.10,
                 oracle_max_error=9, cell_accuracy=0.20, gate_detected=False))
    assert p.owner is Owner.REGISTRATION


def test_policy_records_the_evidence_that_justified_it():
    p = route(ev())
    assert p.evidence["oracle_exact_rate"] == 1.0
    assert "gate_detected" in p.evidence and p.root_cause
