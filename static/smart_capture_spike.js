(() => {
  'use strict';

  const THRESHOLDS = Object.freeze({
    pageMarginRatio: 0.018,
    minPageCoverage: 0.26,
    maxPageCoverage: 0.94,
    minMaskFill: 0.34,
    maxPerspectiveRatio: 1.48,
    minSharpness: 115,
    minPageLuma: 88,
    maxPageLuma: 238,
    maxDarkFraction: 0.22,
    maxBrightFraction: 0.42,
    minRegistrationConfidence: 0.82,
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

  function clamp01(value) {
    return Math.max(0, Math.min(1, value));
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

  function analyzeImageData(imageData) {
    const {data, width, height} = imageData;
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
      }
    }
    const sharpness = lapCount ? lapSq / lapCount - Math.pow(lapSum / lapCount, 2) : 0;
    const meanLuma = lumaCount ? lumaSum / lumaCount : 0;
    const darkFraction = dark / Math.max(1, lumaCount);
    const brightFraction = bright / Math.max(1, lumaCount);

    const minimumMargin = Math.min(marginX, marginY);
    const marginConfidence = clamp01(minimumMargin / 0.04);
    const fillConfidence = clamp01(maskFill / 0.55);
    const perspectiveConfidence = clamp01((THRESHOLDS.maxPerspectiveRatio - perspectiveRatio) / (THRESHOLDS.maxPerspectiveRatio - 1));
    const coverageConfidence = clamp01((coverage - 0.15) / 0.20);
    const registrationConfidence = 0.35 * marginConfidence + 0.20 * fillConfidence + 0.30 * perspectiveConfidence + 0.15 * coverageConfidence;

    const checks = {
      pageVisible: marginX >= THRESHOLDS.pageMarginRatio && marginY >= THRESHOLDS.pageMarginRatio && maskFill >= THRESHOLDS.minMaskFill,
      perspective: perspectiveRatio <= THRESHOLDS.maxPerspectiveRatio && topSpan > boxWidth * 0.35 && leftSpan > boxHeight * 0.35,
      sharpness: sharpness >= THRESHOLDS.minSharpness,
      lighting: meanLuma >= THRESHOLDS.minPageLuma && meanLuma <= THRESHOLDS.maxPageLuma && darkFraction <= THRESHOLDS.maxDarkFraction && brightFraction <= THRESHOLDS.maxBrightFraction,
      pageSize: coverage >= THRESHOLDS.minPageCoverage && coverage <= THRESHOLDS.maxPageCoverage,
      registrationConfidence: registrationConfidence >= THRESHOLDS.minRegistrationConfidence
    };
    const ready = Object.values(checks).every(Boolean);
    return {
      ready, checks,
      metrics: {coverage, maskFill, perspectiveRatio, sharpness, meanLuma, darkFraction, brightFraction, marginX, marginY, registrationConfidence},
      box: {x: component.minX, y: component.minY, width: boxWidth, height: boxHeight},
      reason: firstFailure(checks)
    };
  }

  function emptyResult(reason) {
    return {ready:false, checks:{pageVisible:false,perspective:false,sharpness:false,lighting:false,pageSize:false,registrationConfidence:false}, metrics:{coverage:0,maskFill:0,perspectiveRatio:99,sharpness:0,meanLuma:0,darkFraction:1,brightFraction:0,marginX:0,marginY:0,registrationConfidence:0}, box:null, reason};
  }

  function firstFailure(checks) {
    if (!checks.pageVisible) return 'أظهر الصفحة كاملة مع فراغ حول الحواف';
    if (!checks.perspective) return 'اجعل الهاتف أكثر تعامداً مع الورقة';
    if (!checks.sharpness) return 'ثبّت الهاتف وانتظر اكتمال التركيز';
    if (!checks.lighting) return 'حسّن الإضاءة وتجنب الوهج أو الظلام';
    if (!checks.pageSize) return 'قرّب الهاتف حتى تملأ الصفحة معظم الإطار';
    if (!checks.registrationConfidence) return 'حرّك الهاتف قليلاً حتى تستقر هندسة الصفحة';
    return 'الإطار صالح؛ اثبت للحظة';
  }

  function metricText(name, result) {
    const m = result.metrics;
    if (name === 'pageVisible') return `${Math.round(Math.min(m.marginX, m.marginY) * 100)}%`;
    if (name === 'perspective') return `×${m.perspectiveRatio.toFixed(2)}`;
    if (name === 'sharpness') return Math.round(m.sharpness).toString();
    if (name === 'pageSize') return `${Math.round(m.coverage * 100)}%`;
    if (name === 'registrationConfidence') return `${Math.round(m.registrationConfidence * 100)}%`;
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
    const result = analyzeImageData(analysisContext.getImageData(0, 0, width, height));
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
      stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false});
      video.srcObject = stream; await video.play(); running = true;
      el('modeBadge').textContent = 'تحليل مباشر'; el('manualCapture').disabled = false; el('retake').hidden = true;
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
    const maxWidth = 2200, scale = Math.min(1, maxWidth / frame.width);
    captureCanvas.width = Math.round(frame.width * scale); captureCanvas.height = Math.round(frame.height * scale);
    captureContext.drawImage(frame.source, 0, 0, captureCanvas.width, captureCanvas.height);
    const url = captureCanvas.toDataURL('image/jpeg', .92);
    prepareCapturedImage(url);
    el('capturedPreview').src = url;
    el('captureKind').textContent = kind === 'auto' ? 'التقاط تلقائي' : 'التقاط يدوي احتياطي';
    el('captureSummary').textContent = currentResult ? (currentResult.ready ? 'اجتاز الإطار جميع مؤشرات الجودة.' : 'تم الالتقاط اليدوي رغم وجود مؤشر جودة غير مكتمل.') : 'لم يكتمل التحليل.';
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

  window.SmartCaptureSpike = Object.freeze({THRESHOLDS, analyzeImageData, emptyResult});
})();
