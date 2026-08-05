from hybrid_register.electronic import StudentRecord, apply_merge, participation_from_marks, propose_merge
from hybrid_register.qr_codec import matrix, parse_payload, payload, qr_measurements


def test_qr_payload_has_only_required_fields():
    text = payload("A1", 17, 8)
    assert text == '{"register":"A1","student":17,"step":8}'
    assert parse_payload(text) == {"register": "A1", "student": 17, "step": 8}


def test_qr_is_real_matrix_and_version_is_measured():
    values = qr_measurements()
    assert values["version"] >= 1
    assert values["total_modules"] == len(matrix("A1", 40, 30))
    assert any(any(row) for row in matrix("A1", 40, 30))


def test_first_unmarked_rule():
    assert participation_from_marks(set()) == 0
    assert participation_from_marks(set(range(1, 9))) == 8
    assert participation_from_marks(set(range(1, 31))) == 30
    assert participation_from_marks({1, 2, 4}) == 2


def test_merge_never_mutates_before_confirmation():
    record = StudentRecord(1, "Ahmed", participation=4, homework=10)
    preview = propose_merge(record, 7)
    assert record.participation == 4
    assert preview["conflicts"]
    apply_merge(record, preview, confirm_conflicts=False)
    assert record.participation == 4
    apply_merge(record, preview, confirm_conflicts=True)
    assert record.participation == 7

