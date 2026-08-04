(() => {
  'use strict';

  // Measured floor for ArUco detection on this form (Phase 0 resolution sweep).
  // Detection collapses below ~2 px/module and plateaus near 2.9. Phone captures
  // needed ~3000 px of page width to clear 40% marker coverage. The previous
  // 2200 px cap produced 7.4 px/mm = 2.7 px/module -- below the floor, so every
  // auto-capture was an image the grader could not register at all.
  // What actually matters is the width of the PAGE in source pixels, not the
  // width of the frame. A 3500px frame with the sheet at 51% linear coverage
  // yields only ~1785px of page -- far below the floor. So the requirement is
  // expressed on the page and checked live, from the detected page box.
  const MIN_PAGE_WIDTH_PX = 3000;
  const MAX_CAPTURE_WIDTH = 4608;
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
      pageVisible: marginX >= THRESHOLDS.pageMarginRatio && marginY >= THRESHOLDS.pageMarginRatio && maskFill >= THRESHOLDS.minMaskFill,
      perspective: perspectiveRatio <= THRESHOLDS.maxPerspectiveRatio && topSpan > boxWidth * 0.35 && leftSpan > boxHeight * 0.35,
      sharpness: sharpness >= THRESHOLDS.minSharpness,
      lighting: meanLuma >= THRESHOLDS.minPageLuma && meanLuma <= THRESHOLDS.maxPageLuma && darkFraction <= THRESHOLDS.maxDarkFraction && brightFraction <= THRESHOLDS.maxBrightFraction,
      uniformLighting: uniformity >= THRESHOLDS.minRegionLumaRatio,
      pageSize: pageWidthPx >= MIN_PAGE_WIDTH_PX && coverage <= THRESHOLDS.maxPageCoverage
    };
    const ready = Object.values(checks).every(Boolean);
    return {
      ready, checks,
      metrics: {coverage, maskFill, perspectiveRatio, sharpness, meanLuma, darkFraction, brightFraction, marginX, marginY, uniformity, pageWidthPx},
      box: {x: component.minX, y: component.minY, width: boxWidth, height: boxHeight},
      worstRegionBox: uniformity >= THRESHOLDS.minRegionLumaRatio ? null : worstRegionBox,
      reason: firstFailure(checks, {coverage})
    };
  }

  function emptyResult(reason) {
    return {ready:false, checks:{pageVisible:false,perspective:false,sharpness:false,lighting:false,uniformLighting:false,pageSize:false}, metrics:{coverage:0,maskFill:0,perspectiveRatio:99,sharpness:0,meanLuma:0,darkFraction:1,brightFraction:0,marginX:0,marginY:0,uniformity:0,pageWidthPx:0}, box:null, worstRegionBox:null, reason};
  }

  function firstFailure(checks, metrics) {
    if (!checks.pageVisible) return 'أظهر الصفحة كاملة مع فراغ حول الحواف';
    if (!checks.perspective) return 'اجعل الهاتف أكثر تعامداً مع الورقة';
    if (!checks.sharpness) return 'ثبّت الهاتف وانتظر اكتمال التركيز';
    // A local shadow and a globally dark room need opposite corrections, so
    // they must never share a message.
    if (!checks.uniformLighting) return 'يوجد ظل على جزء من الورقة؛ حرّك يدك أو الهاتف بعيداً عن مصدر الضوء';
    if (!checks.lighting) return 'حسّن الإضاءة وتجنب الوهج أو الظلام';
    if (!checks.pageSize) {
      // Directional: the old message said "move closer" even when too close.
      return metrics && metrics.coverage > THRESHOLDS.maxPageCoverage
        ? 'ابتعد قليلاً حتى تظهر حواف الصفحة كاملة'
        : `قرّب الهاتف؛ عرض الصفحة ${metrics ? metrics.pageWidthPx : 0} بكسل والمطلوب ${MIN_PAGE_WIDTH_PX}`;
    }
    return 'الإطار صالح؛ اثبت للحظة';
  }

  function metricText(name, result) {
    const m = result.metrics;
    if (name === 'pageVisible') return `${Math.round(Math.min(m.marginX, m.marginY) * 100)}%`;
    if (name === 'perspective') return `×${m.perspectiveRatio.toFixed(2)}`;
    if (name === 'sharpness') return Math.round(m.sharpness).toString();
    if (name === 'pageSize') return `${m.pageWidthPx}px`;
    if (name === 'uniformLighting') return `${Math.round(m.uniformity * 100)}%`;
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
    const result = analyzeImageData(analysisContext.getImageData(0, 0, width, height), frame.width);
    updateUI(result);
    el('analysisFps').textContent = `تحليل ${Math.round(performance.now() - started)} ms`;
    stableCount = result.ready ? stableCount + 1 : 0;
    el('stableBar').style.width = `${Math.min(100, stableCount / THRESHOLDS.stableFrames * 100)}%`;
    if (stableCount >= THRESHOLDS.stableFrames) captureFrame('auto');
    else requestAnimationFrame(analyzeFrame);
  }

  async function startCamera() {
    stopCamera(); captured = false; stableCount = 0; sourceMode = 'camera'; viewer.classList.remove('testing');
    try {
      // Ask for the largest frame the camera will give. A capture that cannot
      // reach MIN_PAGE_WIDTH_PX is guaranteed to fail grading, so resolution is
      // negotiated up front rather than discovered after the shutter.
      stream = await navigator.mediaDevices.getUserMedia({
        video: {facingMode: {ideal: 'environment'},
                width: {ideal: MAX_CAPTURE_WIDTH}, height: {ideal: 3456}},
        audio: false
      });
      video.srcObject = stream; await video.play();

      const granted = video.videoWidth;
      if (granted < MIN_STREAM_WIDTH) {
        // Deterministic and known now: the page can never be wider than the
        // frame, so no amount of guidance can rescue this device. Refuse to
        // start rather than guide the teacher toward a capture that must fail.
        stopCamera();
        el('modeBadge').textContent = 'الكاميرا غير كافية';
        el('instruction').textContent =
          `أقصى دقة للكاميرا ${granted} بكسل، والمطلوب ${MIN_STREAM_WIDTH} على الأقل. ` +
          `لن يتمكن المصحّح من قراءة رموز الخلايا بهذه الدقة؛ استخدم كاميرا الجهاز الأساسية ` +
          `أو جهازاً بدقة أعلى.`;
        el('manualCapture').disabled = true;
        window.dispatchEvent(new CustomEvent('smartcapture:unsupported',
          {detail: {grantedWidth: granted, requiredWidth: MIN_STREAM_WIDTH}}));
        return;
      }

      running = true;
      el('modeBadge').textContent = `تحليل مباشر · ${granted}px`;
      el('manualCapture').disabled = false; el('retake').hidden = true;
      requestAnimationFrame(analyzeFrame);
    } catch (error) {
      el('instruction').textContent = 'تعذر تشغيل الكاميرا؛ استخدم صورة اختبار';
      el('modeBadge').textContent = 'الكاميرا غير متاحة';
    }
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
    THRESHOLDS, analyzeImageData, emptyResult, firstFailure,
    MIN_PAGE_WIDTH_PX, MIN_STREAM_WIDTH, MAX_CAPTURE_WIDTH,
    registrationStage: 'commit'
  });
})();
