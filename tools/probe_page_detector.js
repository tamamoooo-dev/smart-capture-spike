/*
 * Runs the SHIPPED analyzeImageData against real captures.
 *
 * The page detector is the first link in the chain: no page box means no
 * boxWidth/boxHeight, which means the orientation check can never work however
 * correct its formula is. This loads the real static/smart_capture_spike.js
 * with a minimal DOM shim and reports what it actually detects.
 *
 * Input: raw RGBA + dimensions produced by tools/dump_frame.py
 */
'use strict';
const fs = require('fs');
const path = require('path');

function stub() {
  const target = function () { return stub(); };
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'getContext') return () => stub();
      if (prop === 'classList') return {toggle() {}, add() {}, remove() {}};
      if (prop === 'style') return {};
      if (prop === 'width' || prop === 'height') return 0;
      if (prop === 'videoWidth' || prop === 'videoHeight') return 0;
      if (prop === 'textContent') return '';
      if (prop === Symbol.toPrimitive) return () => '';
      return stub();
    },
    set() { return true; },
    apply() { return stub(); }
  });
}

const listeners = {};
const win = {
  addEventListener(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
  screen: {orientation: {type: 'portrait-primary', addEventListener() {}}},
  matchMedia: () => ({matches: false}),
  innerWidth: 400, innerHeight: 800,
  dispatchEvent() {}, CustomEvent: function () {},
  URL: {createObjectURL: () => '', revokeObjectURL() {}}
};
const doc = {
  getElementById: () => stub(),
  querySelector: () => stub(),
  body: {classList: {toggle() {}}}
};

const src = fs.readFileSync(
  path.join(__dirname, '..', 'static', 'smart_capture_spike.js'), 'utf8');
new Function('window', 'document', 'performance', 'requestAnimationFrame',
             'URL', 'navigator', 'File', 'Blob', 'atob', src)(
  win, doc, {now: () => 0}, () => {}, win.URL, {mediaDevices: {}},
  function () {}, function () {}, () => '');

const api = win.SmartCaptureSpike;
if (!api || !api.analyzeImageData) {
  console.error('FAILED to load SmartCaptureSpike from the shipped bundle');
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log('name              found  box(w x h)   aspect  pageWidthPx  orient  pageVis  ready  reason');
for (const entry of manifest) {
  const raw = fs.readFileSync(entry.raw);
  const imageData = {data: new Uint8ClampedArray(raw),
                     width: entry.width, height: entry.height};
  const r = api.analyzeImageData(imageData, entry.sourceWidth);
  const box = r.box ? `${r.box.width}x${r.box.height}` : '-';
  const asp = r.metrics.pageAspect ? r.metrics.pageAspect.toFixed(2) : '0.00';
  console.log(
    `${entry.name.padEnd(17)} ${String(!!r.box).padEnd(6)} ${box.padEnd(12)} ` +
    `${asp.padEnd(7)} ${String(r.metrics.pageWidthPx).padEnd(12)} ` +
    `${String(r.checks.orientation).padEnd(7)} ${String(r.checks.pageVisible).padEnd(8)} ` +
    `${String(r.ready).padEnd(6)} ${r.reason}`);
}
