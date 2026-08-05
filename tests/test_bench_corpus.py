import pytest

from bench.corpus import CAPTURE_CLASSES, Capture, Corpus, CorpusError, GroundTruth
from pathlib import Path


def cap(cid, cls="phone"):
    return Capture(id=cid, path=Path(f"{cid}.png"), capture_class=cls)


def test_capture_class_must_be_known():
    with pytest.raises(CorpusError):
        cap("x", "flatbed_maybe")


def test_scanner_class_does_not_offer_chroma():
    """Measured: scanner document mode is achromatic. Chroma is unavailable,
    not merely degraded, so a scanner result can never validate a chroma feature."""
    assert cap("s", "scanner").supports("chroma") is False
    assert cap("s", "scanner").supports("luma") is True
    assert cap("p", "phone").supports("chroma") is True


def test_classes_are_partitioned_not_pooled():
    c = Corpus(captures=[cap("a"), cap("b"), cap("s1", "scanner")])
    assert c.class_counts() == {"phone": 2, "scanner": 1, "synthetic": 0}
    assert [x.id for x in c.of_class("scanner")] == ["s1"]


def test_unknown_class_query_is_rejected():
    with pytest.raises(CorpusError):
        Corpus(captures=[cap("a")]).of_class("nope")


def test_ground_truth_rejects_out_of_range_scores():
    with pytest.raises(CorpusError):
        GroundTruth("x", {1: 31})
    with pytest.raises(CorpusError):
        GroundTruth("x", {41: 5})


def test_ground_truth_defaults_to_unverified():
    assert GroundTruth("x", {1: 5}).verified is False
    assert GroundTruth("x", {i: 1 for i in range(1, 21)}).coverage == 0.5
