import type { AnimName } from '../types.ts';

/** Order = dropdown order in the host controls (1-based in AE expressions). */
export const ANIMATIONS: AnimName[] = [
  'pop', 'bounce', 'fade', 'slide-up', 'scale', 'punch', 'shake', 'typewriter', 'blur-reveal', 'snap',
];
export const ANIMATION_LABELS = ['Pop', 'Bounce', 'Fade', 'Slide Up', 'Scale', 'Punch', 'Shake', 'Typewriter', 'Blur Reveal', 'Snap'];
export const animIndex = (a: AnimName) => ANIMATIONS.indexOf(a) + 1;

/**
 * The whole motion library as ONE ES3 expression function, shared by After Effects layers and the
 * Premiere .mogrt. Procedural, so there are no keyframes to create or manage.
 * smEnv(t, type, k, v): t = seconds since the word appears, type = 1-based ANIMATIONS index,
 * k = intensity multiplier (1 = designed look), v = velocity 0..100 (ease sharpness, 50 = cubic).
 * Returns [scale, opacity 0..1, dx em, dy em, blur px].
 */
export const ENV_FN = `function smEnv(t, type, k, v) {
  if (t < 0) return [1, 0, 0, 0, 0];
  var ep = 1 + (v === undefined ? 50 : v) / 25;
  function cl(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function out3(x) { x = cl(x); return 1 - Math.pow(1 - x, ep); }
  var s = 1, o = 1, dx = 0, dy = 0, b = 0, p;
  if (type == 1) {
    s = t < 0.12 ? 0.8 + 0.3 * out3(t / 0.12) : 1.1 - 0.1 * out3((t - 0.12) / 0.16);
    o = cl(t / 0.06);
  } else if (type == 2) {
    p = cl(t / 0.5);
    dy = 0.35 * (1 - p) * Math.cos(p * Math.PI * 3);
    s = 1 + 0.12 * Math.sin(p * Math.PI * 2) * (1 - p);
    o = cl(t / 0.08);
  } else if (type == 3) {
    o = out3(t / 0.3);
    dy = 0.15 * (1 - out3(t / 0.35));
  } else if (type == 4) {
    o = out3(t / 0.2);
    dy = 0.6 * (1 - out3(t / 0.3));
  } else if (type == 5) {
    s = 0.85 + 0.15 * out3(t / 0.3);
    o = out3(t / 0.15);
  } else if (type == 6) {
    s = t < 0.08 ? 0.6 + 0.65 * out3(t / 0.08) : 1.25 - 0.25 * out3((t - 0.08) / 0.16);
    o = cl(t / 0.04);
  } else if (type == 7) {
    p = cl(t / 0.35);
    dx = 0.08 * Math.sin(t * 70) * (1 - p);
    s = 1 + 0.1 * (1 - p);
  } else if (type == 9) {
    p = out3(t / 0.35);
    b = 20 * (1 - p);
    o = p;
    s = 1.05 - 0.05 * p;
  } else if (type == 10) {
    s = 1.08 - 0.08 * out3(t / 0.12);
    o = cl(t / 0.034);
  }
  return [1 + (s - 1) * k, o, dx * k, dy * k, b * k];
}
`;

/** Expressions for After Effects word layers. Controls live on one null in the caption comp. */
export function aeWordExpressions(controlsComp: string) {
  const head = `${ENV_FN}
var c = comp(${JSON.stringify(controlsComp)}).layer("SubMotion Controls");
var em = marker.numKeys > 0 && marker.key(1).comment.indexOf("emph") == 0;
var ae = em && c.effect("Animate Emphasis")(1).value;
var ty = c.effect(ae ? "Emphasis Animation" : "Animation")(1).value;
var k = c.effect(ae ? "Emphasis Intensity" : "Intensity")(1).value / 50;
var e = smEnv((time - inPoint) * Math.pow(2, (c.effect("Speed")(1).value - 50) / 25), ty, k, c.effect("Velocity")(1).value);
`;
  return {
    scale: head + 'value * e[0];',
    opacity: head + 'value * e[1];',
    position: head + 'var fs = text.sourceText.style.fontSize;\nvalue + [e[2] * fs, e[3] * fs];',
    blur: head + '[e[4], e[4]];',
    fill: `var c = comp(${JSON.stringify(controlsComp)}).layer("SubMotion Controls");
var em = marker.numKeys > 0 && marker.key(1).comment.indexOf("emph") == 0;
var col = em ? c.effect("Emphasis Color")(1) : c.effect("Normal Color")(1);
if (c.effect("Active Word Highlight")(1).value && marker.numKeys > 0) {
  var m = marker.key(1);
  if (time >= m.time && time < m.time + Math.max(m.duration, 0.05)) col = c.effect("Active Color")(1);
}
col;`,
  };
}

/**
 * Expressions for the single text layer inside the Premiere .mogrt. Words are addressed with
 * Expression Selectors (Based On: Words); timing and keywords come from editable text params.
 */
export function mogrtExpressions() {
  const head = `${ENV_FN}
var c = thisComp.layer("SubMotion Controls");
var em = ("," + String(thisComp.layer("SM Keywords").text.sourceText) + ",").indexOf("," + textIndex + ",") >= 0;
var wt = String(thisComp.layer("SM Word Times").text.sourceText).split(",");
var t0 = parseFloat(wt[textIndex - 1]); if (isNaN(t0)) t0 = 0;
var t1 = parseFloat(wt[textIndex]); if (isNaN(t1)) t1 = 1e9;
var t = time - inPoint;
var ae = em && c.effect("Animate Emphasis")(1).value;
var ty = c.effect(ae ? "Emphasis Animation" : "Animation")(1).value;
var k = c.effect(ae ? "Emphasis Intensity" : "Intensity")(1).value / 50;
var e = smEnv((t - t0) * Math.pow(2, (c.effect("Speed")(1).value - 50) / 25), ty, k, c.effect("Velocity")(1).value);
var fs = thisLayer.text.sourceText.style.fontSize;
`;
  const settle = 'Math.max(0, thisComp.duration - 0.1)';
  return {
    // Selector amounts (-100..100). Each drives one animator property.
    emphasisAmount: head + 'em ? 100 : 0;',
    emphasisSizeAmount: head + 'em ? c.effect("Emphasis Size +%")(1).value : 0;', // animator scale = 200%
    activeAmount: head + 'c.effect("Active Word Highlight")(1).value && t >= t0 && t < t1 ? 100 : 0;',
    opacityAmount: head + '(1 - e[1]) * 100;', // animator opacity = 0%
    scaleAmount: head + '(e[0] - 1) * 100;', // animator scale = 200%
    moveYAmount: head + 'e[3] * fs;', // animator position = [0, 100]
    moveXAmount: head + 'e[2] * fs;', // animator position = [100, 0]
    blurAmount: head + 'e[4] / 20 * 100;', // animator blur = 20
    normalColor: 'thisComp.layer("SubMotion Controls").effect("Normal Color")(1);',
    emphasisColor: 'thisComp.layer("SubMotion Controls").effect("Emphasis Color")(1);',
    activeColor: 'thisComp.layer("SubMotion Controls").effect("Active Color")(1);',
    anchor: `var r = sourceRectAtTime(${settle}, false);\n[r.left + r.width / 2, r.top + r.height / 2];`,
    position: 'var c = thisComp.layer("SubMotion Controls");\n[thisComp.width / 2, thisComp.height * c.effect("Position Y %")(1) / 100];',
    scale: `var c = thisComp.layer("SubMotion Controls");
var r = sourceRectAtTime(${settle}, false);
var s = c.effect("Size %")(1) / 100;
var maxW = thisComp.width * c.effect("Max Width %")(1) / 100;
var f = r.width * s > maxW && r.width > 0 ? maxW / r.width : s;
[f * 100, f * 100];`,
  };
}
