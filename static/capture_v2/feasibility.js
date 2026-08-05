/*
 * Smart Capture v2 — feasibility engine.
 *
 * Pure geometry and rule logic. No DOM, no camera, no rendering, so it is
 * testable without a device and cannot be broken by a stylesheet.
 *
 * v1 evaluated checks in priority order and reported the first failure. A
 * checklist cannot notice that its own requirements are mutually
 * unsatisfiable, which is how it came to demand "show all four corners" and a
 * page width geometry proved unreachable at the same time.
 *
 * v2 computes the feasible set first. The key observation is that corner
 * visibility and "move closer" act on ONE degree of freedom -- distance --
 * bounding it from opposite sides. Expressed as bounds on the same scalar
 * (the page's long axis in source pixels), the feasible set is an interval,
 * and its emptiness is detectable before any instruction is chosen.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaptureFeasibility = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const A4_LONG_MM = 297;
  const A4_SHORT_MM = 210;
  const A4_ASPECT = A4_LONG_MM / A4_SHORT_MM;

  const STATUS = {ENFORCE: 'enforce', OBSERVE: 'observe'};

  /**
   * Ceiling on the sheet's long axis, in source pixels, with margins intact.
   *
   * Orientation is a free variable: ArUco registration is rotation invariant
   * (measured 68.6/68.4/68.2% at 0/90/270 degrees), so the sheet's long side
   * is matched to the frame's long side whichever way either is held. Forcing
   * the sheet to look landscape inside a portrait frame cost 25% of the pixels
   * on the target device -- 2915 available instead of 3887.
   */
  function ceiling(frame, marginRatio) {
    const usableLong = Math.max(frame.width, frame.height) * (1 - 2 * marginRatio);
    const usableShort = Math.min(frame.width, frame.height) * (1 - 2 * marginRatio);
    return Math.round(Math.min(usableLong, usableShort * A4_ASPECT));
  }

  /**
   * Can every ENFORCE rule hold simultaneously for this frame?
   *
   * Independent of what the teacher is currently doing: this asks whether a
   * satisfying configuration exists at all. If it does not, no instruction can
   * help and none is emitted.
   */
  function feasibility(frame, req) {
    const maxPageLongPx = ceiling(frame, req.marginRatio);
    const shortfallPx = Math.max(0, req.minPageLongPx - maxPageLongPx);
    return {
      maxPageLongPx,
      requiredPageLongPx: req.minPageLongPx,
      shortfallPx,
      feasible: shortfallPx === 0,
      // The only two levers when infeasible. Moving the phone is not one of
      // them, which is precisely what v1 kept suggesting.
      remedies: shortfallPx === 0 ? [] : [
        'raise the delivered frame resolution',
        'lower the page-width requirement, once validated'
      ]
    };
  }

  /** Page long axis achieved, as a fraction of what this frame allows. */
  function utilisation(observation, feas) {
    if (!observation || !feas.maxPageLongPx) return 0;
    return observation.pageLongPx / feas.maxPageLongPx;
  }

  /**
   * Evaluate one observation against the rules.
   *
   * Returns every rule's state plus at most one instruction. Rules in OBSERVE
   * status are measured and reported but can never block or produce an
   * instruction -- a threshold is not enforced until real captures show it is
   * both satisfiable and discriminative.
   */
  function evaluate(frame, observation, req) {
    const feas = feasibility(frame, req);
    const rules = [];
    const add = (id, status, satisfied, value, detail) =>
      rules.push({id, status, satisfied, value, detail: detail || null});

    if (!observation) {
      add('pageDetected', STATUS.ENFORCE, false, null);
      return {feasibility: feas, rules, blocked: true,
              instruction: {code: 'NO_PAGE', actionable: true}};
    }

    add('pageDetected', STATUS.ENFORCE, true, true);

    const cornersOk = observation.marginsPx &&
      Math.min(observation.marginsPx.left, observation.marginsPx.right,
               observation.marginsPx.top, observation.marginsPx.bottom) >=
      req.marginRatio * Math.min(frame.width, frame.height);
    add('cornerVisibility', STATUS.ENFORCE, cornersOk, observation.marginsPx);

    add('stability', STATUS.ENFORCE, !!observation.stable, !!observation.stable);

    add('pageLongAxis', STATUS.OBSERVE,
        observation.pageLongPx >= req.minPageLongPx,
        observation.pageLongPx,
        {required: req.minPageLongPx, ceiling: feas.maxPageLongPx,
         headroomPx: Math.max(0, feas.maxPageLongPx - observation.pageLongPx)});

    add('axesAligned', STATUS.OBSERVE, !!observation.axesAligned, !!observation.axesAligned);
    add('exposure', STATUS.OBSERVE, null, observation.minRegionExposure);
    add('sharpness', STATUS.OBSERVE, null, observation.sharpness);

    const blocking = rules.filter(r => r.status === STATUS.ENFORCE && r.satisfied === false);
    return {feasibility: feas, rules, blocked: blocking.length > 0,
            utilisation: utilisation(observation, feas),
            instruction: instruct(feas, observation, req, cornersOk, blocking)};
  }

  /**
   * Choose at most one instruction, and only for a target that exists.
   *
   * Ordering is by what is actionable, not by rule priority. An infeasible
   * configuration is reported first because no movement can resolve it, and
   * saying anything else would contradict it.
   */
  function instruct(feas, observation, req, cornersOk, blocking) {
    if (!feas.feasible) {
      return {code: 'INFEASIBLE', actionable: false,
              detail: {achievable: feas.maxPageLongPx,
                       required: feas.requiredPageLongPx,
                       shortfallPx: feas.shortfallPx,
                       remedies: feas.remedies}};
    }
    // Pulling back is always possible, so this is always actionable.
    if (!cornersOk) return {code: 'SHOW_ALL_CORNERS', actionable: true};

    const headroom = feas.maxPageLongPx - observation.pageLongPx;
    const short = req.minPageLongPx - observation.pageLongPx;
    // Only ask for approach when the target is inside the feasible interval.
    if (short > 0 && headroom > req.limitEpsilonPx) {
      return {code: 'MOVE_CLOSER', actionable: true,
              detail: {current: observation.pageLongPx,
                       required: req.minPageLongPx, headroomPx: headroom}};
    }
    if (short > 0) {
      // Feasible in principle, but not from here without losing a corner.
      return {code: 'AT_GEOMETRIC_LIMIT', actionable: false,
              detail: {current: observation.pageLongPx,
                       ceiling: feas.maxPageLongPx}};
    }
    if (!observation.stable) return {code: 'HOLD_STILL', actionable: true};
    if (blocking.length) return {code: 'BLOCKED', actionable: false,
                                 detail: {rules: blocking.map(r => r.id)}};
    return {code: 'READY', actionable: false};
  }

  return {A4_ASPECT, A4_LONG_MM, A4_SHORT_MM, STATUS,
          ceiling, feasibility, evaluate, instruct, utilisation};
}));
