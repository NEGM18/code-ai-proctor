// =============================================================================
// Role Router — AI Observer Extension
// Content script entry point that routes student vs teacher flows based on
// the detected LMS context and authenticated user role.
// =============================================================================

(async function roleRouter() {
  'use strict';

  console.log('[AI Observer] Role Router initializing...');

  // Wait a tick to ensure all previous content scripts have registered
  // their window.* exports (lms_detector, secure_loader, onnx_inference, monitor, teacher_overlay)
  await new Promise((resolve) => setTimeout(resolve, 100));

  // ---------------------------------------------------------------------------
  // 1. Detect LMS Context
  // ---------------------------------------------------------------------------

  if (!window.getLMSContext) {
    console.log('[AI Observer] LMS Detector not available. Role Router idle.');
    return;
  }

  // ⚠ THIS CALL WAS MISSING.
  //
  // The guard above tests that `window.getLMSContext` EXISTS but never invoked
  // it, and every line below dereferences a `context` that was never declared.
  // That is a ReferenceError on first access, thrown inside this IIFE on every
  // page the extension matches — so the router never routed, never sent
  // ROLE_DETECTED, and never ran initStudentMode. Guest mode happened to
  // survive only because monitor.js starts itself from its own storage
  // listener; nothing here was contributing.
  const context = await window.getLMSContext();

  const storage = await new Promise((resolve) => chrome.storage.local.get(['guestMode', 'proctoringActive'], resolve));
  const isGuestMode = storage.guestMode || context.pageUrl.includes('/demo-quiz') || context.pageUrl.includes('/demo');

  // If user is not logged in and not in guest mode, do nothing
  if (context.role === 'unknown' && !isGuestMode) {
    console.log('[AI Observer] No authenticated user detected and not in guest mode. Extension idle.');
    return;
  }

  console.log(`[AI Observer] Role: ${context.role} | LMS: ${context.lms} | Quiz Active: ${context.quizActive} | Guest: ${isGuestMode}`);

  // ---------------------------------------------------------------------------
  // 2. Route based on role or guest mode
  // ---------------------------------------------------------------------------

  if (context.role === 'student' || isGuestMode) {
    await initStudentMode(context);
  }

  // ---------------------------------------------------------------------------
  // 3. Notify background worker of detected role
  // ---------------------------------------------------------------------------

  try {
    chrome.runtime.sendMessage({
      type: 'ROLE_DETECTED',
      data: {
        role: context.role,
        lms: context.lms,
        quizActive: context.quizActive,
        pageUrl: context.pageUrl,
      },
    });
  } catch (e) {
    // Extension context may not be available
  }

  // =========================================================================
  // Student Mode Initialization
  // =========================================================================

  /**
   * Initialize student proctoring mode.
   * The actual start/stop is driven by popup.js setting proctoringActive in storage.
   * This function just ensures the environment is ready.
   * @param {object} ctx - The LMS context object.
   */
  async function initStudentMode(ctx) {
    console.log('[AI Observer] Student mode activated.');

    // Check if proctoring is already flagged active
    const data = await new Promise((resolve) => {
      chrome.storage.local.get(['proctoringActive', 'serverUrl'], resolve);
    });

    if (data.proctoringActive && window.startProctoring) {
      console.log('[AI Observer] Proctoring was active — resuming...');
      // monitor.js handles this via its own storage listener, so we don't
      // need to call startProctoring() directly here.
    }

    // If on a quiz page, auto-start proctoring if student is logged in
    if (ctx.quizActive) {
      console.log('[AI Observer] Quiz/assessment page detected. Auto-triggering proctoring...');
      chrome.storage.local.get(['proctoringActive', 'sessionCode'], (stData) => {
        if (!stData?.proctoringActive) {
          chrome.storage.local.set({ proctoringActive: true, sessionCode: stData?.sessionCode || 'AUTO' });
        }
      });

      try {
        if (chrome.runtime && chrome.runtime.id) {
          chrome.runtime.sendMessage({
            type: 'QUIZ_DETECTED',
            data: { lms: ctx.lms, url: ctx.pageUrl },
          });
        }
      } catch (e) {}
    }
  }

})();
