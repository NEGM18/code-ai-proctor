// =============================================================================
// Background Service Worker — AI Observer Extension (Manifest V3)
// Enterprise message router with badge management, offline queue flushing,
// and tab-aware proctoring state tracking.
// =============================================================================

console.log('[AI Observer] Background service worker started.');

// ---------------------------------------------------------------------------
// State Tracking
// ---------------------------------------------------------------------------

/** @type {Map<number, {studentName: string, studentId: string, sessionCode: string, startedAt: number}>} */
const proctoredTabs = new Map();

/** @type {number} Total violation count across all tabs (for badge) */
let globalViolationCount = 0;

// ---------------------------------------------------------------------------
// Badge Management
// ---------------------------------------------------------------------------

/**
 * Update the extension badge to reflect current state.
 * @param {'idle'|'active'|'alert'|'quiz_detected'} state
 * @param {number} [tabId] - Optional tab to scope the badge to.
 */
function updateBadge(state, tabId) {
  const config = {
    idle:           { text: '',    color: '#6b7280' },
    active:         { text: 'ON',  color: '#10b981' },
    alert:          { text: '!',   color: '#ef4444' },
    quiz_detected:  { text: 'Q',   color: '#f59e0b' },
  };

  const { text, color } = config[state] || config.idle;

  if (tabId) {
    chrome.action.setBadgeText({ text, tabId });
    chrome.action.setBadgeBackgroundColor({ color, tabId });
  } else {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
  }
}

// ---------------------------------------------------------------------------
// Message Router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;

  switch (message.type) {

    // -----------------------------------------------------------------------
    // Proctoring Lifecycle
    // -----------------------------------------------------------------------

    case 'START_PROCTOR': {
      console.log(`[Worker] Proctoring started on tab ${tabId}:`, message.data);
      if (tabId) {
        // ⚠ MERGE, NEVER REPLACE.
        //
        // GUEST_MODE_STARTED arrives FIRST (guest_bridge.js posts it the moment
        // the page asks to start), and START_PROCTOR arrives afterwards, once
        // monitor.js has finished acquiring the camera and compiling the models.
        // A bare .set() therefore overwrote the `guestMode` flag with an object
        // that does not carry it — and the relay below is gated on exactly that
        // flag, so every guest violation was dropped and the demo's evidence
        // panel could never populate no matter what the vision stack detected.
        const existing = proctoredTabs.get(tabId) || {};
        proctoredTabs.set(tabId, {
          ...existing,
          studentName: message.data.studentName,
          studentId: message.data.studentId,
          sessionCode: message.data.sessionCode,
          startedAt: Date.now(),
        });
        updateBadge('active', tabId);
      }
      globalViolationCount = 0;
      sendResponse({ status: 'ok' });
      break;
    }

    case 'STOP_PROCTOR': {
      console.log(`[Worker] Proctoring stopped on tab ${tabId}`);
      if (tabId) {
        proctoredTabs.delete(tabId);
        updateBadge('idle', tabId);
      }
      globalViolationCount = 0;
      sendResponse({ status: 'ok' });
      break;
    }

    // -----------------------------------------------------------------------
    // Violation Events
    // -----------------------------------------------------------------------

    case 'VIOLATION_EVENT': {
      globalViolationCount++;
      const payload = message.payload;
      console.warn(
        `[Worker] Violation #${globalViolationCount}: ${payload.violation_type}`,
        `(severity: ${payload.severity}, tab: ${tabId})`
      );

      // Flash the badge red with alert count
      if (tabId) {
        updateBadge('alert', tabId);
        // Reset to active green after 3 seconds
        setTimeout(() => {
          if (proctoredTabs.has(tabId)) {
            updateBadge('active', tabId);
          }
        }, 3000);
      }

      if (tabId) {
        const tabState = proctoredTabs.get(tabId);
        if (tabState?.guestMode) {
          chrome.tabs.sendMessage(tabId, {
            type: 'GUEST_VIOLATION_RELAY',
            payload: {
              ...payload,
              violation_id: `v-${globalViolationCount}-${Date.now()}`,
            },
          }).catch(() => {});
        }
      }

      sendResponse({ status: 'ok', violationCount: globalViolationCount });
      break;
    }

    // -----------------------------------------------------------------------
    // Heartbeat
    // -----------------------------------------------------------------------

    case 'HEARTBEAT': {
      console.log(`[Worker] Heartbeat from tab ${tabId}`);
      sendResponse({ status: 'ok' });
      break;
    }

    // -----------------------------------------------------------------------
    // Model Status
    // -----------------------------------------------------------------------

    case 'MODEL_STATUS': {
      console.log(`[Worker] Model status:`, message.data);
      sendResponse({ status: 'ok' });
      break;
    }

    // -----------------------------------------------------------------------
    // Role Detection
    // -----------------------------------------------------------------------

    case 'ROLE_DETECTED': {
      console.log(`[Worker] Role detected on tab ${tabId}:`, message.data);

      // If teacher role detected, we could set a different badge
      if (message.data.role === 'teacher') {
        if (tabId) updateBadge('idle', tabId);
      }

      sendResponse({ status: 'ok' });
      break;
    }

    // -----------------------------------------------------------------------
    // Quiz Detection
    // -----------------------------------------------------------------------

    case 'QUIZ_DETECTED': {
      console.log(`[Worker] Quiz page detected on tab ${tabId}:`, message.data);
      if (tabId) {
        updateBadge('quiz_detected', tabId);
      }
      sendResponse({ status: 'ok' });
      break;
    }

    // -----------------------------------------------------------------------
    // Get Proctoring State (for popup queries)
    // -----------------------------------------------------------------------

    case 'GUEST_MODE_STARTED': {
      console.log(`[Worker] Guest mode started: ${message.data.guestSessionId}`);
      if (tabId) {
        // Store guest mode state for this tab
        const existing = proctoredTabs.get(tabId) || {};
        proctoredTabs.set(tabId, {
          ...existing,
          guestMode: true,
          guestSessionId: message.data.guestSessionId,
        });
      }
      sendResponse({ status: 'ok' });
      break;
    }

    case 'GUEST_MODE_STOPPED': {
      console.log(`[Worker] Guest mode stopped for tab ${tabId}`);
      if (tabId) {
        const existing = proctoredTabs.get(tabId);
        if (existing) {
          existing.guestMode = false;
          existing.guestSessionId = null;
        }
      }
      sendResponse({ status: 'ok' });
      break;
    }

    case 'GET_PROCTOR_STATE': {
      sendResponse({
        status: 'ok',
        proctoredTabs: Object.fromEntries(proctoredTabs),
        violationCount: globalViolationCount,
      });
      break;
    }

    // -----------------------------------------------------------------------
    // Default
    // -----------------------------------------------------------------------

    default: {
      console.log(`[Worker] Unknown message type: ${message.type}`);
      sendResponse({ status: 'unknown_type' });
      break;
    }
  }

  // Return true to keep the message channel open for async sendResponse
  return true;
});

// ---------------------------------------------------------------------------
// Tab Cleanup — Remove proctored tab state when the tab is closed
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  if (proctoredTabs.has(tabId)) {
    console.log(`[Worker] Proctored tab ${tabId} was closed. Cleaning up.`);
    proctoredTabs.delete(tabId);
  }
});

// ---------------------------------------------------------------------------
// Startup — Flush offline violation queue
// ---------------------------------------------------------------------------

chrome.runtime.onStartup.addListener(() => {
  console.log('[Worker] Extension startup — checking for queued violations.');
  // The content scripts will handle flushing their own queues via storage
  // when they next run. We just clear the badge state.
  updateBadge('idle');
});

// ---------------------------------------------------------------------------
// Install / Update
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[Worker] Extension ${details.reason}:`, details);
  updateBadge('idle');
});
