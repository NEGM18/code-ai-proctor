// =============================================================================
// Popup Control Script — AI Observer Extension (100% Extension Native)
// Handles student/teacher login, role switching, session management, live roster
// tracking with timing audit badges, direct CSV export, and incident snapshot gallery.
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {
  // ---------------------------------------------------------------------------
  // Element References
  // ---------------------------------------------------------------------------

  const badgeStatus = document.getElementById('badge-status');

  // Views
  const loginView = document.getElementById('login-view');
  const studentControlView = document.getElementById('student-control-view');
  const guestControlView = document.getElementById('guest-control-view');
  const guestStopBtn = document.getElementById('guest-stop-btn');
  const emailInput = document.getElementById('email-input');
  const passwordInput = document.getElementById('password-input');
  const loginBtn = document.getElementById('login-btn');
  const loginError = document.getElementById('login-error');

  // Student Controls
  const studentNameDisplay = document.getElementById('student-name-display');
  const studentIdDisplay = document.getElementById('student-id-display');
  const sessionCodeInput = document.getElementById('session-code-input');
  const universityIdGroup = document.getElementById('university-id-group');
  const universityIdInput = document.getElementById('university-id-input');
  const codePolicyHint = document.getElementById('code-policy-hint');
  const chkCamera = document.getElementById('chk-camera');
  const chkScreen = document.getElementById('chk-screen');
  const chkFullscreen = document.getElementById('chk-fullscreen');
  const providerBadge = document.getElementById('provider-badge');
  const providerLabel = document.getElementById('provider-label');
  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const logoutBtn = document.getElementById('logout-btn');
  const controlError = document.getElementById('control-error');

  if (guestStopBtn) {
    guestStopBtn.addEventListener('click', () => {
      chrome.storage.local.set({ guestMode: false, proctoringActive: false, guestSessionId: null }, () => {
        showLoginView();
      });
    });
  }

  // Initial State Restoration
  // ---------------------------------------------------------------------------

  chrome.storage.local.get(
    ['isLoggedIn', 'userRole', 'studentName', 'studentId',
     'proctoringActive', 'sessionCode', 'guestMode', 'guestSessionId',
     'sbAccessToken', 'sbRefreshToken', 'sbUserId'],
    (data) => {
      window.SafeTestSupabase?.restoreSession(data);

      if (data.guestMode || (data.proctoringActive && data.guestSessionId)) {
        showGuestView();
      } else if (data.isLoggedIn) {
        showStudentView(data.studentName, data.studentId);
        if (data.sessionCode) sessionCodeInput.value = data.sessionCode;
        if (data.proctoringActive) setProctoringActiveUI();
        else setProctoringInactiveUI();
      } else {
        showLoginView();
      }
    }
  );

  function showGuestView() {
    loginView.classList.remove('active');
    studentControlView.classList.remove('active');
    if (guestControlView) guestControlView.classList.add('active');
    badgeStatus.innerText = 'GUEST DEMO ACTIVE';
    badgeStatus.className = 'badge active';
  }


  // ---------------------------------------------------------------------------
  // Login Handler
  // ---------------------------------------------------------------------------

  loginBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      showError(loginError, 'Please enter both email and password.');
      return;
    }

    loginBtn.disabled = true;
    loginBtn.innerText = 'Signing in...';
    clearError(loginError);

    await loginAsStudent(email, password);
  });

  /**
   * Sign in against Supabase Auth.
   *
   * ⚠ THE IDENTITY IS NOW SHARED WITH THE WEBSITE. `/api/student/login` returned
   * a `student_id` string that existed only in the FastAPI database, so an
   * account created on the teacher site and a login here were two unrelated
   * records that merely looked alike. `studentId` below is the `auth.users` UUID
   * — the same id `public.profiles` hangs off and the same id every RLS policy
   * on violations and proctor_sessions compares against.
   *
   * ⚠ WRONG PASSWORD AND SERVER DOWN GET DIFFERENT MESSAGES. The old code said
   * "Cannot connect to server. Check Server URL." for both, which sent students
   * to fiddle with a URL when they had simply mistyped a password.
   */
  async function loginAsStudent(email, password) {
    const rest = window.SafeTestSupabase;
    if (!rest) {
      showError(loginError, 'Extension is missing its auth module. Reload the extension.');
      resetLoginButton();
      return;
    }

    const result = await rest.signIn(email, password);

    if (!result.ok) {
      showError(loginError, result.reason === rest.REASON.UNREACHABLE
        ? 'Cannot reach the authentication service. Check your connection.'
        : (result.error || 'Incorrect email or password.'));
      resetLoginButton();
      return;
    }

    // full_name/role come from the profile row the sign-up trigger populated.
    // A missing profile is not fatal — the session is valid either way — so the
    // display falls back to the email rather than blocking on it.
    const profile = await rest.fetchProfile();
    const fullName = (profile && profile.full_name) || email;

    chrome.storage.local.set({
      isLoggedIn: true,
      userRole: (profile && profile.role) || 'student',
      studentName: fullName,
      studentId: result.userId,
      studentEmail: email,
    }, () => {
      showStudentView(fullName, result.userId);
      checkMediaPermissions();
      detectGPUProvider();
    });
  }

  function resetLoginButton() {
    loginBtn.disabled = false;
    loginBtn.innerText = 'Sign In';
  }



  // ---------------------------------------------------------------------------
  // Student Handlers & GPU Detection
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // ProctorCode policy lookup
  //
  // ⚠ AN UNKNOWN POLICY IS NOT "NO POLICY". If the lookup fails — offline, token
  // expired, server down — `requireStudentId` stays at its last known value and
  // the hint says the policy could not be read. Defaulting a failed lookup to
  // `false` would let a network blip silently drop a field the institution
  // requires, and the sitting would proceed looking perfectly normal.
  // ---------------------------------------------------------------------------
  let requireStudentId = false;
  let policyKnown = false;

  function setPolicyHint(message, isError) {
    if (!codePolicyHint) return;
    codePolicyHint.innerText = message || '';
    codePolicyHint.style.display = message ? 'block' : 'none';
    codePolicyHint.style.color = isError ? '' : '#94a3b8';
  }

  async function refreshCodePolicy() {
    const code = sessionCodeInput.value.trim();
    if (!code) {
      requireStudentId = false;
      policyKnown = false;
      universityIdGroup.style.display = 'none';
      setPolicyHint('', false);
      return;
    }

    const rest = window.SafeTestSupabase;
    if (!rest || !rest.signedIn) return;

    const result = await rest.fetchProctorCode(code);

    if (!result.ok) {
      policyKnown = false;
      setPolicyHint('Could not verify this code right now.', true);
      return;   // ⚠ leave requireStudentId as-is; do NOT relax it
    }
    if (!result.code) {
      requireStudentId = false;
      policyKnown = true;
      universityIdGroup.style.display = 'none';
      setPolicyHint('No sitting found for that code yet.', false);
      return;
    }

    policyKnown = true;
    requireStudentId = result.code.require_student_id === true;
    universityIdGroup.style.display = requireStudentId ? '' : 'none';
    setPolicyHint(
      requireStudentId ? 'This sitting requires your university student ID.' : '',
      false,
    );
  }

  sessionCodeInput.addEventListener('change', () => { void refreshCodePolicy(); });
  sessionCodeInput.addEventListener('blur', () => { void refreshCodePolicy(); });

  startBtn.addEventListener('click', async () => {
    const sessionCode = sessionCodeInput.value.trim();
    const universityId = universityIdInput ? universityIdInput.value.trim() : '';

    // Re-check right before starting, in case the code was typed and the field
    // never lost focus.
    if (!policyKnown) await refreshCodePolicy();

    if (requireStudentId && !universityId) {
      showError(controlError, 'This sitting requires your university student ID.');
      universityIdGroup.style.display = '';
      universityIdInput.focus();
      return;
    }

    if (!sessionCode) {
      showError(controlError, 'Please enter a proctoring session code.');
      return;
    }

    clearError(controlError);
    startBtn.disabled = true;
    startBtn.innerText = 'Requesting permissions...';

    try {
      const cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
      cameraStream.getTracks().forEach((track) => track.stop());
      setChecklistVerified(chkCamera, true);
    } catch (err) {
      showError(controlError, 'Camera permission is required.');
      startBtn.disabled = false;
      startBtn.innerText = 'Start Proctoring';
      return;
    }

    chrome.storage.local.get(['studentId', 'studentName'], (stData) => {
      chrome.storage.local.set({
        proctoringActive: true,
        sessionCode: sessionCode,
        // ⚠ NO 'STU-100' FALLBACK ANY MORE. student_id is a uuid foreign key to
        // auth.users now, so an invented placeholder is not a degraded value —
        // it is a value the database will reject outright. If we somehow got
        // here without a real id, recording nothing is correct.
        studentId: stData.studentId || null,
        studentName: stData.studentName || null,
        // Empty string would write '' into a nullable text column, which reads
        // as "they gave us a blank ID" rather than "none was asked for".
        studentUniversityId: universityId || null,
      }, () => {
        setProctoringActiveUI();
        startBtn.disabled = false;
        startBtn.innerText = 'Start Proctoring';
      });
    });
  });

  stopBtn.addEventListener('click', () => {
    chrome.storage.local.set({ proctoringActive: false }, () => {
      setProctoringInactiveUI();
    });
  });

  logoutBtn.addEventListener('click', () => performLogout());

  function performLogout() {
    // Clear the tokens too. Leaving a valid access/refresh pair in storage after
    // a logout means the next person to open this browser profile is still
    // authenticated as the student who signed out.
    window.SafeTestSupabase?.clearSession();
    chrome.storage.local.set({
      proctoringActive: false,
      isLoggedIn: false,
      userRole: null,
      studentName: null,
      studentId: null,
      sbAccessToken: null,
      sbRefreshToken: null,
      sbUserId: null,
    }, () => {
      showLoginView();
    });
  }

  function showLoginView() {
    loginView.classList.add('active');
    studentControlView.classList.remove('active');
    if (guestControlView) guestControlView.classList.remove('active');
    badgeStatus.innerText = 'Disconnected';
    badgeStatus.className = 'badge';
    loginBtn.disabled = false;
    loginBtn.innerText = 'Sign In';
  }

  function showStudentView(name, id) {
    loginView.classList.remove('active');
    studentControlView.classList.add('active');
    studentNameDisplay.innerText = name;
    studentIdDisplay.innerText = `Student ID: ${id}`;
    checkMediaPermissions();
    detectGPUProvider();
  }

  function setProctoringActiveUI() {
    startBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
    badgeStatus.innerText = 'PROCTOR ACTIVE';
    badgeStatus.className = 'badge active';
    setChecklistVerified(chkCamera, true);
    setChecklistVerified(chkScreen, true);
    setChecklistVerified(chkFullscreen, true);
  }

  function setProctoringInactiveUI() {
    startBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
    badgeStatus.innerText = 'Ready';
    badgeStatus.className = 'badge';
    setChecklistVerified(chkCamera, false);
    setChecklistVerified(chkScreen, false);
    setChecklistVerified(chkFullscreen, false);
    checkMediaPermissions();
  }

  function setChecklistVerified(element, verified) {
    if (!element) return;
    if (verified) {
      element.classList.add('verified');
      element.querySelector('.chk-icon').innerText = '✓';
    } else {
      element.classList.remove('verified');
      element.querySelector('.chk-icon').innerText = '✕';
    }
  }

  async function checkMediaPermissions() {
    try {
      const result = await navigator.permissions.query({ name: 'camera' });
      setChecklistVerified(chkCamera, result.state === 'granted');
    } catch {
      setChecklistVerified(chkCamera, false);
    }
  }

  async function detectGPUProvider() {
    if (!providerBadge || !providerLabel) return;
    try {
      if (navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) {
          const info = await adapter.requestAdapterInfo?.();
          const gpuName = info?.device || info?.description || 'GPU';
          providerLabel.textContent = `WebGPU: ${gpuName}`;
          providerBadge.classList.add('webgpu');
          return;
        }
      }
    } catch {}
    providerLabel.textContent = 'WASM (CPU)';
    providerBadge.classList.add('wasm');
  }

  function showError(el, msg) {
    el.innerText = msg;
    el.style.display = 'block';
  }

  function clearError(el) {
    el.innerText = '';
    el.style.display = 'none';
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
});
