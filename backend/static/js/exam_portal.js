(function () {
  "use strict";

  const cfg = window.__PORTAL__ || {};
  const cheatThreshold = typeof cfg.cheatThreshold === "number" ? cfg.cheatThreshold : 0.5;
  const apiKeyRequired = !!cfg.apiKeyRequired;

  const $ = (id) => document.getElementById(id);

  let modelReady = false;

  async function refreshQuizModelHealth() {
    const banner = $("quizModelBanner");
    try {
      const h = await fetch("/health").then((r) => r.json());
      modelReady = !!h.model_configured;
      if (banner) {
        if (modelReady) {
          banner.hidden = true;
          banner.textContent = "";
          banner.className = "model-banner";
        } else {
          banner.hidden = false;
          banner.className = "model-banner error";
          banner.textContent =
            "No classifier weights found at " +
            (h.model_path || "(unknown)") +
            ". Run: python prepare_demo_weights.py — or train on your dataset (train_cheating_yolo.py), then restart uvicorn.";
        }
      }
    } catch (e) {
      modelReady = false;
      if (banner) {
        banner.hidden = false;
        banner.className = "model-banner error";
        banner.textContent = "Could not reach /health: " + e.message;
      }
    }
    return modelReady;
  }

  function apiKeyHeaders() {
    const h = {};
    if (apiKeyRequired) {
      const k = ($("apiKeyStore") && $("apiKeyStore").value.trim()) || localStorage.getItem("proctor_api_key") || "";
      if (k) h["X-API-Key"] = k;
    }
    return h;
  }

  function rememberApiKey() {
    const el = $("apiKeyStore");
    if (el && el.value.trim()) localStorage.setItem("proctor_api_key", el.value.trim());
  }

  async function jsonFetch(path, opts) {
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.detail || res.statusText || "Request failed");
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  /* ——— Tab navigation ——— */
  document.querySelectorAll("nav.tabs button[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-tab");
      document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const panel = document.querySelector('.panel[data-panel="' + tab + '"]');
      if (panel) panel.classList.add("active");
      if (tab === "quiz") refreshQuizModelHealth();
    });
  });

  function setMsg(id, text, cls) {
    const el = $(id);
    if (!el) return;
    el.textContent = text || "";
    el.className = "msg" + (cls ? " " + cls : "");
  }

  /* ——— Organization ——— */
  $("orgSignupForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    setMsg("orgSignupMsg", "Saving…", "");
    const body = {
      name: $("org_name").value.trim(),
      email: $("org_signup_email").value.trim(),
      password: $("org_signup_password").value,
      location: $("org_location").value.trim(),
      country: $("org_country").value.trim(),
      tax_id: $("org_tax_id").value.trim(),
      registration_number: $("org_reg").value.trim(),
      phone: $("org_phone").value.trim(),
      website: $("org_website").value.trim(),
    };
    try {
      await jsonFetch("/api/org/signup", { method: "POST", body: JSON.stringify(body) });
      setMsg("orgSignupMsg", "Organization registered. You can sign in below.", "ok");
      $("org_login_email").value = body.email;
    } catch (err) {
      setMsg("orgSignupMsg", String(err.body?.detail || err.message), "error");
    }
  });

  $("orgLoginBtn")?.addEventListener("click", async () => {
    setMsg("orgLoginMsg", "Signing in…", "");
    const email = $("org_login_email").value.trim();
    const password = $("org_login_password").value;
    try {
      const data = await jsonFetch("/api/org/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      sessionStorage.setItem("org_email", email);
      sessionStorage.setItem("org_password", password);
      $("orgSessionName").textContent = data.organization?.name || email;
      $("orgSessionCard").hidden = false;
      document.querySelectorAll(".org-mgmt").forEach((el) => {
        el.hidden = false;
      });
      setMsg("orgLoginMsg", "Signed in.", "ok");
      refreshOrgAccounts();
    } catch (err) {
      setMsg("orgLoginMsg", String(err.body?.detail || err.message), "error");
    }
  });

  $("orgLogoutBtn")?.addEventListener("click", () => {
    sessionStorage.removeItem("org_email");
    sessionStorage.removeItem("org_password");
    $("orgSessionCard").hidden = true;
    document.querySelectorAll(".org-mgmt").forEach((el) => {
      el.hidden = true;
    });
    $("orgAccountsOut").textContent = "{}";
    setMsg("orgLoginMsg", "Signed out.", "warn");
  });

  function orgCreds() {
    return {
      org_email: sessionStorage.getItem("org_email") || "",
      org_password: sessionStorage.getItem("org_password") || "",
    };
  }

  async function refreshOrgAccounts() {
    const c = orgCreds();
    if (!c.org_email) return;
    try {
      const data = await jsonFetch("/api/org/accounts", {
        method: "POST",
        body: JSON.stringify(c),
      });
      $("orgAccountsOut").textContent = JSON.stringify(data, null, 2);
    } catch (err) {
      $("orgAccountsOut").textContent = JSON.stringify(err.body || { error: err.message }, null, 2);
    }
  }

  $("orgRefreshAccounts")?.addEventListener("click", refreshOrgAccounts);

  $("teacherForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const c = orgCreds();
    if (!c.org_email) {
      setMsg("teacherMsg", "Sign in as organization first.", "error");
      return;
    }
    setMsg("teacherMsg", "Creating…", "");
    const body = Object.assign({}, c, {
      teacher_id: $("t_id").value.trim(),
      full_name: $("t_name").value.trim(),
      email: $("t_email").value.trim(),
      password: $("t_password").value,
      department: $("t_dept").value.trim(),
    });
    try {
      await jsonFetch("/api/org/teachers", { method: "POST", body: JSON.stringify(body) });
      setMsg("teacherMsg", "Teacher created.", "ok");
      refreshOrgAccounts();
    } catch (err) {
      setMsg("teacherMsg", String(err.body?.detail || err.message), "error");
    }
  });

  $("studentCreateForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const c = orgCreds();
    if (!c.org_email) {
      setMsg("studentCreateMsg", "Sign in as organization first.", "error");
      return;
    }
    setMsg("studentCreateMsg", "Creating…", "");
    const body = Object.assign({}, c, {
      student_id: $("s_id").value.trim(),
      full_name: $("s_name").value.trim(),
      email: $("s_email").value.trim(),
      password: $("s_password").value,
    });
    try {
      await jsonFetch("/api/org/students", { method: "POST", body: JSON.stringify(body) });
      setMsg("studentCreateMsg", "Student created.", "ok");
      refreshOrgAccounts();
    } catch (err) {
      setMsg("studentCreateMsg", String(err.body?.detail || err.message), "error");
    }
  });

  /* ——— Student ——— */
  let studentSession = { email: "", password: "" };
  window.allStudentQuizzes = [];

  window.openCourseDetail = function(className) {
      document.getElementById('coursesGridView').hidden = true;
      document.getElementById('courseDetailView').hidden = false;
      document.getElementById('detailCourseTitle').textContent = className;
      
      const quizList = document.getElementById("dashQuizzesListContainer");
      const filtered = window.allStudentQuizzes.filter(q => q.class_name === className);
      
      if (filtered.length > 0) {
          quizList.innerHTML = filtered.map(q => `
            <div style="padding:1rem;border:1px solid ${q.status==='completed'?'var(--border)':'var(--accent)'};border-radius:var(--radius-sm);background:rgba(255,255,255,0.02);display:flex;justify-content:space-between;align-items:center;">
              <div>
                <div style="font-weight:700;margin-bottom:0.15rem;color:${q.status==='completed'?'inherit':'var(--accent)'};font-size:1.1rem;">${q.quiz_title}</div>
                <div style="font-size:0.85rem;color:var(--text-secondary);">
                  ${q.question_count} Questions · ${q.time_limit_minutes ? q.time_limit_minutes + ' min' : 'No time limit'}
                </div>
              </div>
              <div>
              ${q.status === 'completed' 
                ? `<span class="tag" style="background:rgba(255,255,255,0.1);color:var(--text);margin-left:0;font-size:0.9rem;padding:0.4rem 0.8rem;">Score: ${q.score}/${q.total}</span>` 
                : `<a href="/quiz/${q.share_token}" target="_blank" style="display:inline-block;padding:0.5rem 1rem;border-radius:6px;background:var(--accent);color:#fff;font-size:0.9rem;font-weight:700">Take Quiz →</a>`
              }
              </div>
            </div>
          `).join("");
      } else {
          quizList.innerHTML = `<div class="empty-state" style="margin:0;"><div class="empty-icon">📝</div><p>No active quizzes</p></div>`;
      }
  };

  $("studentLoginBtn")?.addEventListener("click", async () => {
    setMsg("studentLoginMsg", "Signing in…", "");
    const email = $("stu_login_email").value.trim();
    const password = $("stu_login_password").value;
    try {
      const data = await jsonFetch("/api/student/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      studentSession = { email, password };
      sessionStorage.setItem("student_email", email);
      sessionStorage.setItem("student_password", password);
      $("studentFlowCard").hidden = false;
      $("studentWelcome").textContent = data.student?.full_name || email;
      updateStudentPanels(data.student);
      setMsg("studentLoginMsg", "Signed in.", "ok");
    } catch (err) {
      setMsg("studentLoginMsg", String(err.body?.detail || err.message), "error");
    }
  });

  $("studentLogoutBtn")?.addEventListener("click", () => {
    studentSession = { email: "", password: "" };
    sessionStorage.removeItem("student_email");
    sessionStorage.removeItem("student_password");
    $("studentFlowCard").hidden = true;
    setMsg("studentLoginMsg", "Signed out.", "warn");
  });

  function updateStudentPanels(student) {
    const must = student?.must_change_password;
    const face = student?.face_uploaded;
    $("panelChangePw").hidden = !must;
    $("panelFace").hidden = must || face;
    $("panelDash").hidden = must || !face;
    if (!must && face) loadDashboard();
  }

  $("changePwBtn")?.addEventListener("click", async () => {
    const email = studentSession.email || sessionStorage.getItem("student_email");
    const old_password = $("stu_old_pw").value;
    const new_password = $("stu_new_pw").value;
    setMsg("changePwMsg", "Updating…", "");
    try {
      await jsonFetch("/api/student/change-password", {
        method: "POST",
        body: JSON.stringify({ email, old_password, new_password }),
      });
      studentSession.password = new_password;
      sessionStorage.setItem("student_password", new_password);
      $("stu_login_password").value = new_password;
      const login = await jsonFetch("/api/student/login", {
        method: "POST",
        body: JSON.stringify({ email, password: new_password }),
      });
      updateStudentPanels(login.student);
      setMsg("changePwMsg", "Password updated.", "ok");
    } catch (err) {
      setMsg("changePwMsg", String(err.body?.detail || err.message), "error");
    }
  });

  $("faceUploadBtn")?.addEventListener("click", async () => {
    const f = $("faceFile").files[0];
    if (!f) {
      setMsg("faceMsg", "Choose an image.", "error");
      return;
    }
    const email = studentSession.email || sessionStorage.getItem("student_email");
    const password = studentSession.password || sessionStorage.getItem("student_password");
    setMsg("faceMsg", "Uploading…", "");
    const fd = new FormData();
    fd.append("file", f);
    try {
      const res = await fetch("/api/student/face", {
        method: "POST",
        headers: {
          "X-Student-Email": email,
          "X-Student-Password": password,
        },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.detail || res.statusText), { body: data });
      const login = await jsonFetch("/api/student/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      updateStudentPanels(login.student);
      setMsg("faceMsg", "Face image saved.", "ok");
    } catch (err) {
      setMsg("faceMsg", String(err.body?.detail || err.message), "error");
    }
  });

  async function loadDashboard() {
    const email = studentSession.email || sessionStorage.getItem("student_email");
    const password = studentSession.password || sessionStorage.getItem("student_password");
    setMsg("dashMsg", "Loading dashboard…", "");
    try {
      const data = await jsonFetch("/api/student/dashboard", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      
      const classList = $("dashClassesListContainer");
      if (data.classes && data.classes.length > 0) {
        const patterns = [
            'linear-gradient(135deg, rgba(13,110,253,0.3) 25%, rgba(10,88,202,0.3) 25%, rgba(10,88,202,0.3) 50%, rgba(13,110,253,0.3) 50%, rgba(13,110,253,0.3) 75%, rgba(10,88,202,0.3) 75%, rgba(10,88,202,0.3) 100%)',
            'linear-gradient(45deg, rgba(32,201,151,0.3) 25%, rgba(26,161,121,0.3) 25%, rgba(26,161,121,0.3) 50%, rgba(32,201,151,0.3) 50%, rgba(32,201,151,0.3) 75%, rgba(26,161,121,0.3) 75%, rgba(26,161,121,0.3) 100%)',
            'linear-gradient(135deg, rgba(111,66,193,0.3) 25%, rgba(89,53,154,0.3) 25%, rgba(89,53,154,0.3) 50%, rgba(111,66,193,0.3) 50%, rgba(111,66,193,0.3) 75%, rgba(89,53,154,0.3) 75%, rgba(89,53,154,0.3) 100%)',
            'linear-gradient(45deg, rgba(232,62,140,0.3) 25%, rgba(186,50,112,0.3) 25%, rgba(186,50,112,0.3) 50%, rgba(232,62,140,0.3) 50%, rgba(232,62,140,0.3) 75%, rgba(186,50,112,0.3) 75%, rgba(186,50,112,0.3) 100%)',
            'linear-gradient(135deg, rgba(253,126,20,0.3) 25%, rgba(202,101,16,0.3) 25%, rgba(202,101,16,0.3) 50%, rgba(253,126,20,0.3) 50%, rgba(253,126,20,0.3) 75%, rgba(202,101,16,0.3) 75%, rgba(202,101,16,0.3) 100%)'
        ];
        classList.innerHTML = data.classes.map((c, idx) => `
          <div style="background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; cursor:pointer; transition:transform 0.2s, box-shadow 0.2s; display:flex; flex-direction:column;" 
               onmouseover="this.style.transform='translateY(-4px)'; this.style.borderColor='var(--accent)';" 
               onmouseout="this.style.transform='none'; this.style.borderColor='var(--border)';"
               onclick="window.openCourseDetail('${c.class_name.replace(/'/g, "\\'")}')">
            <div style="height:120px; background-image: ${patterns[idx % patterns.length]}; background-size: 40px 40px;"></div>
            <div style="padding:1.5rem; flex-grow:1; display:flex; flex-direction:column;">
                <div style="font-size:1.2rem; font-weight:700; color:#fff; margin-bottom:0.25rem;">${c.class_name}</div>
                <div style="font-size:0.85rem; color:var(--text-secondary);">Spring 25-26</div>
                <div style="margin-top:auto; padding-top:1rem; display:flex; justify-content:flex-end; color:var(--text-secondary); font-weight:bold; letter-spacing:2px;">⋮</div>
            </div>
          </div>
        `).join("");
      } else {
        classList.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1;"><div class="empty-icon">📚</div><p>No classes joined</p></div>`;
      }
      
      window.allStudentQuizzes = data.upcoming_quizzes || [];
      
      setMsg("dashMsg", "", "");
    } catch (err) {
      setMsg("dashMsg", String(err.body?.detail || err.message), "error");
    }
  }

  $("dashRefreshBtn")?.addEventListener("click", loadDashboard);

  $("joinClassBtn")?.addEventListener("click", async () => {
    const code = $("join_code").value.trim().toUpperCase();
    const pw = $("join_pw").value;
    if (!code || !pw) {
      setMsg("joinClassMsg", "Enter code and password.", "error");
      return;
    }
    const email = studentSession.email || sessionStorage.getItem("student_email");
    const password = studentSession.password || sessionStorage.getItem("student_password");
    setMsg("joinClassMsg", "Joining…", "");
    try {
      await jsonFetch("/api/student/join-class", {
        method: "POST",
        body: JSON.stringify({ email, password, class_code: code, class_password: pw }),
      });
      setMsg("joinClassMsg", "Successfully joined class!", "ok");
      $("join_code").value = "";
      $("join_pw").value = "";
      loadDashboard();
      setTimeout(() => { $("studentJoinClassCard").hidden = true; setMsg("joinClassMsg","",""); }, 2000);
    } catch (err) {
      setMsg("joinClassMsg", String(err.body?.detail || err.message), "error");
    }
  });

  /* ——— Quiz / webcam (10-frame buffered inference) ——— */
  const BUFFER_SIZE = 4;
  const video = $("quizVideo");
  const canvas = $("quizCanvas");
  let stream = null;
  let timer = null;
  const snapshots = [];
  let frameBuffer = [];        // JPEG blobs waiting for batch send
  let batchInFlight = false;   // guard: don't overlap network requests

  /**
   * Capture a single 640×640 JPEG blob from the webcam and push it to the
   * frame buffer.  When the buffer reaches BUFFER_SIZE the batch is sent.
   */
  function captureFrame() {
    if (!video.videoWidth) return;

    const ctx = canvas.getContext("2d");
    // Centre-crop to a square matching the model's training resolution.
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const side = Math.min(vw, vh);
    const sx = Math.round((vw - side) / 2);
    const sy = Math.round((vh - side) / 2);
    const TARGET = 640;
    canvas.width = TARGET;
    canvas.height = TARGET;
    ctx.drawImage(video, sx, sy, side, side, 0, 0, TARGET, TARGET);

    canvas.toBlob(
      function (blob) {
        if (!blob) return;
        frameBuffer.push(blob);

        // Update the buffer progress indicator.
        const el = $("bufferProgress");
        if (el) el.textContent = "Buffering frame " + frameBuffer.length + "/" + BUFFER_SIZE + "…";

        if (frameBuffer.length >= BUFFER_SIZE && !batchInFlight) {
          sendBatch();
        }
      },
      "image/jpeg",
      0.88
    );
  }

  /**
   * POST the entire frame buffer to /api/predict_batch, display the
   * aggregated verdict, and (if alert) add the best snapshot to the gallery.
   */
  async function sendBatch() {
    if (batchInFlight) return;
    batchInFlight = true;

    // Grab the current buffer and clear it immediately so new captures
    // start filling a fresh window.
    const batch = frameBuffer.splice(0, frameBuffer.length);
    const t0 = performance.now();

    try {
      const fd = new FormData();
      batch.forEach(function (blob, i) {
        fd.append("files", blob, "frame_" + i + ".jpg");
      });

      const email = sessionStorage.getItem("student_email");
      const headers = Object.assign({}, apiKeyHeaders());
      if (email) headers["X-User-Email"] = email;
      headers["X-Client-Reference"] = "exam-portal-quiz-batch";

      const res = await fetch("/api/predict_batch", { method: "POST", body: fd, headers: headers });
      const data = await res.json().catch(function () { return {}; });

      if (!res.ok) {
        setMsg("quizMsg", String(data.detail || res.statusText), "error");
        if (res.status === 503) await refreshQuizModelHealth();
        return;
      }

      // --- Update UI with aggregated results ---
      const avgP = data.avg_cheat_probability ?? 0;
      const maxP = data.max_cheat_probability ?? 0;

      $("cheatProbText").textContent = avgP.toFixed(4);
      $("cheatMeter").style.width = Math.min(100, avgP * 100) + "%";

      const ms = Math.round(performance.now() - t0);
      $("quizMeta").textContent =
        "window=" + (data.window_size || batch.length) +
        "  avg=" + avgP.toFixed(3) +
        "  max=" + maxP.toFixed(3) +
        "  threshold=" + cheatThreshold +
        (data.alert ? "  ALERT" : "") +
        "  " + ms + "ms";

      if (data.alert) {
        setMsg("quizMsg", "ALERT — cheating detected in this window", "error");
      } else {
        setMsg("quizMsg", "Live — batched inference (" + BUFFER_SIZE + "-frame window)", "ok");
      }

      // Add the single best snapshot if alert was triggered.
      if (data.alert && data.best_snapshot_b64) {
        const url = "data:image/jpeg;base64," + data.best_snapshot_b64;
        snapshots.unshift({
          url: url,
          t: data.timestamp,
          avgP: avgP.toFixed(4),
          maxP: maxP.toFixed(4),
        });
        renderSnapshots();
      }
    } catch (e) {
      setMsg("quizMsg", "Batch predict failed: " + e.message, "error");
    } finally {
      batchInFlight = false;
      // Reset progress indicator for next window.
      const el = $("bufferProgress");
      if (el) el.textContent = "";
    }
  }

  $("quizStartBtn")?.addEventListener("click", async () => {
    rememberApiKey();
    await refreshQuizModelHealth();
    if (!modelReady) {
      setMsg("quizMsg", "Weights missing — fix the banner above, then try again.", "error");
      return;
    }
    if (apiKeyRequired && !apiKeyHeaders()["X-API-Key"]) {
      setMsg("quizMsg", "Set your proctor API key in the field above (required on this server).", "error");
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      $("badgeLive").classList.add("on");
      setMsg("quizMsg", "Live — batched inference (" + BUFFER_SIZE + "-frame window)", "ok");
      const intervalMs = Math.max(400, parseInt($("quizInterval")?.value || "1000", 10) || 1000);
      if (timer) clearInterval(timer);
      frameBuffer = [];
      timer = window.setInterval(captureFrame, intervalMs);
    } catch (err) {
      setMsg("quizMsg", "Camera error: " + err.message, "error");
    }
  });

  $("quizStopBtn")?.addEventListener("click", () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    video.srcObject = null;
    $("badgeLive").classList.remove("on");
    // Clear the frame buffer to free memory.
    frameBuffer = [];
    setMsg("quizMsg", "Stopped.", "warn");
    const el = $("bufferProgress");
    if (el) el.textContent = "";
  });

  function renderSnapshots() {
    const root = $("snapshotGallery");
    root.innerHTML = "";
    snapshots.slice(0, 24).forEach((s) => {
      const wrap = document.createElement("div");
      wrap.className = "snapshot-item";
      const img = document.createElement("img");
      img.src = s.url;
      img.className = "alert";
      img.title = (s.t || "") + (s.avgP ? " avg=" + s.avgP + " max=" + s.maxP : "");
      wrap.appendChild(img);
      root.appendChild(wrap);
    });
  }

  $("clearSnapshotsBtn")?.addEventListener("click", () => {
    // No need to revoke data: URLs (only object URLs need revoking).
    snapshots.length = 0;
    renderSnapshots();
  });

  /* Restore sessions on load */
  window.addEventListener("DOMContentLoaded", () => {
    refreshQuizModelHealth();
    if ($("apiKeyStore") && localStorage.getItem("proctor_api_key")) {
      $("apiKeyStore").value = localStorage.getItem("proctor_api_key");
    }
    const oe = sessionStorage.getItem("org_email");
    const op = sessionStorage.getItem("org_password");
    if (oe && op) {
      $("org_login_email").value = oe;
      $("org_login_password").value = op;
    }
    const se = sessionStorage.getItem("student_email");
    const sp = sessionStorage.getItem("student_password");
    if (se && sp) {
      $("stu_login_email").value = se;
      $("stu_login_password").value = sp;
    }
  });
})();
