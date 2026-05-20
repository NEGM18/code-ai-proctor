// js/quiz.js

let attemptId = null;
let timerInterval = null;
let proctorInterval = null;
let isSubmitting = false;
let timeRemaining = 0;

// Get quiz ID from URL
const urlParams = new URLSearchParams(window.location.search);
const quizId = urlParams.get('id');

document.addEventListener('DOMContentLoaded', async () => {
    if (!quizId) {
        alert("No quiz selected.");
        window.location.href = 'dashboard.html';
        return;
    }

    await loadQuiz();
    await initAIObserver();

    // Anti-cheating: Prevent leaving tab
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", handleBlur);

    document.getElementById('quizForm').addEventListener('submit', submitQuiz);
});

async function loadQuiz() {
    try {
        const response = await fetch(`api/get_quiz.php?id=${quizId}`);
        const data = await response.json();

        if (data.ok) {
            attemptId = data.attempt_id;
            timeRemaining = data.quiz.time_limit_minutes * 60;
            
            document.getElementById('quizTitle').textContent = data.quiz.title;
            
            renderQuestions(data.questions);
            startTimer();
            document.getElementById('submitBtn').disabled = false;
        } else {
            document.getElementById('questionsContainer').innerHTML = `<p class="alert error">${data.error}</p>`;
        }
    } catch (e) {
        document.getElementById('questionsContainer').innerHTML = `<p class="alert error">Failed to load quiz.</p>`;
    }
}

function renderQuestions(questions) {
    const container = document.getElementById('questionsContainer');
    container.innerHTML = '';

    questions.forEach((q, index) => {
        const block = document.createElement('div');
        block.className = 'question-block';
        
        let imageHtml = '';
        if (q.image_path) {
            imageHtml = `<img src="${q.image_path}" alt="Question Image" style="max-width: 100%; border-radius: 8px; margin-bottom: 1rem;">`;
        }

        block.innerHTML = `
            <div class="question-text"><strong class="text-red">Q${index + 1}.</strong> ${escapeHTML(q.question_text)}</div>
            ${imageHtml}
            <div class="options-grid">
                <label class="option-label">
                    <input type="radio" name="q_${q.id}" value="a" required>
                    <span>${escapeHTML(q.option_a)}</span>
                </label>
                <label class="option-label">
                    <input type="radio" name="q_${q.id}" value="b" required>
                    <span>${escapeHTML(q.option_b)}</span>
                </label>
                <label class="option-label">
                    <input type="radio" name="q_${q.id}" value="c" required>
                    <span>${escapeHTML(q.option_c)}</span>
                </label>
                <label class="option-label">
                    <input type="radio" name="q_${q.id}" value="d" required>
                    <span>${escapeHTML(q.option_d)}</span>
                </label>
            </div>
        `;
        container.appendChild(block);
    });
}

function startTimer() {
    updateTimerDisplay();
    timerInterval = setInterval(() => {
        if (timeRemaining <= 0) {
            clearInterval(timerInterval);
            submitQuiz(new Event('submit')); // Auto submit
        } else {
            timeRemaining--;
            updateTimerDisplay();
        }
    }, 1000);
}

function updateTimerDisplay() {
    const m = Math.floor(timeRemaining / 60).toString().padStart(2, '0');
    const s = (timeRemaining % 60).toString().padStart(2, '0');
    document.getElementById('timeRemaining').textContent = `${m}:${s}`;
    
    if (timeRemaining < 60) {
        document.getElementById('timeRemaining').style.animation = 'pulse 1s infinite';
    }
}

async function submitQuiz(e) {
    if (e) e.preventDefault();
    if (isSubmitting) return;
    isSubmitting = true;

    clearInterval(timerInterval);
    clearInterval(proctorInterval);
    
    const formData = new FormData(document.getElementById('quizForm'));
    const answers = {};
    for (let [key, value] of formData.entries()) {
        if (key.startsWith('q_')) {
            const qId = key.split('_')[1];
            answers[qId] = value;
        }
    }

    try {
        const response = await fetch('api/submit_quiz.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ attempt_id: attemptId, answers: answers })
        });
        const data = await response.json();

        if (data.ok) {
            document.getElementById('quizContainer').innerHTML = `
                <div style="text-align: center; padding: 3rem 0;">
                    <h1 class="text-red">Quiz Completed!</h1>
                    <p style="font-size: 1.2rem; margin: 1.5rem 0;">You scored: <strong>${data.score} / ${data.total}</strong></p>
                    <a href="dashboard.html" class="btn btn-primary">Return to Dashboard</a>
                </div>
            `;
        } else {
            alert(data.error);
            isSubmitting = false;
        }
    } catch (err) {
        alert("Failed to submit. Please try again.");
        isSubmitting = false;
    }
}

// ----------------------------------------------------------------------
// AI Observer Camera Integration & Anti-Cheating
// ----------------------------------------------------------------------

const video = document.getElementById('webcam');
const canvas = document.getElementById('snapshotCanvas');

async function initAIObserver() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        video.srcObject = stream;
        
        // Start capturing frames every 2 seconds
        proctorInterval = setInterval(captureAndAnalyze, 2000);
    } catch (err) {
        console.error("Camera access denied or unavailable.", err);
        triggerCheatingPenalty("Camera access is required for AI Observer.");
    }
}

async function captureAndAnalyze() {
    if (video.readyState !== 4) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Convert frame to blob to send to local FastAPI predict endpoint
    canvas.toBlob(async (blob) => {
        const formData = new FormData();
        formData.append('file', blob, 'frame.jpg');

        try {
            // Note: In reality, this endpoint URL might differ based on setup.
            // Assuming local Python FastAPI is running on port 8000
            const response = await fetch('http://localhost:8000/api/predict', {
                method: 'POST',
                body: formData,
                headers: {
                    'X-Client-Reference': 'student_module_attempt_' + attemptId
                }
            });
            
            if (response.ok) {
                const data = await response.json();
                if (data.alert) {
                    console.warn("AI OBSERVER ALERT:", data);
                    triggerCheatingPenalty("AI detected cheating behavior.");
                }
            }
        } catch (e) {
            // The API might be offline, silently fail or log it
            console.error("Proctoring connection issue:", e);
        }
    }, 'image/jpeg', 0.8);
}

function handleVisibilityChange() {
    if (document.hidden && !isSubmitting) {
        triggerCheatingPenalty("You left the quiz tab.");
    }
}

function handleBlur() {
    if (!isSubmitting) {
        // Delay slightly to avoid false positives from browser popups
        setTimeout(() => {
            if (!document.hasFocus() && !isSubmitting) {
                triggerCheatingPenalty("Window lost focus.");
            }
        }, 500);
    }
}

function triggerCheatingPenalty(reason) {
    if (isSubmitting) return;
    
    console.warn("PENALTY:", reason);
    clearInterval(timerInterval);
    clearInterval(proctorInterval);
    
    // Stop camera
    if (video.srcObject) {
        video.srcObject.getTracks().forEach(track => track.stop());
    }

    document.getElementById('cheatingOverlay').style.display = 'flex';
    isSubmitting = true;

    // Optional: Send automatic 0 score or "failed" flag to backend
    // fetch('api/submit_quiz.php', { method: 'POST', body: ... })
}

function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
        tag => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        }[tag] || tag)
    );
}
