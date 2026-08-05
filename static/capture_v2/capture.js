/*
 * Smart Capture v2 — the page.
 *
 * This layer owns the camera, the canvas and the DOM, and nothing else. It
 * measures with observe.js, decides with feasibility.js, records with
 * session.js. It contains no threshold and no rule of its own: if a decision
 * appears here, it has escaped the layer that can be tested without a device.
 *
 * Capture is manual. Auto-capture is deliberately absent until the enforce set
 * is validated by VS-1.
 */
(function () {
  'use strict';

  const F = window.CaptureFeasibility;
  const O = window.CaptureObserve;
  const S = window.CaptureSession;
  const R = window.CaptureRectify;

  // Diagnostics are hidden unless asked for. Recording is unaffected by it.
  const DEBUG = /[?&]debug=1/.test(location.search);

  const REQ = {
    // Observe-status: used to aim, never to block. VS-1 decides whether 3000 is
    // the right number, a lower one, or no requirement at all.
    minPageLongPx: 3000,
    marginRatio: 0.018,
    limitEpsilonPx: 30
  };
  const ANALYSIS_WIDTH = 360;
  const ANALYSIS_INTERVAL_MS = 180;
  const MAX_CAPTURE_WIDTH = 4608;
  // How long the best qualifying frame is sought before one is committed.
  // A mechanism parameter, not a quality threshold: it decides how long to
  // look, never whether a frame is good enough.
  const AUTO_WINDOW_MS = 1200;

  const INSTRUCTIONS = {
    NO_PAGE: 'وجّه الكاميرا نحو السجل كاملاً',
    SHOW_ALL_CORNERS: 'أظهر زوايا الورقة الأربع',
    MOVE_CLOSER: 'اقترب قليلاً من الورقة',
    HOLD_STILL: 'ثبّت الهاتف',
    AT_GEOMETRIC_LIMIT: 'هذه أقصى مسافة ممكنة مع بقاء الزوايا ظاهرة',
    INFEASIBLE: 'دقة الكاميرا لا تكفي لهذا المطلب',
    BLOCKED: 'الإطار غير مكتمل',
    READY: 'جاهز — اضغط للالتقاط'
  };

  const el = id => document.getElementById(id);
  const video = el('cameraV2');
  const analysisCanvas = el('analysisCanvasV2');
  const analysisContext = analysisCanvas.getContext('2d', {willReadFrequently: true});
  const outline = el('outlineCanvasV2');
  const outlineContext = outline.getContext('2d');
  const captureCanvas = el('captureCanvasV2');
  const captureContext = captureCanvas.getContext('2d');

  // iPadOS reports itself as MacIntel, so touch points are what distinguish it.
  const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const stability = O.tracker();
  let session = null;
  let stream = null;
  let running = false;
  let lastAnalysis = 0;
  let latest = null;
  let saved = null;   // {id, blob, objectUrl, file} for the last capture
  // Auto-capture state. `best` is the highest score seen since the enforce set
  // started holding; the frame committed is the first to match it once the
  // window has elapsed, so no full-resolution frames need buffering.
  let auto = {armed: false, since: 0, best: 0, latched: false};
  let autoEnabled = true;

  function device() {
    const track = stream && stream.getVideoTracks()[0];
    const settings = track && track.getSettings ? track.getSettings() : {};
    return {
      userAgent: navigator.userAgent,
      // Both, never one: getSettings() and videoWidth disagreed on the target
      // device, and the analysis only ever sees the frame the element reports.
      settingsWidth: settings.width || 0,
      settingsHeight: settings.height || 0,
      videoWidth: video.videoWidth || 0,
      videoHeight: video.videoHeight || 0
    };
  }

  // --- rendering -----------------------------------------------------------

  function renderInstruction(result) {
    const text = INSTRUCTIONS[result.instruction.code] || result.instruction.code;
    el('instructionV2').textContent = text;
    // An unactionable state is stated, never phrased as something to do.
    el('instructionV2').dataset.actionable = String(!!result.instruction.actionable);
    el('shutterV2').disabled = !running;
  }

  function renderOutline(observation) {
    outline.width = outline.clientWidth;
    outline.height = outline.clientHeight;
    outlineContext.clearRect(0, 0, outline.width, outline.height);
    if (!observation || !observation.quad) return;
    const sx = outline.width / analysisCanvas.width;
    const sy = outline.height / analysisCanvas.height;
    // The quad, not the bounding box: a tilted sheet's box is strictly larger
    // than the paper, so the box outline sat outside the sheet it claimed.
    outlineContext.strokeStyle = 'rgba(255,255,255,0.9)';
    outlineContext.lineWidth = 2;
    outlineContext.beginPath();
    observation.quad.forEach((p, i) => {
      const x = p[0] * sx, y = p[1] * sy;
      if (i === 0) outlineContext.moveTo(x, y); else outlineContext.lineTo(x, y);
    });
    outlineContext.closePath();
    outlineContext.stroke();
  }

  /**
   * Debug panel.
   *
   * Its own ids, its own stylesheet scope, and it is built only when asked for.
   * v1 hid its entire page because `.diag{display:none}` also matched the class
   * it put on <body>, so nothing here shares a selector with the live UI.
   */
  function renderDiagnostics(report, vector) {
    const panel = el('dbgPanelV2');
    if (!panel || !report.diagnostics) return;
    const rows = report.diagnostics.rules.map(r =>
      `<tr><td>${r.id}</td><td>${r.status}${r.session ? ' · ' + r.session : ''}</td>` +
      `<td>${format(r.value)}</td><td>${r.satisfied === null ? '—' : (r.satisfied ? '✓' : '✗')}</td></tr>`);
    const f = report.diagnostics.feasibility;
    rows.push(`<tr><td>ceiling</td><td>—</td><td>${f.maxPageLongPx}px</td><td>${f.feasible ? '✓' : '✗'}</td></tr>`);
    rows.push(`<tr><td>utilisation</td><td>—</td><td>${(report.diagnostics.utilisation * 100).toFixed(1)}%</td><td>—</td></tr>`);
    rows.push(`<tr><td>records</td><td>—</td><td>${session ? session.count : 0}</td><td>—</td></tr>`);
    if (vector) rows.push(`<tr><td>drift</td><td>—</td><td>${format(vector.driftPx)}</td><td>—</td></tr>`);
    panel.innerHTML = `<table>${rows.join('')}</table>`;
  }

  function format(value) {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3);
    if (typeof value === 'object') return Object.values(value).join('/');
    return String(value);
  }

  // --- the loop ------------------------------------------------------------

  function frameSource() {
    return {source: video, width: video.videoWidth, height: video.videoHeight};
  }

  function analyse(timestamp) {
    if (!running) return;
    if (timestamp - lastAnalysis < ANALYSIS_INTERVAL_MS) {requestAnimationFrame(analyse); return;}
    lastAnalysis = timestamp;

    const frame = frameSource();
    if (!frame.width || !frame.height) {requestAnimationFrame(analyse); return;}

    const width = ANALYSIS_WIDTH;
    const height = Math.max(180, Math.round(width * frame.height / frame.width));
    analysisCanvas.width = width;
    analysisCanvas.height = height;
    analysisContext.drawImage(frame.source, 0, 0, width, height);

    let observation = null;
    try {
      observation = O.observe(analysisContext.getImageData(0, 0, width, height), frame.width);
    } catch (error) {
      // A measurement failure must never blank the preview. v1 stopped the
      // stream on a failed gate and turned the page black.
      el('noteV2').textContent = 'observe: ' + error.message;
    }

    const motion = stability.update(observation);
    if (observation) observation.stable = motion.stable;

    // Evaluate the corrected document, sampled rather than built. The rules
    // that consume exposure and sharpness are unchanged; what feeds them is
    // now measured on the rectified page, where a far region backed by fewer
    // source pixels scores lower instead of being averaged away.
    let regional = null;
    if (observation && observation.quad) {
      regional = R.sampleRegions(analysisImage(), observation.quad);
      if (regional) {
        observation.minRegionExposure = regional.minRegionExposure;
        observation.sharpness = regional.meanSharpness;
      }
    }

    const result = F.evaluate({width: frame.width, height: frame.height}, observation, REQ);
    const vector = F.record({width: frame.width, height: frame.height}, observation, result);
    vector.driftPx = motion.driftPx;
    vector.stillFrames = motion.stillFrames;
    if (observation) {
      vector.perspectiveRatio = observation.perspectiveRatio;
      vector.meanLuma = observation.meanLuma;
      vector.darkFraction = observation.darkFraction;
      vector.brightFraction = observation.brightFraction;
      vector.maskFill = observation.maskFill;
      vector.coverage = observation.coverage;
      vector.aspect = observation.aspect;
      vector.tilt = R.tilt(observation.quad);
    }
    if (regional) {
      vector.sharpnessUniformity = regional.sharpnessUniformity;
      vector.minRegionSharpness = regional.minRegionSharpness;
      vector.worstRegionX = regional.worstRegion.rx;
      vector.worstRegionY = regional.worstRegion.ry;
    }
    latest = {result, vector, observation, regional};

    const report = F.report(result, {debug: DEBUG});
    renderInstruction(report);
    renderOutline(observation);
    if (DEBUG) renderDiagnostics(report, vector);

    considerAutoCapture(result, regional, timestamp);

    requestAnimationFrame(analyse);
  }

  /** The ImageData the analysis is currently holding, for the sampler. */
  function analysisImage() {
    return analysisContext.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height);
  }

  /**
   * Commit the best frame, without buffering full-resolution frames.
   *
   * Selection, not a gate: the enforce set decides whether a frame may be
   * committed at all, exactly as for the manual shutter. This only chooses
   * *which* qualifying frame, and applies no threshold to anything.
   *
   * Ranked by meanSharpness. It was sharpnessUniformity until a flatbed scan --
   * where blur is impossible -- scored 0.001 on it, worse than a phone capture
   * that detected 118 of 1200 markers. Its weakest region is the blank names
   * strip at the end of the sheet, in every capture measured: the metric finds
   * "no print here", not "out of focus here". meanSharpness orders the same
   * three captures correctly at 384.5 / 94.1 / 75.7.
   */
  function considerAutoCapture(result, regional, timestamp) {
    if (!autoEnabled || !running) return;
    if (result.blocked || !regional) {
      // Losing the enforce set is what ends one sheet and begins the next.
      auto = {armed: false, since: 0, best: 0, latched: false};
      return;
    }
    // One capture per sheet. Without this the loop re-arms the instant it
    // commits and keeps firing at the window interval: measured at 7 captures
    // of one motionless sheet before anyone touched the phone.
    if (auto.latched) return;

    const score = regional.meanSharpness;
    if (!auto.armed) {
      auto = {armed: true, since: timestamp, best: score, latched: false};
      return;
    }
    auto.best = Math.max(auto.best, score);
    const elapsed = timestamp - auto.since;
    // Within 2% of the best seen: waiting for an exact match can spin forever
    // on a hand-held frame that never repeats a number precisely.
    if (elapsed >= AUTO_WINDOW_MS && score >= auto.best * 0.98) {
      auto = {armed: false, since: 0, best: 0, latched: true};
      capture('auto');
    }
  }

  // --- capture -------------------------------------------------------------

  function capture(kind) {
    const frame = frameSource();
    if (!frame.width || !frame.height || !latest) return;

    const scale = frame.width > MAX_CAPTURE_WIDTH ? MAX_CAPTURE_WIDTH / frame.width : 1;
    captureCanvas.width = Math.round(frame.width * scale);
    captureCanvas.height = Math.round(frame.height * scale);
    captureContext.drawImage(frame.source, 0, 0, captureCanvas.width, captureCanvas.height);
    const url = captureCanvas.toDataURL('image/jpeg', 0.96);

    // Recorded whether or not the enforce rules were satisfied. VS-1 needs the
    // rejected captures too: a rule that never fires on real captures is not
    // discriminative, and that verdict needs the failures to be visible.
    const id = session.add(latest.vector, {blocked: latest.result.blocked,
                                           instruction: latest.result.instruction.code,
                                           kind: kind || 'manual'});

    // A blob URL, never the data URL. WebKit ignores the download attribute on
    // data: URLs, which is why the image never saved on the phone while the
    // session export -- a blob URL on the same device -- did.
    //
    // Built here rather than in the click handler: navigator.share must be
    // reached synchronously from the user gesture, so nothing expensive may sit
    // between the tap and the call.
    const blob = dataUrlToBlob(url);
    if (saved) URL.revokeObjectURL(saved.objectUrl);
    let file = null;
    try {
      file = new File([blob], `${id}.jpg`, {type: blob.type, lastModified: Date.now()});
    } catch (error) {
      file = null;  // no File constructor: the share path is simply unavailable
    }
    saved = {id, blob, objectUrl: URL.createObjectURL(blob), file};

    el('capturedPreviewV2').src = saved.objectUrl;
    const link = el('downloadCaptureV2');
    link.href = saved.objectUrl;
    link.download = `${id}.jpg`;
    el('captureIdV2').textContent = id;
    el('resultCardV2').hidden = false;
    el('countV2').textContent = String(session.count);
    status(`${id} · ${(blob.size / 1048576).toFixed(1)}MB — جاهزة للحفظ`);
  }

  function dataUrlToBlob(dataUrl) {
    const [header, encoded] = dataUrl.split(',');
    const mime = (header.match(/^data:([^;]+)/) || [])[1] || 'image/jpeg';
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], {type: mime});
  }

  /** Every save path ends here. Nothing may fail silently. */
  function status(text, kind) {
    const node = el('saveStatusV2');
    node.textContent = text;
    node.dataset.kind = kind || 'info';
  }

  /**
   * Save the captured image.
   *
   * Two flows, because the platforms genuinely differ:
   *
   *   iOS  -- the share sheet is the only route to Photos. A blob download does
   *           work there (the session export proves it), but it lands in Files
   *           rather than the camera roll, so it is the fallback, not the lead.
   *   else -- an anchor download is the natural desktop flow, and the share
   *           sheet on desktop has no obvious "save to disk" at all.
   *
   * Whichever runs, the outcome is reported. The previous version reported
   * nothing on any path, so a silent no-op and a successful save looked alike.
   */
  async function saveImage(event) {
    event.preventDefault();
    if (!saved) return status('لا توجد صورة ملتقطة بعد', 'error');

    const canShare = !!(saved.file && navigator.canShare &&
                        navigator.canShare({files: [saved.file]}));

    if (IOS && canShare) {
      try {
        await navigator.share({files: [saved.file], title: saved.id});
        return status(`تم حفظ ${saved.id}`, 'ok');
      } catch (error) {
        if (error && error.name === 'AbortError') return status('أُلغي الحفظ', 'info');
        status('تعذّرت المشاركة، جارٍ التنزيل…', 'error');
      }
    }

    if (downloadImage()) return;

    if (canShare) {
      try {
        await navigator.share({files: [saved.file], title: saved.id});
        return status(`تم حفظ ${saved.id}`, 'ok');
      } catch (error) {
        if (error && error.name === 'AbortError') return status('أُلغي الحفظ', 'info');
      }
    }

    // Last resort: show it, so it can be saved by long-press.
    const tab = window.open(saved.objectUrl, '_blank');
    if (tab) {
      tab.opener = null;
      status('فُتحت الصورة في تبويب — اضغط عليها مطولاً ثم «حفظ الصورة»', 'info');
    } else {
      status('تعذّر الحفظ. اسمح بالنوافذ المنبثقة وأعد المحاولة.', 'error');
    }
  }

  function downloadImage() {
    const anchor = document.createElement('a');
    if (!('download' in anchor)) return false;
    anchor.href = saved.objectUrl;
    anchor.download = `${saved.id}.jpg`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    status(`تم تنزيل ${saved.id}.jpg`, 'ok');
    return true;
  }

  function exportSession() {
    const blob = new Blob([JSON.stringify(session.toJSON(), null, 2)], {type: 'application/json'});
    const link = el('exportSessionV2');
    if (link.dataset.url) URL.revokeObjectURL(link.dataset.url);
    const url = URL.createObjectURL(blob);
    link.dataset.url = url;
    link.href = url;
    link.download = `${session.session.toLowerCase()}-records.json`;
  }

  // --- bring-up ------------------------------------------------------------

  function awaitVideoDimensions(timeoutMs) {
    // play() can resolve before metadata loads, and reading videoWidth straight
    // after it returned 0 on iOS.
    return new Promise(resolve => {
      const started = Date.now();
      (function poll() {
        if (video.videoWidth > 0 && video.readyState >= 2) return resolve(true);
        if (Date.now() - started > (timeoutMs || 4000)) return resolve(false);
        setTimeout(poll, 100);
      })();
    });
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {facingMode: {ideal: 'environment'},
                width: {ideal: MAX_CAPTURE_WIDTH}, height: {ideal: 3456}},
        audio: false
      });
      video.srcObject = stream;
      await video.play().catch(error => { el('noteV2').textContent = 'play(): ' + error.message; });
      await awaitVideoDimensions();
      session = S.create({session: 'VS-1', device: device()});
      running = true;
      el('shutterV2').disabled = false;
      requestAnimationFrame(analyse);
    } catch (error) {
      // Never blank the page on a camera failure: state it and stop.
      el('instructionV2').textContent = 'تعذر تشغيل الكاميرا';
      el('noteV2').textContent = (error && error.name) + ': ' + (error && error.message);
    }
  }

  // Revealed at load, not on a successful start. Gating it on the camera would
  // hide the panel in exactly the case it exists for: a camera that never came
  // up. Diagnosability must not depend on the thing being diagnosed.
  if (DEBUG) {
    el('dbgPanelV2').hidden = false;
    el('dbgPanelV2').innerHTML = '<table><tr><td>state</td><td>camera not started</td></tr></table>';
  }

  el('startV2').addEventListener('click', start);
  // The manual shutter stays: auto-capture chooses when the enforce set already
  // holds, and the teacher must still be able to commit a frame regardless.
  el('shutterV2').addEventListener('click', () => capture('manual'));
  el('autoV2').addEventListener('change', event => {
    autoEnabled = event.target.checked;
    auto = {armed: false, since: 0, best: 0, latched: false};
  });
  el('downloadCaptureV2').addEventListener('click', saveImage);
  el('exportSessionV2').addEventListener('click', exportSession);

  window.SmartCaptureV2 = {REQ, DEBUG, IOS, AUTO_WINDOW_MS, capture, saveImage,
                           exportSession, considerAutoCapture,
                           get session() { return session; },
                           get latest() { return latest; },
                           get saved() { return saved; },
                           get auto() { return auto; }};
})();
