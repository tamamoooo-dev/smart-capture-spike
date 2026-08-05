/*
 * Smart Capture v2 — measurement.
 *
 * This is v1's analyzeImageData with the rule logic removed. The measurement
 * half was never the problem: page width predicted from geometry agreed with
 * the device to 0.6% over 909 samples, and regional exposure predicted per-row
 * grading success at AUC 0.940. The failure was the checklist wrapped around
 * it, which evaluated checks in priority order and could not notice that its
 * own requirements were unsatisfiable.
 *
 * So the algorithm is reused as-is and the checks are gone. This file decides
 * nothing: it reports what is in front of the camera, and feasibility.js is the
 * only place a rule is evaluated.
 *
 * Pure: no DOM, no camera, no rendering. It takes ImageData-shaped input, so
 * the same code runs in the browser and over dumped frames in node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaptureObserve = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Measured constants, carried over unchanged from the v1 detector.
  const PARAMS = Object.freeze({
    paperChromaMax: 82,      // paper is achromatic; ink and desk are not
    paperLumaFloor: 105,
    paperLumaCeil: 205,
    minComponentShare: 0.04, // below this the "page" is noise
    lightingGridX: 6,        // the grid that produced AUC 0.940
    lightingGridY: 4,
    minRegionSamples: 12
  });

  function percentile(values, ratio) {
    const copy = Array.from(values).sort((a, b) => a - b);
    return copy[Math.min(copy.length - 1, Math.max(0, Math.floor(copy.length * ratio)))] || 0;
  }

  /** Largest connected run of paper-coloured pixels, as a bounding box. */
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
          if (Math.abs((next % width) - x) > 1) continue;
          seen[next] = 1; queue[tail++] = next;
        }
      }
      if (!best || count > best.count) best = {count, minX, minY, maxX, maxY};
    }
    return best;
  }

  /** Width of the paper mask across one row or column, for perspective. */
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

  /**
   * Measure one frame.
   *
   * Analysis runs on a downscaled canvas; every length is scaled back to source
   * pixels so the numbers describe the image that will actually be captured and
   * graded, not the thumbnail it was measured on.
   *
   * Returns null when no page is present. That is a measurement outcome, not a
   * failure — feasibility.js turns it into the one instruction it warrants.
   */
  function observe(imageData, sourceWidth) {
    const {data, width, height} = imageData;
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
    const paperThreshold = Math.max(PARAMS.paperLumaFloor,
                                    Math.min(PARAMS.paperLumaCeil, p55 + 12));
    const mask = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      mask[i] = gray[i] >= paperThreshold && chroma[i] < PARAMS.paperChromaMax ? 1 : 0;
    }

    const component = largestComponent(mask, width, height);
    if (!component || component.count < count * PARAMS.minComponentShare) return null;

    const boxWidth = component.maxX - component.minX + 1;
    const boxHeight = component.maxY - component.minY + 1;
    const pageLongPx = Math.round(Math.max(boxWidth, boxHeight) * sourceScale);
    const pageShortPx = Math.round(Math.min(boxWidth, boxHeight) * sourceScale);

    // Orientation of the SHEET inside the frame, not of the device or the
    // stream: videoWidth/videoHeight describe the MediaStream and do not change
    // when the phone is rotated. Recorded, never required -- ArUco registration
    // is rotation invariant, so this is a free variable under observation.
    const axesAligned = (boxWidth >= boxHeight) === (width >= height);

    const marginsPx = {
      left: Math.round(component.minX * sourceScale),
      right: Math.round((width - 1 - component.maxX) * sourceScale),
      top: Math.round(component.minY * sourceScale),
      bottom: Math.round((height - 1 - component.maxY) * sourceScale)
    };

    // Perspective: the paper's span at 14% and 86% along each axis. A tilted
    // sheet is wider at one end than the other, which no page-box measurement
    // can see.
    const topSpan = scanSpan(mask, width, height, 'row', component.minY + Math.round(boxHeight * 0.14), 2);
    const bottomSpan = scanSpan(mask, width, height, 'row', component.minY + Math.round(boxHeight * 0.86), 2);
    const leftSpan = scanSpan(mask, width, height, 'column', component.minX + Math.round(boxWidth * 0.14), 2);
    const rightSpan = scanSpan(mask, width, height, 'column', component.minX + Math.round(boxWidth * 0.86), 2);
    const perspectiveRatio = Math.max(
      Math.max(topSpan, bottomSpan) / Math.max(1, Math.min(topSpan, bottomSpan)),
      Math.max(leftSpan, rightSpan) / Math.max(1, Math.min(leftSpan, rightSpan)));

    const gx = PARAMS.lightingGridX, gy = PARAMS.lightingGridY;
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
        if (value < 65) dark++;
        if (value > 247) bright++;
        const rx = Math.min(gx - 1, Math.floor((x - component.minX) / boxWidth * gx));
        const ry = Math.min(gy - 1, Math.floor((y - component.minY) / boxHeight * gy));
        regionSum[ry * gx + rx] += value;
        regionCount[ry * gx + rx] += 1;
      }
    }

    // Regional, never page-mean. On IMG_1147 the phone's own shadow covered
    // rows 21-40 while barely moving the page mean; local exposure predicted
    // per-row grading success at AUC 0.940, the strongest predictor measured.
    let minRegion = Infinity, maxRegion = 0, worstRegion = -1;
    for (let r = 0; r < regionSum.length; r++) {
      if (regionCount[r] < PARAMS.minRegionSamples) continue;
      const value = regionSum[r] / regionCount[r];
      if (value < minRegion) {minRegion = value; worstRegion = r;}
      if (value > maxRegion) maxRegion = value;
    }

    return {
      pageLongPx, pageShortPx,
      aspect: Math.max(boxWidth, boxHeight) / Math.max(1, Math.min(boxWidth, boxHeight)),
      axesAligned,
      marginsPx,
      minRegionExposure: maxRegion > 0 && minRegion < Infinity ? minRegion / maxRegion : 0,
      sharpness: lapCount ? lapSq / lapCount - Math.pow(lapSum / lapCount, 2) : 0,
      meanLuma: lumaCount ? lumaSum / lumaCount : 0,
      darkFraction: dark / Math.max(1, lumaCount),
      brightFraction: bright / Math.max(1, lumaCount),
      perspectiveRatio,
      maskFill: component.count / (boxWidth * boxHeight),
      coverage: (boxWidth * boxHeight) / count,
      // Analysis-space box, for drawing the outline. Never used for decisions.
      box: {x: component.minX, y: component.minY, width: boxWidth, height: boxHeight},
      worstRegionBox: worstRegion < 0 ? null : {
        x: component.minX + (worstRegion % gx) / gx * boxWidth,
        y: component.minY + Math.floor(worstRegion / gx) / gy * boxHeight,
        width: boxWidth / gx,
        height: boxHeight / gy
      }
    };
  }

  /**
   * Consecutive-frame stillness.
   *
   * Motion blur is the one defect no later observation can recover, so
   * stability is an enforce rule. The tolerance is expressed as a fraction of
   * the page's long axis rather than in pixels, so it means the same thing at
   * any distance: 0.5% of 297 mm is 1.5 mm, about a third of the 4.675 mm row
   * pitch that is this form's binding geometric constraint.
   *
   * The raw drift is recorded on every frame, so VS-1 can check the tolerance
   * against grading outcomes instead of taking it on trust.
   */
  function tracker(opts) {
    const driftRatio = (opts && opts.driftRatio) || 0.005;
    const framesRequired = (opts && opts.framesRequired) || 3;
    let previous = null, still = 0;
    return {
      update(observation) {
        if (!observation) {previous = null; still = 0; return {stable: false, driftPx: null, stillFrames: 0};}
        let driftPx = null;
        if (previous) {
          driftPx = Math.max(
            Math.abs(observation.pageLongPx - previous.pageLongPx),
            Math.abs(observation.marginsPx.left - previous.marginsPx.left),
            Math.abs(observation.marginsPx.top - previous.marginsPx.top));
          still = driftPx <= driftRatio * observation.pageLongPx ? still + 1 : 0;
        } else {
          still = 0;
        }
        previous = observation;
        return {stable: still >= framesRequired, driftPx, stillFrames: still};
      },
      reset() { previous = null; still = 0; }
    };
  }

  return {PARAMS, observe, tracker, percentile, largestComponent, scanSpan};
}));
