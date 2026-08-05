from hybrid_register.guided import infer_cumulative_prefix


FILLED = 0.09
EMPTY = 0.002
WEAK_EMPTY = 0.026
WEAK_FILLED = 0.03


def test_clean_prefix_returns_transition_score():
    result = infer_cumulative_prefix([FILLED] * 5 + [EMPTY] * 3)

    assert result.score == 5
    assert result.status == "confident"
    assert not result.review_required
    assert result.violation_steps == ()


def test_single_weak_hole_is_corrected_by_prefix_structure():
    result = infer_cumulative_prefix([FILLED, FILLED, WEAK_EMPTY, FILLED, FILLED, EMPTY, EMPTY])

    assert result.score == 5
    assert result.status == "corrected_weak_cell"
    assert result.violation_steps == (3,)
    assert result.weak_violation_steps == (3,)


def test_single_weak_mark_after_transition_is_ignored():
    result = infer_cumulative_prefix([FILLED, FILLED, FILLED, EMPTY, WEAK_FILLED, EMPTY])

    assert result.score == 3
    assert result.status == "corrected_weak_cell"
    assert result.violation_steps == (5,)


def test_strong_filled_empty_filled_pattern_requires_review():
    result = infer_cumulative_prefix([FILLED, FILLED, EMPTY, FILLED, EMPTY, EMPTY])

    assert result.score is None
    assert result.status == "review"
    assert result.review_required
    assert result.raw_transitions >= 2


def test_multiple_weak_breaks_are_not_silently_corrected():
    result = infer_cumulative_prefix([FILLED, WEAK_EMPTY, FILLED, WEAK_EMPTY, FILLED, EMPTY])

    assert result.score is None
    assert result.status == "review"
    assert len(result.violation_steps) > 1


def test_empty_and_full_rows_are_valid_prefixes():
    empty = infer_cumulative_prefix([EMPTY] * 8)
    full = infer_cumulative_prefix([FILLED] * 8)

    assert empty.score == 0 and empty.status == "confident"
    assert full.score == 8 and full.status == "confident"
