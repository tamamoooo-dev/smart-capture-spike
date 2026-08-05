from app import app


def page():
    return app.test_client().get("/smart-capture-spike").get_data(as_text=True)


def script():
    return app.test_client().get("/static/smart_capture_spike.js").get_data(as_text=True)


def test_smart_capture_spike_is_standalone_rtl():
    response = app.test_client().get("/smart-capture-spike")
    assert response.status_code == 200
    assert '<html lang="ar" dir="rtl">' in response.get_data(as_text=True)
    assert "getUserMedia" in script()


def test_live_checks_are_guidance_only():
    html = page()
    for check in ("orientation", "pageVisible", "perspective", "sharpness",
                  "lighting", "uniformLighting", "pageSize"):
        assert f'data-check="{check}"' in html


def test_registration_is_not_a_live_check():
    """Marker detection needs ~3000 px and is non-monotonic in resolution
    (66.3% at 3000 px, 54.7% at 3500 px), so it cannot steer the teacher.
    It belongs to the commit stage."""
    assert 'data-check="registrationReady"' not in page()
    assert "registrationStage: 'commit'" in script()


def test_resolution_requirement_is_on_the_page_not_the_frame():
    """A 3500px frame at 51% linear coverage yields only ~1785px of page. The
    grading requirement is page width, so that is what gets checked."""
    js = script()
    assert "MIN_PAGE_WIDTH_PX = 3000" in js
    assert "pageWidthPx >= MIN_PAGE_WIDTH_PX" in js
    assert "minPageCoverage" not in js, "guessed coverage constant should be derived away"
    assert "maxWidth = 2200" not in js


def test_insufficient_camera_is_refused_before_any_capture():
    """A page can never be wider than the frame, so a camera below the floor is
    a deterministic failure known at stream start. It must not be discovered
    after the shutter."""
    js = script()
    assert "granted < MIN_STREAM_WIDTH" in js
    assert "smartcapture:unsupported" in js
    assert "stopCamera();" in js


def test_no_post_capture_resolution_rejection():
    """Deterministic conditions are enforced before the shutter; the commit
    stage handles only unpredictable failures."""
    js = script()
    assert "belowFloor" not in js


def test_stream_requests_maximum_available_resolution():
    js = script()
    assert "width: {ideal: MAX_CAPTURE_WIDTH}" in js
    assert "width:{ideal:1920}" not in js


def test_landscape_orientation_is_required_and_checked_first():
    """The register is A4 landscape. On a 4:3 sensor with 5% margins a portrait
    hold caps the page at ~2722px against a 3000px floor, so portrait can never
    satisfy pageSize. Every other correction is wasted until the phone turns."""
    js = script()
    assert "orientation: landscape" in js
    assert "أدر الهاتف أفقياً" in js
    assert js.index("checks.orientation") < js.index("checks.pageVisible")


def test_orientation_is_measured_from_the_sheet_not_the_stream():
    """video.videoWidth/videoHeight describe the MediaStream and do not change
    when the phone is rotated. Testing frame aspect made the check permanently
    true (360 >= 270), so rotating the device had no effect at all."""
    js = script()
    assert "const pageAspect = boxWidth / Math.max(1, boxHeight)" in js
    assert "const landscape = pageAspect >= 1.0" in js
    assert "const landscape = width >= height" not in js


def test_device_orientation_is_observed_for_layout():
    """Nothing previously listened for rotation, so the UI stayed
    portrait-shaped however the phone was turned."""
    js = script()
    assert "screen.orientation" in js
    assert "orientationchange" in js
    assert "(orientation: landscape)" in js
    assert "device-landscape" in js


def test_css_responds_to_landscape_orientation():
    css = app.test_client().get("/static/smart_capture_spike.css").get_data(as_text=True)
    assert "@media (orientation:landscape)" in css
    assert "device-landscape" in css


def test_portrait_hold_is_not_treated_as_an_incapable_camera():
    """Capability is a sensor property, so it is tested on the LONG side. A
    capable phone held portrait must be guided to rotate, not refused."""
    js = script()
    assert "Math.max(video.videoWidth, video.videoHeight)" in js


def test_framing_guide_matches_the_paper_aspect():
    css = app.test_client().get("/static/smart_capture_spike.css").get_data(as_text=True)
    assert "aspect-ratio:297/210" in css


def test_page_size_checks_resolution_only():
    """Corner visibility is pageVisible's job. Testing coverage inside pageSize
    made one check enforce two competing requirements, so satisfying resolution
    could push the teacher into losing a corner."""
    js = script()
    assert "pageSize: pageWidthPx >= MIN_PAGE_WIDTH_PX
" in js
    assert "pageSize: pageWidthPx >= MIN_PAGE_WIDTH_PX && coverage" not in js


def test_move_closer_is_never_asked_once_resolution_is_met():
    """pageSize passes on page width alone, so no move-closer message can be
    produced while pageWidthPx is already above the floor."""
    js = script()
    body = js[js.index("if (!checks.pageSize)"):js.index("return 'الإطار صالح")]
    assert "قرّب الهاتف" in body
    assert "metrics.pageWidthPx >= metrics.achievablePageWidthPx" in body


def test_shortfall_beyond_safe_fill_is_reported_not_nagged():
    """Past the safe fill, moving closer would cost a corner. That is a device
    or orientation limit and must be reported as one."""
    js = script()
    assert "MAX_SAFE_PAGE_FILL = 0.90" in js
    assert "achievablePageWidthPx" in js
    assert "تعذّر بلوغ الدقة المطلوبة مع إبقاء الزوايا الأربع ظاهرة" in js


def test_resolution_indicator_shows_pixels_not_screen_fill():
    js = script()
    assert "if (name === 'pageSize') return `${m.pageWidthPx}px`" in js


def test_lighting_is_measured_regionally_not_page_wide():
    """A page mean cannot see a localised shadow: on IMG_1147 the phone's own
    shadow covered rows 21-40 while barely moving the page mean, yet local
    exposure predicted per-row grading success with AUC 0.940."""
    js = script()
    assert "lightingGridX" in js and "lightingGridY" in js
    assert "minRegionLumaRatio" in js
    assert "uniformity" in js


def test_shadow_and_darkness_get_different_messages():
    """Opposite remedies: move out of the light vs add light."""
    js = script()
    assert "checks.uniformLighting" in js
    assert "حرّك يدك أو الهاتف بعيداً عن مصدر الضوء" in js
    assert "حسّن الإضاءة" in js


def test_page_size_guidance_is_directional():
    """The previous build told the teacher to move closer when too close."""
    js = script()
    assert "metrics.coverage > THRESHOLDS.maxPageCoverage" in js
    assert "ابتعد قليلاً" in js
    assert "قرّب الهاتف" in js


def test_worst_shadow_region_is_localised_for_the_guide_overlay():
    js = script()
    assert "worstRegionBox" in js


def test_frames_are_processed_locally_only():
    assert "/api/scan" not in page()
    assert "fetch(" not in script()


def test_orientation_falls_back_closed_when_no_page_is_found():
    """No page box must never let orientation pass on a fallback value."""
    js = script()
    assert "checks:{orientation:false,pageVisible:false," in js
    assert "landscape:false,pageAspect:0}" in js


def test_detector_readout_is_visible_live():
    """The orientation indicator is unfalsifiable from the UI unless the
    measured box and aspect are shown, so a real measurement can be told apart
    from a fallback."""
    js = script()
    assert "m.pageAspect.toFixed(2)" in js
    assert "لا صفحة" in js
    assert "fillText" in js


def test_page_detector_probe_exists():
    """tools/probe_page_detector.js runs the shipped analyzeImageData against
    real captures. Verified: IMG_1147 and scannercolor both return aspect 1.41
    (A4 landscape = 1.414), and a 90-degree rotation flips it to 0.71."""
    from pathlib import Path
    probe = Path(__file__).resolve().parents[1] / "tools" / "probe_page_detector.js"
    assert probe.is_file()
    assert "analyzeImageData" in probe.read_text(encoding="utf-8")
