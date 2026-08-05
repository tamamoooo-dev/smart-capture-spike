(() => {
  'use strict';

  // Measured floor for ArUco detection on this form (Phase 0 resolution sweep):
  // detection collapses below ~2 px/module and plateaus near 2.9, and phone
  // captures needed ~3000 px of PAGE width to clear 40% marker coverage.
  //
  // The requirement is on the page, not the frame -- a 3500 px frame with the
  // sheet at 51% linear coverage yields only ~1785 px of page. So it is checked
  // live from the detected page box, scaled back to source pixels.
  //
  // This also forces landscape. On a 4:3 sensor with 5% margins, a portrait
  // hold caps the page at ~2722 px while landscape reaches ~3629 px, so a
  // portrait capture of an A4-landscape register can never satisfy the floor.
  const MIN_PAGE_WIDTH_PX = 3000;
  const MAX_CAPTURE_WIDTH = 4608;
  // Full visibility of all four corners is a HARD requirement and is never
  // traded for resolution. This is the largest share of the frame's long side
  // the page may occupy while still leaving margin for the corners, and it
  // bounds what "move closer" can ever achieve. Measured on the target device
  // (iPhone 17 Pro, 4032x3024 granted): landscape reaches 3629px of page and
  // clears the floor; portrait reaches 2722px and cannot, so in portrait the
  // correct instruction is to rotate, never to move closer.
  // A4 landscape. The theoretical ceiling on page width is derived from this
  // and from pageMarginRatio, rather than guessed: the largest A4-aspect
  // rectangle that fits inside the frame while still leaving the margins that
  // pageVisible demands. The previous MAX_SAFE_PAGE_FILL = 0.90 was arbitrary.
  const A4_ASPECT = 297 / 210;
  // Headroom below this counts as the geometric limit: the page box is an
  // axis-aligned bound, so in-plane rotation inflates it slightly and exact
  // equality is never reached in practice.
  const LIMIT_EPSILON_PX = 30;
  // Deterministic conditions are enforced BEFORE the shutter. A device whose
  // camera cannot deliver at least this many pixels can never satisfy
  // MIN_PAGE_WIDTH_PX, because the page cannot be wider than the frame.
  const MIN_STREAM_WIDTH = MIN_PAGE_WIDTH_PX;

  const THRESHOLDS = Object.freeze({
    pageMarginRatio: 0.018,
    // Upper bound only: the lower bound is derived from MIN_PAGE_WIDTH_PX
    // rather than guessed, so it tracks the real grading requirement.
    maxPageCoverage: 0.94,
    minMaskFill: 0.34,
    maxPerspectiveRatio: 1.48,
    minSharpness: 115,
    minPageLuma: 88,
    maxPageLuma: 238,
    maxDarkFraction: 0.22,
    maxBrightFraction: 0.42,
    // Regional lighting. A page-mean test cannot see a localised shadow: on
    // IMG_1147 the phone's own shadow covered rows 21-40 while barely moving the
    // page mean, yet local exposure predicted per-row grading success with
    // AUC 0.940 -- the strongest predictor measured. The check must be regional.
    lightingGridX: 6,
    lightingGridY: 4,
    minRegionLumaRatio: 0.74,
    stableFrames: 8,
    analysisIntervalMs: 180
  });

  const el = id => document.getElementById(id);
  const video = el('camera');
  const still = el('stillFrame');
  const viewer = el('viewer');
  const analysisCanvas = el('analysisCanvas');
  const analysisContext = analysisCanvas.getContext('2d', {willReadFrequently: true});
  const guide = el('guideCanvas');
  const guideContext = guide.getContext('2d');
  const captureCanvas = el('captureCanvas');
  const captureContext = captureCanvas.getContext('2d');
  let stream = null;
  let running = false;
  let captured = false;
  let stableCount = 0;
  let lastAnalysis = 0;
  let currentResult = null;
  let sourceMode = 'none';
  let capturedDataUrl = null;
  let capturedObjectUrl = null;
  let capturedFile = null;

  // Debug state. A black preview must be diagnosable from the page itself
  // rather than by reading the source, so every stage of bring-up is recorded.
  const dbg = {permission: 'unknown', streamStarted: false, tracks: 0,
               videoW: 0, videoH: 0, readyState: -1, frames: 0,
               grantedWidth: 0, belowFloor: false, lastError: ''};
  const READY_STATES = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA',
                        'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];

  function renderDebug() {
    const panel = el('dbgPanel');
    if (!panel) return;
    dbg.videoW = video.videoWidth || 0;
    dbg.videoH = video.videoHeight || 0;
    dbg.readyState = video.readyState;
    const rows = [
      ['camera permission', dbg.permission, dbg.permission === 'granted' ? 'ok' : 'bad'],
      ['stream started', dbg.streamStarted ? 'YES' : 'NO', dbg.streamStarted ? 'ok' : 'bad'],
      ['live tracks', dbg.tracks, dbg.tracks ? 'ok' : 'bad'],
      ['video size', dbg.videoW + ' x ' + dbg.videoH, dbg.videoW ? 'ok' : 'bad'],
      ['readyState', dbg.readyState + ' ' + (READY_STATES[dbg.readyState] || ''),
       dbg.readyState >= 4 ? 'ok' : 'bad'],
      ['frames analysed', dbg.frames, dbg.frames ? 'ok' : 'bad'],
      ['granted width', dbg.grantedWidth],
      ['below floor', dbg.belowFloor ? 'YES (< ' + MIN_STREAM_WIDTH + ')' : 'no',
       dbg.belowFloor ? 'bad' : 'ok'],
      ['last error', dbg.lastError || '-', dbg.lastError ? 'bad' : 'ok']
    ];
    panel.innerHTML = '<table>' + rows.map(function (r) {
      return '<tr><td>' + r[0] + '</td><td class="' + (r[2] || '') + '">' + r[1] + '</td></tr>';
    }).join('') + '</table>';
  }

  window.addEventListener('error', function (e) {
    dbg.lastError = e.message + ' @' + String(e.filename || '').split('/').pop() + ':' + e.lineno;
    renderDebug();
  });
  window.addEventListener('unhandledrejection', function (e) {
    dbg.lastError = 'promise: ' + ((e.reason && e.reason.message) || e.reason);
    renderDebug();
  });

  // videoWidth is only populated once metadata has loaded. play() can resolve
  // before that, so reading dimensions straight after it returned 0 on iOS and
  // tripped the capability gate on a camera that was perfectly capable.
  function awaitVideoDimensions(timeoutMs) {
    timeoutMs = timeoutMs || 4000;
    return new Promise(function (resolve) {
      const started = Date.now();
      (function poll() {
        if (video.videoWidth > 0 && video.readyState >= 2) return resolve(true);
        if (Date.now() - started > timeoutMs) return resolve(false);
        setTimeout(poll, 100);
      })();
    });
  }

  function deviceLandscape() {
    const type = (window.screen && window.screen.orientation && window.screen.orientation.type) || '';
    if (type) return type.startsWith('landscape');
    if (window.matchMedia) return window.matchMedia('(orientation: landscape)').matches;
    if (typeof window.orientation === 'number') return Math.abs(window.orientation) === 90;
    return window.innerWidth >= window.innerHeight;
  }

  function applyDeviceOrientation() {
    document.body.classList.toggle('device-landscape', deviceLandscape());
  }

  // Diagnostic mode (?diag=1). Measures the ACTUAL geometric ceiling on this
  // device instead of assuming it. peakWithCorners is the number that matters:
  // the widest page ever achieved while all four corners were still visible.
  const DIAG = /[?&]diag=1/.test(location.search);
  const diag = {peakWithCorners: 0, peakAny: 0, peakFrame: 0, samples: 0, at: null};

  function resetPeaks() {
    diag.peakWithCorners = 0; diag.peakAny = 0; diag.peakFrame = 0;
    diag.samples = 0; diag.at = null;
  }

  function updateDiagnostics(result) {
    if (!DIAG) return;
    const panel = el('diagPanel');
    if (!panel) return;
    const m = result.metrics;
    const cornersOk = result.checks.pageVisible;
    diag.samples++;
    diag.peakAny = Math.max(diag.peakAny, m.pageWidthPx);
    diag.peakFrame = Math.max(diag.peakFrame, m.frameWidthPx);
    if (cornersOk && m.pageWidthPx > diag.peakWithCorners) {
      diag.peakWithCorners = m.pageWidthPx;
      diag.at = {coverage: m.coverage, left: m.marginLeftPx, right: m.marginRightPx,
                 top: m.marginTopPx, bottom: m.marginBottomPx};
    }
    const pct = v => `${(v * 100).toFixed(1)}%`;
    const rows = [
      ['source frame', `${m.frameWidthPx} × ${m.frameHeightPx}`],
      ['detected page', `${m.pageWidthPx} × ${m.pageHeightPx}`],
      ['page width / required', `${m.pageWidthPx} / ${MIN_PAGE_WIDTH_PX}`,
       m.pageWidthPx >= MIN_PAGE_WIDTH_PX ? 'ok' : 'bad'],
      ['page / frame width', pct(m.frameWidthPx ? m.pageWidthPx / m.frameWidthPx : 0)],
      ['coverage (area)', pct(m.coverage)],
      ['margins L/R/T/B px', `${m.marginLeftPx}/${m.marginRightPx}/${m.marginTopPx}/${m.marginBottomPx}`],
      ['four corners visible', cornersOk ? 'YES' : 'NO', cornersOk ? 'ok' : 'bad'],
      ['page aspect', m.pageAspect.toFixed(3)],
      ['theoretical max width', m.theoreticalMaxPageWidthPx],
      ['remaining headroom', m.atGeometricLimit
        ? `0 px (geometric limit)` : `+${m.headroomPx} px`,
        m.atGeometricLimit ? 'bad' : 'ok'],
      ['limit reachable?', m.deviceCanReachFloor ? 'YES' : 'NO',
        m.deviceCanReachFloor ? 'ok' : 'bad'],
      ['— PEAK with corners', diag.peakWithCorners, 'peak'],
      ['— PEAK any', diag.peakAny],
      ['— peak frame width', diag.peakFrame]
    ];
    panel.innerHTML = '<table>' + rows.map(([k, v, cls]) =>
      `<tr><td>${k}</td><td class="${cls || ''}">${v}</td></tr>`).join('') + '</table>';
  }

  function percentile(values, ratio) {
    const copy = Array.from(values).sort((a, b) => a - b);
    return copy[Math.min(copy.length - 1, Math.max(0, Math.floor(copy.length * ratio)))] || 0;
  }

  function largestComponent(mask, width, height) {
    const seen = new Uint8Array(mask.length);
    const queue = new Int32Array(mask.length);
    let best = null;
    for (let seed = 0; seed < mask.length; seed++) {
      if (!mask[seed] || seen[seed]) continue;
      let head = 0, tail = 0, count = 0;
      let minX = width, minY = height, maxX = 0, maxY = 0;
      queue[tail++] = seed;
      seen[seed] = 1;
      while (head < tail) {
        const index = queue[head++];
        const x = index % width, y = (index / width) | 0;
        count++; minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        const neighbours = [index - 1, index + 1, index - width, index + width];
        for (const next of neighbours) {
          if (next < 0 || next >= mask.length || seen[next] || !mask[next]) continue;
          const nx = next % width;
          if (Math.abs(nx - x) > 1) continue;
          seen[next] = 1; queue[tail++] = next;
        }
      }
      if (!best || count > best.count) best = {count, minX, minY, maxX, maxY};
    }
    return best;
  }

  function scanSpan(mask, width, height, axis, position, radius) {
    let min = Infinity, max = -Infinity, found = 0;
    if (axis === 'row') {
      for (let y = Math.max(0, position - radius); y <= Math.min(height - 1, position + radius); y++) {
        for (let x = 0; x < width; x++) if (mask[y * width + x]) {min = Math.min(min, x); max = Math.max(max, x); found++;}
      }
    } else {
      for (let x = Math.max(0, position - radius); x <= Math.min(width - 1, position + radius); x++) {
        for (let y = 0; y < height; y++) if (mask[y * width + x]) {min = Math.min(min, y); max = Math.max(max, y); found++;}
      }
    }
    return found ? Math.max(1, max - min + 1) : 0;
  }

  function analyzeImageData(imageData, sourceWidth) {
    const {data, width, height} = imageData;
    // Analysis runs on a small canvas; scale the page box back to source pixels
    // so the resolution check is about the image we will actually capture.
    const sourceScale = (sourceWidth || width) / width;
    const count = width * height;
    const gray = new Float32Array(count);
    const chroma = new Uint8Array(count);
    const sample = [];
    for (let i = 0, p = 0; i < count; i++, p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      chroma[i] = Math.max(r, g, b) - Math.min(r, g, b);
      if ((i & 7) === 0) sample.push(gray[i]);
    }
    const p55 = percentile(sample, 0.55);
    const paperThreshold = Math.max(105, Math.min(205, p55 + 12));
    const mask = new Uint8Array(count);
    for (let i = 0; i < count; i++) mask[i] = gray[i] >= paperThreshold && chroma[i] < 82 ? 1 : 0;

    const component = largestComponent(mask, width, height);
    if (!component || component.count < count * 0.04) return emptyResult('لم يُعثر على صفحة فاتحة مستقرة');
    const boxWidth = component.maxX - component.minX + 1;
    const boxHeight = component.maxY - component.minY + 1;
    const coverage = (boxWidth * boxHeight) / count;
    const pageWidthPx = Math.round(boxWidth * sourceScale);
    // Orientation of the SHEET inside the frame, not of the device or the
    // stream. video.videoWidth/videoHeight describe the MediaStream and do not
    // change when the phone is rotated, so the previous test (frame aspect) was
    // permanently true. What matters is that the A4-landscape register lies
    // horizontally in the image -- however the teacher achieves that.
    // Ceiling on what "move closer" can achieve without losing a corner.
    // A landscape page is bounded by the frame's HORIZONTAL extent, not its
    // long side: in a portrait-held frame (3024x4032) the page can never be
    // wider than 3024 however close the teacher gets. Using max() here computed
    // 3629 against a true ceiling of 2722 and kept asking for the impossible.
    // Largest A4-aspect page that fits the frame with the required margins.
    const usableWpx = width * sourceScale * (1 - 2 * THRESHOLDS.pageMarginRatio);
    const usableHpx = height * sourceScale * (1 - 2 * THRESHOLDS.pageMarginRatio);
    const theoreticalMaxPageWidthPx = Math.round(Math.min(usableWpx, usableHpx * A4_ASPECT));
    const achievablePageWidthPx = theoreticalMaxPageWidthPx;
    // Clamped at zero: a rotated sheet's bounding box can exceed the ideal.
    const headroomPx = Math.max(0, theoreticalMaxPageWidthPx - pageWidthPx);
    const atGeometricLimit = headroomPx <= LIMIT_EPSILON_PX;
    const frameLandscape = width >= height;
    const deviceCanReachFloor = achievablePageWidthPx >= MIN_PAGE_WIDTH_PX;
    // Measured margin headroom: if the page is already near the edge, moving
    // closer costs a corner, which is never an acceptable trade.
    const roomToApproach = Math.min(
      component.minX, width - 1 - component.maxX,
      component.minY, height - 1 - component.maxY) > THRESHOLDS.pageMarginRatio * width * 1.5;
    const marginLeftPx = Math.round(component.minX * sourceScale);
    const marginRightPx = Math.round((width - 1 - component.maxX) * sourceScale);
    const marginTopPx = Math.round(component.minY * sourceScale);
    const marginBottomPx = Math.round((height - 1 - component.maxY) * sourceScale);
    const frameWidthPx = Math.round(width * sourceScale);
    const frameHeightPx = Math.round(height * sourceScale);
    const pageHeightPx = Math.round(boxHeight * sourceScale);
    const pageAspect = boxWidth / Math.max(1, boxHeight);
    const landscape = pageAspect >= 1.0;
    const maskFill = component.count / (boxWidth * boxHeight);
    const marginX = Math.min(component.minX, width - 1 - component.maxX) / width;
    const marginY = Math.min(component.minY, height - 1 - component.maxY) / height;

    const yTop = component.minY + Math.round(boxHeight * 0.14);
    const yBottom = component.minY + Math.round(boxHeight * 0.86);
    const xLeft = component.minX + Math.round(boxWidth * 0.14);
    const xRight = component.minX + Math.round(boxWidth * 0.86);
    const topSpan = scanSpan(mask, width, height, 'row', yTop, 2);
    const bottomSpan = scanSpan(mask, width, height, 'row', yBottom, 2);
    const leftSpan = scanSpan(mask, width, height, 'column', xLeft, 2);
    const rightSpan = scanSpan(mask, width, height, 'column', xRight, 2);
    const horizontalRatio = Math.max(topSpan, bottomSpan) / Math.max(1, Math.min(topSpan, bottomSpan));
    const verticalRatio = Math.max(leftSpan, rightSpan) / Math.max(1, Math.min(leftSpan, rightSpan));
    const perspectiveRatio = Math.max(horizontalRatio, verticalRatio);

    const gx = THRESHOLDS.lightingGridX, gy = THRESHOLDS.lightingGridY;
    const regionSum = new Float64Array(gx * gy);
    const regionCount = new Float64Array(gx * gy);
    let lapSum = 0, lapSq = 0, lapCount = 0;
    let lumaSum = 0, lumaCount = 0, dark = 0, bright = 0;
    for (let y = Math.max(1, component.minY); y < Math.min(height - 1, component.maxY); y++) {
      for (let x = Math.max(1, component.minX); x < Math.min(width - 1, component.maxX); x++) {
        const i = y * width + x;
        if (!mask[i]) continue;
        const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
        lapSum += lap; lapSq += lap * lap; lapCount++;
        const value = gray[i]; lumaSum += value; lumaCount++;
        if (value < 65) dark++; if (value > 247) bright++;
        const rx = Math.min(gx - 1, Math.floor((x - component.minX) / boxWidth * gx));
        const ry = Math.min(gy - 1, Math.floor((y - component.minY) / boxHeight * gy));
        const r = ry * gx + rx;
        regionSum[r] += value; regionCount[r] += 1;
      }
    }
    const sharpness = lapCount ? lapSq / lapCount - Math.pow(lapSum / lapCount, 2) : 0;
    const meanLuma = lumaCount ? lumaSum / lumaCount : 0;
    const darkFraction = dark / Math.max(1, lumaCount);
    const brightFraction = bright / Math.max(1, lumaCount);

    // Uniformity = darkest region / brightest region. A shadow across part of
    // the page drives this down while leaving meanLuma almost untouched.
    let minRegion = Infinity, maxRegion = 0, worstRegion = -1;
    for (let r = 0; r < regionSum.length; r++) {
      if (regionCount[r] < 12) continue;
      const value = regionSum[r] / regionCount[r];
      if (value < minRegion) {minRegion = value; worstRegion = r;}
      if (value > maxRegion) maxRegion = value;
    }
    const uniformity = maxRegion > 0 && minRegion < Infinity ? minRegion / maxRegion : 0;
    const worstRegionBox = worstRegion < 0 ? null : {
      x: component.minX + (worstRegion % gx) / gx * boxWidth,
      y: component.minY + Math.floor(worstRegion / gx) / gy * boxHeight,
      width: boxWidth / gx,
      height: boxHeight / gy
    };

    // The live loop guides only. Registration is validated once, on the
    // full-resolution committed frame, because marker detection needs ~3000 px
    // and is non-monotonic in resolution -- unusable as a hill-climbing signal.
    const checks = {
      // The register is A4 landscape. On a 4:3 sensor a portrait hold caps the
      // page at ~2722px against a 3000px floor, so portrait can never satisfy
      // pageSize. Checked first: every other correction is wasted in portrait.
      orientation: landscape,
      pageVisible: marginX >= THRESHOLDS.pageMarginRatio && marginY >= THRESHOLDS.pageMarginRatio && maskFill >= THRESHOLDS.minMaskFill,
      perspective: perspectiveRatio <= THRESHOLDS.maxPerspectiveRatio && topSpan > boxWidth * 0.35 && leftSpan > boxHeight * 0.35,
      sharpness: sharpness >= THRESHOLDS.minSharpness,
      lighting: meanLuma >= THRESHOLDS.minPageLuma && meanLuma <= THRESHOLDS.maxPageLuma && darkFraction <= THRESHOLDS.maxDarkFraction && brightFraction <= THRESHOLDS.maxBrightFraction,
      uniformLighting: uniformity >= THRESHOLDS.minRegionLumaRatio,
      // Resolution ONLY. Corner visibility is pageVisible's job; testing
      // coverage here too made one check enforce two competing requirements,
      // so satisfying resolution could push the teacher into losing a corner.
      pageSize: pageWidthPx >= MIN_PAGE_WIDTH_PX
    };
    const ready = Object.values(checks).every(Boolean);
    return {
      ready, checks,
      metrics: {coverage, maskFill, perspectiveRatio, sharpness, meanLuma, darkFraction, brightFraction, marginX, marginY, uniformity, pageWidthPx, pageHeightPx, achievablePageWidthPx, theoreticalMaxPageWidthPx, headroomPx, atGeometricLimit, deviceCanReachFloor, roomToApproach, frameLandscape, landscape, pageAspect, frameWidthPx, frameHeightPx, marginLeftPx, marginRightPx, marginTopPx, marginBottomPx},
      box: {x: component.minX, y: component.minY, width: boxWidth, height: boxHeight},
      worstRegionBox: uniformity >= THRESHOLDS.minRegionLumaRatio ? null : worstRegionBox,
      reason: firstFailure(checks, {coverage})
    };
  }

  function emptyResult(reason) {
    return {ready:false, checks:{orientation:false,pageVisible:false,perspective:false,sharpness:false,lighting:false,uniformLighting:false,pageSize:false}, metrics:{coverage:0,maskFill:0,perspectiveRatio:99,sharpness:0,meanLuma:0,darkFraction:1,brightFraction:0,marginX:0,marginY:0,uniformity:0,pageWidthPx:0,pageHeightPx:0,achievablePageWidthPx:0,theoreticalMaxPageWidthPx:0,headroomPx:0,atGeometricLimit:false,deviceCanReachFloor:false,roomToApproach:false,frameLandscape:true,landscape:false,pageAspect:0,frameWidthPx:0,frameHeightPx:0,marginLeftPx:0,marginRightPx:0,marginTopPx:0,marginBottomPx:0}, box:null, worstRegionBox:null, reason};
  }

  function firstFailure(checks, metrics) {
    if (!checks.orientation) return 'أدر الهاتف أفقياً ليطابق اتجاه السجل';
    if (!checks.pageVisible) return 'أظهر الصفحة كاملة مع فراغ حول الحواف';
    if (!checks.perspective) return 'اجعل الهاتف أكثر تعامداً مع الورقة';
    if (!checks.sharpness) return 'ثبّت الهاتف وانتظر اكتمال التركيز';
    // A local shadow and a globally dark room need opposite corrections, so
    // they must never share a message.
    if (!checks.uniformLighting) return 'يوجد ظل على جزء من الورقة؛ حرّك يدك أو الهاتف بعيداً عن مصدر الضوء';
    if (!checks.lighting) return 'حسّن الإضاءة وتجنب الوهج أو الظلام';
    if (!checks.pageSize) {
      // "Move closer" is only ever emitted when it is actually achievable.
      // Once the geometric limit is reached the remaining valid outputs are:
      // rotate the phone, or report that this configuration cannot satisfy the
      // requirement. Asking for the impossible is never one of them.
      // With no measurement we cannot know whether approaching is achievable,
      // so no directional instruction may be given at all.
      if (!metrics) return 'وجّه الكاميرا إلى السجل';
      if (!metrics.deviceCanReachFloor) {
        return metrics.frameLandscape
          ? `هذا الجهاز لا يبلغ الدقة المطلوبة مع إبقاء الزوايا الأربع ظاهرة (${metrics.achievablePageWidthPx} من ${MIN_PAGE_WIDTH_PX} بكسل)`
          : `أدر الهاتف أفقياً؛ الوضع الرأسي يبلغ ${metrics.achievablePageWidthPx} بكسل فقط من ${MIN_PAGE_WIDTH_PX}`;
      }
      if (metrics.atGeometricLimit || !metrics.roomToApproach) {
        return `لا يمكن الاقتراب أكثر دون فقدان زوايا الصفحة (${metrics.pageWidthPx} من ${MIN_PAGE_WIDTH_PX} بكسل)`;
      }
      return `قرّب الهاتف؛ ${metrics.pageWidthPx} من ${MIN_PAGE_WIDTH_PX} بكسل، المتبقي ${metrics.headroomPx}`;
    }
    return 'الإطار صالح؛ اثبت للحظة';
  }

  function metricText(name, result) {
    const m = result.metrics;
    if (name === 'pageVisible') return `${Math.round(Math.min(m.marginX, m.marginY) * 100)}%`;
    if (name === 'perspective') return `×${m.perspectiveRatio.toFixed(2)}`;
    if (name === 'sharpness') return Math.round(m.sharpness).toString();
    if (name === 'pageSize') return `${m.pageWidthPx} / ${MIN_PAGE_WIDTH_PX} px`;
    if (name === 'uniformLighting') return `${Math.round(m.uniformity * 100)}%`;
    if (name === 'orientation') return m.pageAspect ? `×${m.pageAspect.toFixed(2)}` : '—';
    return Math.round(m.meanLuma).toString();
  }

  function updateUI(result) {
    currentResult = result;
    for (const [name, ok] of Object.entries(result.checks)) {
      const row = document.querySelector(`[data-check="${name}"]`);
      row.classList.toggle('pass', ok); row.classList.toggle('fail', !ok);
      row.querySelector('b').textContent = metricText(name, result);
    }
    viewer.classList.toggle('ready', result.ready);
    el('decision').classList.toggle('ready', result.ready);
    el('decision').querySelector('strong').textContent = result.ready ? 'الإطار جاهز' : 'غير جاهز للالتقاط';
    el('decision').querySelector('span').textContent = result.reason;
    el('instruction').textContent = result.reason;
    drawGuide(result);
  }

  function drawGuide(result) {
    guide.width = analysisCanvas.width; guide.height = analysisCanvas.height;
    guideContext.clearRect(0, 0, guide.width, guide.height);
    if (!result.box) return;
    const {x, y, width, height} = result.box;
    guideContext.strokeStyle = result.ready ? '#65d38b' : '#ef746f';
    guideContext.lineWidth = 3; guideContext.setLineDash([8, 5]);
    guideContext.strokeRect(x + 1, y + 1, width - 2, height - 2);
    // Label the outline with the measured aspect so the reading is visible on
    // the frame itself, not only in the side panel.
    if (result.metrics && result.metrics.pageAspect) {
      guideContext.setLineDash([]);
      guideContext.font = '600 13px Tahoma, Arial';
      guideContext.fillStyle = result.checks.orientation ? '#65d38b' : '#ef746f';
      guideContext.fillText(`${result.metrics.pageAspect.toFixed(2)}`, x + 6, y + 16);
    }
    // Show the teacher WHERE the shadow is, not just that one exists.
    if (result.worstRegionBox) {
      const w = result.worstRegionBox;
      guideContext.setLineDash([]);
      guideContext.strokeStyle = '#ffcf5c';
      guideContext.lineWidth = 2;
      guideContext.strokeRect(w.x, w.y, w.width, w.height);
    }
  }

  function sourceDimensions() {
    if (sourceMode === 'camera') return {source: video, width: video.videoWidth, height: video.videoHeight};
    return {source: still, width: still.naturalWidth, height: still.naturalHeight};
  }

  function dataUrlToBlob(dataUrl) {
    const [header, encoded] = dataUrl.split(',');
    const mimeType = header.match(/^data:([^;]+)/)?.[1] || 'image/jpeg';
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], {type: mimeType});
  }

  function prepareCapturedImage(dataUrl) {
    if (capturedObjectUrl) URL.revokeObjectURL(capturedObjectUrl);
    const blob = dataUrlToBlob(dataUrl);
    capturedDataUrl = dataUrl;
    capturedObjectUrl = URL.createObjectURL(blob);
    try {
      capturedFile = new File([blob], 'smart-capture.jpg', {type: blob.type, lastModified: Date.now()});
    } catch (_error) {
      capturedFile = null;
    }
    el('downloadCapture').href = capturedObjectUrl;
  }

  async function saveCapturedImage(event) {
    event.preventDefault();
    if (!capturedObjectUrl) return;

    const shareData = capturedFile ? {files: [capturedFile]} : null;
    const canShareFile = shareData && navigator.share && navigator.canShare && navigator.canShare(shareData);
    if (canShareFile) {
      try {
        await navigator.share({files: shareData.files, title: 'صورة الالتقاط الذكي'});
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
        window.location.assign(capturedDataUrl);
        return;
      }
    }

    const imageTab = window.open(capturedObjectUrl, '_blank');
    if (imageTab) imageTab.opener = null;
    else window.location.assign(capturedDataUrl);
  }

  function analyzeFrame(timestamp = performance.now()) {
    if (!running || captured) return;
    if (timestamp - lastAnalysis < THRESHOLDS.analysisIntervalMs) {requestAnimationFrame(analyzeFrame); return;}
    lastAnalysis = timestamp;
    const frame = sourceDimensions();
    if (!frame.width || !frame.height) {requestAnimationFrame(analyzeFrame); return;}
    const width = 360, height = Math.max(180, Math.round(width * frame.height / frame.width));
    analysisCanvas.width = width; analysisCanvas.height = height;
    analysisContext.drawImage(frame.source, 0, 0, width, height);
    const started = performance.now();
    let result;
    try {
      result = analyzeImageData(analysisContext.getImageData(0, 0, width, height), frame.width);
      dbg.frames++;
    } catch (e) {
      dbg.lastError = 'analyze: ' + e.message;
      renderDebug();
      requestAnimationFrame(analyzeFrame);
      return;
    }
    updateUI(result);
    updateDiagnostics(result);
    renderDebug();
    // Live detector readout: page box, aspect and page width in source pixels.
    // Without this the orientation indicator is unfalsifiable from the UI --
    // there is no way to tell a real measurement from a fallback value.
    const m = result.metrics, b = result.box;
    el('analysisFps').textContent = b
      ? `الدقة ${m.pageWidthPx}/${MIN_PAGE_WIDTH_PX}px ${m.pageWidthPx >= MIN_PAGE_WIDTH_PX ? '✓' : '✗'} · الحد النظري ${m.theoreticalMaxPageWidthPx}px · المتبقي ${m.atGeometricLimit ? '0 (الحد الهندسي)' : '+' + m.headroomPx} · نسبة ${m.pageAspect.toFixed(2)} · ${Math.round(performance.now() - started)}ms`
      : `لا صفحة · ${Math.round(performance.now() - started)}ms`;
    stableCount = result.ready ? stableCount + 1 : 0;
    el('stableBar').style.width = `${Math.min(100, stableCount / THRESHOLDS.stableFrames * 100)}%`;
    if (stableCount >= THRESHOLDS.stableFrames) captureFrame('auto');
    else requestAnimationFrame(analyzeFrame);
  }

  async function startCamera() {
    stopCamera(); captured = false; stableCount = 0; sourceMode = 'camera'; viewer.classList.remove('testing');
    dbg.lastError = ''; dbg.frames = 0;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {facingMode: {ideal: 'environment'},
                width: {ideal: MAX_CAPTURE_WIDTH}, height: {ideal: 3456}},
        audio: false
      });
      dbg.permission = 'granted';
      dbg.streamStarted = true;
      dbg.tracks = stream.getVideoTracks().filter(function (t) { return t.readyState === 'live'; }).length;
      video.srcObject = stream;
      await video.play().catch(function (e) { dbg.lastError = 'play(): ' + e.message; });
      await awaitVideoDimensions();
      renderDebug();

      const granted = Math.max(video.videoWidth, video.videoHeight);
      dbg.grantedWidth = granted;
      dbg.belowFloor = granted > 0 && granted < MIN_STREAM_WIDTH;

      // A camera below the floor cannot produce a gradeable image, but that is
      // a reason to withhold AUTO-CAPTURE -- never a reason to blank the
      // preview. Stopping the stream here made the page black on every desktop
      // webcam, and on iOS whenever videoWidth had not populated yet.
      if (dbg.belowFloor) {
        el('modeBadge').textContent = 'دقة غير كافية · ' + granted + 'px';
        el('instruction').textContent =
          'أقصى دقة للكاميرا ' + granted + ' بكسل والمطلوب ' + MIN_STREAM_WIDTH +
          '. المعاينة تعمل للقياس، لكن الالتقاط التلقائي متوقف.';
        window.dispatchEvent(new CustomEvent('smartcapture:unsupported',
          {detail: {grantedWidth: granted, requiredWidth: MIN_STREAM_WIDTH}}));
      } else if (!granted) {
        el('modeBadge').textContent = 'لم تُقرأ أبعاد الفيديو';
        dbg.lastError = dbg.lastError || 'videoWidth stayed 0';
      } else {
        el('modeBadge').textContent = 'تحليل مباشر · ' + granted + 'px';
      }

      running = true;
      el('manualCapture').disabled = false;
      el('retake').hidden = true;
      requestAnimationFrame(analyzeFrame);
    } catch (error) {
      if (/NotAllowed|Permission/i.test((error && error.name) || '')) dbg.permission = 'denied';
      dbg.streamStarted = false;
      dbg.lastError = (error && error.name) + ': ' + (error && error.message);
      el('instruction').textContent = 'تعذر تشغيل الكاميرا؛ استخدم صورة اختبار';
      el('modeBadge').textContent = 'الكاميرا غير متاحة';
    }
    renderDebug();
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null; video.srcObject = null; running = false;
  }

  function captureFrame(kind) {
    if (captured) return;
    const frame = sourceDimensions(); if (!frame.width || !frame.height) return;
    captured = true; running = false;
    // Resolution was already guaranteed: the stream was refused below
    // MIN_STREAM_WIDTH, and pageSize gates on measured page width every frame.
    // Nothing here can re-check a deterministic condition that has already
    // been enforced -- only cap runaway sensor sizes.
    const scale = frame.width > MAX_CAPTURE_WIDTH ? MAX_CAPTURE_WIDTH / frame.width : 1;
    captureCanvas.width = Math.round(frame.width * scale); captureCanvas.height = Math.round(frame.height * scale);
    captureContext.drawImage(frame.source, 0, 0, captureCanvas.width, captureCanvas.height);
    const url = captureCanvas.toDataURL('image/jpeg', .96);
    prepareCapturedImage(url);
    el('capturedPreview').src = url;
    el('captureKind').textContent = kind === 'auto' ? 'التقاط تلقائي' : 'التقاط يدوي احتياطي';
    el('captureSummary').textContent = currentResult
      ? (currentResult.ready
          ? `اجتاز الإطار جميع مؤشرات الجودة · عرض الصفحة ${currentResult.metrics.pageWidthPx}px`
          : 'تم الالتقاط اليدوي رغم وجود مؤشر جودة غير مكتمل.')
      : 'لم يكتمل التحليل.';
    el('resultCard').hidden = false; el('retake').hidden = false; el('manualCapture').disabled = true;
    el('captureFlash').classList.remove('active'); void el('captureFlash').offsetWidth; el('captureFlash').classList.add('active');
    el('modeBadge').textContent = kind === 'auto' ? 'تم الالتقاط تلقائياً' : 'تم الالتقاط يدوياً';
    stopCamera();
    window.dispatchEvent(new CustomEvent('smartcapture', {detail:{kind, result:currentResult}}));
  }

  function loadTestFile(file) {
    if (!file) return;
    stopCamera(); captured = false; stableCount = 0; sourceMode = 'still';
    still.onload = () => {
      viewer.classList.add('testing'); running = true; el('manualCapture').disabled = false; el('retake').hidden = true;
      el('modeBadge').textContent = 'اختبار صورة محلية'; requestAnimationFrame(analyzeFrame);
      URL.revokeObjectURL(still.src);
    };
    still.src = URL.createObjectURL(file);
  }

  // Nothing previously observed device orientation, so rotating the phone had
  // no effect on the layout at all. screen.orientation is preferred;
  // orientationchange and resize cover browsers that lack it.
  if (window.screen && window.screen.orientation && window.screen.orientation.addEventListener) {
    window.screen.orientation.addEventListener('change', applyDeviceOrientation);
  }
  window.addEventListener('orientationchange', applyDeviceOrientation);
  window.addEventListener('resize', applyDeviceOrientation);
  applyDeviceOrientation();

  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({name: 'camera'})
      .then(function (p) { dbg.permission = p.state; renderDebug(); })
      .catch(function () {});
  }
  renderDebug();

  if (DIAG) {
    document.body.classList.add('diag');
    const reset = el('diagReset'), copy = el('diagCopy');
    if (reset) reset.addEventListener('click', () => { resetPeaks(); el('instruction').textContent = 'أُعيد ضبط القياس'; });
    if (copy) copy.addEventListener('click', async () => {
      const m = currentResult ? currentResult.metrics : {};
      const text = JSON.stringify({
        ua: navigator.userAgent,
        frame: [m.frameWidthPx, m.frameHeightPx],
        peakPageWidthWithCorners: diag.peakWithCorners,
        peakPageWidthAny: diag.peakAny,
        peakFrameWidth: diag.peakFrame,
        atPeak: diag.at, required: MIN_PAGE_WIDTH_PX, samples: diag.samples
      }, null, 2);
      try { await navigator.clipboard.writeText(text); el('instruction').textContent = 'نُسخ القياس'; }
      catch { el('instruction').textContent = text; }
    });
  }

  el('startCamera').addEventListener('click', startCamera);
  el('manualCapture').addEventListener('click', () => captureFrame('manual'));
  el('retake').addEventListener('click', () => {
    el('resultCard').hidden = true; captured = false; stableCount = 0;
    if (sourceMode === 'camera') startCamera(); else {running = true; requestAnimationFrame(analyzeFrame);}
  });
  el('testFile').addEventListener('change', event => loadTestFile(event.target.files[0]));
  el('downloadCapture').addEventListener('click', saveCapturedImage);
  window.addEventListener('pagehide', () => {
    stopCamera();
    if (capturedObjectUrl) URL.revokeObjectURL(capturedObjectUrl);
  });

  // Registration is deliberately absent from the live loop: marker detection
  // needs ~3000px and is non-monotonic in resolution, so it cannot steer the
  // teacher. It belongs to the commit stage, on the full-resolution frame.
  window.SmartCaptureSpike = Object.freeze({
    THRESHOLDS, analyzeImageData, emptyResult, firstFailure, deviceLandscape,
    MIN_PAGE_WIDTH_PX, MIN_STREAM_WIDTH, MAX_CAPTURE_WIDTH, A4_ASPECT, LIMIT_EPSILON_PX,
    registrationStage: 'commit', DIAG, diag, resetPeaks, dbg, awaitVideoDimensions
  });
})();
