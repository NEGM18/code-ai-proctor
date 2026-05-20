// js/dashboard.js

let allQuizzes = [];

document.addEventListener('DOMContentLoaded', () => {
    fetchDashboardData();
    checkInviteLink();
    document.getElementById('joinClassForm').addEventListener('submit', handleJoinClass);
});

async function fetchDashboardData() {
    try {
        const response = await fetch('api/fetch_dashboard.php');
        const data = await response.json();

        if (data.ok) {
            allQuizzes = data.quizzes || [];
            renderClasses(data.classes);
            // Notice: We don't render quizzes immediately. 
            // They are shown inside the specific course detail view.
        } else {
            console.error('Error fetching dashboard:', data.error);
        }
    } catch (error) {
        console.error('Network error:', error);
    }
}

// Pre-defined colorful patterns for the Moodle-like cards
const cardPatterns = [
    'linear-gradient(135deg, #0d6efd 25%, #0a58ca 25%, #0a58ca 50%, #0d6efd 50%, #0d6efd 75%, #0a58ca 75%, #0a58ca 100%)', // Blue
    'linear-gradient(45deg, #20c997 25%, #1aa179 25%, #1aa179 50%, #20c997 50%, #20c997 75%, #1aa179 75%, #1aa179 100%)', // Teal
    'linear-gradient(135deg, #6f42c1 25%, #59359a 25%, #59359a 50%, #6f42c1 50%, #6f42c1 75%, #59359a 75%, #59359a 100%)', // Purple
    'linear-gradient(45deg, #e83e8c 25%, #ba3270 25%, #ba3270 50%, #e83e8c 50%, #e83e8c 75%, #ba3270 75%, #ba3270 100%)', // Pink
    'linear-gradient(135deg, #fd7e14 25%, #ca6510 25%, #ca6510 50%, #fd7e14 50%, #fd7e14 75%, #ca6510 75%, #ca6510 100%)'  // Orange
];

function renderClasses(classes) {
    const container = document.getElementById('classesList');
    container.innerHTML = '';

    if (!classes || classes.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted); grid-column: 1 / -1;">You have not joined any classes yet.</p>';
        return;
    }

    classes.forEach((cls, index) => {
        const pattern = cardPatterns[index % cardPatterns.length];
        
        const div = document.createElement('div');
        div.className = 'course-card';
        div.onclick = () => openCourseDetail(cls);
        
        div.innerHTML = `
            <div class="card-pattern" style="background-image: ${pattern}; background-size: 40px 40px;"></div>
            <div class="card-body">
                <div class="card-title">${escapeHTML(cls.class_name)}</div>
                <div class="card-subtitle">Spring 25-26</div>
                <div class="card-footer">
                    <span class="dots">⋮</span>
                </div>
            </div>
        `;
        container.appendChild(div);
    });
}

function openCourseDetail(cls) {
    document.getElementById('coursesGridView').classList.add('hidden');
    document.getElementById('courseDetailView').classList.remove('hidden');
    
    document.getElementById('detailCourseTitle').textContent = cls.class_name;
    
    // Filter quizzes for this specific class
    const classQuizzes = allQuizzes.filter(q => q.class_name === cls.class_name);
    renderDetailQuizzes(classQuizzes);
}

function showGridView() {
    document.getElementById('courseDetailView').classList.add('hidden');
    document.getElementById('coursesGridView').classList.remove('hidden');
}

function renderDetailQuizzes(quizzes) {
    const container = document.getElementById('detailQuizzesList');
    container.innerHTML = '';

    if (quizzes.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted); font-size: 0.9rem;">No active quizzes for this course at the moment.</p>';
        return;
    }

    quizzes.forEach(quiz => {
        const div = document.createElement('div');
        div.className = 'material-item';
        div.innerHTML = `
            <div class="material-icon icon-quiz">📝</div>
            <div style="flex-grow: 1;">
                <a href="quiz.html?id=${quiz.id}" class="material-link">${escapeHTML(quiz.title)}</a>
                <span class="material-meta">Time limit: ${quiz.time_limit_minutes} mins</span>
            </div>
            <a href="quiz.html?id=${quiz.id}" class="btn-primary-moodle" style="font-size: 0.85rem;">Attempt Quiz</a>
        `;
        container.appendChild(div);
    });
}

async function handleJoinClass(e) {
    e.preventDefault();
    const code = document.getElementById('classCode').value.trim().toUpperCase();
    const password = document.getElementById('classPassword').value;
    const alertBox = document.getElementById('joinAlert');

    try {
        const response = await fetch('api/join_class.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ class_code: code, class_password: password })
        });
        const data = await response.json();

        if (data.ok) {
            alertBox.style.color = 'green';
            alertBox.textContent = data.message;
            document.getElementById('joinClassForm').reset();
            fetchDashboardData(); 
            setTimeout(closeJoinModal, 1500);
        } else {
            alertBox.style.color = 'red';
            alertBox.textContent = data.error;
        }
    } catch (error) {
        alertBox.style.color = 'red';
        alertBox.textContent = 'Connection failed.';
    }
}

function checkInviteLink() {
    const params = new URLSearchParams(window.location.search);
    const joinCode = params.get('join_code');
    if (joinCode) {
        openJoinModal();
        document.getElementById('classCode').value = joinCode;
        window.history.replaceState({}, document.title, window.location.pathname);
    }
}

function openJoinModal() {
    const modal = document.getElementById('joinModal');
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    document.getElementById('joinAlert').textContent = '';
}

function closeJoinModal() {
    const modal = document.getElementById('joinModal');
    modal.classList.add('hidden');
    modal.style.display = 'none';
}

function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, 
        tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag] || tag)
    );
}
