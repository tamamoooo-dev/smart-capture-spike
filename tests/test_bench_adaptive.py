"""Guards on the frozen AdaptiveSwitch baseline (ADR-0004).

These pin behaviour, not accuracy. The measured 2.08 MAE belongs to one image
and one degradation mechanism; what must not drift silently is the switching
contract itself.
"""
import numpy as np
import pytest

from bench.fusion import AdaptiveSwitch, Fusion
from bench.inference import infer_sheet
from bench.observations import ObservationTensor


def make(hi_plane, lo_plane, quality, names=("chroma_area", "local_contrast")):
    vals = np.stack([hi_plane, lo_plane], axis=-1)
    q = quality[:, :, None]
    return ObservationTensor("c", "phone", names, vals, {},
                             q, ("exposure",))


def bar(scores, steps=30, hi=1.0, lo=0.0):
    out = np.full((len(scores), steps), lo)
    for i, s in enumerate(scores):
        out[i, :s] = hi
    return out


def test_frozen_constants_have_not_drifted():
    """ADR-0004 pins these. Changing them requires new corpus evidence."""
    assert AdaptiveSwitch.HIGH_QUALITY_FEATURE == "chroma_area"
    assert AdaptiveSwitch.LOW_QUALITY_FEATURE == "local_contrast"
    assert AdaptiveSwitch.QUALITY_METRIC == "exposure"
    assert AdaptiveSwitch.THRESHOLD == 0.75


def test_satisfies_the_layer2_protocol():
    assert isinstance(AdaptiveSwitch(), Fusion)


def test_high_quality_rows_follow_the_chroma_branch():
    truth = [7, 7, 7, 7]
    good, bad = bar(truth), bar([20] * 4)
    obs = make(good, bad, np.full((4, 30), 0.95))
    assert [t.score for t in infer_sheet(AdaptiveSwitch().fit(obs).log_odds(obs))] == truth


def test_low_quality_rows_follow_the_contrast_branch():
    truth = [7, 7, 7, 7]
    good, bad = bar([20] * 4), bar(truth)
    obs = make(good, bad, np.full((4, 30), 0.40))
    assert [t.score for t in infer_sheet(AdaptiveSwitch().fit(obs).log_odds(obs))] == truth


def test_switching_is_per_cell_not_per_sheet():
    """Quality varies within a sheet, so the branch must too."""
    q = np.full((4, 30), 0.95)
    q[2:] = 0.40
    good = bar([9, 9, 25, 25])
    bad = bar([25, 25, 9, 9])
    obs = make(good, bad, q)
    assert [t.score for t in infer_sheet(AdaptiveSwitch().fit(obs).log_odds(obs))] == [9, 9, 9, 9]


def test_missing_quality_falls_back_rather_than_averaging():
    """Without quality planes it must pick a branch, never blend two that disagree."""
    vals = np.stack([bar([6] * 3), bar([19] * 3)], axis=-1)
    obs = ObservationTensor("c", "phone", ("chroma_area", "local_contrast"), vals)
    assert [t.score for t in infer_sheet(AdaptiveSwitch().fit(obs).log_odds(obs))] == [6, 6, 6]


def test_requires_fit_before_use():
    obs = make(bar([5] * 2), bar([5] * 2), np.full((2, 30), 0.9))
    with pytest.raises(RuntimeError):
        AdaptiveSwitch().log_odds(obs)


def test_quality_planes_survive_selection_and_disk(tmp_path):
    obs = make(bar([5, 9]), bar([5, 9]), np.full((2, 30), 0.8))
    obs.meta["degradation"] = ["shadow"]
    obs.save(tmp_path)
    back = ObservationTensor.load(tmp_path / "c.json")
    assert back.quality_names == ("exposure",)
    assert np.allclose(back.quality_plane("exposure"), 0.8)
    assert back.select(("chroma_area",)).quality is not None


def test_quality_shape_mismatch_is_rejected():
    with pytest.raises(ValueError):
        ObservationTensor("c", "phone", ("a",), np.zeros((4, 30, 1)),
                          {}, np.zeros((3, 30, 1)), ("exposure",))
    with pytest.raises(ValueError):
        ObservationTensor("c", "phone", ("a",), np.zeros((4, 30, 1)),
                          {}, np.zeros((4, 30, 2)), ("exposure",))


def test_unknown_quality_metric_raises():
    obs = make(bar([5] * 2), bar([5] * 2), np.full((2, 30), 0.9))
    with pytest.raises(KeyError):
        obs.quality_plane("nope")
