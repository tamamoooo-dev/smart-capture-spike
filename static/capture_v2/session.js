/*
 * Smart Capture v2 — the VS-1 record.
 *
 * Recording is not display. Diagnostics are hidden unless ?debug=1, but the
 * record is written on every capture regardless, because it is the only
 * mechanism that promotes or deletes an observe rule. A rule with no records
 * behind it cannot be validated, and by the lifecycle rule it is deleted.
 *
 * The export pairs mechanically with bench/: each capture id is also the image
 * filename stem, so a VS-1 run drops into bench/data/ as a manifest without
 * anyone matching rows by hand.
 *
 * Pure: no DOM, no camera. The page hands it numbers.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaptureSession = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const pad = (n, width) => String(n).padStart(width, '0');

  /** vs1-0003 — stable, sortable, and usable as a filename stem. */
  function captureId(session, index) {
    return `${String(session).toLowerCase()}-${pad(index, 4)}`;
  }

  function create(opts) {
    const session = (opts && opts.session) || 'VS-1';
    const device = (opts && opts.device) || {};
    const clock = (opts && opts.clock) || (() => new Date().toISOString());
    const records = [];

    return {
      session,
      get count() { return records.length; },
      get records() { return records.slice(); },

      /**
       * Record one capture.
       *
       * `vector` is CaptureFeasibility.record(...) — every measured value,
       * whatever its rule status. Observe rules are recorded exactly like
       * enforce rules; that symmetry is the point, since the observe ones are
       * the ones VS-1 has to decide.
       */
      add(vector, extra) {
        const id = captureId(session, records.length + 1);
        records.push(Object.assign({
          id,
          session,
          at: clock(),
          image: `${id}.jpg`
        }, extra || {}, {metrics: vector}));
        return id;
      },

      /**
       * The VS-1 artefact: records plus the manifest bench/ expects.
       *
       * `layout: 'frozen-cycle-1'` states which paper the numbers describe.
       * Results are never pooled across layouts or capture classes, so the
       * class is recorded at the source rather than inferred later.
       */
      toJSON() {
        return {
          session,
          device,
          exportedAt: clock(),
          captures: records.slice(),
          manifest: {
            captures: records.map(r => ({
              id: r.id,
              path: r.image,
              capture_class: 'phone',
              layout: 'frozen-cycle-1',
              conditions: r.conditions || [],
              notes: r.notes || ''
            }))
          }
        };
      }
    };
  }

  return {create, captureId};
}));
