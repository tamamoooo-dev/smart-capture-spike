import numpy as np

from bench.families import (
    complete_linkage, disagreement, choose_representatives,
    merge_family_sets, spearman_matrix,
)
from bench.observations import ObservationTensor


def obs_from(planes, names):
    return ObservationTensor("c", "phone", tuple(names), np.stack(planes, axis=-1))


def test_identical_features_are_one_family():
    rng = np.random.default_rng(0)
    base = rng.normal(size=(40, 30))
    o = obs_from([base, base.copy(), rng.normal(size=(40, 30))], ["a", "b", "c"])
    fams = complete_linkage(spearman_matrix(o), o.names, 0.9)
    assert ["a", "b"] in fams and ["c"] in fams


def test_monotone_transform_counts_as_redundant():
    """Spearman, not Pearson: a rescaled feature carries no new information."""
    rng = np.random.default_rng(1)
    base = rng.uniform(0.1, 1.0, size=(40, 30))
    o = obs_from([base, np.log(base)], ["lin", "log"])
    assert complete_linkage(spearman_matrix(o), o.names, 0.9) == [["lin", "log"]]


def test_complete_linkage_does_not_chain():
    """a~b and b~c must not merge a with c when a and c are unrelated."""
    rng = np.random.default_rng(2)
    a = rng.normal(size=(40, 30))
    c = rng.normal(size=(40, 30))
    b = a + c
    fams = complete_linkage(spearman_matrix(obs_from([a, b, c], ["a", "b", "c"])),
                            ("a", "b", "c"), 0.9)
    assert not any({"a", "c"} <= set(f) for f in fams)


def test_merge_keeps_only_groupings_holding_on_every_class():
    per = {"phone": [["a", "b"], ["c"]], "scanner": [["a"], ["b", "c"]]}
    assert merge_family_sets(per) == [["a"], ["b"], ["c"]]


def test_merge_preserves_grouping_agreed_by_all_classes():
    per = {"phone": [["a", "b"], ["c"]], "scanner": [["a", "b"], ["c"]]}
    assert merge_family_sets(per) == [["a", "b"], ["c"]]


def test_representative_is_the_most_central_member():
    rng = np.random.default_rng(3)
    core = rng.normal(size=(40, 30))
    o = obs_from([core, core + 0.01 * rng.normal(size=(40, 30)),
                  core + 0.4 * rng.normal(size=(40, 30))], ["x", "y", "z"])
    fam = choose_representatives(spearman_matrix(o), o.names, [["x", "y", "z"]])[0]
    assert fam.representative in ("x", "y")


def test_disagreement_is_zero_when_families_agree():
    assert disagreement([7, 7, 7]) == 0.0
    assert disagreement([7]) == 0.0
    assert disagreement([2, 9]) == 7.0
