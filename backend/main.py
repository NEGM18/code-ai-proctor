"""
FastAPI web app and JSON API for proctoring using a trained YOLO classification model.

Optional: Azure SQL Server via DB_CONNECTION_STRING (ODBC). See .env.example and README.
"""
from __future__ import annotations

import asyncio
import base64
import io
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Generator
import numpy as np
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.security import APIKeyHeader
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from PIL import Image
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

import database
from backend.core.security import hash_password, verify_password
from cheating_detector import CheatingDetector
from model_paths import effective_model_path

logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent
templates = Jinja2Templates(directory=str(ROOT / "templates"))

DEVICE = os.environ.get("PROCTOR_DEVICE")
API_KEY = os.environ.get("PROCTOR_API_KEY", "").strip() or None
CHEAT_THRESHOLD = float(os.environ.get("PROCTOR_CHEAT_THRESHOLD", "0.7"))
BATCH_WINDOW_SIZE = int(os.environ.get("PROCTOR_BATCH_SIZE", "3"))

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

_detector: CheatingDetector | None = None
_detector_weights: Path | None = None


def resolved_model_path() -> Path:
    """Re-evaluated so new files under weights/ or runs/ are picked up without restarting."""
    return effective_model_path(PROJECT_ROOT)


def get_detector() -> CheatingDetector:
    global _detector, _detector_weights
    path = resolved_model_path()
    if _detector is not None and _detector_weights == path:
        return _detector
    if not path.is_file():
        raise HTTPException(
            status_code=503,
            detail=f"Model weights not found at {path}. Run prepare_demo_weights.py, train, or set PROCTOR_MODEL_PATH.",
        )
    _detector = CheatingDetector(path, device=DEVICE)
    _detector_weights = path
    return _detector


def require_api_key(x_api_key: str | None = Depends(api_key_header)) -> None:
    if API_KEY is None:
        return
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


def db_session() -> Generator[Session, None, None]:
    if not database.env_wants_database():
        raise HTTPException(
            status_code=503,
            detail="Database not configured. Set DB_CONNECTION_STRING to your ODBC connection string.",
        )
    if not database.is_configured():
        err = database.last_init_error() or "Connection failed. Install ODBC Driver 18 and verify the connection string."
        raise HTTPException(status_code=503, detail=f"Database unavailable: {err}")
    yield from database.get_db()


DbSession = Annotated[Session, Depends(db_session)]


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=256)
    display_name: str | None = Field(default=None, max_length=255)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class OrganizationLoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class OrganizationSignupRequest(BaseModel):
    name: str = Field(min_length=2, max_length=255)
    email: EmailStr
    password: str = Field(min_length=8, max_length=256)
    location: str = Field(min_length=2, max_length=255)
    country: str = Field(min_length=2, max_length=128)
    tax_id: str = Field(min_length=2, max_length=128)
    registration_number: str = Field(min_length=2, max_length=128)
    phone: str = Field(min_length=5, max_length=64)
    website: str = Field(min_length=4, max_length=255)


class TeacherCreateRequest(BaseModel):
    org_email: EmailStr
    org_password: str = Field(min_length=1, max_length=256)
    teacher_id: str = Field(min_length=1, max_length=128)
    full_name: str = Field(min_length=1, max_length=255)
    email: EmailStr
    password: str = Field(min_length=8, max_length=256)
    department: str = Field(min_length=1, max_length=255)


class StudentCreateRequest(BaseModel):
    org_email: EmailStr
    org_password: str = Field(min_length=1, max_length=256)
    student_id: str = Field(min_length=1, max_length=128)
    full_name: str = Field(min_length=1, max_length=255)
    email: EmailStr
    password: str = Field(min_length=8, max_length=256)


class StudentLoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class StudentChangePasswordRequest(BaseModel):
    email: EmailStr
    old_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=8, max_length=256)


class OrganizationAccountsRequest(BaseModel):
    org_email: EmailStr
    org_password: str = Field(min_length=1, max_length=256)


class TeacherLoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class ClassCreateRequest(BaseModel):
    teacher_email: EmailStr
    teacher_password: str = Field(min_length=1, max_length=256)
    name: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=1, max_length=255)


class QuizCreateRequest(BaseModel):
    teacher_email: EmailStr
    teacher_password: str = Field(min_length=1, max_length=256)
    class_id: int
    title: str = Field(min_length=1, max_length=255)
    description: str | None = None
    time_limit_minutes: int | None = None
    start_time: datetime | None = None
    end_time: datetime | None = None


class StudentJoinClassRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)
    class_code: str = Field(min_length=1, max_length=10)
    class_password: str = Field(min_length=1, max_length=255)


class QuizAnswerSubmitRequest(BaseModel):
    attempt_id: int
    question_id: int
    selected_option: str = Field(min_length=1, max_length=1)


class StudentAppealRequest(BaseModel):
    attempt_id: int
    student_email: EmailStr
    student_password: str = Field(min_length=1, max_length=256)
    appeal_text: str = Field(min_length=1)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if database.env_wants_database():
        try:
            database.create_tables()
        except Exception as e:
            database.record_init_failure(e)
            logger.exception("Database schema init failed; app continues without SQL")
    yield


app = FastAPI(title="AI Observer", version="2.0.0", lifespan=lifespan)

# CORS — allow tunnel domain and localhost
from fastapi.middleware.cors import CORSMiddleware
_cors_origins = os.environ.get("CORS_ORIGINS", "http://localhost:8000,http://127.0.0.1:8000").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors_origins],
    allow_methods=["*"],
    allow_headers=["*"],
)

_static_dir = ROOT / "static"
if _static_dir.is_dir():
    app.mount("/static", StaticFiles(directory=str(_static_dir)), name="static")

_uploads_dir = ROOT / "uploads"
_uploads_dir.mkdir(exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(_uploads_dir)), name="uploads")

from fastapi.responses import Response

@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> Response:
    return Response(content=b"", media_type="image/x-icon", status_code=204)



@app.get("/health")
def health() -> dict[str, object]:
    path = resolved_model_path()
    payload: dict[str, object] = {
        "status": "ok",
        "model_configured": path.is_file(),
        "model_path": str(path),
    }
    if not database.env_wants_database():
        payload["database"] = "disabled"
    elif not database.is_configured():
        payload["database"] = "misconfigured"
        if database.last_init_error():
            payload["database_error"] = database.last_init_error()
    else:
        payload["database"] = "connected" if database.ping() else "error"
    return payload


@app.get("/api/meta")
def api_meta() -> dict[str, object]:
    """Stable metadata for LMS or external tools embedding this service."""
    return {
        "name": "online-exam-cheating-classifier",
        "model_path": str(resolved_model_path()),
        "classes": ["cheating", "normal"],
        "cheat_threshold": CHEAT_THRESHOLD,
        "predict_endpoint": "/api/predict",
        "register_endpoint": "/api/register",
        "organization_signup_endpoint": "/api/org/signup",
        "organization_login_endpoint": "/api/org/login",
        "organization_accounts_post_endpoint": "/api/org/accounts",
        "student_dashboard_post_endpoint": "/api/student/dashboard",
        "web_portal": "/",
        "docs": "/docs",
        "database_env_set": database.env_wants_database(),
        "database_ready": database.is_configured(),
    }


@app.post("/api/register")
def api_register(body: RegisterRequest, db: DbSession) -> dict[str, object]:
    if database.get_user_by_email(db, str(body.email)):
        raise HTTPException(status_code=409, detail="Email already registered")
    database.create_user(db, str(body.email), hash_password(body.password), body.display_name)
    return {"ok": True, "email": str(body.email)}


@app.post("/api/login")
def api_login(body: LoginRequest, db: DbSession) -> dict[str, object]:
    user = database.get_user_by_email(db, str(body.email))
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return {"ok": True, "email": user.email, "user_id": user.id}


@app.post("/api/org/login")
def api_org_login(body: OrganizationLoginRequest, db: DbSession) -> dict[str, object]:
    org = database.verify_organization_login(db, str(body.email), body.password)
    if org is None:
        raise HTTPException(status_code=401, detail="Invalid organization credentials")
    return {
        "ok": True,
        "organization": {
            "id": org.id,
            "name": org.name,
            "email": org.email,
            "location": org.location,
            "country": org.country,
            "tax_id": org.tax_id,
            "registration_number": org.registration_number,
            "phone": org.phone,
            "website": org.website,
        },
    }


@app.post("/api/org/signup")
def api_org_signup(body: OrganizationSignupRequest, db: DbSession) -> dict[str, object]:
    if database.get_organization_by_email(db, str(body.email)) is not None:
        raise HTTPException(status_code=409, detail="Organization email already exists")
    row = database.create_organization(
        db,
        name=body.name,
        email=str(body.email),
        password=body.password,
        location=body.location,
        country=body.country,
        tax_id=body.tax_id,
        registration_number=body.registration_number,
        phone=body.phone,
        website=body.website,
    )
    return {"ok": True, "organization_id": row.id, "email": row.email, "name": row.name}


@app.post("/api/org/teachers")
def api_org_create_teacher(body: TeacherCreateRequest, db: DbSession) -> dict[str, object]:
    org = database.verify_organization_login(db, str(body.org_email), body.org_password)
    if org is None:
        raise HTTPException(status_code=401, detail="Invalid organization credentials")
    if database.get_user_by_email(db, str(body.email)) is not None:
        raise HTTPException(status_code=409, detail="Email already used by app user")
    # Prevent collisions with existing teacher/student emails
    if db.scalar(select(database.Teacher).where(database.Teacher.email == str(body.email).lower().strip())):
        raise HTTPException(status_code=409, detail="Teacher email already exists")
    if db.scalar(select(database.Student).where(database.Student.email == str(body.email).lower().strip())):
        raise HTTPException(status_code=409, detail="Student email already exists")
    row = database.create_teacher_account(
        db,
        organization_id=org.id,
        teacher_id=body.teacher_id,
        full_name=body.full_name,
        email=str(body.email),
        password=body.password,
        department=body.department,
    )
    return {"ok": True, "teacher_id": row.teacher_id, "email": row.email}


@app.post("/api/org/students")
def api_org_create_student(body: StudentCreateRequest, db: DbSession) -> dict[str, object]:
    org = database.verify_organization_login(db, str(body.org_email), body.org_password)
    if org is None:
        raise HTTPException(status_code=401, detail="Invalid organization credentials")
    if database.get_user_by_email(db, str(body.email)) is not None:
        raise HTTPException(status_code=409, detail="Email already used by app user")
    if db.scalar(select(database.Teacher).where(database.Teacher.email == str(body.email).lower().strip())):
        raise HTTPException(status_code=409, detail="Teacher email already exists")
    if db.scalar(select(database.Student).where(database.Student.email == str(body.email).lower().strip())):
        raise HTTPException(status_code=409, detail="Student email already exists")
    row = database.create_student_account(
        db,
        organization_id=org.id,
        student_id=body.student_id,
        full_name=body.full_name,
        email=str(body.email),
        password=body.password,
    )
    return {"ok": True, "student_id": row.student_id, "email": row.email}


def _org_accounts_payload(org_email: str, org_password: str, db: Session) -> dict[str, object]:
    org = database.verify_organization_login(db, org_email, org_password)
    if org is None:
        raise HTTPException(status_code=401, detail="Invalid organization credentials")
    rows = database.list_recent_accounts(db, org.id)
    return {"ok": True, "organization_id": org.id, **rows}


@app.get("/api/org/accounts")
def api_org_accounts(
    org_email: EmailStr,
    org_password: str,
    db: DbSession,
) -> dict[str, object]:
    """Prefer POST with a JSON body so credentials are not in the query string."""
    return _org_accounts_payload(str(org_email), org_password, db)


@app.post("/api/org/accounts")
def api_org_accounts_post(body: OrganizationAccountsRequest, db: DbSession) -> dict[str, object]:
    return _org_accounts_payload(str(body.org_email), body.org_password, db)


@app.post("/api/student/login")
def api_student_login(body: StudentLoginRequest, db: DbSession) -> dict[str, object]:
    student = database.verify_student_login(db, str(body.email), body.password)
    if student is None:
        raise HTTPException(status_code=401, detail="Invalid student credentials")
    return {
        "ok": True,
        "student": {
            "id": student.id,
            "student_id": student.student_id,
            "full_name": student.full_name,
            "email": student.email,
            "must_change_password": bool(student.must_change_password),
            "face_uploaded": bool(student.face_template_path),
        },
    }


@app.post("/api/student/change-password")
def api_student_change_password(body: StudentChangePasswordRequest, db: DbSession) -> dict[str, object]:
    student = database.verify_student_login(db, str(body.email), body.old_password)
    if student is None:
        raise HTTPException(status_code=401, detail="Invalid student credentials")
    database.update_student_password(db, student, body.new_password)
    return {"ok": True}


@app.post("/api/student/face")
async def api_student_upload_face(
    db: DbSession,
    email: EmailStr = Header(alias="X-Student-Email"),
    password: str = Header(alias="X-Student-Password"),
    file: UploadFile = File(...),
) -> dict[str, object]:
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Expected an image file")
    student = database.verify_student_login(db, str(email), password)
    if student is None:
        raise HTTPException(status_code=401, detail="Invalid student credentials")
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Empty file")
    folder = ROOT / "uploads" / "student_faces"
    folder.mkdir(parents=True, exist_ok=True)
    ext = ".jpg"
    if file.filename and "." in file.filename:
        ext = "." + file.filename.rsplit(".", 1)[1].lower()
    out = folder / f"{student.student_id}_{datetime.utcnow().strftime('%Y%m%d%H%M%S')}{ext}"
    out.write_bytes(payload)
    database.update_student_face_path(db, student, str(out))
    return {"ok": True, "face_template_path": str(out)}


def _student_dashboard_payload(email: str, password: str, db: Session) -> dict[str, object]:
    student = database.verify_student_login(db, email, password)
    if student is None:
        raise HTTPException(status_code=401, detail="Invalid student credentials")
    return {"ok": True, **database.get_student_dashboard_payload(db, student)}


@app.get("/api/student/dashboard")
def api_student_dashboard(
    email: EmailStr,
    password: str,
    db: DbSession,
) -> dict[str, object]:
    """Prefer POST with a JSON body so the password is not in the query string."""
    return _student_dashboard_payload(str(email), password, db)


@app.post("/api/student/dashboard")
def api_student_dashboard_post(body: StudentLoginRequest, db: DbSession) -> dict[str, object]:
    return _student_dashboard_payload(str(body.email), body.password, db)


@app.get("/", response_class=HTMLResponse)
def portal_home(request: Request) -> HTMLResponse:
    """Landing / login page."""
    return templates.TemplateResponse(
        "exam_portal.html",
        {
            "request": request,
            "cheat_threshold": CHEAT_THRESHOLD,
            "api_key_required": API_KEY is not None,
        },
    )


@app.get("/org-signup", response_class=HTMLResponse)
def org_signup_page(request: Request) -> HTMLResponse:
    """Organization registration page."""
    return templates.TemplateResponse("org_signup.html", {"request": request})


@app.get("/org-dashboard", response_class=HTMLResponse)
def org_dashboard_page(request: Request) -> HTMLResponse:
    """Organization management dashboard."""
    return templates.TemplateResponse("org_dashboard.html", {"request": request})


@app.get("/teacher-dashboard", response_class=HTMLResponse)
def teacher_dashboard_page(request: Request) -> HTMLResponse:
    """Teacher dashboard — classes, quizzes, grades, notifications, camera."""
    return templates.TemplateResponse(
        "teacher_dashboard.html",
        {
            "request": request,
            "cheat_threshold": CHEAT_THRESHOLD,
            "api_key_required": API_KEY is not None,
        },
    )


@app.get("/student-dashboard", response_class=HTMLResponse)
def student_dashboard_page(request: Request) -> HTMLResponse:
    """Student dashboard — courses, quizzes, profile management."""
    return templates.TemplateResponse("student_dashboard.html", {"request": request})


# ---------------------------------------------------------------------------
# Teacher endpoints
# ---------------------------------------------------------------------------

def _auth_teacher(db, email, password):
    teacher = database.verify_teacher_login(db, str(email), password)
    if teacher is None:
        raise HTTPException(status_code=401, detail="Invalid teacher credentials")
    return teacher


@app.post("/api/teacher/login")
def api_teacher_login(body: TeacherLoginRequest, db: DbSession) -> dict[str, object]:
    teacher = _auth_teacher(db, body.email, body.password)
    return {
        "ok": True,
        "teacher": {
            "id": teacher.id, "teacher_id": teacher.teacher_id,
            "full_name": teacher.full_name, "email": teacher.email,
            "department": teacher.department,
            "organization_id": teacher.organization_id,
        },
    }


@app.post("/api/teacher/dashboard")
def api_teacher_dashboard(body: TeacherLoginRequest, db: DbSession) -> dict[str, object]:
    teacher = _auth_teacher(db, body.email, body.password)
    classes = database.get_teacher_classes(db, teacher.id)
    quizzes = database.get_teacher_quizzes(db, teacher.id)
    notifications = database.get_teacher_notifications(db, teacher.id)
    unread = sum(1 for n in notifications if not n["acknowledged"])
    return {
        "ok": True,
        "teacher": {"id": teacher.id, "full_name": teacher.full_name, "email": teacher.email, "department": teacher.department},
        "classes": classes, "quizzes": quizzes,
        "notification_count": unread,
    }


@app.post("/api/teacher/classes")
def api_teacher_create_class(body: ClassCreateRequest, db: DbSession) -> dict[str, object]:
    teacher = _auth_teacher(db, body.teacher_email, body.teacher_password)
    cls = database.create_class(db, teacher_id=teacher.id, organization_id=teacher.organization_id,
                                name=body.name, password=body.password)
    return {"ok": True, "class_id": cls.id, "class_code": cls.class_code, "name": cls.name}


@app.delete("/api/teacher/classes/{class_id}")
def api_teacher_delete_class(class_id: int, body: TeacherLoginRequest, db: DbSession) -> dict[str, object]:
    teacher = _auth_teacher(db, body.email, body.password)
    cls = db.get(database.Class, class_id)
    if cls is None or cls.teacher_id != teacher.id:
        raise HTTPException(status_code=404, detail="Class not found")
    success = database.delete_class(db, class_id)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to delete class")
    return {"ok": True}

@app.post("/api/teacher/quizzes")
def api_teacher_create_quiz(body: QuizCreateRequest, db: DbSession) -> dict[str, object]:
    teacher = _auth_teacher(db, body.teacher_email, body.teacher_password)
    quiz = database.create_quiz(db, class_id=body.class_id, teacher_id=teacher.id,
                                title=body.title, description=body.description,
                                time_limit_minutes=body.time_limit_minutes,
                                start_time=body.start_time, end_time=body.end_time)
    return {"ok": True, "quiz_id": quiz.id, "share_token": quiz.share_token, "title": quiz.title}


@app.delete("/api/teacher/quizzes/{quiz_id}")
def api_teacher_delete_quiz(quiz_id: int, body: TeacherLoginRequest, db: DbSession) -> dict[str, object]:
    teacher = _auth_teacher(db, body.email, body.password)
    quiz = db.get(database.Quiz, quiz_id)
    if quiz is None or quiz.teacher_id != teacher.id:
        raise HTTPException(status_code=404, detail="Quiz not found")
    success = database.delete_quiz(db, quiz_id)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to delete quiz")
    return {"ok": True}


class ClassStructureRequest(BaseModel):
    teacher_email: EmailStr
    teacher_password: str = Field(min_length=1, max_length=256)
    course_structure_json: str


@app.post("/api/teacher/classes/{class_id}/structure")
def api_teacher_save_structure(class_id: int, body: ClassStructureRequest, db: DbSession) -> dict[str, object]:
    teacher = _auth_teacher(db, body.teacher_email, body.teacher_password)
    cls = db.get(database.Class, class_id)
    if cls is None or cls.teacher_id != teacher.id:
        raise HTTPException(status_code=404, detail="Class not found")
    cls.course_structure_json = body.course_structure_json
    db.commit()
    return {"ok": True}


@app.post("/api/teacher/classes/{class_id}/upload_lecture")
async def api_teacher_upload_lecture(
    class_id: int, db: DbSession,
    teacher_email: str = Form(...), teacher_password: str = Form(...),
    file: UploadFile = File(...),
) -> dict[str, object]:
    teacher = _auth_teacher(db, teacher_email, teacher_password)
    cls = db.get(database.Class, class_id)
    if cls is None or cls.teacher_id != teacher.id:
        raise HTTPException(status_code=404, detail="Class not found")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    folder = ROOT / "uploads" / "lectures"
    folder.mkdir(parents=True, exist_ok=True)
    ext = ".pdf"
    if file.filename and "." in file.filename:
        ext = "." + file.filename.rsplit(".", 1)[1].lower()
    fname = f"c{class_id}_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}{ext}"
    out = folder / fname
    out.write_bytes(data)
    file_path = f"/uploads/lectures/{fname}"
    return {"ok": True, "file_path": file_path}


@app.post("/api/teacher/quizzes/{quiz_id}/questions")
async def api_teacher_add_question(
    quiz_id: int, db: DbSession,
    teacher_email: str = Form(...), teacher_password: str = Form(...),
    question_text: str = Form(...),
    option_a: str = Form(...), option_b: str = Form(...),
    option_c: str = Form(...), option_d: str = Form(...),
    correct_option: str = Form(...),
    image: UploadFile | None = File(default=None),
) -> dict[str, object]:
    teacher = _auth_teacher(db, teacher_email, teacher_password)
    image_path = None
    if image and image.content_type and image.content_type.startswith("image/"):
        data = await image.read()
        if data:
            folder = ROOT / "uploads" / "quiz_images"
            folder.mkdir(parents=True, exist_ok=True)
            ext = ".jpg"
            if image.filename and "." in image.filename:
                ext = "." + image.filename.rsplit(".", 1)[1].lower()
            fname = f"q{quiz_id}_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}{ext}"
            out = folder / fname
            out.write_bytes(data)
            image_path = f"/uploads/quiz_images/{fname}"
    existing = database.get_quiz_questions(db, quiz_id)
    q = database.add_quiz_question(
        db, quiz_id=quiz_id, question_text=question_text,
        option_a=option_a, option_b=option_b, option_c=option_c, option_d=option_d,
        correct_option=correct_option, image_path=image_path,
        order_index=len(existing),
    )
    return {"ok": True, "question_id": q.id}


@app.get("/api/teacher/quizzes/{quiz_id}/questions")
def api_teacher_get_questions(quiz_id: int, db: DbSession) -> dict[str, object]:
    questions = database.get_quiz_questions(db, quiz_id)
    return {"ok": True, "questions": questions}


@app.get("/api/teacher/quizzes/{quiz_id}/link")
def api_teacher_quiz_link(quiz_id: int, db: DbSession, request: Request) -> dict[str, object]:
    quiz = db.get(database.Quiz, quiz_id)
    if quiz is None:
        raise HTTPException(status_code=404, detail="Quiz not found")
    base = str(request.base_url).rstrip("/")
    link = f"{base}/quiz/{quiz.share_token}"
    return {"ok": True, "link": link, "share_token": quiz.share_token}


@app.get("/api/teacher/grades/{quiz_id}")
def api_teacher_grades(quiz_id: int, teacher_email: str, teacher_password: str, db: DbSession) -> dict[str, object]:
    _auth_teacher(db, teacher_email, teacher_password)
    grades = database.get_quiz_grades(db, quiz_id)
    return {"ok": True, "grades": grades}


@app.get("/api/teacher/grades/{quiz_id}/export")
def api_teacher_export_grades(quiz_id: int, teacher_email: str, teacher_password: str, db: DbSession):
    _auth_teacher(db, teacher_email, teacher_password)
    from export_utils import grades_to_csv
    grades = database.get_quiz_grades(db, quiz_id)
    csv_bytes = grades_to_csv(grades)
    quiz = db.get(database.Quiz, quiz_id)
    fname = f"grades_{quiz.title.replace(' ', '_') if quiz else quiz_id}.csv"
    return StreamingResponse(
        io.BytesIO(csv_bytes), media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@app.post("/api/teacher/quiz/{quiz_id}/insights")
def api_teacher_quiz_insights(quiz_id: int, body: TeacherLoginRequest, db: DbSession) -> dict:
    """AI-powered teaching insights for a quiz based on student answer patterns."""
    _auth_teacher(db, body.email, body.password)
    from backend.services import ai_tutor
    return ai_tutor.analyze_quiz_for_teacher(db, quiz_id)


@app.post("/api/teacher/notifications")
def api_teacher_notifications(body: TeacherLoginRequest, db: DbSession) -> dict[str, object]:
    teacher = _auth_teacher(db, body.email, body.password)
    notifs = database.get_teacher_notifications(db, teacher.id)
    return {"ok": True, "notifications": notifs}


@app.post("/api/teacher/notifications/{incident_id}/acknowledge")
def api_teacher_ack_notification(incident_id: int, body: TeacherLoginRequest, db: DbSession) -> dict[str, object]:
    _auth_teacher(db, body.email, body.password)
    database.acknowledge_notification(db, incident_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Student class/quiz endpoints
# ---------------------------------------------------------------------------

@app.post("/api/student/join-class")
def api_student_join_class(body: StudentJoinClassRequest, db: DbSession) -> dict[str, object]:
    student = database.verify_student_login(db, str(body.email), body.password)
    if student is None:
        raise HTTPException(status_code=401, detail="Invalid student credentials")
    cls = database.join_class_by_code(db, body.class_code, body.class_password, student.id)
    if cls is None:
        raise HTTPException(status_code=401, detail="Invalid class code or password")
    return {"ok": True, "class_id": cls.id, "class_name": cls.name}


@app.get("/api/quiz/{share_token}")
def api_quiz_by_token(share_token: str, db: DbSession) -> dict[str, object]:
    quiz = database.get_quiz_by_token(db, share_token)
    if quiz is None:
        raise HTTPException(status_code=404, detail="Quiz not found")
    questions = database.get_quiz_questions(db, quiz.id)
    safe_questions = [{
        "id": q["id"], "question_text": q["question_text"],
        "image_path": q["image_path"],
        "option_a": q["option_a"], "option_b": q["option_b"],
        "option_c": q["option_c"], "option_d": q["option_d"],
    } for q in questions]
    cls = db.get(database.Class, quiz.class_id)
    return {
        "ok": True,
        "quiz": {
            "id": quiz.id, "title": quiz.title, "description": quiz.description or "",
            "class_name": cls.name if cls else "", "time_limit_minutes": quiz.time_limit_minutes,
            "question_count": len(safe_questions), "is_active": quiz.is_active,
        },
        "questions": safe_questions,
    }


@app.post("/api/quiz/{share_token}/start")
def api_quiz_start(share_token: str, body: StudentLoginRequest, db: DbSession) -> dict[str, object]:
    student = database.verify_student_login(db, str(body.email), body.password)
    if student is None:
        raise HTTPException(status_code=401, detail="Invalid student credentials")
    quiz = database.get_quiz_by_token(db, share_token)
    if quiz is None or not quiz.is_active:
        raise HTTPException(status_code=404, detail="Quiz not found or inactive")
        
    now = datetime.now()
    start_dt = quiz.start_time.replace(tzinfo=None) if quiz.start_time else None
    end_dt = quiz.end_time.replace(tzinfo=None) if quiz.end_time else None
    
    if start_dt and now < start_dt:
        raise HTTPException(status_code=403, detail="This quiz has not started yet.")
    if end_dt and now > end_dt:
        raise HTTPException(status_code=403, detail="This quiz has already ended.")
        
    attempt = database.start_quiz_attempt(db, quiz.id, student.id)
    return {"ok": True, "attempt_id": attempt.id, "quiz_id": quiz.id, "total": attempt.total}


@app.post("/api/quiz/answer")
def api_quiz_answer(body: QuizAnswerSubmitRequest, db: DbSession) -> dict[str, object]:
    answer = database.submit_quiz_answer(db, body.attempt_id, body.question_id, body.selected_option)
    return {"ok": True, "is_correct": answer.is_correct}


@app.post("/api/quiz/attempt/{attempt_id}/complete")
def api_quiz_complete(attempt_id: int, db: DbSession) -> dict[str, object]:
    attempt = database.complete_quiz_attempt(db, attempt_id)
    is_flagged = database.is_attempt_flagged(db, attempt_id)
    return {"ok": True, "score": attempt.score, "total": attempt.total,
            "percentage": round(attempt.score / attempt.total * 100, 1) if attempt.total else 0,
            "is_flagged": is_flagged}


@app.post("/api/student/appeal")
def api_student_appeal(body: StudentAppealRequest, db: DbSession) -> dict[str, object]:
    student = database.verify_student_login(db, str(body.student_email), body.student_password)
    if student is None:
        raise HTTPException(status_code=401, detail="Invalid student credentials")
    
    database.file_cheating_appeal(db, body.attempt_id, student.id, body.appeal_text)
    return {"ok": True}


# ---------------------------------------------------------------------------
# AI Tutor endpoints
# ---------------------------------------------------------------------------

class QuizTimingRequest(BaseModel):
    attempt_id: int
    question_id: int
    entered_at: datetime
    answered_at: datetime | None = None


@app.post("/api/quiz/timing")
def api_quiz_timing(body: QuizTimingRequest, db: DbSession) -> dict[str, object]:
    """Record time spent on a question during a quiz attempt."""
    database.record_question_timing(
        db, body.attempt_id, body.question_id,
        body.entered_at, body.answered_at,
    )
    return {"ok": True}


class ReviewRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


@app.post("/api/student/quiz/{attempt_id}/review")
def api_student_quiz_review(attempt_id: int, body: ReviewRequest, db: DbSession) -> dict[str, object]:
    """Get AI-powered review for a completed quiz attempt."""
    student = database.verify_student_login(db, str(body.email), body.password)
    if student is None:
        raise HTTPException(status_code=401, detail="Invalid student credentials")
    # Verify attempt belongs to this student
    attempt = db.get(database.QuizAttempt, attempt_id)
    if attempt is None or attempt.student_id != student.id:
        raise HTTPException(status_code=404, detail="Attempt not found")
    if attempt.status != "completed":
        raise HTTPException(status_code=400, detail="Quiz not completed yet")
    from backend.services import ai_tutor
    result = ai_tutor.analyze_quiz_performance(db, attempt_id)
    return {"ok": True, **result}


class PracticeQuizRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)
    num_questions: int = Field(default=5, ge=1, le=20)


@app.post("/api/student/quiz/{attempt_id}/practice")
def api_student_practice_quiz(attempt_id: int, body: PracticeQuizRequest, db: DbSession) -> dict[str, object]:
    """Generate a practice quiz based on weak areas from a completed attempt."""
    student = database.verify_student_login(db, str(body.email), body.password)
    if student is None:
        raise HTTPException(status_code=401, detail="Invalid student credentials")
    attempt = db.get(database.QuizAttempt, attempt_id)
    if attempt is None or attempt.student_id != student.id:
        raise HTTPException(status_code=404, detail="Attempt not found")
    if attempt.status != "completed":
        raise HTTPException(status_code=400, detail="Quiz not completed yet")
    from backend.services import ai_tutor
    result = ai_tutor.generate_practice_quiz(db, attempt_id, body.num_questions)
    return result


@app.get("/student-review/{attempt_id}", response_class=HTMLResponse)
def student_review_page(attempt_id: int, request: Request) -> HTMLResponse:
    """AI Tutor review page for a completed quiz attempt."""
    return templates.TemplateResponse(
        "student_review.html",
        {"request": request, "attempt_id": attempt_id},
    )


@app.get("/quiz/{share_token}", response_class=HTMLResponse)
def quiz_take_page(share_token: str, request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "quiz_take.html",
        {"request": request, "share_token": share_token,
         "cheat_threshold": CHEAT_THRESHOLD, "api_key_required": API_KEY is not None},
    )


class CheatingReportRequest(BaseModel):
    student_email: EmailStr
    quiz_id: int | None = None
    attempt_id: int | None = None
    cheat_probability: float = Field(ge=0.0, le=1.0)
    snapshot_b64: str | None = None


@app.post("/api/cheating/report")
def api_cheating_report(body: CheatingReportRequest, db: DbSession) -> dict[str, object]:
    """Receive cheating reports from the desktop proctoring app.

    When a student is flagged, this endpoint records the incident and
    notifies the teacher in real time.
    """
    student = database.get_student_by_email(db, str(body.student_email))
    if student is None:
        raise HTTPException(status_code=404, detail="Student not found")

    teacher_id = None
    quiz_id_to_use = body.quiz_id
    if body.quiz_id:
        quiz = db.get(database.Quiz, body.quiz_id)
        if quiz:
            teacher_id = quiz.teacher_id
    elif body.attempt_id:
        attempt = db.get(database.QuizAttempt, body.attempt_id)
        if attempt:
            quiz_id_to_use = attempt.quiz_id
            quiz = db.get(database.Quiz, attempt.quiz_id)
            if quiz:
                teacher_id = quiz.teacher_id

    incident = database.record_cheating_incident(
        db,
        student_id=student.id,
        cheat_probability=body.cheat_probability,
        snapshot_b64=body.snapshot_b64,
        attempt_id=body.attempt_id,
        quiz_id=quiz_id_to_use,
        teacher_id=teacher_id,
    )
    return {
        "ok": True,
        "incident_id": incident.id,
        "student_id": student.student_id,
        "teacher_notified": teacher_id is not None,
    }




@app.post("/api/predict")
async def api_predict(
    file: UploadFile = File(...),
    _: None = Depends(require_api_key),
    x_user_email: str | None = Header(default=None, alias="X-User-Email"),
    x_client_reference: str | None = Header(default=None, alias="X-Client-Reference"),
) -> JSONResponse:
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Expected an image file")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")

    detector = get_detector()

    try:
        img = Image.open(io.BytesIO(data)).convert("RGB")
        arr = np.array(img)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not decode image: {e}") from e

    logger.debug("Predict input: shape=%s dtype=%s", arr.shape, arr.dtype)

    pred = detector.predict(arr)
    cheat_prob = pred.probs.get("cheating", 0.0)
    alert = cheat_prob >= CHEAT_THRESHOLD

    logger.info(
        "Prediction: label=%s  cheat_p=%.4f  alert=%s  shape=%s",
        pred.label, cheat_prob, alert, arr.shape,
    )

    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "label": pred.label,
        "confidence": pred.confidence,
        "probs": pred.probs,
        "cheat_probability": cheat_prob,
        "alert": alert,
    }

    if database.is_configured():
        try:

            def _write() -> None:
                database.write_prediction_event(
                    user_email=(x_user_email.strip() if x_user_email else None),
                    label=pred.label,
                    cheat_probability=float(cheat_prob),
                    alert=bool(alert),
                    probs=pred.probs,
                    client_reference=(x_client_reference.strip() if x_client_reference else None),
                )

            await asyncio.to_thread(_write)
        except Exception:
            logger.exception("Failed to persist prediction to database")

    return JSONResponse(payload)


@app.post("/api/predict_batch")
async def api_predict_batch(
    files: list[UploadFile] = File(...),
    _: None = Depends(require_api_key),
    x_user_email: str | None = Header(default=None, alias="X-User-Email"),
    x_client_reference: str | None = Header(default=None, alias="X-Client-Reference"),
) -> JSONResponse:
    """Batch inference on a window of frames.

    The frontend collects N frames (default 10) and sends them all at once.
    The backend runs inference on each, aggregates via average P(cheating),
    and returns the verdict plus the single best snapshot (highest cheating
    probability) as a base64-encoded JPEG when an alert is triggered.
    """
    if not files:
        raise HTTPException(status_code=400, detail="No files provided")
    if len(files) > BATCH_WINDOW_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"Too many files: {len(files)} exceeds window size {BATCH_WINDOW_SIZE}",
        )

    # Decode all images.
    arrays: list[np.ndarray] = []
    raw_bytes: list[bytes] = []  # keep the JPEG bytes for the best snapshot
    for i, f in enumerate(files):
        if not f.content_type or not f.content_type.startswith("image/"):
            raise HTTPException(
                status_code=400, detail=f"File {i} is not an image (got {f.content_type})"
            )
        data = await f.read()
        if not data:
            raise HTTPException(status_code=400, detail=f"File {i} is empty")
        try:
            img = Image.open(io.BytesIO(data)).convert("RGB")
            arr = np.array(img)
        except Exception as e:
            raise HTTPException(
                status_code=400, detail=f"Could not decode image {i}: {e}"
            ) from e
        arrays.append(arr)
        raw_bytes.append(data)

    detector = get_detector()
    batch = detector.predict_batch(arrays, threshold=CHEAT_THRESHOLD)

    logger.info(
        "Batch prediction: window=%d  avg_p=%.4f  max_p=%.4f  alert=%s",
        batch.window_size, batch.avg_cheat_probability,
        batch.max_cheat_probability, batch.alert,
    )

    payload: dict[str, object] = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "window_size": batch.window_size,
        "avg_cheat_probability": batch.avg_cheat_probability,
        "max_cheat_probability": batch.max_cheat_probability,
        "min_cheat_probability": batch.min_cheat_probability,
        "cheat_threshold": CHEAT_THRESHOLD,
        "alert": batch.alert,
        "per_frame_probs": batch.cheat_probs,
    }

    # Include the best-snapshot JPEG as base64 only when there is an alert.
    if batch.alert:
        best_jpeg = raw_bytes[batch.best_frame_index]
        payload["best_snapshot_b64"] = base64.b64encode(best_jpeg).decode("ascii")
        payload["best_frame_index"] = batch.best_frame_index
        payload["best_frame_cheat_probability"] = batch.max_cheat_probability

    # Persist the aggregated event to the database (if configured).
    if database.is_configured():
        try:
            def _write() -> None:
                database.write_prediction_event(
                    user_email=(x_user_email.strip() if x_user_email else None),
                    label="cheating" if batch.alert else "normal",
                    cheat_probability=float(batch.avg_cheat_probability),
                    alert=bool(batch.alert),
                    probs={"avg": batch.avg_cheat_probability, "max": batch.max_cheat_probability},
                    client_reference=(x_client_reference.strip() if x_client_reference else None),
                )
            await asyncio.to_thread(_write)
        except Exception:
            logger.exception("Failed to persist batch prediction to database")

    return JSONResponse(payload)
