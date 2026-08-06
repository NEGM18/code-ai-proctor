// Tests for the hardware tier probe and the ONNX execution-provider chain.
//
//   node extension/test/runtime_profile.test.js
//
// Everything here runs without a browser, a GPU or ORT: probeWebGPU takes an
// injectable navigator, resolveThreadCount takes an injectable capability set,
// and createSession takes an injectable ort namespace. That is deliberate — the
// GPU/CPU decision is the single highest-blast-radius branch in the extension
// and it must be verifiable in CI on a headless box.

const rp = require('../content/vision/runtime_profile.js');

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}
const checkTrue = (name, cond) => check(name, !!cond, true);

/** navigator stub whose requestAdapter behaves however the test needs. */
const navWith = (requestAdapter) => ({ gpu: { requestAdapter } });

async function main() {
  console.log('=== probeWebGPU ===');
  {
    check('no navigator.gpu -> unavailable',
      (await rp.probeWebGPU({})).available, false);

    check('null adapter -> unavailable',
      (await rp.probeWebGPU(navWith(async () => null))).available, false);

    // The whole point of the probe: a driver that exposes navigator.gpu but
    // throws on adapter creation must NOT be treated as GPU-capable.
    const thrown = await rp.probeWebGPU(navWith(async () => { throw new Error('device lost'); }));
    check('requestAdapter throwing -> unavailable', thrown.available, false);
    checkTrue('throw reason is recorded', /device lost/.test(thrown.reason));

    const ok = await rp.probeWebGPU(navWith(async () => ({ info: { vendor: 'test' } })));
    check('real adapter -> available', ok.available, true);
    check('adapter info captured', ok.adapterInfo, { vendor: 'test' });
  }

  console.log('\n=== resolveThreadCount ===');
  {
    check('1 thread requested stays 1', rp.resolveThreadCount(1).threads, 1);

    // A content script on an ordinary LMS page is not cross-origin isolated, so
    // ORT's threaded WASM build cannot start. Asking for 2 anyway is how the
    // session fails to load entirely.
    check('no SharedArrayBuffer -> 1',
      rp.resolveThreadCount(2, { hasSharedArrayBuffer: false, crossOriginIsolated: true, hardwareConcurrency: 8 }).threads, 1);
    check('not cross-origin isolated -> 1',
      rp.resolveThreadCount(2, { hasSharedArrayBuffer: true, crossOriginIsolated: false, hardwareConcurrency: 8 }).threads, 1);
    check('single core -> 1',
      rp.resolveThreadCount(2, { hasSharedArrayBuffer: true, crossOriginIsolated: true, hardwareConcurrency: 1 }).threads, 1);
    check('isolated multicore -> 2',
      rp.resolveThreadCount(2, { hasSharedArrayBuffer: true, crossOriginIsolated: true, hardwareConcurrency: 8 }).threads, 2);
    check('never exceeds core count',
      rp.resolveThreadCount(4, { hasSharedArrayBuffer: true, crossOriginIsolated: true, hardwareConcurrency: 2 }).threads, 2);
  }

  console.log('\n=== tier profiles ===');
  {
    const A = rp.TIER_PROFILES[rp.RuntimeTier.GPU];
    const B = rp.TIER_PROFILES[rp.RuntimeTier.CPU];

    check('Tier A provider chain', A.executionProviders, ['webgpu', 'wasm']);
    check('Tier B provider chain', B.executionProviders, ['wasm']);
    check('Tier B requests 2 WASM threads', B.wasmThreads, 2);
    check('Tier B enables SIMD', B.wasmSimd, true);
    check('Tier B caps input at 320', B.maxInputSize, 320);
    check('Tier B detect input is 320', B.detectInputSize, 320);

    // Tier A must sit inside the 15-30 FPS band; Tier B inside 8-10.
    checkTrue('Tier A targets 15-30 FPS', A.targetFps >= 15 && A.targetFps <= 30);
    checkTrue('Tier B targets 8-10 FPS', B.targetFps >= 8 && B.targetFps <= 10);

    // Non-negotiable across BOTH tiers: the phone detector never samples.
    check('Tier A runs phone detect continuously', A.detectMode, 'continuous');
    check('Tier B runs phone detect continuously', B.detectMode, 'continuous');
  }

  console.log('\n=== resolveRuntimeProfile ===');
  {
    rp.resetRuntimeProfile();
    const gpu = await rp.resolveRuntimeProfile({
      navigator: navWith(async () => ({})),
    });
    check('adapter present -> Tier A', gpu.tier, rp.RuntimeTier.GPU);
    check('Tier A gets the webgpu chain', gpu.executionProviders, ['webgpu', 'wasm']);

    rp.resetRuntimeProfile();
    const cpu = await rp.resolveRuntimeProfile({ navigator: {} });
    check('no gpu -> Tier B', cpu.tier, rp.RuntimeTier.CPU);
    check('Tier B gets the wasm-only chain', cpu.executionProviders, ['wasm']);

    // Two concurrent callers (classifier + vision engine) must not race two
    // adapter probes or end up on different tiers.
    rp.resetRuntimeProfile();
    let probeCount = 0;
    const nav = navWith(async () => { probeCount++; return {}; });
    const [a, b] = await Promise.all([
      rp.resolveRuntimeProfile({ navigator: nav }),
      rp.resolveRuntimeProfile({ navigator: nav }),
    ]);
    check('concurrent resolves share one profile object', a === b, true);
    check('adapter probed exactly once', probeCount, 1);

    rp.resetRuntimeProfile();
  }

  console.log('\n=== createSession fallback ===');
  {
    // Tier A, everything works: the webgpu chain is used verbatim.
    const calls = [];
    const okOrt = {
      // ⚠ env.webgpu is what marks a build as WebGPU-capable. Without it, ORT
      // silently drops the EP and runs on CPU while we report a GPU.
      env: { webgpu: {} },
      InferenceSession: {
        create: async (_src, opts) => { calls.push(opts.executionProviders); return { id: 'session' }; },
      },
    };
    const profileA = { executionProviders: ['webgpu', 'wasm'], degradedToWasm: false };
    const r1 = await rp.createSession(okOrt, 'model.onnx', profileA, 'test');
    check('uses the tier chain', calls[0], ['webgpu', 'wasm']);
    check('reports the primary provider', r1.provider, 'webgpu');

    // ⚠ THE PRODUCTION BUG. The BROWSER has WebGPU (so the tier probe said A),
    // but this ORT BUILD has no webgpu backend. ORT would drop the EP, succeed
    // on wasm, and leave us reporting 'webgpu' while running CPU at a 50ms
    // cadence no CPU can hold. The chain must be corrected BEFORE the call.
    const wasmOnlyCalls = [];
    const wasmOnlyOrt = {
      env: { wasm: {} },   // no env.webgpu -> wasm-only bundle
      InferenceSession: {
        create: async (_src, opts) => { wasmOnlyCalls.push(opts.executionProviders); return { id: 's' }; },
      },
    };
    check('a wasm-only build is detected', rp.ortSupportsWebGpu(wasmOnlyOrt), false);
    check('a webgpu build is detected', rp.ortSupportsWebGpu(okOrt), true);

    const profileMismatch = { executionProviders: ['webgpu', 'wasm'], degradedToWasm: false };
    const rMismatch = await rp.createSession(wasmOnlyOrt, 'model.onnx', profileMismatch, 'test');
    check('webgpu is stripped from the chain', wasmOnlyCalls[0], ['wasm']);
    check('and the provider reported is the TRUTH', rMismatch.provider, 'wasm');
    check('the profile records why', profileMismatch.ortLacksWebGpu, true);
    check('and is marked degraded so cadence can re-tier', profileMismatch.degradedToWasm, true);

    // Tier A, this particular graph will not build on the GPU (unsupported op,
    // shader compile failure). It must silently land on CPU, not take
    // proctoring down with it.
    const retries = [];
    let attempt = 0;
    const flakyOrt = {
      // A genuinely WebGPU-capable build — the backend exists, but THIS graph
      // will not compile on it. Distinct from the wasm-only case above, and the
      // two must be handled by different mechanisms.
      env: { webgpu: {} },
      InferenceSession: {
        create: async (_src, opts) => {
          retries.push(opts.executionProviders);
          if (attempt++ === 0) throw new Error('webgpu op unsupported');
          return { id: 'wasm-session' };
        },
      },
    };
    const profileB = { executionProviders: ['webgpu', 'wasm'], degradedToWasm: false };
    const r2 = await rp.createSession(flakyOrt, 'model.onnx', profileB, 'test');
    check('retries on pure wasm', retries[1], ['wasm']);
    check('fallback session reports wasm', r2.provider, 'wasm');
    check('degradation is recorded on the profile', profileB.degradedToWasm, true);

    // Tier B already IS wasm — there is nothing to fall back to, so the error
    // must propagate rather than being swallowed into a null session.
    const deadOrt = {
      InferenceSession: { create: async () => { throw new Error('model corrupt'); } },
    };
    let threw = false;
    try {
      await rp.createSession(deadOrt, 'model.onnx', { executionProviders: ['wasm'] }, 'test');
    } catch (err) {
      threw = /model corrupt/.test(err.message);
    }
    check('wasm-only failure propagates', threw, true);
  }

  console.log('\n=== input size resolution ===');
  {
    check('static NCHW shape is read',
      rp.resolveSessionInputSize({ inputNames: ['images'], inputMetadata: { images: { shape: [1, 3, 448, 448] } } }),
      448);
    check('dynamic axis reports null',
      rp.resolveSessionInputSize({ inputNames: ['images'], inputMetadata: { images: { shape: [1, 3, 'h', 'w'] } } }),
      null);
    check('missing metadata reports null', rp.resolveSessionInputSize({}), null);

    // The clamp exists because export_vision_models.py uses dynamic=False. A
    // static 448 graph CANNOT be fed 320 — doing so throws at run() — so the
    // model's own shape has to win, and the caller must be told the tier cap
    // was not honoured.
    const stuck = rp.clampInputSize(320, 448, 320);
    check('static graph overrides the tier preference', stuck.size, 448);
    check('unhonoured cap is flagged', stuck.honored, false);

    const free = rp.clampInputSize(320, null, 320);
    check('dynamic graph gets the tier size', free.size, 320);
    check('dynamic graph honours the cap', free.honored, true);

    const capped = rp.clampInputSize(448, null, 320);
    check('preference is capped on Tier B', capped.size, 320);

    const small = rp.clampInputSize(256, 256, 320);
    check('a model already under the cap is honoured', small.honored, true);
  }

  console.log('\n=== configureOrtEnv ===');
  {
    const fakeOrt = { env: { wasm: {}, logLevel: null } };
    const profile = { ...rp.TIER_PROFILES[rp.RuntimeTier.CPU] };
    rp.configureOrtEnv(fakeOrt, profile, {
      hasSharedArrayBuffer: true, crossOriginIsolated: true, hardwareConcurrency: 4,
    });
    check('Tier B applies 2 threads when supported', fakeOrt.env.wasm.numThreads, 2);
    check('SIMD is always on', fakeOrt.env.wasm.simd, true);
    check('applied settings are recorded', profile.appliedThreads, 2);

    const fakeOrt2 = { env: { wasm: {}, logLevel: null } };
    const profile2 = { ...rp.TIER_PROFILES[rp.RuntimeTier.CPU] };
    rp.configureOrtEnv(fakeOrt2, profile2, {
      hasSharedArrayBuffer: false, crossOriginIsolated: false, hardwareConcurrency: 4,
    });
    check('falls back to 1 thread on a normal page', fakeOrt2.env.wasm.numThreads, 1);
    check('but keeps SIMD', fakeOrt2.env.wasm.simd, true);
  }

  console.log(`\n${checks} checks — ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
