from zipfile import ZipFile

from hybrid_register.codes import DICTIONARY_SHA256, PRIMARY_CODE_TYPE, REFERENCE_CODE_TYPES, SECONDARY_CODE_TYPE, marker_address, marker_id, symbol_matrix, tag_dictionary
from hybrid_register.layout import OPTIMIZED_CELL_LAYOUT, RegisterLayout
from hybrid_register.register_pdf import teacher_cell_number
from hybrid_register.xlsx_rtl import set_workbook_rtl


def test_participation_columns_progress_right_to_left():
    layout = RegisterLayout()
    step_1_x, *_ = layout.cell_box_points(0, 0)
    step_30_x, *_ = layout.cell_box_points(0, 29)
    assert step_1_x > step_30_x


def test_teacher_mark_zone_is_separate_from_scanner_symbol():
    layout = RegisterLayout()
    cell_x, cell_y, cell_w, cell_h = layout.cell_box_points(5, 19)
    symbol_x, symbol_y, symbol_w, symbol_h = layout.symbol_box_points(5, 19)
    mark_x, mark_y, mark_w, mark_h = layout.mark_box_points(5, 19)

    assert symbol_x + symbol_w < mark_x
    assert mark_x + mark_w <= cell_x + cell_w
    assert cell_y <= mark_y < mark_y + mark_h <= cell_y + cell_h
    assert mark_w * mark_h > symbol_w * symbol_h
    assert symbol_y >= cell_y
    assert symbol_y + symbol_h <= cell_y + cell_h


def test_teacher_number_repeats_student_id_not_field_number():
    assert {teacher_cell_number(6) for _field in range(1, 31)} == {"6"}
    assert teacher_cell_number(1) == "1"


def test_field_header_sits_above_first_student_and_preserves_rtl_order():
    layout = RegisterLayout()
    first_x, header_y, first_w, header_h = layout.field_header_box_points(0)
    last_x, last_y, last_w, last_h = layout.field_header_box_points(29)
    _, first_student_y, _, student_h = layout.cell_box_points(0, 0)

    assert first_x > last_x
    assert header_y == first_student_y + student_h
    assert (first_w, header_h) == (last_w, last_h)
    assert last_y == header_y


def test_optimized_cell_increases_marker_without_sacrificing_teacher_zone():
    default = RegisterLayout()
    _, _, default_symbol_w, _ = default.symbol_box_points(0, 0)
    _, _, optimized_symbol_w, _ = OPTIMIZED_CELL_LAYOUT.symbol_box_points(0, 0)
    _, _, optimized_mark_w, optimized_mark_h = OPTIMIZED_CELL_LAYOUT.mark_box_points(0, 0)

    assert optimized_symbol_w > default_symbol_w
    assert optimized_mark_w / 72 * 25.4 >= 3.2
    assert optimized_mark_h / 72 * 25.4 >= 4.2


def test_reference_implementation_is_numeric_tag_based():
    assert PRIMARY_CODE_TYPE == "aruco"
    assert SECONDARY_CODE_TYPE == "apriltag"
    assert REFERENCE_CODE_TYPES == ("aruco", "apriltag")


def test_all_symbol_families_generate_distinct_square_matrices():
    expected_sides = {"qr": 37, "datamatrix": 28, "apriltag": 10, "aruco": 11}
    for code_type, side in expected_sides.items():
        first = symbol_matrix(code_type, "A1", 1, 1)
        last = symbol_matrix(code_type, "A1", 40, 30)
        assert len(first) == side
        assert all(len(row) == side for row in first)
        assert first != last
    assert marker_id(1, 1) == 0
    assert marker_id(40, 30) == 1199
    assert marker_address(0) == (1, 1)
    assert marker_address(1199) == (40, 30)


def test_reference_dictionaries_have_frozen_fingerprints():
    import hashlib
    for code_type in REFERENCE_CODE_TYPES:
        actual = hashlib.sha256(tag_dictionary(code_type).bytesList.tobytes()).hexdigest()
        assert actual == DICTIONARY_SHA256[code_type]


def test_xlsx_postprocessor_sets_every_sheet_rtl(tmp_path):
    target = tmp_path / "sample.xlsx"
    with ZipFile(target, "w") as archive:
        archive.writestr("xl/worksheets/sheet1.xml", '<x:worksheet><x:sheetViews><x:sheetView workbookViewId="0"/></x:sheetViews></x:worksheet>')
        archive.writestr("xl/worksheets/sheet2.xml", '<worksheet><sheetViews><sheetView rightToLeft="1" workbookViewId="0"/></sheetViews></worksheet>')
    set_workbook_rtl(target)
    with ZipFile(target) as archive:
        for name in ("xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"):
            xml = archive.read(name).decode("utf-8")
            assert xml.count('rightToLeft="1"') == 1
