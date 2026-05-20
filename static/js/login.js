/**
 * AI Observer — Login Page Logic
 * Handles role-based authentication and particle background animation.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  /* ═══════ Particle Background Animation ═══════ */
  const canvas = $("particleCanvas");
  const ctx = canvas.getContext("2d");
  let particles = [];
  const PARTICLE_COUNT = 60;

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  class Particle {
    constructor() {
      this.reset();
    }

    reset() {
      this.x = Math.random() * canvas.width;
      this.y = Math.random() * canvas.height;
      this.size = Math.random() * 2.5 + 0.5;
      this.speedX = (Math.random() - 0.5) * 0.4;
      this.speedY = (Math.random() - 0.5) * 0.4;
      this.opacity = Math.random() * 0.5 + 0.1;
      this.isRed = Math.random() > 0.65;
      this.pulseSpeed = Math.random() * 0.02 + 0.005;
      this.pulsePhase = Math.random() * Math.PI * 2;
    }

    update() {
      this.x += this.speedX;
      this.y += this.speedY;
      this.pulsePhase += this.pulseSpeed;

      if (this.x < -10 || this.x > canvas.width + 10 ||
          this.y < -10 || this.y > canvas.height + 10) {
        this.reset();
      }
    }

    draw() {
      const pulse = Math.sin(this.pulsePhase) * 0.15 + 0.85;
      const alpha = this.opacity * pulse;

      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);

      if (this.isRed) {
        ctx.fillStyle = `rgba(230, 57, 70, ${alpha})`;
        ctx.shadowColor = "rgba(230, 57, 70, 0.4)";
        ctx.shadowBlur = 8;
      } else {
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.5})`;
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  function drawConnections() {
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 140) {
          const alpha = (1 - dist / 140) * 0.06;
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(230, 57, 70, ${alpha})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }
  }

  function animateParticles() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background gradient overlay
    const grad = ctx.createRadialGradient(
      canvas.width * 0.5, canvas.height * 0.3, 0,
      canvas.width * 0.5, canvas.height * 0.3, canvas.width * 0.7
    );
    grad.addColorStop(0, "rgba(230, 57, 70, 0.03)");
    grad.addColorStop(1, "transparent");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawConnections();
    particles.forEach((p) => {
      p.update();
      p.draw();
    });

    requestAnimationFrame(animateParticles);
  }

  function initParticles() {
    resizeCanvas();
    particles = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push(new Particle());
    }
    animateParticles();
  }

  window.addEventListener("resize", resizeCanvas);
  initParticles();

  /* ═══════ Role Selector ═══════ */
  let selectedRole = "organization";

  const roleEndpoints = {
    organization: "/api/org/login",
    teacher: "/api/teacher/login",
    student: "/api/student/login",
  };

  const roleDashboards = {
    organization: "/org-dashboard",
    teacher: "/teacher-dashboard",
    student: "/student-dashboard",
  };

  document.querySelectorAll(".role-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".role-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedRole = btn.getAttribute("data-role");
      setMsg("", "");
    });
  });

  /* ═══════ Login Form ═══════ */
  function setMsg(text, cls) {
    const el = $("loginMsg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "login-msg" + (cls ? " " + cls : "");
  }

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = $("login_email").value.trim();
    const password = $("login_password").value;

    if (!email || !password) {
      setMsg("Please enter your email and password.", "error");
      return;
    }

    const btn = $("loginBtn");
    const btnText = btn.querySelector(".btn-text");
    const btnSpinner = btn.querySelector(".btn-spinner");

    btn.disabled = true;
    btnText.textContent = "Signing in…";
    btnSpinner.hidden = false;
    setMsg("", "");

    try {
      const res = await fetch(roleEndpoints[selectedRole], {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.detail || "Invalid credentials");
      }

      // Store session
      sessionStorage.setItem("auth_role", selectedRole);
      sessionStorage.setItem("auth_email", email);
      sessionStorage.setItem("auth_password", password);

      if (selectedRole === "organization") {
        sessionStorage.setItem("org_email", email);
        sessionStorage.setItem("org_password", password);
        sessionStorage.setItem("org_name", data.organization?.name || email);
      } else if (selectedRole === "teacher") {
        sessionStorage.setItem("teacher_email", email);
        sessionStorage.setItem("teacher_password", password);
        sessionStorage.setItem("teacher_name", data.teacher?.full_name || email);
      } else if (selectedRole === "student") {
        sessionStorage.setItem("student_email", email);
        sessionStorage.setItem("student_password", password);
        sessionStorage.setItem("student_name", data.student?.full_name || email);
        sessionStorage.setItem("student_must_change", data.student?.must_change_password ? "1" : "0");
        sessionStorage.setItem("student_face_uploaded", data.student?.face_uploaded ? "1" : "0");
      }

      setMsg("Success! Redirecting…", "ok");

      // Redirect after brief delay
      setTimeout(() => {
        window.location.href = roleDashboards[selectedRole];
      }, 600);

    } catch (err) {
      setMsg(err.message || "Login failed. Please try again.", "error");

      // Shake the card
      const card = document.querySelector(".login-card");
      card.classList.add("shake");
      setTimeout(() => card.classList.remove("shake"), 500);

      btn.disabled = false;
      btnText.textContent = "Log in";
      btnSpinner.hidden = true;
    }
  });

  // Microsoft SSO placeholder
  $("ssoBtn")?.addEventListener("click", () => {
    setMsg("Microsoft SSO integration coming soon.", "warn");
  });

  // Restore last used email
  window.addEventListener("DOMContentLoaded", () => {
    const lastEmail = sessionStorage.getItem("auth_email");
    if (lastEmail) {
      $("login_email").value = lastEmail;
    }
    const lastRole = sessionStorage.getItem("auth_role");
    if (lastRole) {
      document.querySelectorAll(".role-btn").forEach((btn) => {
        btn.classList.remove("active");
        if (btn.getAttribute("data-role") === lastRole) {
          btn.classList.add("active");
          selectedRole = lastRole;
        }
      });
    }
  });
})();
