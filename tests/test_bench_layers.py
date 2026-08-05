"""Layer-separation contract tests.

The three layers must stay swappable: Layer 2 is expected to be replaced by a
learned model once verified labels exist, without touching Layer 1 or Layer 3.
"""
import numpy as np
import pytest

from bench.fusion import CLIP, Fusion, SelfCalibratingLLR, SingleFeature
from bench.inference import Transition, infer_row, infer_sheet
from bench.observations import ObservationTensor


def tensor(values, names=("a", "b")):
    return ObservationTensor("cap", "phone", tuple(names), np.asarray(values, float))


def thermometer(scores, steps=30, high=1.0, low=0.0, noise=0.0, seed=0):
    rng = np.random.default_rng(seed)
    out = np.full((len(scores), steps), low)
    for i, s in enumerate(scores):
        out[i, :s] = high
    return out + rng.normal(0, noise, out.shape) if noise else out


# --- Layer 3: transition inference --------------------------------------

def test_map_recovers_exact_transition():
    for score in (0, 1, 15, 29, 30):
        odds = np.where(np.arange(30) < score, 3.0, -3.0)
        assert infer_row(odds).score == score


def test_single_corrupted_cell_is_outvoted():
    """One bad cell must not move the transition: the row has 30 votes."""
    odds = np.where(np.arange(30) < 12, 3.0, -3.0)
    odds[4] = -CLIP
    assert infer_row(odds).score == 12


def test_margin_shrinks_as_evidence_weakens():
    strong = infer_row(np.where(np.arange(30) < 10, 4.0, -4.0))
    weak = infer_row(np.where(np.arange(30) < 10, 0.2, -0.2))
    assert strong.margin > weak.margin


def test_ambiguity_is_reported_at_the_boundary():
    odds = np.where(np.arange(30) < 10, 3.0, -3.0)
    odds[10] = 0.0
    t = infer_row(odds)
    assert t.score == 10 and t.ambiguous_by == 1


def test_inference_layer_takes_only_log_odds():
    """Layer 3 must work on a bare array with no feature or image context."""
    assert isinstance(infer_row([1.0] * 5 + [-1.0] * 5), Transition)
    assert len(infer_sheet(np.zeros((7, 30)))) == 7


# --- Layer 2: fusion ------------------------------------------------------

def test_both_fusions_satisfy_the_protocol():
    assert isinstance(SelfCalibratingLLR(), Fusion)
    assert isinstance(SingleFeature("a"), Fusion)


def test_fusion_is_unsupervised_labels_change_nothing():
    """The current model must ignore labels; a future one may not."""
    obs = tensor(np.stack([thermometer([5] * 12), thermometer([5] * 12)], axis=-1))
    a = SelfCalibratingLLR().fit(obs).log_odds(obs)
    b = SelfCalibratingLLR().fit(obs, labels=np.ones((12, 30), bool)).log_odds(obs)
    assert np.allclose(a, b)


def test_uninformative_feature_is_downweighted_not_trusted():
    """A collapsed channel must contribute nothing, not confident noise."""
    good = thermometer([8] * 20)
    dead = np.full((20, 30), 0.5)
    obs = tensor(np.stack([good, dead], axis=-1), names=("good", "dead"))
    model = SelfCalibratingLLR().fit(obs)
    assert "good" in model.active_features
    assert "dead" not in model.active_features


def test_contributions_are_clipped():
    obs = tensor(np.stack([thermometer([5] * 6, high=1e6, low=-1e6)] * 3, axis=-1),
                 names=("x", "y", "z"))
    odds = SelfCalibratingLLR().fit(obs).log_odds(obs)
    assert np.abs(odds).max() <= 3 * CLIP + 1e-9


def test_fusion_output_feeds_inference_directly():
    """End-to-end across all three layers on synthetic observations."""
    scores = [0, 3, 17, 30, 9]
    obs = tensor(np.stack([thermometer(scores, noise=0.05, seed=1),
                           thermometer(scores, noise=0.05, seed=2)], axis=-1))
    odds = SelfCalibratingLLR().fit(obs).log_odds(obs)
    assert [t.score for t in infer_sheet(odds)] == scores


def test_log_odds_requires_fit_first():
    obs = tensor(np.stack([thermometer([4] * 5)] * 2, axis=-1))
    with pytest.raises(RuntimeError):
        SelfCalibratingLLR().log_odds(obs)


# --- Layer 1 output contract ---------------------------------------------

def test_tensor_rejects_name_shape_mismatch():
    with pytest.raises(ValueError):
        ObservationTensor("c", "phone", ("a",), np.zeros((40, 30, 2)))


def test_tensor_roundtrips_through_disk(tmp_path):
    obs = tensor(np.random.default_rng(0).normal(size=(40, 30, 2)))
    obs.meta["registration_p95_mm"] = 0.86
    obs.save(tmp_path)
    back = ObservationTensor.load(tmp_path / "cap.json")
    assert back.names == obs.names
    assert back.capture_class == "phone"
    assert back.meta["registration_p95_mm"] == 0.86
    assert np.allclose(back.values, obs.values)


def test_select_preserves_requested_order():
    obs = tensor(np.random.default_rng(0).normal(size=(4, 30, 2)))
    assert obs.select(("b", "a")).names == ("b", "a")
    assert np.allclose(obs.select(("b",)).plane("b"), obs.plane("b"))


def test_unknown_feature_raises():
    with pytest.raises(KeyError):
        tensor(np.zeros((4, 30, 2))).plane("nope")
