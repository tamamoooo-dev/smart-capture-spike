/*
 * Smart Capture v2 — rectification and evaluation of the corrected document.
 *
 * The teacher points the camera at the register. Everything geometric is
 * absorbed here: the sheet is cropped from its four corners, its perspective
 * is undone, and its rotation is normalised to A4 landscape. Nothing about
 * framing is pushed back onto the person holding the phone.
 *
 * What rectification does NOT do is fix focus. Measured on the first real
 * capture: 118 of 1200 markers detected as shot, 58 after rectification at
 * 14 px/mm, with the far band at zero either way. Warping soft pixels does not
 * sharpen them. So the corrected document is evaluated REGIONALLY -- a
 * page-wide sharpness number scores that capture as good, and auto-capture
 * would have fired on it.
 *
 * Pure: no DOM, no camera. Takes ImageData-shaped input, returns numbers.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaptureRectify = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const A4_LONG_MM = 297;
  const A4_SHORT_MM = 210;

  /**
   * Homography mapping the four source corners onto a rectangle.
   *
   * Solves the standard 8x8 system by Gaussian elimination with partial
   * pivoting. Returns the inverse map (destination -> source), because
   * sampling walks the destination and asks where each pixel came from.
   */
  function homography(src, dst) {
    const a = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      a.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    for (let col = 0; col < 8; col++) {
      let pivot = col;
      for (let r = col + 1; r < 8; r++) {
        if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
      }
      if (Math.abs(a[pivot][col]) < 1e-12) return null;   // degenerate quad
      [a[col], a[pivot]] = [a[pivot], a[col]];
      [b[col], b[pivot]] = [b[pivot], b[col]];
      for (let r = 0; r < 8; r++) {
        if (r === col) continue;
        const factor = a[r][col] / a[col][col];
        if (!factor) continue;
        for (let c = col; c < 8; c++) a[r][c] -= factor * a[col][c];
        b[r] -= factor * b[col];
      }
    }
    const h = b.map((value, i) => value / a[i][i]);
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  function apply(h, x, y) {
    const w = h[6] * x + h[7] * y + h[8];
    return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
  }

  /**
   * Which pairing of the sheet's corners is its long axis?
   *
   * Rotation is normalised here rather than required of the teacher: whichever
   * way the sheet was held, the longer measured side becomes A4's 297 mm.
   * ArUco registration is rotation invariant, so this costs nothing downstream.
   */
  function orientation(quad) {
    const side = (a, b) => Math.hypot(quad[b][0] - quad[a][0], quad[b][1] - quad[a][1]);
    const topBottom = (side(0, 1) + side(2, 3)) / 2;
    const leftRight = (side(1, 2) + side(3, 0)) / 2;
    return {longIsHorizontal: topBottom >= leftRight,
            longPx: Math.max(topBottom, leftRight),
            shortPx: Math.min(topBottom, leftRight)};
  }

  /**
   * Crop, undo perspective, normalise rotation.
   *
   * `pxPerMm` sets the corrected document's sampling density. Bilinear, because
   * nearest-neighbour aliases the printed markers badly at preview scale.
   */
  function rectify(imageData, quad, pxPerMm) {
    const scale = pxPerMm || 4;
    const width = Math.round(A4_LONG_MM * scale);
    const height = Math.round(A4_SHORT_MM * scale);
    const info = orientation(quad);
    // Send the sheet's long side to the corrected document's long side.
    const corners = info.longIsHorizontal ? quad : [quad[1], quad[2], quad[3], quad[0]];
    const h = homography([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]],
                         corners.map(p => [p[0], p[1]]));
    if (!h) return null;

    const out = new Uint8ClampedArray(width * height * 4);
    const src = imageData.data, sw = imageData.width, sh = imageData.height;
    let sampled = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [sx, sy] = apply(h, x, y);
        const o = (y * width + x) * 4;
        if (sx < 0 || sy < 0 || sx >= sw - 1 || sy >= sh - 1) { out[o + 3] = 255; continue; }
        const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
        for (let c = 0; c < 3; c++) {
          const p00 = src[(y0 * sw + x0) * 4 + c], p10 = src[(y0 * sw + x0 + 1) * 4 + c];
          const p01 = src[((y0 + 1) * sw + x0) * 4 + c], p11 = src[((y0 + 1) * sw + x0 + 1) * 4 + c];
          out[o + c] = p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) +
                       p01 * (1 - fx) * fy + p11 * fx * fy;
        }
        out[o + 3] = 255;
        sampled++;
      }
    }
    return {data: out, width, height, pxPerMm: scale,
            coverage: sampled / (width * height),
            sourceLongPx: info.longPx, sourceShortPx: info.shortPx,
            rotated: !info.longIsHorizontal};
  }

  /**
   * Tilt of the sheet relative to the sensor plane.
   *
   * Opposite sides of the quad are equal only when the phone is parallel to the
   * paper; the ratio grows with tilt. The first real capture measured 1.13 and
   * 1.15 here, and its far edge was the part that failed to register -- tilt
   * spreads the sheet across the depth of field, and one end leaves it.
   */
  function tilt(quad) {
    const side = (a, b) => Math.hypot(quad[b][0] - quad[a][0], quad[b][1] - quad[a][1]);
    const horizontal = [side(0, 1), side(2, 3)];
    const vertical = [side(1, 2), side(3, 0)];
    const ratio = arr => Math.max(...arr) / Math.max(1e-6, Math.min(...arr));
    return Math.max(ratio(horizontal), ratio(vertical));
  }

  /**
   * Evaluate the CORRECTED document, region by region.
   *
   * Page-wide numbers are what let the first real capture look good: its
   * exposure, coverage and geometry were all fine while one end of the sheet
   * was unreadable. The weakest region is what decides, for the same reason
   * regional exposure beat page-mean exposure at predicting row success.
   */
  function evaluate(doc, gridX, gridY) {
    const gx = gridX || 6, gy = gridY || 4;
    const {data, width, height} = doc;
    const cells = [];
    for (let ry = 0; ry < gy; ry++) {
      for (let rx = 0; rx < gx; rx++) {
        const x0 = Math.floor(rx * width / gx), x1 = Math.floor((rx + 1) * width / gx);
        const y0 = Math.floor(ry * height / gy), y1 = Math.floor((ry + 1) * height / gy);
        let lumaSum = 0, n = 0, lapSum = 0, lapSq = 0, lapN = 0;
        for (let y = y0 + 1; y < y1 - 1; y++) {
          for (let x = x0 + 1; x < x1 - 1; x++) {
            const i = (y * width + x) * 4;
            const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            lumaSum += g; n++;
            const gl = 0.299 * data[i - 4] + 0.587 * data[i - 3] + 0.114 * data[i - 2];
            const gr = 0.299 * data[i + 4] + 0.587 * data[i + 5] + 0.114 * data[i + 6];
            const gu = 0.299 * data[i - width * 4] + 0.587 * data[i - width * 4 + 1] +
                       0.114 * data[i - width * 4 + 2];
            const gd = 0.299 * data[i + width * 4] + 0.587 * data[i + width * 4 + 1] +
                       0.114 * data[i + width * 4 + 2];
            const lap = 4 * g - gl - gr - gu - gd;
            lapSum += lap; lapSq += lap * lap; lapN++;
          }
        }
        cells.push({
          rx, ry,
          exposure: n ? lumaSum / n : 0,
          sharpness: lapN ? lapSq / lapN - Math.pow(lapSum / lapN, 2) : 0
        });
      }
    }
    const exposures = cells.map(c => c.exposure);
    const sharpnesses = cells.map(c => c.sharpness);
    const maxExposure = Math.max(...exposures);
    const maxSharp = Math.max(...sharpnesses);
    const worst = cells[sharpnesses.indexOf(Math.min(...sharpnesses))];
    return {
      cells,
      minRegionExposure: maxExposure > 0 ? Math.min(...exposures) / maxExposure : 0,
      // The gradient metric: the weakest region against the strongest. A sheet
      // that is sharp at one end and soft at the other scores low here while
      // its page-wide sharpness looks healthy.
      sharpnessUniformity: maxSharp > 0 ? Math.min(...sharpnesses) / maxSharp : 0,
      minRegionSharpness: Math.min(...sharpnesses),
      meanSharpness: sharpnesses.reduce((s, v) => s + v, 0) / sharpnesses.length,
      worstRegion: {rx: worst.rx, ry: worst.ry}
    };
  }

  return {A4_LONG_MM, A4_SHORT_MM, homography, apply, orientation, rectify, tilt, evaluate};
}));
