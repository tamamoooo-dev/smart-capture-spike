"""Guards on the geometry model.

The regression these protect against is real: modelling marker corners at the
full symbol-box size instead of the detected black square inflated residuals
from ~0.2 mm to ~1.2 mm and looked exactly like page curvature.
"""
import numpy as np

from bench.geometry import (
    DETECTED_SIDE_RATIO,
    PT2MM,
    marker_corners_mm,
)
from hybrid_register.layout import OPTIMIZED_CELL_LAYOUT as OPT


def test_detected_square_is_eight_of_eleven_modules():
    assert DETECTED_SIDE_RATIO == 8 / 11


def test_modelled_marker_side_matches_measured_2_943mm():
    """IMG_1147 gave a median observed side of 2.943 mm."""
    quad = marker_corners_mm(0, 0, OPT)
    side = np.linalg.norm(quad[1] - quad[0])
    assert abs(side - 2.945) < 0.01


def test_marker_square_is_concentric_with_symbol_box():
    x, y, w, h = OPT.symbol_box_points(7, 12)
    _, page_h_pt = OPT.page_points
    box_cx = (x + w / 2) * PT2MM
    box_cy = (page_h_pt - (y + h / 2)) * PT2MM
    centre = marker_corners_mm(7, 12, OPT).mean(axis=0)
    assert abs(centre[0] - box_cx) < 1e-9
    assert abs(centre[1] - box_cy) < 1e-9


def test_corner_order_is_clockwise_from_top_left():
    """Must match OpenCV's ArUco convention or correspondences are scrambled."""
    q = marker_corners_mm(3, 4, OPT)
    assert q[0][0] < q[1][0]          # TL left of TR
    assert q[0][1] < q[3][1]          # TL above BL (y grows downward)
    assert np.allclose(q[1][1], q[0][1])
    assert np.allclose(q[2][0], q[1][0])


def test_rtl_step_ordering_is_preserved():
    """Step 1 must sit to the RIGHT of step 30 on the Arabic sheet."""
    step1 = marker_corners_mm(0, 0, OPT).mean(axis=0)
    step30 = marker_corners_mm(0, 29, OPT).mean(axis=0)
    assert step1[0] > step30[0]


def test_students_advance_downward():
    first = marker_corners_mm(0, 0, OPT).mean(axis=0)
    last = marker_corners_mm(39, 0, OPT).mean(axis=0)
    assert last[1] > first[1]


def test_row_and_column_pitch_match_the_frozen_layout():
    a = marker_corners_mm(0, 0, OPT).mean(axis=0)
    row_next = marker_corners_mm(1, 0, OPT).mean(axis=0)
    col_next = marker_corners_mm(0, 1, OPT).mean(axis=0)
    assert abs((row_next[1] - a[1]) - 4.675) < 0.01
    assert abs((a[0] - col_next[0]) - 7.60) < 0.01
