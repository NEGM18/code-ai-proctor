(function(){"use strict";
const $=id=>document.getElementById(id),ss=sessionStorage;
let allClasses=[],allQuizzes=[],allNotifs=[],currentClass=null,weeks=[];
function creds(){return{email:ss.getItem("teacher_email")||"",password:ss.getItem("teacher_password")||""}}
async function jf(p,o){const h=Object.assign({"Content-Type":"application/json"},o.headers||{});const r=await fetch(p,Object.assign({},o,{headers:h}));const d=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(d.detail||"Failed");e.body=d;e.status=r.status;throw e}return d}
function msg(id,t,c){const e=$(id);if(!e)return;e.textContent=t||"";e.className="msg"+(c?" "+c:"")}

// Main tab nav
document.querySelectorAll("#mainNav button[data-main-tab]").forEach(b=>{b.addEventListener("click",()=>{
  document.querySelectorAll("#mainNav button").forEach(x=>x.classList.remove("active"));b.classList.add("active");
  const t=b.dataset.mainTab;
  $("classesGridView").style.display=t==="classes"?"block":"none";
  $("classDetailView").hidden=true;
  $("cameraPanel").style.display=t==="camera"?"block":"none";
})});

// Session guard
const cr=creds();if(!cr.email){location.href="/";return}
$("teacherHeaderName").textContent=ss.getItem("teacher_name")||cr.email;
$("teacherSignOutBtn").addEventListener("click",()=>{ss.clear();location.href="/"});

// Auto-login for teacher_portal.js compat
const te=$("tch_login_email"),tp=$("tch_login_password");
if(te)te.value=cr.email;if(tp)tp.value=cr.password;
window.addEventListener("DOMContentLoaded",()=>{const b=$("teacherLoginBtn");if(b)b.click()});

// Patterns for class cards
const patterns=['linear-gradient(135deg,rgba(230,57,70,.25) 25%,rgba(180,40,50,.25) 25%,rgba(180,40,50,.25) 50%,rgba(230,57,70,.25) 50%,rgba(230,57,70,.25) 75%,rgba(180,40,50,.25) 75%)','linear-gradient(45deg,rgba(32,201,151,.25) 25%,rgba(26,161,121,.25) 25%,rgba(26,161,121,.25) 50%,rgba(32,201,151,.25) 50%,rgba(32,201,151,.25) 75%,rgba(26,161,121,.25) 75%)','linear-gradient(135deg,rgba(111,66,193,.25) 25%,rgba(89,53,154,.25) 25%,rgba(89,53,154,.25) 50%,rgba(111,66,193,.25) 50%,rgba(111,66,193,.25) 75%,rgba(89,53,154,.25) 75%)','linear-gradient(45deg,rgba(232,62,140,.25) 25%,rgba(186,50,112,.25) 25%,rgba(186,50,112,.25) 50%,rgba(232,62,140,.25) 50%,rgba(232,62,140,.25) 75%,rgba(186,50,112,.25) 75%)','linear-gradient(135deg,rgba(253,126,20,.25) 25%,rgba(202,101,16,.25) 25%,rgba(202,101,16,.25) 50%,rgba(253,126,20,.25) 50%,rgba(253,126,20,.25) 75%,rgba(202,101,16,.25) 75%)'];



window._teacherStoreData=function(classes,quizzes,notifCount){
  allClasses=classes||[];allQuizzes=quizzes||[];
  $("statClasses").textContent=allClasses.length;
  $("statQuizzes").textContent=allQuizzes.length;
  $("statAlerts").textContent=notifCount||0;
  renderClassCards();
};

function renderClassCards(){
  const cont=$("classesListContainer");if(!cont)return;
  if(!allClasses.length){cont.innerHTML='<div class="empty-state"><div class="empty-icon">📚</div><p>No classes yet</p></div>';return}
  cont.innerHTML=allClasses.map((c,i)=>`<div class="class-card" data-cid="${c.id}"><div class="card-banner" style="background-image:${patterns[i%patterns.length]};background-size:40px 40px"></div><div class="card-body"><h3>${c.name}</h3><div class="meta">${c.student_count} students</div><div style="display:flex;justify-content:space-between;align-items:center;margin-top:auto;padding-top:.75rem"><div class="code-badge" style="margin:0">${c.class_code}</div><button class="ghost" style="font-size:.65rem;padding:.15rem .4rem;color:var(--error)" onclick="event.stopPropagation();window._teacherDeleteClass(${c.id},'${c.name.replace(/'/g,"\\\\'")}')" title="Delete Class">🗑</button></div></div></div>`).join("");
  cont.querySelectorAll(".class-card").forEach(card=>{card.addEventListener("click",()=>{
    const id=parseInt(card.dataset.cid);openClassDetail(allClasses.find(x=>x.id===id));
  })});
}
function tryRenderCards(){if(allClasses.length)renderClassCards()}

// Detail tabs
document.querySelectorAll("#detailTabs button[data-dtab]").forEach(b=>{b.addEventListener("click",()=>{
  document.querySelectorAll("#detailTabs button").forEach(x=>x.classList.remove("active"));b.classList.add("active");
  document.querySelectorAll(".dtab-panel").forEach(p=>{p.style.display="none";p.classList.remove("active")});
  const p=document.querySelector(`.dtab-panel[data-dpanel="${b.dataset.dtab}"]`);
  if(p){p.style.display="block";p.classList.add("active")}
})});

$("backToClassesBtn").addEventListener("click",()=>{$("classDetailView").hidden=true;$("classesGridView").style.display="block"});

function openClassDetail(cls){
  if(!cls)return;currentClass=cls;
  $("classesGridView").style.display="none";$("classDetailView").hidden=false;
  $("detailClassName").textContent=cls.name;
  $("detailClassCode").textContent=cls.class_code;
  $("detailClassPw").textContent=cls.password;
  $("detailStudentCount").textContent=cls.student_count;
  // Reset to Course tab
  document.querySelectorAll("#detailTabs button").forEach(b=>b.classList.remove("active"));
  document.querySelector('#detailTabs button[data-dtab="course"]').classList.add("active");
  document.querySelectorAll(".dtab-panel").forEach(p=>{p.style.display="none";p.classList.remove("active")});
  const cp=document.querySelector('.dtab-panel[data-dpanel="course"]');cp.style.display="block";cp.classList.add("active");
  // Load weeks from backend
  try{weeks=currentClass.course_structure_json?JSON.parse(currentClass.course_structure_json):[]}catch(e){weeks=[]}
  if(!weeks.length)weeks=[{name:"General",items:[{type:"announce",label:"Announcements"},{type:"attend",label:"Attendance"}]}];
  renderCourseTab();loadClassGradesDropdown();loadClassNotifications();
}

async function saveWeeks(){if(!currentClass)return;const j=JSON.stringify(weeks);currentClass.course_structure_json=j;const c=allClasses.find(x=>x.id===currentClass.id);if(c)c.course_structure_json=j;const cr=creds();try{await jf(`/api/teacher/classes/${currentClass.id}/structure`,{method:"POST",body:JSON.stringify({teacher_email:cr.email,teacher_password:cr.password,course_structure_json:j})})}catch(e){console.error(e)}}

function renderCourseTab(){
  const root=$("panelCourse");if(!root)return;
  const classQuizzes=allQuizzes.filter(q=>q.class_id===currentClass.id);
  let html="";
  weeks.forEach((w,wi)=>{
    const isGeneral=wi===0;
    html+=`<div class="moodle-section"><div class="section-header" data-wi="${wi}"><h3><span class="chevron">▾</span> ${w.name}</h3>${isGeneral?'<span style="color:var(--text-secondary);font-size:.8rem">Default</span>':`<button class="ghost" style="font-size:.7rem;padding:.2rem .5rem" onclick="event.stopPropagation();window._removeWeek(${wi})">Remove</button>`}</div><div class="section-body" id="weekBody_${wi}">`;
    // Items
    (w.items||[]).forEach((it,ii)=>{
      if(it.type==="announce")html+=`<div class="moodle-item"><div class="item-icon" style="background:rgba(111,66,193,.2);color:#b184f5">💬</div><div class="item-label">Announcements</div></div>`;
      else if(it.type==="attend")html+=`<div class="moodle-item"><div class="item-icon" style="background:rgba(214,51,132,.2);color:#f27eb6">👥</div><div class="item-label">Attendance</div></div>`;
      else if(it.type==="lecture"){const l=it.url?`<a href="${it.url}" target="_blank" style="color:inherit;text-decoration:none">${it.label}</a>`:it.label;html+=`<div class="moodle-item"><div class="item-icon" style="background:rgba(15,81,50,.2);color:#51b782">📄</div><div class="item-label">${l}</div><span class="item-badge">${it.fileType||"PDF"}</span><button class="ghost" style="font-size:.65rem;padding:.15rem .4rem;margin-left:auto;color:var(--error)" onclick="window._removeLecture(${wi},${ii})">×</button></div>`;}
    });
    // Quizzes assigned to this week
    const wQuizzes=classQuizzes.filter(q=>{const assigned=JSON.parse(localStorage.getItem("quiz_week_"+q.id)||"null");return assigned===wi||(assigned===null&&!isGeneral?false:false)});
    // Show all class quizzes in general if unassigned
    const unassigned=isGeneral?classQuizzes.filter(q=>{const a=localStorage.getItem("quiz_week_"+q.id);return a===null||a==="null"}):[];
    const showQuizzes=[...wQuizzes,...(isGeneral?unassigned:[])];
    const seen=new Set();
    showQuizzes.forEach(q=>{if(seen.has(q.id))return;seen.add(q.id);
      html+=`<div class="moodle-item"><div class="item-icon" style="background:rgba(230,57,70,.15);color:var(--accent)">📝</div><div class="item-label">${q.title}</div><span class="item-badge">${q.question_count} Q${q.time_limit_minutes?" · "+q.time_limit_minutes+"min":""}</span><div style="margin-left:auto;display:flex;gap:.35rem"><button class="ghost" style="font-size:.65rem;padding:.15rem .4rem" onclick="window._teacherCopyLink('${q.id}')">Link</button><button class="ghost" style="font-size:.65rem;padding:.15rem .4rem" onclick="window._teacherAddQuestions(${q.id},'${q.title.replace(/'/g,"\\'")}')">Questions</button><button class="ghost" style="font-size:.65rem;padding:.15rem .4rem;color:var(--error)" onclick="window._teacherDeleteQuiz(${q.id},'${q.title.replace(/'/g,"\\'")}')">Del</button></div></div>`;
    });
    if(!isGeneral){
      html+=`<div class="week-actions"><button class="ghost" onclick="window._showQuizForm(${wi})">+ Create Quiz</button><button class="ghost" onclick="window._showLectureForm(${wi})">+ Upload Lecture</button></div>`;
      html+=`<div id="quizForm_${wi}" class="quiz-inline-form" hidden><h4>Create Quiz in ${w.name}</h4><label>Title</label><input id="qf_title_${wi}" type="text"/><div class="grid-2"><div><label>Description</label><textarea id="qf_desc_${wi}" rows="1"></textarea></div><div><label>Time (min)</label><input id="qf_time_${wi}" type="number" min="1"/></div></div><div class="grid-2"><div><label>Start</label><input id="qf_start_${wi}" type="datetime-local"/></div><div><label>End</label><input id="qf_end_${wi}" type="datetime-local"/></div></div><div class="row-actions"><button class="primary" onclick="window._createWeekQuiz(${wi})">Create</button><button class="ghost" onclick="document.getElementById('quizForm_${wi}').hidden=true">Cancel</button></div><div id="qfMsg_${wi}" class="msg"></div></div>`;
      html+=`<div id="lectureForm_${wi}" class="lecture-upload-area" hidden><div><label>File</label><input id="lf_file_${wi}" type="file" accept=".pdf,.pptx,.ppt,.docx,.doc"/></div><button class="primary" style="font-size:.78rem" onclick="window._addLecture(${wi})">Add</button><button class="ghost" style="font-size:.78rem" onclick="document.getElementById('lectureForm_${wi}').hidden=true">Cancel</button></div>`;
    }
    html+=`</div></div>`;
  });
  html+=`<button class="add-week-btn" onclick="window._addWeek()">+ Add Week</button>`;
  root.innerHTML=html;
  // Collapsible headers
  root.querySelectorAll(".section-header").forEach(h=>{h.addEventListener("click",()=>{
    const b=h.nextElementSibling;const ch=h.querySelector(".chevron");
    if(b.classList.contains("collapsed")){b.classList.remove("collapsed");if(ch)ch.classList.remove("collapsed")}
    else{b.classList.add("collapsed");if(ch)ch.classList.add("collapsed")}
  })});
}

window._addWeek=function(){const n=prompt("Week name:","Week "+(weeks.length));if(!n)return;weeks.push({name:n,items:[]});saveWeeks();renderCourseTab()};
window._removeWeek=function(wi){if(!confirm("Remove "+weeks[wi].name+"?"))return;weeks.splice(wi,1);saveWeeks();renderCourseTab()};

// Override copy link with toast feedback + HTTP fallback
window._teacherCopyLink = async function(quizId) {
  try {
    const r = await jf(`/api/teacher/quizzes/${quizId}/link`, { method: "GET" });
    const link = r.link;
    try {
      await navigator.clipboard.writeText(link);
    } catch(clipErr) {
      // Fallback for HTTP: use textarea trick
      const ta = document.createElement("textarea");
      ta.value = link;
      ta.style.cssText = "position:fixed;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    // Show toast
    const toast = document.createElement("div");
    toast.textContent = "📋 Link copied: " + link;
    toast.style.cssText = "position:fixed;bottom:2rem;left:50%;transform:translateX(-50%);padding:0.75rem 1.5rem;background:var(--surface);border:1px solid var(--accent);border-radius:10px;color:var(--accent);font-size:0.85rem;font-weight:600;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,0.4);animation:slideIn 0.3s ease";
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  } catch(e) {
    alert("Failed to get quiz link: " + (e.body?.detail || e.message));
  }
};

// Delete class
window._teacherDeleteClass = async function(classId, className) {
  if(!confirm(`Are you sure you want to delete the class "${className}" and all its quizzes, grades, and enrollments?`)) return;
  const c = creds();
  try {
    await jf(`/api/teacher/classes/${classId}`, {
      method: "DELETE",
      body: JSON.stringify({ email: c.email, password: c.password })
    });
    // Refresh dashboard
    const dash = await jf("/api/teacher/dashboard", { method: "POST", body: JSON.stringify(c) });
    window._teacherStoreData(dash.classes || [], dash.quizzes || [], dash.notification_count || 0);
    $("classDetailView").hidden = true;
    $("classesGridView").style.display = "block";
  } catch(e) {
    alert("Delete failed: " + (e.body?.detail || e.message));
  }
};

window._showQuizForm=function(wi){$("quizForm_"+wi).hidden=false};
window._showLectureForm=function(wi){$("lectureForm_"+wi).hidden=false};

window._createWeekQuiz=async function(wi){
  const title=$("qf_title_"+wi)?.value?.trim();if(!title){msg("qfMsg_"+wi,"Enter title","error");return}
  msg("qfMsg_"+wi,"Creating…","");
  const c=creds();const sv=$("qf_start_"+wi)?.value,ev=$("qf_end_"+wi)?.value;
  try{
    const d=await jf("/api/teacher/quizzes",{method:"POST",body:JSON.stringify({teacher_email:c.email,teacher_password:c.password,class_id:currentClass.id,title,description:$("qf_desc_"+wi)?.value?.trim()||null,time_limit_minutes:parseInt($("qf_time_"+wi)?.value)||null,start_time:sv?sv+":00":null,end_time:ev?ev+":00":null})});
    localStorage.setItem("quiz_week_"+d.quiz_id,String(wi));
    msg("qfMsg_"+wi,"Created!","ok");
    // Reload dashboard data
    const dash=await jf("/api/teacher/dashboard",{method:"POST",body:JSON.stringify(c)});
    allQuizzes=dash.quizzes||[];allClasses=dash.classes||[];
    currentClass=allClasses.find(x=>x.id===currentClass.id)||currentClass;
    $("statQuizzes").textContent=allQuizzes.length;
    renderCourseTab();loadClassGradesDropdown();
    // Open add questions
    window._teacherAddQuestions(d.quiz_id,d.title);
  }catch(e){msg("qfMsg_"+wi,e.body?.detail||e.message,"error")}
};

window._addLecture=async function(wi){
  const f=$("lf_file_"+wi)?.files[0];if(!f){alert("Choose a file");return}
  const ext=f.name.split(".").pop().toUpperCase();
  $("lectureForm_"+wi).hidden=true;
  const cr=creds();const fd=new FormData();fd.append("teacher_email",cr.email);fd.append("teacher_password",cr.password);fd.append("file",f);
  try{
    const r=await fetch(`/api/teacher/classes/${currentClass.id}/upload_lecture`,{method:"POST",body:fd});
    const d=await r.json();if(!r.ok)throw new Error(d.detail||"Upload failed");
    if(!weeks[wi].items)weeks[wi].items=[];
    weeks[wi].items.push({type:"lecture",label:f.name.replace(/\.[^.]+$/,""),fileType:ext,url:d.file_path});
    await saveWeeks();renderCourseTab();
  }catch(e){alert(e.message)}
};
window._removeLecture=function(wi,ii){weeks[wi].items.splice(ii,1);saveWeeks();renderCourseTab()};

// ——— Question Builder Panel ———
let activeQBQuizId = null;

window._teacherAddQuestions = async function(quizId, title) {
  activeQBQuizId = quizId;
  const panel = $("questionBuilderPanel");
  if(!panel) return;
  panel.hidden = false;
  $("qbQuizTitle").textContent = title;
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  await refreshQBList(quizId);
};

async function refreshQBList(quizId) {
  try {
    const data = await jf(`/api/teacher/quizzes/${quizId}/questions`, { method: "GET" });
    const list = $("qbExistingList");
    const qs = data.questions || [];
    if (!qs.length) {
      list.innerHTML = '<div style="text-align:center;padding:1.5rem;color:var(--text-secondary);font-size:.9rem">No questions added yet. Use the form below to add MCQ questions.</div>';
      return;
    }
    list.innerHTML = qs.map((q, i) => `
      <div class="question-item" style="animation:panelIn .3s ease ${i*0.05}s both">
        <div class="q-number">Q${i+1}</div>
        <p style="margin:0.25rem 0;font-size:0.9rem">${q.question_text}</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.25rem 1rem;font-size:0.82rem;color:var(--text-secondary);margin-top:0.35rem">
          <span${q.correct_option==="a"?' style="color:var(--success);font-weight:700"':""}>A: ${q.option_a}</span>
          <span${q.correct_option==="b"?' style="color:var(--success);font-weight:700"':""}>B: ${q.option_b}</span>
          <span${q.correct_option==="c"?' style="color:var(--success);font-weight:700"':""}>C: ${q.option_c}</span>
          <span${q.correct_option==="d"?' style="color:var(--success);font-weight:700"':""}>D: ${q.option_d}</span>
        </div>
        ${q.image_path ? '<img src="' + q.image_path + '" style="max-width:160px;margin-top:0.5rem;border-radius:8px;border:1px solid var(--border)" />' : ''}
      </div>
    `).join("");
  } catch (e) {
    console.error("Failed to load questions:", e);
  }
}

$("qbAddBtn")?.addEventListener("click", async () => {
  if (!activeQBQuizId) { msg("qbMsg", "No quiz selected.", "error"); return; }
  const text = $("qb_text")?.value?.trim();
  const a = $("qb_a")?.value?.trim();
  const b = $("qb_b")?.value?.trim();
  const c = $("qb_c")?.value?.trim();
  const d = $("qb_d")?.value?.trim();
  const correct = $("qb_correct")?.value;
  if (!text || !a || !b || !c || !d) { msg("qbMsg", "Fill in question text and all 4 options.", "error"); return; }
  msg("qbMsg", "Adding question…", "");
  const fd = new FormData();
  const cr = creds();
  fd.append("teacher_email", cr.email);
  fd.append("teacher_password", cr.password);
  fd.append("question_text", text);
  fd.append("option_a", a);
  fd.append("option_b", b);
  fd.append("option_c", c);
  fd.append("option_d", d);
  fd.append("correct_option", correct);
  const imageFile = $("qb_image")?.files[0];
  if (imageFile) fd.append("image", imageFile);
  try {
    const res = await fetch(`/api/teacher/quizzes/${activeQBQuizId}/questions`, { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.detail || "Failed"), { body: data });
    msg("qbMsg", "Question added!", "ok");
    $("qb_text").value = "";
    $("qb_a").value = "";
    $("qb_b").value = "";
    $("qb_c").value = "";
    $("qb_d").value = "";
    $("qb_image").value = "";
    await refreshQBList(activeQBQuizId);
    // Refresh dashboard data to update question counts in the course tab
    const dash = await jf("/api/teacher/dashboard", { method: "POST", body: JSON.stringify(cr) });
    allQuizzes = dash.quizzes || []; allClasses = dash.classes || [];
    currentClass = allClasses.find(x => x.id === currentClass?.id) || currentClass;
    renderCourseTab();
  } catch (e) {
    msg("qbMsg", e.body?.detail || e.message || "Failed to add question.", "error");
  }
});

// Grades (class-scoped)
function loadClassGradesDropdown(){
  const sel=$("detail_grade_quiz");if(!sel||!currentClass)return;
  const cq=allQuizzes.filter(q=>q.class_id===currentClass.id);
  sel.innerHTML='<option value="">— Choose quiz —</option>'+cq.map(q=>`<option value="${q.id}">${q.title} (${q.question_count}Q)</option>`).join("");
}
$("detailLoadGrades")?.addEventListener("click",async()=>{
  const qid=$("detail_grade_quiz").value;if(!qid){msg("detailGradesMsg","Select a quiz","error");return}
  msg("detailGradesMsg","Loading…","");
  const c=creds();
  try{
    const d=await jf(`/api/teacher/grades/${qid}?teacher_email=${encodeURIComponent(c.email)}&teacher_password=${encodeURIComponent(c.password)}`,{method:"GET"});
    const g=d.grades||[];$("detailGradesTableCard").hidden=!g.length;
    $("detailGradesBody").innerHTML=g.map(r=>{const p=r.percentage||0;const cls=p>=80?"score-high":p>=50?"score-mid":"score-low";return`<tr><td>${r.student_id}</td><td>${r.student_name}</td><td>${r.student_email}</td><td>${r.score}/${r.total}</td><td class="${cls}">${p}%</td><td>${r.status}</td></tr>`}).join("");
    msg("detailGradesMsg",g.length+" results","ok");
  }catch(e){msg("detailGradesMsg",e.body?.detail||e.message,"error")}
});
$("detailExportGrades")?.addEventListener("click",()=>{
  const qid=$("detail_grade_quiz").value;if(!qid){msg("detailGradesMsg","Select quiz first","error");return}
  const c=creds();window.open(`/api/teacher/grades/${qid}/export?teacher_email=${encodeURIComponent(c.email)}&teacher_password=${encodeURIComponent(c.password)}`,"_blank");
});

// AI Insights
$("detailAIInsights")?.addEventListener("click", async () => {
  const qid = $("detail_grade_quiz").value;
  if(!qid) { msg("detailGradesMsg", "Select a quiz first", "error"); return; }
  msg("detailGradesMsg", "🤖 AI is analyzing student performance…", "");
  $("insightsPanel").hidden = true;

  const c = creds();
  try {
    const d = await jf(`/api/teacher/quiz/${qid}/insights`, {
      method: "POST",
      body: JSON.stringify({ email: c.email, password: c.password })
    });
    if(!d.ok) throw new Error(d.error || "Analysis failed");
    msg("detailGradesMsg", "Insights generated!", "ok");
    renderInsights(d);
    $("insightsPanel").hidden = false;
    $("insightsPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch(e) {
    msg("detailGradesMsg", e.body?.detail || e.message || "Failed to generate insights", "error");
  }
});

function renderInsights(data) {
  const ins = data.insights || {};
  const stats = data.question_stats || [];
  let html = "";

  // Summary header
  const gradeColor = {"A":"var(--success)","B":"#22d3ee","C":"var(--warn)","D":"#f97316","F":"var(--danger)"}[ins.class_grade] || "var(--text)";
  html += `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:1rem;margin-bottom:1.5rem">
      <div style="text-align:center;padding:1rem;background:rgba(255,255,255,.03);border-radius:var(--radius);border:1px solid var(--border)">
        <div style="font-size:2rem;font-weight:800;color:${gradeColor}">${ins.class_grade || "—"}</div>
        <div style="font-size:.75rem;color:var(--text-secondary);text-transform:uppercase;font-weight:600">Class Grade</div>
      </div>
      <div style="text-align:center;padding:1rem;background:rgba(255,255,255,.03);border-radius:var(--radius);border:1px solid var(--border)">
        <div style="font-size:2rem;font-weight:800;color:var(--accent)">${data.avg_score}%</div>
        <div style="font-size:.75rem;color:var(--text-secondary);text-transform:uppercase;font-weight:600">Average</div>
      </div>
      <div style="text-align:center;padding:1rem;background:rgba(255,255,255,.03);border-radius:var(--radius);border:1px solid var(--border)">
        <div style="font-size:2rem;font-weight:800;color:var(--text)">${data.total_students}</div>
        <div style="font-size:.75rem;color:var(--text-secondary);text-transform:uppercase;font-weight:600">Students</div>
      </div>
      <div style="text-align:center;padding:1rem;background:rgba(255,255,255,.03);border-radius:var(--radius);border:1px solid var(--border)">
        <div style="font-size:2rem;font-weight:800;color:var(--text)">${stats.length}</div>
        <div style="font-size:.75rem;color:var(--text-secondary);text-transform:uppercase;font-weight:600">Questions</div>
      </div>
    </div>`;

  // Summary
  if(ins.overall_summary) {
    html += `<div style="padding:1rem;background:rgba(111,66,193,.06);border:1px solid rgba(111,66,193,.2);border-radius:var(--radius-sm);margin-bottom:1.5rem;font-size:.95rem;line-height:1.6">${ins.overall_summary}</div>`;
  }

  // Per-question performance bars
  html += `<h3 style="font-size:1rem;margin:0 0 .75rem;color:var(--text-secondary)">📊 Per-Question Performance</h3>`;
  stats.forEach((qs, i) => {
    const pct = qs.pct_correct;
    const barColor = pct >= 80 ? "var(--success)" : pct >= 50 ? "var(--warn)" : "var(--danger)";
    const dist = qs.distribution;
    const opts = ["a","b","c","d"];
    const distHtml = opts.map(o => {
      const count = dist[o] || 0;
      const w = qs.total_answers ? Math.round(count/qs.total_answers*100) : 0;
      const isCorrect = o === qs.correct_option;
      return `<div style="display:flex;align-items:center;gap:.4rem;font-size:.78rem">
        <span style="width:16px;font-weight:700;color:${isCorrect?'var(--success)':'var(--text-secondary)'}">${o.toUpperCase()}</span>
        <div style="flex:1;height:6px;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden">
          <div style="width:${w}%;height:100%;background:${isCorrect?'var(--success)':'rgba(255,255,255,.15)'};border-radius:3px"></div>
        </div>
        <span style="font-size:.72rem;color:var(--text-secondary)">${count}</span>
      </div>`;
    }).join("");
    html += `
      <div style="padding:.85rem;border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:.6rem;background:rgba(255,255,255,.02)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.4rem">
          <span style="font-weight:700;font-size:.88rem">Q${i+1}</span>
          <span style="font-size:.78rem;font-weight:700;color:${barColor}">${pct}% correct</span>
        </div>
        <p style="font-size:.82rem;margin:0 0 .5rem;color:var(--text-secondary)">${qs.question_text}</p>
        <div style="height:8px;background:rgba(255,255,255,.06);border-radius:4px;overflow:hidden;margin-bottom:.5rem">
          <div style="width:${pct}%;height:100%;background:${barColor};border-radius:4px;transition:width .6s"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.25rem">${distHtml}</div>
        ${qs.avg_time_seconds ? `<div style="font-size:.72rem;color:var(--muted);margin-top:.35rem">⏱ Avg time: ${qs.avg_time_seconds}s</div>` : ""}
      </div>`;
  });

  // Strengths & Weaknesses
  html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin:1.5rem 0">`;
  if(ins.strengths?.length) {
    html += `<div style="padding:1rem;background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.2);border-radius:var(--radius-sm)">
      <h4 style="margin:0 0 .5rem;color:var(--success);font-size:.9rem">✅ Strengths</h4>
      <ul style="margin:0;padding-left:1.2rem;font-size:.85rem;line-height:1.6;color:var(--text)">${ins.strengths.map(s=>`<li>${s}</li>`).join("")}</ul>
    </div>`;
  }
  if(ins.weaknesses?.length) {
    html += `<div style="padding:1rem;background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.2);border-radius:var(--radius-sm)">
      <h4 style="margin:0 0 .5rem;color:var(--danger);font-size:.9rem">⚠️ Weaknesses</h4>
      <ul style="margin:0;padding-left:1.2rem;font-size:.85rem;line-height:1.6;color:var(--text)">${ins.weaknesses.map(w=>`<li>${w}</li>`).join("")}</ul>
    </div>`;
  }
  html += `</div>`;

  // Focus Areas
  if(ins.focus_areas?.length) {
    html += `<h3 style="font-size:1rem;margin:0 0 .75rem;color:var(--text-secondary)">🎯 Focus Areas</h3>`;
    ins.focus_areas.forEach(fa => {
      const prioColor = fa.priority==="high"?"var(--danger)":fa.priority==="medium"?"var(--warn)":"var(--success)";
      html += `
        <div style="padding:.85rem;border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:.6rem;border-left:3px solid ${prioColor}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.3rem">
            <span style="font-weight:700;font-size:.88rem">Q${fa.question_number}: ${fa.topic || ""}</span>
            <span style="font-size:.68rem;font-weight:700;text-transform:uppercase;padding:.15rem .45rem;border-radius:4px;background:${prioColor}20;color:${prioColor}">${fa.priority}</span>
          </div>
          <p style="font-size:.82rem;margin:0 0 .3rem;color:var(--text-secondary)"><strong>Issue:</strong> ${fa.issue || ""}</p>
          <p style="font-size:.82rem;margin:0;color:var(--accent)"><strong>Action:</strong> ${fa.recommendation || ""}</p>
        </div>`;
    });
  }

  // Teaching Tips
  if(ins.teaching_tips?.length) {
    html += `<div style="margin-top:1.5rem;padding:1rem;background:rgba(111,66,193,.06);border:1px solid rgba(111,66,193,.2);border-radius:var(--radius-sm)">
      <h4 style="margin:0 0 .5rem;color:#b184f5;font-size:.9rem">💡 Teaching Tips</h4>
      <ol style="margin:0;padding-left:1.2rem;font-size:.85rem;line-height:1.8;color:var(--text)">${ins.teaching_tips.map(t=>`<li>${t}</li>`).join("")}</ol>
    </div>`;
  }

  $("insightsContent").innerHTML = html;
}

// Notifications (class-scoped)
async function loadClassNotifications(){
  if(!currentClass)return;const c=creds();
  try{
    const d=await jf("/api/teacher/notifications",{method:"POST",body:JSON.stringify(c)});
    allNotifs=d.notifications||[];
    const classQuizIds=new Set(allQuizzes.filter(q=>q.class_id===currentClass.id).map(q=>q.title));
    const filtered=allNotifs.filter(n=>classQuizIds.has(n.quiz_title));
    const cont=$("detailNotifsContainer");
    if(!filtered.length){cont.innerHTML='<div class="card"><div class="empty-state"><div class="empty-icon">🔔</div><p>No alerts</p></div></div>';return}
    cont.innerHTML=filtered.map(n=>`<div class="notif-item ${n.acknowledged?"":"unread"}">${n.snapshot_b64?`<img src="data:image/jpeg;base64,${n.snapshot_b64}" style="cursor:pointer" onclick="window._openSnapshotModal('data:image/jpeg;base64,${n.snapshot_b64}','${encodeURIComponent(n.appeal_text||"")}')" />`:'<div style="width:80px;height:60px;background:var(--surface-2);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:1.5rem">📷</div>'}<div class="notif-meta"><strong>${n.student_name||"Unknown"}</strong> — ${n.quiz_title||""}<small>P(cheat): ${(n.cheat_probability*100).toFixed(1)}% · ${new Date(n.detected_at).toLocaleString()}</small>${n.appeal_text?'<div style="margin-top:.25rem;font-size:.8rem;color:var(--accent);font-weight:600">Appeal Filed</div>':""}</div>${n.acknowledged?'<span class="tag" style="background:rgba(34,197,94,.15);color:var(--success)">ACK</span>':`<button class="ghost" style="font-size:.75rem;padding:.3rem .65rem" onclick="window._ackNotifDetail(${n.id},this)">Ack</button>`}</div>`).join("");
  }catch(e){console.error(e)}
}
$("detailRefreshNotifs")?.addEventListener("click",loadClassNotifications);

window._ackNotifDetail=async function(id,btn){
  const c=creds();
  try{await jf(`/api/teacher/notifications/${id}/acknowledge`,{method:"POST",body:JSON.stringify({email:c.email,password:c.password})});btn.closest(".notif-item").classList.remove("unread");btn.outerHTML='<span class="tag" style="background:rgba(34,197,94,.15);color:var(--success)">ACK</span>'}catch(e){alert(e.message)}
};

// Camera logic
const cfg=window.__PORTAL__||{};let modelReady=false;
async function checkHealth(){const b=$("quizModelBanner");try{const h=await fetch("/health").then(r=>r.json());modelReady=!!h.model_configured;if(b){if(modelReady)b.hidden=true;else{b.hidden=false;b.className="model-banner error";b.textContent="No weights. Run: python prepare_demo_weights.py"}}}catch(e){modelReady=false;if(b){b.hidden=false;b.className="model-banner error";b.textContent="Health check failed"}}}
function apiH(){const h={};if(cfg.apiKeyRequired){const k=($("apiKeyStore")&&$("apiKeyStore").value.trim())||localStorage.getItem("proctor_api_key")||"";if(k)h["X-API-Key"]=k}return h}
const BUF=4,vid=$("quizVideo"),cvs=$("quizCanvas");let stream=null,timer=null,snaps=[],fbuf=[],inflight=false;
function cap(){if(!vid.videoWidth)return;const c=cvs.getContext("2d"),vw=vid.videoWidth,vh=vid.videoHeight,s=Math.min(vw,vh),sx=Math.round((vw-s)/2),sy=Math.round((vh-s)/2);cvs.width=640;cvs.height=640;c.drawImage(vid,sx,sy,s,s,0,0,640,640);cvs.toBlob(b=>{if(!b)return;fbuf.push(b);const e=$("bufferProgress");if(e)e.textContent="Buffer "+fbuf.length+"/"+BUF;if(fbuf.length>=BUF&&!inflight)sendB()},"image/jpeg",.88)}
async function sendB(){if(inflight)return;inflight=true;const batch=fbuf.splice(0,fbuf.length);const t0=performance.now();try{const fd=new FormData();batch.forEach((b,i)=>fd.append("files",b,"f"+i+".jpg"));const h=Object.assign({},apiH());h["X-Client-Reference"]="teacher-cam";const r=await fetch("/api/predict_batch",{method:"POST",body:fd,headers:h});const d=await r.json().catch(()=>({}));if(!r.ok){msg("quizMsg",d.detail||r.statusText,"error");if(r.status===503)await checkHealth();return}const a=d.avg_cheat_probability??0,m=d.max_cheat_probability??0;$("cheatProbText").textContent=a.toFixed(4);$("cheatMeter").style.width=Math.min(100,a*100)+"%";$("quizMeta").textContent="avg="+a.toFixed(3)+" max="+m.toFixed(3)+" "+Math.round(performance.now()-t0)+"ms";if(d.alert){msg("quizMsg","ALERT","error");if(d.best_snapshot_b64){snaps.unshift({url:"data:image/jpeg;base64,"+d.best_snapshot_b64,t:d.timestamp,a:a.toFixed(4)});renderSnaps()}}else msg("quizMsg","Live","ok")}catch(e){msg("quizMsg","Failed: "+e.message,"error")}finally{inflight=false;const e=$("bufferProgress");if(e)e.textContent=""}}
$("quizStartBtn")?.addEventListener("click",async()=>{await checkHealth();if(!modelReady){msg("quizMsg","No weights","error");return}try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"user",width:{ideal:640},height:{ideal:480}},audio:false});vid.srcObject=stream;await vid.play();$("badgeLive").classList.add("on");msg("quizMsg","Live","ok");if(timer)clearInterval(timer);fbuf=[];timer=setInterval(cap,Math.max(400,parseInt($("quizInterval")?.value||"1000",10)||1000))}catch(e){msg("quizMsg","Camera: "+e.message,"error")}});
$("quizStopBtn")?.addEventListener("click",()=>{if(timer){clearInterval(timer);timer=null}if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}vid.srcObject=null;$("badgeLive").classList.remove("on");fbuf=[];msg("quizMsg","Stopped","warn");const e=$("bufferProgress");if(e)e.textContent=""});
function renderSnaps(){const r=$("snapshotGallery");r.innerHTML="";snaps.slice(0,24).forEach(s=>{const i=document.createElement("img");i.src=s.url;i.className="alert";i.title=(s.t||"")+" avg="+s.a;r.appendChild(i)})}
$("clearSnapshotsBtn")?.addEventListener("click",()=>{snaps.length=0;renderSnaps()});
checkHealth();

// Fallback initial load if teacher_portal.js hasn't called _teacherStoreData yet
setTimeout(async()=>{
  if(allClasses.length)return;
  const c=creds();if(!c.email)return;
  try{const d=await jf("/api/teacher/dashboard",{method:"POST",body:JSON.stringify(c)});window._teacherStoreData(d.classes||[],d.quizzes||[],d.notification_count||0)}catch(e){console.error(e)}
},1200);
})();
