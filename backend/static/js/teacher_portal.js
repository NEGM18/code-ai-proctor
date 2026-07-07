(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let teacherSession = { email: "", password: "", data: null };

  function setMsg(id, text, cls) {
    const el = $(id);
    if (!el) return;
    el.textContent = text || "";
    el.className = "msg" + (cls ? " " + cls : "");
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

  /* ——— Sub-tab navigation ——— */
  document.querySelectorAll("nav.tabs button[data-teacher-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("nav.tabs button[data-teacher-tab]").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".teacher-sub").forEach((p) => {
        p.classList.remove("active");
        p.style.display = "none";
      });
      btn.classList.add("active");
      const panel = document.querySelector('.teacher-sub[data-teacher-panel="' + btn.dataset.teacherTab + '"]');
      if (panel) {
        panel.classList.add("active");
        panel.style.display = "block";
      }
    });
  });

  /* ——— Teacher Login ——— */
  $("teacherLoginBtn")?.addEventListener("click", async () => {
    setMsg("teacherLoginMsg", "Signing in…", "");
    const email = $("tch_login_email").value.trim();
    const password = $("tch_login_password").value;
    try {
      const data = await jsonFetch("/api/teacher/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      teacherSession = { email, password, data: data.teacher };
      sessionStorage.setItem("teacher_email", email);
      sessionStorage.setItem("teacher_password", password);
      setMsg("teacherLoginMsg", "Signed in.", "ok");
      showTeacherDashboard();
    } catch (err) {
      setMsg("teacherLoginMsg", String(err.body?.detail || err.message), "error");
    }
  });

  $("teacherLogoutBtn")?.addEventListener("click", () => {
    teacherSession = { email: "", password: "", data: null };
    sessionStorage.removeItem("teacher_email");
    sessionStorage.removeItem("teacher_password");
    $("teacherDashboard").hidden = true;
    $("teacherLoginCard").hidden = false;
    setMsg("teacherLoginMsg", "Signed out.", "warn");
  });

  async function showTeacherDashboard() {
    $("teacherLoginCard").hidden = true;
    $("teacherDashboard").hidden = false;
    await loadTeacherDashboard();
  }

  window._teacherDashLoaded = true;

  async function loadTeacherDashboard() {
    const { email, password } = teacherSession;
    if (!email) return;
    try {
      const data = await jsonFetch("/api/teacher/dashboard", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      $("statClasses").textContent = (data.classes || []).length;
      $("statQuizzes").textContent = (data.quizzes || []).length;
      $("statAlerts").textContent = data.notification_count || 0;
      if (data.notification_count > 0) {
        $("notifBadge").hidden = false;
        $("notifBadge").textContent = data.notification_count;
      } else {
        $("notifBadge").hidden = true;
      }
      // If teacher_detail.js is active, delegate rendering to it
      if (typeof window._teacherStoreData === "function") {
        window._teacherStoreData(data.classes || [], data.quizzes || [], data.notification_count || 0);
      } else {
        renderClassesList(data.classes || []);
      }
      renderQuizzesList(data.quizzes || []);
      populateQuizClassDropdown(data.classes || []);
      populateGradeQuizDropdown(data.quizzes || []);
    } catch (err) {
      console.error("Dashboard load failed:", err);
    }
  }

  /* ——— Classes ——— */
  function renderClassesList(classes) {
    const container = $("classesListContainer");
    if (!classes.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">📚</div><p>No classes yet</p></div>';
      return;
    }
    container.innerHTML = classes.map((c) => `
      <div class="question-item">
        <div class="q-number">${c.name}</div>
        <div style="display:flex;gap:1.5rem;flex-wrap:wrap;font-size:0.85rem;color:var(--text-secondary)">
          <span>Code: <strong style="color:var(--accent);font-family:monospace;font-size:1rem">${c.class_code}</strong></span>
          <span>Password: <strong style="color:var(--text)">${c.password}</strong></span>
          <span>Students: <strong style="color:var(--text)">${c.student_count}</strong></span>
        </div>
      </div>
    `).join("");
  }

  $("createClassBtn")?.addEventListener("click", async () => {
    const name = $("cls_name").value.trim();
    const password = $("cls_password").value.trim();
    if (!name || !password) { setMsg("classCreateMsg", "Fill in all fields.", "error"); return; }
    setMsg("classCreateMsg", '<span class="spinner"></span> Creating…', "");
    try {
      const data = await jsonFetch("/api/teacher/classes", {
        method: "POST",
        body: JSON.stringify({
          teacher_email: teacherSession.email,
          teacher_password: teacherSession.password,
          name, password,
        }),
      });
      setMsg("classCreateMsg", `Class created! Code: ${data.class_code}`, "ok");
      $("cls_name").value = "";
      $("cls_password").value = "";
      loadTeacherDashboard();
    } catch (err) {
      setMsg("classCreateMsg", String(err.body?.detail || err.message), "error");
    }
  });

  /* ——— Quizzes ——— */
  function populateQuizClassDropdown(classes) {
    const sel = $("quiz_class_id");
    if (!sel) return;
    sel.innerHTML = '<option value="">— Select class —</option>' +
      classes.map((c) => `<option value="${c.id}">${c.name} (${c.class_code})</option>`).join("");
  }

  let activeQuizId = null;

  function renderQuizzesList(quizzes) {
    const container = $("quizzesListContainer");
    if (!quizzes.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">📝</div><p>No quizzes yet</p></div>';
      return;
    }
    container.innerHTML = quizzes.map((q) => `
      <div class="question-item">
        <div class="q-number">${q.title} <span class="tag">${q.question_count} Q</span></div>
        <div style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:0.5rem">
          ${q.class_name} · ${q.time_limit_minutes ? q.time_limit_minutes + " min" : "No time limit"}
          ${q.start_time ? " · Starts: " + new Date(q.start_time).toLocaleString() : ""}
          ${q.end_time ? " · Ends: " + new Date(q.end_time).toLocaleString() : ""}
          ${q.description ? " · " + q.description : ""}
        </div>
        <div class="row-actions" style="margin-top:0.35rem">
          <button class="ghost" onclick="window._teacherCopyLink('${q.id}')">Copy Link</button>
          <button class="ghost" onclick="window._teacherAddQuestions(${q.id}, '${q.title.replace(/'/g, "\\'")}')">Add Questions</button>
          <button class="ghost" onclick="window._teacherDeleteQuiz(${q.id}, '${q.title.replace(/'/g, "\\'")}')" style="color:var(--error)">Delete</button>
        </div>
        <div id="quizLinkMsg_${q.id}" class="msg"></div>
      </div>
    `).join("");
  }

  window._teacherDeleteQuiz = async function (quizId, title) {
    if (!confirm(`Are you sure you want to completely delete the quiz "${title}" and all its associated questions and grades?`)) return;
    try {
      await jsonFetch(`/api/teacher/quizzes/${quizId}`, {
        method: "DELETE",
        body: JSON.stringify({ email: teacherSession.email, password: teacherSession.password })
      });
      loadTeacherDashboard();
    } catch (err) {
      alert("Delete failed: " + (err.body?.detail || err.message));
    }
  };

  window._teacherCopyLink = async function (quizId) {
    try {
      const data = await jsonFetch(`/api/teacher/quizzes/${quizId}/link`, { method: "GET" });
      await navigator.clipboard.writeText(data.link);
      const msgEl = document.getElementById("quizLinkMsg_" + quizId);
      if (msgEl) { msgEl.textContent = "Copied: " + data.link; msgEl.className = "msg ok"; }
    } catch (err) {
      alert("Link: " + (err.body?.link || err.message));
    }
  };

  window._teacherAddQuestions = async function (quizId, title) {
    activeQuizId = quizId;
    $("addQuestionCard").hidden = false;
    $("questionQuizTitle").textContent = title;
    await refreshQuestionsList(quizId);
  };

  async function refreshQuestionsList(quizId) {
    try {
      const data = await jsonFetch(`/api/teacher/quizzes/${quizId}/questions`, { method: "GET" });
      const list = $("questionsList");
      list.innerHTML = (data.questions || []).map((q, i) => `
        <div class="question-item">
          <div class="q-number">Q${i + 1}</div>
          <p style="margin:0.25rem 0;font-size:0.9rem">${q.question_text}</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.25rem 1rem;font-size:0.82rem;color:var(--text-secondary);margin-top:0.35rem">
            <span${q.correct_option === "a" ? ' style="color:var(--success);font-weight:700"' : ""}>A: ${q.option_a}</span>
            <span${q.correct_option === "b" ? ' style="color:var(--success);font-weight:700"' : ""}>B: ${q.option_b}</span>
            <span${q.correct_option === "c" ? ' style="color:var(--success);font-weight:700"' : ""}>C: ${q.option_c}</span>
            <span${q.correct_option === "d" ? ' style="color:var(--success);font-weight:700"' : ""}>D: ${q.option_d}</span>
          </div>
          ${q.image_path ? '<img src="' + q.image_path + '" style="max-width:120px;margin-top:0.5rem;border-radius:8px;border:1px solid var(--border)" />' : ""}
        </div>
      `).join("");
    } catch (err) {
      console.error("Failed to load questions:", err);
    }
  }

  $("createQuizBtn")?.addEventListener("click", async () => {
    const class_id = parseInt($("quiz_class_id").value);
    const title = $("quiz_title").value.trim();
    if (!class_id || !title) { setMsg("quizCreateMsg", "Select a class and enter a title.", "error"); return; }
    setMsg("quizCreateMsg", "Creating…", "");
    try {
      const start_val = $("quiz_start_time").value;
      const end_val = $("quiz_end_time").value;
      
      const data = await jsonFetch("/api/teacher/quizzes", {
        method: "POST",
        body: JSON.stringify({
          teacher_email: teacherSession.email,
          teacher_password: teacherSession.password,
          class_id, title,
          description: $("quiz_desc").value.trim() || null,
          time_limit_minutes: parseInt($("quiz_time").value) || null,
          start_time: start_val ? start_val + ":00" : null,
          end_time: end_val ? end_val + ":00" : null,
        }),
      });
      setMsg("quizCreateMsg", `Quiz "${data.title}" created!`, "ok");
      $("quiz_title").value = "";
      $("quiz_desc").value = "";
      $("quiz_time").value = "";
      $("quiz_start_time").value = "";
      $("quiz_end_time").value = "";
      activeQuizId = data.quiz_id;
      $("addQuestionCard").hidden = false;
      $("questionQuizTitle").textContent = data.title;
      $("questionsList").innerHTML = "";
      loadTeacherDashboard();
    } catch (err) {
      setMsg("quizCreateMsg", String(err.body?.detail || err.message), "error");
    }
  });

  $("addQuestionBtn")?.addEventListener("click", async () => {
    if (!activeQuizId) { setMsg("questionAddMsg", "No quiz selected.", "error"); return; }
    const text = $("q_text").value.trim();
    const a = $("q_a").value.trim();
    const b = $("q_b").value.trim();
    const c = $("q_c").value.trim();
    const d = $("q_d").value.trim();
    const correct = $("q_correct").value;
    if (!text || !a || !b || !c || !d) { setMsg("questionAddMsg", "Fill in all fields.", "error"); return; }
    setMsg("questionAddMsg", "Adding…", "");
    const fd = new FormData();
    fd.append("teacher_email", teacherSession.email);
    fd.append("teacher_password", teacherSession.password);
    fd.append("question_text", text);
    fd.append("option_a", a);
    fd.append("option_b", b);
    fd.append("option_c", c);
    fd.append("option_d", d);
    fd.append("correct_option", correct);
    const imageFile = $("q_image")?.files[0];
    if (imageFile) fd.append("image", imageFile);
    try {
      const res = await fetch(`/api/teacher/quizzes/${activeQuizId}/questions`, { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.detail || "Failed"), { body: data });
      setMsg("questionAddMsg", "Question added!", "ok");
      $("q_text").value = "";
      $("q_a").value = "";
      $("q_b").value = "";
      $("q_c").value = "";
      $("q_d").value = "";
      $("q_image").value = "";
      await refreshQuestionsList(activeQuizId);
    } catch (err) {
      setMsg("questionAddMsg", String(err.body?.detail || err.message), "error");
    }
  });

  /* ——— Grades ——— */
  function populateGradeQuizDropdown(quizzes) {
    const sel = $("grade_quiz_select");
    if (!sel) return;
    sel.innerHTML = '<option value="">— Choose quiz —</option>' +
      quizzes.map((q) => `<option value="${q.id}">${q.title} (${q.class_name})</option>`).join("");
  }

  $("loadGradesBtn")?.addEventListener("click", async () => {
    const quizId = $("grade_quiz_select").value;
    if (!quizId) { setMsg("gradesMsg", "Select a quiz.", "error"); return; }
    setMsg("gradesMsg", "Loading…", "");
    try {
      const url = `/api/teacher/grades/${quizId}?teacher_email=${encodeURIComponent(teacherSession.email)}&teacher_password=${encodeURIComponent(teacherSession.password)}`;
      const data = await jsonFetch(url, { method: "GET" });
      renderGradesTable(data.grades || []);
      setMsg("gradesMsg", `${(data.grades || []).length} results loaded.`, "ok");
    } catch (err) {
      setMsg("gradesMsg", String(err.body?.detail || err.message), "error");
    }
  });

  function renderGradesTable(grades) {
    const card = $("gradesTableCard");
    const tbody = $("gradesBody");
    if (!grades.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    tbody.innerHTML = grades.map((g) => {
      const pct = g.percentage || 0;
      const cls = pct >= 80 ? "score-high" : pct >= 50 ? "score-mid" : "score-low";
      return `<tr>
        <td>${g.student_id}</td><td>${g.student_name}</td><td>${g.student_email}</td>
        <td>${g.score}/${g.total}</td><td class="${cls}">${pct}%</td>
        <td>${g.status}</td>
      </tr>`;
    }).join("");
  }

  $("exportGradesBtn")?.addEventListener("click", () => {
    const quizId = $("grade_quiz_select").value;
    if (!quizId) { setMsg("gradesMsg", "Select a quiz first.", "error"); return; }
    const url = `/api/teacher/grades/${quizId}/export?teacher_email=${encodeURIComponent(teacherSession.email)}&teacher_password=${encodeURIComponent(teacherSession.password)}`;
    window.open(url, "_blank");
  });

  /* ——— Notifications ——— */
  $("refreshNotifsBtn")?.addEventListener("click", loadNotifications);

  async function loadNotifications() {
    const { email, password } = teacherSession;
    if (!email) return;
    try {
      const data = await jsonFetch("/api/teacher/notifications", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      renderNotifications(data.notifications || []);
    } catch (err) {
      console.error("Notifications load failed:", err);
    }
  }

  function renderNotifications(notifs) {
    const container = $("notifsContainer");
    if (!notifs.length) {
      container.innerHTML = '<div class="card"><div class="empty-state"><div class="empty-icon">🔔</div><p>No cheating alerts yet</p></div></div>';
      return;
    }
    container.innerHTML = notifs.map((n) => `
      <div class="notif-item ${n.acknowledged ? "" : "unread"}">
        ${n.snapshot_b64 ? `<img src="data:image/jpeg;base64,${n.snapshot_b64}" alt="Snapshot" style="cursor:pointer" onclick="window._openSnapshotModal('data:image/jpeg;base64,${n.snapshot_b64}', '${encodeURIComponent(n.appeal_text || '')}')" />` : '<div style="width:80px;height:60px;background:var(--surface-2);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:1.5rem">📷</div>'}
        <div class="notif-meta">
          <strong>${n.student_name || "Unknown Student"}</strong> — ${n.quiz_title || "Unknown Quiz"}
          <small>P(cheat): ${(n.cheat_probability * 100).toFixed(1)}% · ${new Date(n.detected_at).toLocaleString()}</small>
          ${n.appeal_text ? `<div style="margin-top:0.25rem;font-size:0.8rem;color:var(--accent);font-weight:600">Appeal Filed</div>` : ''}
        </div>
        ${n.acknowledged ? '<span class="tag" style="background:rgba(34,197,94,0.15);color:var(--success)">ACK</span>' :
          '<button class="ghost" style="font-size:0.75rem;padding:0.3rem 0.65rem" onclick="window._ackNotif(' + n.id + ',this)">Acknowledge</button>'}
      </div>
    `).join("");
  }

  window._openSnapshotModal = function(imgSrc, appealEncoded) {
    $("snapshotModalImg").src = imgSrc;
    const appeal = decodeURIComponent(appealEncoded);
    const appealEl = $("snapshotModalAppeal");
    if (appeal) {
      appealEl.innerHTML = `<strong>Student Appeal:</strong><br>${appeal.replace(/\n/g, "<br>")}`;
      appealEl.style.display = "block";
    } else {
      appealEl.style.display = "none";
    }
    $("snapshotModal").style.display = "flex";
  };

  window._ackNotif = async function (id, btn) {
    try {
      await jsonFetch(`/api/teacher/notifications/${id}/acknowledge`, {
        method: "POST",
        body: JSON.stringify({ email: teacherSession.email, password: teacherSession.password }),
      });
      btn.closest(".notif-item").classList.remove("unread");
      btn.outerHTML = '<span class="tag" style="background:rgba(34,197,94,0.15);color:var(--success)">ACK</span>';
    } catch (err) {
      alert(err.message);
    }
  };

  /* ——— Restore teacher session on page load ——— */
  window.addEventListener("DOMContentLoaded", () => {
    const te = sessionStorage.getItem("teacher_email");
    const tp = sessionStorage.getItem("teacher_password");
    if (te && tp) {
      $("tch_login_email").value = te;
      $("tch_login_password").value = tp;
      teacherSession = { email: te, password: tp, data: null };
    }
  });
})();
