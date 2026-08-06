// =============================================================================
// LMS Detector Module — AI Observer Extension
// Detects the current LMS platform, quiz pages, and tracks quiz opening timing.
// =============================================================================

/**
 * @typedef {'canvas'|'moodle'|'blackboard'|'google_classroom'|'d2l'|'generic'} LMSPlatform
 * @typedef {'student'|'teacher'|'unknown'} UserRole
 */

// Global timestamp of when the student opened the current quiz page
let quizOpenedAtIso = null;
// Guards against re-entrant stamping while the storage read is in flight.
let quizStampPending = false;

/**
 * LMS URL pattern definitions.
 */
const LMS_PATTERNS = {
  canvas: [
    (url) => /\.instructure\.com/i.test(url),
    (url) => /\/courses\/\d+/i.test(url) && /canvas/i.test(url),
  ],
  moodle: [
    (url) => /\/mod\/quiz\//i.test(url),
    (url) => /\/moodle\//i.test(url),
    (url) => /moodle\./i.test(url),
  ],
  blackboard: [
    (url) => /\.blackboard\.com/i.test(url),
    (url) => /blackboard/i.test(url) && /\/ultra\//i.test(url),
    (url) => /\/webapps\/assessment/i.test(url),
  ],
  google_classroom: [
    (url) => /classroom\.google\.com/i.test(url),
  ],
  d2l: [
    (url) => /\.brightspace\.com/i.test(url),
    (url) => /\/d2l\//i.test(url),
  ],
};

/**
 * Quiz/assessment URL patterns that indicate a test is in progress.
 */
const QUIZ_PATTERNS = [
  /quiz/i, // Any URL containing the word "quiz" (path, query, or host) is treated as a quiz page
  /\/demo-quiz/i,
  /\/demo/i,
  /\/courses\/\d+\/quizzes\/\d+/i,
  /\/courses\/\d+\/assignments\/\d+/i,
  /\/mod\/quiz\/attempt\.php/i,
  /\/mod\/quiz\/view\.php/i,
  /\/webapps\/assessment\/take/i,
  /\/ultra\/courses\/.*\/assessments/i,
  /docs\.google\.com\/forms/i,
  /\/d2l\/lms\/quizzing/i,
  /[?&]attempt=/i,
  /\/exam\//i,
  /\/test\//i,
  /\/assessment\//i,
];

/**
 * Detect the current LMS platform from the page URL.
 * @returns {LMSPlatform}
 */
function detectLMSPlatform() {
  const url = window.location.href;
  for (const [platform, tests] of Object.entries(LMS_PATTERNS)) {
    for (const testFn of tests) {
      if (testFn(url)) return /** @type {LMSPlatform} */ (platform);
    }
  }
  return 'generic';
}

/**
 * Check whether the current page URL matches a known quiz/assessment pattern.
 * If active, records the ISO timestamp when the quiz was opened.
 * @returns {boolean}
 */
function detectQuizActive() {
  const url = window.location.href;
  const isQuiz = QUIZ_PATTERNS.some((pattern) => pattern.test(url));

  if (isQuiz && !quizOpenedAtIso && !quizStampPending) {
    quizStampPending = true;
    const candidate = new Date().toISOString();

    // Stamp ONCE per session, not once per page.
    //
    // A paginated quiz (Moodle attempt.php in particular) does a FULL page
    // navigation per question, and each one creates a fresh content-script
    // instance with quizOpenedAtIso === null. Unconditionally re-stamping here
    // overwrote the stored value on every page, so the timing baseline kept
    // moving forward to match and LATE_PROCTORING_STARTED could never fire
    // after page one. Adopt the existing stamp when there is one.
    chrome.storage.local.get(['quizOpenedAtIso'], (data) => {
      quizStampPending = false;
      if (data && data.quizOpenedAtIso) {
        quizOpenedAtIso = data.quizOpenedAtIso;
        console.log('[AI Observer] Adopted existing quiz-open timestamp:', quizOpenedAtIso);
        return;
      }
      quizOpenedAtIso = candidate;
      console.log('[AI Observer] Quiz page opened timestamp recorded:', quizOpenedAtIso);
      chrome.storage.local.set({ quizOpenedAtIso: candidate });
    });
  }

  return isQuiz;
}

/**
 * Get the timestamp when the quiz page was opened (if any).
 * @returns {string|null}
 */
function getQuizOpenedTimestamp() {
  return quizOpenedAtIso;
}

/**
 * Read the user's role from chrome.storage.local.
 * @returns {Promise<{role: UserRole, teacherId: number|null, studentId: string|null}>}
 */
async function detectUserRole() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ['userRole', 'teacherId', 'studentId', 'isLoggedIn'],
      (data) => {
        if (!data.isLoggedIn) {
          resolve({ role: 'unknown', teacherId: null, studentId: null });
          return;
        }
        const role = data.userRole || 'unknown';
        resolve({
          role: /** @type {UserRole} */ (role),
          teacherId: data.teacherId || null,
          studentId: data.studentId || null,
        });
      }
    );
  });
}

/**
 * Get full LMS context for the current page.
 * @returns {Promise<{lms: LMSPlatform, role: UserRole, quizActive: boolean, quizOpenedAtIso: string|null, teacherId: number|null, studentId: string|null, pageUrl: string}>}
 */
async function getLMSContext() {
  const lms = detectLMSPlatform();
  const quizActive = detectQuizActive();
  const { role, teacherId, studentId } = await detectUserRole();

  const context = {
    lms,
    role,
    quizActive,
    quizOpenedAtIso,
    teacherId,
    studentId,
    pageUrl: window.location.href,
  };

  console.log('[AI Observer] LMS Context:', context);
  return context;
}

// Initial auto-detection on script load
detectQuizActive();

// ---------------------------------------------------------------------------
// Export to window for cross-script communication
// ---------------------------------------------------------------------------
window.detectLMSPlatform = detectLMSPlatform;
window.detectQuizActive = detectQuizActive;
window.getQuizOpenedTimestamp = getQuizOpenedTimestamp;
window.detectUserRole = detectUserRole;
window.getLMSContext = getLMSContext;
