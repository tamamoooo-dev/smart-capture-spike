import pytest

from bench.metrics import (
    RowMetrics,
    RowOutcome,
    RowStatus,
    combine,
    score_rows,
)


def accepted(student: int, score: int) -> RowOutcome:
    return RowOutcome(student, RowStatus.ACCEPTED, score)


def review(student: int) -> RowOutcome:
    return RowOutcome(student, RowStatus.REVIEW)


def unregistered(student: int) -> RowOutcome:
    return RowOutcome(student, RowStatus.UNREGISTERED)


def test_accepted_row_must_carry_a_score():
    with pytest.raises(ValueError):
        RowOutcome(1, RowStatus.ACCEPTED, None)


def test_non_accepted_row_must_not_carry_a_score():
    """A row sent to review must commit nothing. This is the safety invariant."""
    with pytest.raises(ValueError):
        RowOutcome(1, RowStatus.REVIEW, 5)
    with pytest.raises(ValueError):
        RowOutcome(1, RowStatus.UNREGISTERED, 5)


def test_correct_accepts_do_not_count_as_false():
    m = score_rows([accepted(1, 5), accepted(2, 0), accepted(3, 30)],
                   {1: 5, 2: 0, 3: 30})
    assert m.rows_scored == 3
    assert m.correct_accepts == 3
    assert m.false_accepts == 0
    assert m.accuracy_given_accepted == 1.0


def test_wrong_accept_is_a_false_accept():
    m = score_rows([accepted(1, 6)], {1: 5})
    assert m.false_accepts == 1
    assert m.false_accept_rate == 1.0
    assert m.abs_errors == [1]


def test_review_is_not_a_false_accept():
    """Sending an uncertain row to review is a cost, never an accuracy failure."""
    m = score_rows([review(1), review(2)], {1: 5, 2: 9})
    assert m.false_accepts == 0
    assert m.false_accept_rate == 0.0
    assert m.review_rate == 1.0


def test_unregistered_is_tracked_separately_from_review():
    m = score_rows([unregistered(1), review(2)], {1: 5, 2: 9})
    assert m.unregistered_rate == 0.5
    assert m.review_rate == 0.5
    assert m.false_accepts == 0


def test_unlabelled_rows_are_skipped_not_counted_correct():
    """Partial ground truth must not flatter a pipeline."""
    m = score_rows([accepted(1, 5), accepted(2, 99 % 31)], {1: 5})
    assert m.rows_scored == 1
    assert m.correct_accepts == 1


def test_duplicate_outcomes_are_rejected():
    with pytest.raises(ValueError):
        score_rows([accepted(1, 5), accepted(1, 6)], {1: 5})


def test_off_by_one_share_discriminates_error_character():
    geometry_like = score_rows(
        [accepted(1, 6), accepted(2, 4), accepted(3, 8)], {1: 5, 2: 5, 3: 7})
    assert geometry_like.off_by_one_share == 1.0
    assert geometry_like.max_abs_error == 1

    extraction_like = score_rows([accepted(1, 30), accepted(2, 0)], {1: 5, 2: 9})
    assert extraction_like.off_by_one_share == 0.0
    assert extraction_like.max_abs_error == 25


def test_targets_require_both_accuracy_and_low_review():
    good = RowMetrics(rows_scored=10000, correct_accepts=9900, false_accepts=0, reviews=100)
    assert good.meets_targets()

    accurate_but_unusable = RowMetrics(rows_scored=100, correct_accepts=50, reviews=50)
    assert accurate_but_unusable.false_accept_rate == 0.0
    assert not accurate_but_unusable.meets_targets()

    fast_but_wrong = RowMetrics(rows_scored=1000, correct_accepts=990, false_accepts=10)
    assert not fast_but_wrong.meets_targets()


def test_combine_aggregates_across_captures():
    a = score_rows([accepted(1, 5), review(2)], {1: 5, 2: 9})
    b = score_rows([accepted(1, 4)], {1: 5})
    total = combine([a, b])
    assert total.rows_scored == 3
    assert total.correct_accepts == 1
    assert total.false_accepts == 1
    assert total.reviews == 1
    assert total.abs_errors == [1]


def test_empty_metrics_do_not_divide_by_zero():
    m = RowMetrics()
    assert m.false_accept_rate == 0.0
    assert m.accuracy_given_accepted == 0.0
    assert m.off_by_one_share == 0.0
