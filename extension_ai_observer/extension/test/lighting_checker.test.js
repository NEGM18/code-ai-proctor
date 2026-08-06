// Unit tests for the pre-exam lighting readiness gate.
//
//   node extension/test/lighting_checker.test.js
//
// Everything here drives evaluateLighting / regionStats / frameStats directly
// with synthetic buffers and stat objects. No canvas, no DOM, no timers — so
// every assertion is exact arithmetic rather than a tolerance fit.
//
// The threshold comparisons are STRICT (`< 40`, `> 215`, `< 35`, `> 160`), and
// an off-by-one in any of them is a student locked out of an exam, so each one
// is pinned at its boundary from both sides.

const L = require('../content/lighting_checker.js');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}
const checkTrue = (name, cond) => check(name, !!cond, true);
const near = (name, actual, expected, eps = 1e-6) => {
  checks++;
  const ok = Math.abs(actual - expected) < eps;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
};

const { LIGHTING_STATUS, LIGHTING_MESSAGES, LIGHTING_THRESHOLDS } = L;

/** Build a stats object. Defaults sit comfortably inside every PASS band. */
const stats = (o = {}) => ({
  avgLuminance: 120,
  faceLuminance: 110,
  bgLuminance: 125,
  faceStdDev: 30,
  ...o,
});
const statusOf = (o) => L.evaluateLighting(stats(o)).status;

// ===========================================================================
console.log('\n--- thresholds are exactly as specified ---');
// ===========================================================================
check('minLuminance', LIGHTING_THRESHOLDS.minLuminance, 40);
check('maxLuminance', LIGHTING_THRESHOLDS.maxLuminance, 215);
check('backlitFaceMax', LIGHTING_THRESHOLDS.backlitFaceMax, 35);
check('backlitBgMin', LIGHTING_THRESHOLDS.backlitBgMin, 160);

// ===========================================================================
console.log('\n--- TOO_DARK boundary (avg < 40) ---');
// ===========================================================================
check('avg 0   -> TOO_DARK', statusOf({ avgLuminance: 0, faceLuminance: 0, bgLuminance: 0, faceStdDev: 0 }), LIGHTING_STATUS.TOO_DARK);
check('avg 39  -> TOO_DARK', statusOf({ avgLuminance: 39 }), LIGHTING_STATUS.TOO_DARK);
check('avg 39.9 -> TOO_DARK', statusOf({ avgLuminance: 39.9 }), LIGHTING_STATUS.TOO_DARK);
check('avg 40  -> PASS (boundary is exclusive)', statusOf({ avgLuminance: 40 }), LIGHTING_STATUS.PASS);
check('avg 41  -> PASS', statusOf({ avgLuminance: 41 }), LIGHTING_STATUS.PASS);

// ===========================================================================
console.log('\n--- OVEREXPOSED boundary (avg > 215) ---');
// ===========================================================================
check('avg 214 -> PASS', statusOf({ avgLuminance: 214 }), LIGHTING_STATUS.PASS);
check('avg 215 -> PASS (boundary is exclusive)', statusOf({ avgLuminance: 215 }), LIGHTING_STATUS.PASS);
check('avg 215.1 -> OVEREXPOSED', statusOf({ avgLuminance: 215.1 }), LIGHTING_STATUS.OVEREXPOSED);
check('avg 216 -> OVEREXPOSED', statusOf({ avgLuminance: 216 }), LIGHTING_STATUS.OVEREXPOSED);
check('avg 255 -> OVEREXPOSED', statusOf({ avgLuminance: 255, faceLuminance: 255, bgLuminance: 255, faceStdDev: 0 }), LIGHTING_STATUS.OVEREXPOSED);

// ===========================================================================
console.log('\n--- HIGH_BACKLIGHT needs BOTH conditions ---');
// ===========================================================================
// This is the fairness-critical property. HIGH_BACKLIGHT is a RELATIVE test:
// a dark face alone must never trigger it, because face luminance is a
// function of skin tone as well as of illumination.
check('face 34 + bg 161 -> HIGH_BACKLIGHT',
  statusOf({ faceLuminance: 34, bgLuminance: 161 }), LIGHTING_STATUS.HIGH_BACKLIGHT);
check('face 35 + bg 161 -> PASS (face boundary exclusive)',
  statusOf({ faceLuminance: 35, bgLuminance: 161 }), LIGHTING_STATUS.PASS);
check('face 34 + bg 160 -> PASS (bg boundary exclusive)',
  statusOf({ faceLuminance: 34, bgLuminance: 160 }), LIGHTING_STATUS.PASS);
check('dark face + DARK bg -> not backlight',
  statusOf({ avgLuminance: 60, faceLuminance: 20, bgLuminance: 70, faceStdDev: 20 }), LIGHTING_STATUS.PASS);
check('bright face + bright bg -> not backlight',
  statusOf({ avgLuminance: 180, faceLuminance: 175, bgLuminance: 185 }), LIGHTING_STATUS.PASS);

// ===========================================================================
console.log('\n--- ⚠ FAIRNESS REGRESSION: even light is never a lockout ---');
// ===========================================================================
// A low-reflectance face in a well-lit room. The face crop is genuinely darker
// than a light-skinned one would be, but the background is NOT bright relative
// to it, so nothing here is a lighting fault. If anyone ever relaxes
// HIGH_BACKLIGHT into a face-only test, these four go red.
check('face 50 / bg 55, textured -> PASS',
  statusOf({ avgLuminance: 54, faceLuminance: 50, bgLuminance: 55, faceStdDev: 20 }), LIGHTING_STATUS.PASS);
check('face 50 / bg 55, flat -> PASS',
  statusOf({ avgLuminance: 54, faceLuminance: 50, bgLuminance: 55, faceStdDev: 4 }), LIGHTING_STATUS.PASS);
check('face 30 / bg 45 (dim but even) -> PASS',
  statusOf({ avgLuminance: 42, faceLuminance: 30, bgLuminance: 45, faceStdDev: 15 }), LIGHTING_STATUS.PASS);
check('face 34 / bg 159 stays PASS — bg must clear 160',
  statusOf({ avgLuminance: 130, faceLuminance: 34, bgLuminance: 159, faceStdDev: 25 }), LIGHTING_STATUS.PASS);

// ===========================================================================
console.log('\n--- silhouette branch: flat AND much darker than the room ---');
// ===========================================================================
check('delta 80 + stdDev 8 -> HIGH_BACKLIGHT',
  statusOf({ avgLuminance: 125, faceLuminance: 60, bgLuminance: 140, faceStdDev: 8 }), LIGHTING_STATUS.HIGH_BACKLIGHT);
check('delta 80 + stdDev 12 -> PASS (stdDev boundary exclusive)',
  statusOf({ avgLuminance: 125, faceLuminance: 60, bgLuminance: 140, faceStdDev: 12 }), LIGHTING_STATUS.PASS);
check('delta 70 + stdDev 8 -> PASS (delta boundary exclusive)',
  statusOf({ avgLuminance: 125, faceLuminance: 60, bgLuminance: 130, faceStdDev: 8 }), LIGHTING_STATUS.PASS);
check('textured face at same delta -> PASS',
  statusOf({ avgLuminance: 125, faceLuminance: 60, bgLuminance: 140, faceStdDev: 35 }), LIGHTING_STATUS.PASS);

// ===========================================================================
console.log('\n--- ⚠ UNREADABLE ≠ FAILING ---');
// ===========================================================================
// A flat face crop at normal luminance almost always means the student has not
// aligned to the oval yet. "We cannot see a face" is not a lighting fault and
// must never withhold an exam — CLAUDE.md §5, applied to a gate.
check('flat face, normal light -> PASS',
  statusOf({ avgLuminance: 120, faceLuminance: 120, bgLuminance: 125, faceStdDev: 1 }), LIGHTING_STATUS.PASS);
check('perfectly uniform mid-grey frame -> PASS',
  statusOf({ avgLuminance: 128, faceLuminance: 128, bgLuminance: 128, faceStdDev: 0 }), LIGHTING_STATUS.PASS);
check('no measurement at all -> PASS/no_measurement',
  L.evaluateLighting({}).detail.reason, 'no_measurement');
check('null stats -> PASS', L.evaluateLighting(null).status, LIGHTING_STATUS.PASS);
check('NaN average -> PASS', statusOf({ avgLuminance: NaN }), LIGHTING_STATUS.PASS);
check('face/bg missing -> falls back to global verdict',
  statusOf({ faceLuminance: NaN, bgLuminance: NaN, faceStdDev: NaN }), LIGHTING_STATUS.PASS);

// ===========================================================================
console.log('\n--- precedence: global exposure is settled first ---');
// ===========================================================================
// In a near-black frame the face/background comparison is measuring sensor
// noise, so its answer means nothing and must not win.
check('dark frame that also looks backlit -> TOO_DARK',
  statusOf({ avgLuminance: 20, faceLuminance: 10, bgLuminance: 200, faceStdDev: 2 }), LIGHTING_STATUS.TOO_DARK);
check('blown-out frame that also looks backlit -> OVEREXPOSED',
  statusOf({ avgLuminance: 240, faceLuminance: 30, bgLuminance: 250, faceStdDev: 2 }), LIGHTING_STATUS.OVEREXPOSED);

// ===========================================================================
console.log('\n--- user-facing messages are verbatim ---');
// ===========================================================================
check('TOO_DARK message',
  L.evaluateLighting(stats({ avgLuminance: 10 })).userMessage,
  'Your room is too dark. Please turn on overhead lights.');
check('OVEREXPOSED message',
  L.evaluateLighting(stats({ avgLuminance: 240 })).userMessage,
  'Camera feed is washed out. Avoid bright lights pointing at the lens.');
check('HIGH_BACKLIGHT message',
  L.evaluateLighting(stats({ faceLuminance: 20, bgLuminance: 200 })).userMessage,
  'Strong backlight detected behind you. Move your camera away from bright windows.');
checkTrue('PASS has a message too', LIGHTING_MESSAGES.PASS.length > 0);
checkTrue('every status maps to a message',
  Object.keys(LIGHTING_STATUS).every((k) => typeof LIGHTING_MESSAGES[k] === 'string'));

// ===========================================================================
console.log('\n--- regionStats: hand-computed ---');
// ===========================================================================
{
  //  0 10 20 30
  // 40 50 60 70
  const g = Uint8ClampedArray.from([0, 10, 20, 30, 40, 50, 60, 70]);
  const all = L.regionStats(g, 4, 2);
  check('full-frame count', all.count, 8);
  near('full-frame mean', all.mean, 35);
  // variance = 14000/8 - 35^2 = 1750 - 1225 = 525
  near('full-frame stdDev', all.stdDev, Math.sqrt(525));
  near('full-frame sum', all.sum, 280);
  near('full-frame sumSq', all.sumSq, 14000);

  const q = L.regionStats(g, 4, 2, { x: 0, y: 0, w: 2, h: 2 });   // 0,10,40,50
  check('sub-region count', q.count, 4);
  near('sub-region mean', q.mean, 25);
  near('sub-region stdDev', q.stdDev, Math.sqrt(425));

  const empty = L.regionStats(g, 4, 2, { x: 0, y: 0, w: 0, h: 0 });
  check('zero-area count', empty.count, 0);
  checkTrue('zero-area mean is NaN, never 0', Number.isNaN(empty.mean));

  const outside = L.regionStats(g, 4, 2, { x: 99, y: 99, w: 10, h: 10 });
  check('out-of-frame box is clamped to empty', outside.count, 0);

  const uniform = L.regionStats(Uint8ClampedArray.from([7, 7, 7, 7]), 2, 2);
  near('uniform region stdDev is exactly 0', uniform.stdDev, 0);
  checkTrue('uniform stdDev is never negative', uniform.stdDev >= 0);
}

// ===========================================================================
console.log('\n--- faceBoxFor / frameStats ---');
// ===========================================================================
{
  const box = L.faceBoxFor(128, 96);
  checkTrue('face box is inside the frame',
    box.x >= 0 && box.y >= 0 && box.x + box.w <= 128 && box.y + box.h <= 96);
  checkTrue('face box is a minority of the frame',
    (box.w * box.h) / (128 * 96) < 0.35);
  checkTrue('face box is taller than it is wide', box.h > box.w);
  checkTrue('face box is horizontally centred',
    Math.abs((box.x + box.w / 2) - 64) <= 1);

  // A backlit frame: dark subject in the oval, bright window everywhere else.
  const W = 128, H = 96;
  const g = new Uint8ClampedArray(W * H);
  g.fill(200);
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) g[y * W + x] = 25;
  }
  const fs = L.frameStats(g, W, H);
  near('face region reads dark', fs.faceLuminance, 25);
  near('background reads bright', fs.bgLuminance, 200);
  near('uniform face has no internal contrast', fs.faceStdDev, 0);

  // ⚠ The case the whole face box exists for: the AVERAGE is perfectly normal,
  // so a global-luminance-only gate would wave this student straight through.
  checkTrue('average alone looks fine',
    fs.avgLuminance > LIGHTING_THRESHOLDS.minLuminance
    && fs.avgLuminance < LIGHTING_THRESHOLDS.maxLuminance);
  check('…but the gate reports HIGH_BACKLIGHT',
    L.evaluateLighting(fs).status, LIGHTING_STATUS.HIGH_BACKLIGHT);

  // Same geometry, evenly lit -> PASS.
  const even = new Uint8ClampedArray(W * H);
  even.fill(120);
  for (let i = 0; i < even.length; i += 3) even[i] = 90;   // some texture
  check('evenly lit frame -> PASS', L.evaluateLighting(L.frameStats(even, W, H)).status, LIGHTING_STATUS.PASS);

  const dark = new Uint8ClampedArray(W * H);
  dark.fill(12);
  check('lights-off frame -> TOO_DARK', L.evaluateLighting(L.frameStats(dark, W, H)).status, LIGHTING_STATUS.TOO_DARK);

  const blown = new Uint8ClampedArray(W * H);
  blown.fill(245);
  check('blown-out frame -> OVEREXPOSED', L.evaluateLighting(L.frameStats(blown, W, H)).status, LIGHTING_STATUS.OVEREXPOSED);
}

// ===========================================================================
console.log('\n--- LightingChecker state machine (advisory) ---');
// ===========================================================================
{
  const good = stats();
  const bad = stats({ avgLuminance: 10 });

  const c = new L.LightingChecker();

  // Before any sample the message says so rather than pretending the room has
  // been assessed. `optimal` drives message COLOUR only.
  const pre = c.advisory();
  check('pre-sample sampled flag', pre.sampled, false);
  check('pre-sample optimal flag', pre.optimal, false);
  check('pre-sample message', pre.userMessage, LIGHTING_MESSAGES.CHECKING);
  check('pre-sample isOptimal()', c.isOptimal(), false);
  check('checkLightingStatus() is the same object shape', c.checkLightingStatus(), pre);

  c.tick(good);
  check('1 good sample -> not yet "good"', c.isOptimal(), false);
  c.tick(good);
  check('2 good samples -> not yet "good"', c.isOptimal(), false);
  c.tick(good);
  check('3 good samples -> message reads good', c.isOptimal(), true);
  check('status is PASS', c.advisory().status, LIGHTING_STATUS.PASS);
  check('sampled flag set', c.advisory().sampled, true);

  // One bad sample restarts the run, so the wording cannot flicker back to
  // "good" off a single lucky frame.
  c.tick(bad);
  check('one bad sample -> not optimal', c.isOptimal(), false);
  check('stableCount reset', c.stableCount, 0);
  check('status follows the bad sample', c.advisory().status, LIGHTING_STATUS.TOO_DARK);

  c.tick(good); c.tick(good);
  check('2 good after a reset -> not optimal', c.isOptimal(), false);
  c.tick(good);
  check('3 good after a reset -> optimal again', c.isOptimal(), true);

  // An unreadable frame is not evidence either way: it must not advance the
  // run, and it must not destroy it.
  const before = c.stableCount;
  c.tick(null);
  check('unreadable frame leaves stableCount alone', c.stableCount, before);
  check('unreadable frame leaves the advice alone', c.advisory().status, LIGHTING_STATUS.PASS);

  const t = c.telemetry();
  check('telemetry sample count', t.samples, 7);
  check('telemetry counts PASS samples', t.statusCounts.PASS, 6);
  check('telemetry counts TOO_DARK samples', t.statusCounts.TOO_DARK, 1);
  check('telemetry optimal flag', t.optimal, true);
  check('telemetry required', t.required, 3);
  check('telemetry not running (never start()ed)', t.running, false);

  c.reset();
  check('reset clears samples', c.telemetry().samples, 0);
  check('reset clears optimal', c.isOptimal(), false);
  check('reset returns to the pre-sample message', c.advisory().userMessage, LIGHTING_MESSAGES.CHECKING);
}

// ===========================================================================
console.log('\n--- ⚠ ADVISORY: nothing here can block an exam ---');
// ===========================================================================
// The single most important property of this module after the hardening pass.
// An earlier revision gated the Start button on the lighting verdict; because
// backlitFaceMax is an absolute grey level measured on skin, that made the
// failure mode DENIAL OF EXAM ACCESS. There is now no blocking predicate at all.
{
  const c = new L.LightingChecker();

  check('isReady() no longer exists', typeof c.isReady, 'undefined');
  checkTrue('no exported symbol implies blocking',
    !/block|lockout|readin?ess|isReady/i.test(Object.keys(L).join(' ')));

  // Drive the worst inputs imaginable. None of them may produce a blocked state,
  // because there is no blocked state to produce — every result is advice.
  const worst = [
    stats({ avgLuminance: 0, faceLuminance: 0, bgLuminance: 0, faceStdDev: 0 }),
    stats({ avgLuminance: 255, faceLuminance: 255, bgLuminance: 255, faceStdDev: 0 }),
    stats({ avgLuminance: 120, faceLuminance: 5, bgLuminance: 250, faceStdDev: 0 }),
    null,
  ];
  for (const w of worst) {
    const r = c.tick(w);
    checkTrue('advice always carries a user message', typeof r.userMessage === 'string' && r.userMessage.length > 0);
    checkTrue('advice never exposes a blocking flag',
      r.blocked === undefined && r.ready === undefined && r.mustFix === undefined);
  }

  // A pitch-black feed for 30 s produces advice, and only advice.
  for (let i = 0; i < 150; i++) c.tick(stats({ avgLuminance: 3, faceLuminance: 2, bgLuminance: 3, faceStdDev: 0 }));
  const r = c.advisory();
  check('30 s of darkness -> still just TOO_DARK advice', r.status, LIGHTING_STATUS.TOO_DARK);
  check('…and optimal is merely false, not blocking', r.optimal, false);
  checkTrue('…and the message is actionable', /overhead lights/.test(r.userMessage));
}

// ===========================================================================
console.log('\n--- onUpdate callback ---');
// ===========================================================================
{
  const seen = [];
  const c = new L.LightingChecker({ onUpdate: (r) => seen.push(r.status) });
  c.tick(stats());
  c.tick(stats({ avgLuminance: 10 }));
  c.tick(stats({ faceLuminance: 20, bgLuminance: 200 }));
  check('onUpdate fired per tick', seen.length, 3);
  check('onUpdate carries the verdicts', seen,
    [LIGHTING_STATUS.PASS, LIGHTING_STATUS.TOO_DARK, LIGHTING_STATUS.HIGH_BACKLIGHT]);
}

// ===========================================================================
console.log('\n--- detail payload is present for telemetry ---');
// ===========================================================================
{
  const r = L.evaluateLighting(stats({ faceLuminance: 20.44, bgLuminance: 200.46 }));
  check('reason is recorded', r.detail.reason, 'face_dark_bg_bright');
  check('face luminance rounded to 1dp', r.detail.faceLuminance, 20.4);
  check('bg luminance rounded to 1dp', r.detail.bgLuminance, 200.5);
  checkTrue('avg luminance present', typeof r.detail.avgLuminance === 'number');
  check('unmeasurable fields are null, not 0',
    L.evaluateLighting({ avgLuminance: 50 }).detail.faceLuminance, null);
}

// ===========================================================================
console.log('\n--- the gate is not a detector ---');
// ===========================================================================
// Nothing in this module may grow a severity, a violation type, or a reporting
// hook. The moment a lighting reading can reach an incident report, an unlucky
// room becomes evidence of misconduct — CLAUDE.md §5.
{
  const exported = Object.keys(L).join(' ');
  checkTrue('no severity in the public surface', !/severity/i.test(exported));
  checkTrue('no violation type in the public surface', !/violation/i.test(exported));
  const r = L.evaluateLighting(stats({ avgLuminance: 5 }));
  checkTrue('a verdict carries no severity field', r.severity === undefined);
  checkTrue('a verdict carries no condition field', r.condition === undefined);
}

console.log(`\n${checks} checks — ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
