"""Database persistence for users, organizations, teachers, and students.

Supports SQLite, XAMPP MySQL (via pymysql), and Azure SQL (via pyodbc).
"""
from __future__ import annotations

import json
import logging
import os
import random
import re
import string
import urllib.parse
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Generator, Optional

from dotenv import load_dotenv

load_dotenv()  # Load .env file before reading any env vars

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    create_engine,
    inspect,
    select,
    text,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker

from backend.core.security import hash_password, verify_password

logger = logging.getLogger(__name__)

# Pulling the raw string from your environment variable
_connection_string = os.environ.get("DB_CONNECTION_STRING", "").strip()
_engine = None
_SessionLocal: sessionmaker[Session] | None = None
_init_error: str | None = None


class Base(DeclarativeBase):
    pass


class AppUser(Base):
    __tablename__ = "app_users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    display_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    predictions: Mapped[list["ProctorPrediction"]] = relationship(back_populates="user")


class ProctorPrediction(Base):
    __tablename__ = "proctor_predictions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("app_users.id"), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    label: Mapped[str] = mapped_column(String(64), nullable=False)
    cheat_probability: Mapped[float] = mapped_column(Float, nullable=False)
    alert: Mapped[bool] = mapped_column(Boolean, nullable=False)
    probs_json: Mapped[str] = mapped_column(Text, nullable=False)
    client_reference: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)

    user: Mapped[Optional["AppUser"]] = relationship(back_populates="predictions")


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    location: Mapped[str] = mapped_column(String(255), nullable=False)
    country: Mapped[str] = mapped_column(String(128), nullable=False)
    tax_id: Mapped[str] = mapped_column(String(128), nullable=False)
    registration_number: Mapped[str] = mapped_column(String(128), nullable=False)
    phone: Mapped[str] = mapped_column(String(64), nullable=False)
    website: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Teacher(Base):
    __tablename__ = "teachers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), nullable=False, index=True)
    teacher_id: Mapped[str] = mapped_column(String(128), nullable=False)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    department: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Student(Base):
    __tablename__ = "students"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), nullable=False, index=True)
    student_id: Mapped[str] = mapped_column(String(128), nullable=False)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    program: Mapped[str] = mapped_column(String(255), nullable=False, default="General")
    face_template_path: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    must_change_password: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Class(Base):
    __tablename__ = "classes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    teacher_id: Mapped[int] = mapped_column(ForeignKey("teachers.id"), nullable=False, index=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    class_code: Mapped[str] = mapped_column(String(10), unique=True, nullable=False, index=True)
    password: Mapped[str] = mapped_column(String(255), nullable=False)
    course_structure_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class ClassEnrollment(Base):
    __tablename__ = "class_enrollments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    class_id: Mapped[int] = mapped_column(ForeignKey("classes.id"), nullable=False, index=True)
    student_id: Mapped[int] = mapped_column(ForeignKey("students.id"), nullable=False, index=True)
    enrolled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Quiz(Base):
    __tablename__ = "quizzes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    class_id: Mapped[int] = mapped_column(ForeignKey("classes.id"), nullable=False, index=True)
    teacher_id: Mapped[int] = mapped_column(ForeignKey("teachers.id"), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    share_token: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    time_limit_minutes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    start_time: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    end_time: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class QuizQuestion(Base):
    __tablename__ = "quiz_questions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    quiz_id: Mapped[int] = mapped_column(ForeignKey("quizzes.id"), nullable=False, index=True)
    question_text: Mapped[str] = mapped_column(Text, nullable=False)
    image_path: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    option_a: Mapped[str] = mapped_column(Text, nullable=False)
    option_b: Mapped[str] = mapped_column(Text, nullable=False)
    option_c: Mapped[str] = mapped_column(Text, nullable=False)
    option_d: Mapped[str] = mapped_column(Text, nullable=False)
    correct_option: Mapped[str] = mapped_column(String(1), nullable=False)
    order_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class QuizAttempt(Base):
    __tablename__ = "quiz_attempts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    quiz_id: Mapped[int] = mapped_column(ForeignKey("quizzes.id"), nullable=False, index=True)
    student_id: Mapped[int] = mapped_column(ForeignKey("students.id"), nullable=False, index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    score: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="in_progress")


class QuizAnswer(Base):
    __tablename__ = "quiz_answers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    attempt_id: Mapped[int] = mapped_column(ForeignKey("quiz_attempts.id"), nullable=False, index=True)
    question_id: Mapped[int] = mapped_column(ForeignKey("quiz_questions.id"), nullable=False, index=True)
    selected_option: Mapped[str] = mapped_column(String(1), nullable=False)
    is_correct: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class QuizAnswerTiming(Base):
    __tablename__ = "quiz_answer_timings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    attempt_id: Mapped[int] = mapped_column(ForeignKey("quiz_attempts.id"), nullable=False, index=True)
    question_id: Mapped[int] = mapped_column(ForeignKey("quiz_questions.id"), nullable=False, index=True)
    entered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    answered_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_seconds: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)


class CheatingIncident(Base):
    __tablename__ = "cheating_incidents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    attempt_id: Mapped[Optional[int]] = mapped_column(ForeignKey("quiz_attempts.id"), nullable=True, index=True)
    student_id: Mapped[int] = mapped_column(ForeignKey("students.id"), nullable=False, index=True)
    quiz_id: Mapped[Optional[int]] = mapped_column(ForeignKey("quizzes.id"), nullable=True, index=True)
    teacher_id: Mapped[Optional[int]] = mapped_column(ForeignKey("teachers.id"), nullable=True, index=True)
    snapshot_b64: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    cheat_probability: Mapped[float] = mapped_column(Float, nullable=False)
    detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    acknowledged: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    appeal_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)


def env_wants_database() -> bool:
    return bool(_connection_string)


def is_configured() -> bool:
    return _SessionLocal is not None


def last_init_error() -> str | None:
    return _init_error


def _redact_connection_error(msg: str) -> str:
    return re.sub(r"(?i)\b(Pwd|Password)\s*=\s*[^;]+", r"\1=***", msg)[:800]


def _shutdown_engine() -> None:
    global _engine, _SessionLocal
    if _engine is not None:
        try:
            _engine.dispose()
        except Exception:
            logger.exception("Engine dispose failed")
    _engine = None
    _SessionLocal = None


def record_init_failure(exc: BaseException) -> None:
    global _init_error
    _init_error = _redact_connection_error(str(exc).split("\n")[0])
    _shutdown_engine()


def init_engine() -> None:
    global _engine, _SessionLocal, _init_error
    _init_error = None
    
    if not _connection_string:
        _shutdown_engine()
        return
        
    try:
        # Detect SQLite vs MSSQL vs MySQL
        if _connection_string.startswith("sqlite"):
            url_str = _connection_string
            _engine = create_engine(url_str, connect_args={"check_same_thread": False}, future=True)
            logger.info("Using SQLite database: %s", _connection_string)
        elif _connection_string.startswith("mysql"):
            url_str = _connection_string
            _engine = create_engine(url_str, pool_pre_ping=True, future=True)
            logger.info("Using MySQL database")
        else:
            # MSSQL via ODBC
            quoted_conn_str = urllib.parse.quote_plus(_connection_string)
            url_str = f"mssql+pyodbc:///?odbc_connect={quoted_conn_str}"
            _engine = create_engine(url_str, pool_pre_ping=True, future=True)
        
        _SessionLocal = sessionmaker(
            bind=_engine, 
            autoflush=False, 
            autocommit=False, 
            expire_on_commit=False, 
            future=True
        )
        
        # Verification Ping
        with _engine.connect() as conn:
            conn.execute(text("SELECT 1"))
            logger.info("Database connection verified successfully.")

    except Exception as e:
        record_init_failure(e)
        logger.exception("Failed to create SQLAlchemy engine")


def create_tables() -> None:
    if _engine is None:
        return
    Base.metadata.create_all(bind=_engine)
    _ensure_student_schema()
    _ensure_incident_schema()
    _ensure_quiz_time_schema()
    _ensure_class_structure_schema()
    _ensure_answer_timing_schema()


def ping() -> bool:
    if _engine is None:
        return False
    try:
        with _engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


def get_db() -> Generator[Session, None, None]:
    if _SessionLocal is None:
        raise RuntimeError("Database not configured")
    db = _SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def session_scope() -> Generator[Session, None, None]:
    if _SessionLocal is None:
        raise RuntimeError("Database not configured")
    session = _SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_user_by_email(db: Session, email: str) -> AppUser | None:
    return db.scalar(select(AppUser).where(AppUser.email == email.lower().strip()))


def create_user(db: Session, email: str, password_hash: str, display_name: str | None) -> AppUser:
    now = datetime.now(timezone.utc)
    user = AppUser(
        email=email.lower().strip(),
        password_hash=password_hash,
        display_name=display_name,
        created_at=now,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def log_prediction(
    db: Session,
    *,
    user_id: int | None,
    label: str,
    cheat_probability: float,
    alert: bool,
    probs: dict[str, float],
    client_reference: str | None,
) -> None:
    row = ProctorPrediction(
        user_id=user_id,
        created_at=datetime.now(timezone.utc),
        label=label,
        cheat_probability=float(cheat_probability),
        alert=bool(alert),
        probs_json=json.dumps(probs),
        client_reference=(client_reference[:256] if client_reference else None),
    )
    db.add(row)


def write_prediction_event(
    *,
    user_email: str | None,
    label: str,
    cheat_probability: float,
    alert: bool,
    probs: dict[str, float],
    client_reference: str | None,
) -> None:
    with session_scope() as db:
        uid: int | None = None
        if user_email:
            u = get_user_by_email(db, user_email)
            uid = u.id if u else None
        log_prediction(
            db,
            user_id=uid,
            label=label,
            cheat_probability=cheat_probability,
            alert=alert,
            probs=probs,
            client_reference=client_reference,
        )


def create_organization(
    db: Session,
    *,
    name: str,
    email: str,
    password: str,
    location: str,
    country: str,
    tax_id: str,
    registration_number: str,
    phone: str,
    website: str,
) -> Organization:
    row = Organization(
        name=name.strip(),
        email=email.lower().strip(),
        password_hash=hash_password(password),
        location=location.strip(),
        country=country.strip(),
        tax_id=tax_id.strip(),
        registration_number=registration_number.strip(),
        phone=phone.strip(),
        website=website.strip(),
        created_at=datetime.now(timezone.utc),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def get_organization_by_email(db: Session, email: str) -> Organization | None:
    return db.scalar(select(Organization).where(Organization.email == email.lower().strip()))


def verify_organization_login(db: Session, email: str, password: str) -> Organization | None:
    org = get_organization_by_email(db, email)
    if org is None:
        return None
    if not verify_password(password, org.password_hash):
        return None
    return org


def create_teacher_account(
    db: Session,
    *,
    organization_id: int,
    teacher_id: str,
    full_name: str,
    email: str,
    password: str,
    department: str,
) -> Teacher:
    row = Teacher(
        organization_id=organization_id,
        teacher_id=teacher_id.strip(),
        full_name=full_name.strip(),
        email=email.lower().strip(),
        password_hash=hash_password(password),
        department=department.strip(),
        created_at=datetime.now(timezone.utc),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def create_student_account(
    db: Session,
    *,
    organization_id: int,
    student_id: str,
    full_name: str,
    email: str,
    password: str,
    program: str = "General",
    face_template_path: str | None = None,
) -> Student:
    row = Student(
        organization_id=organization_id,
        student_id=student_id.strip(),
        full_name=full_name.strip(),
        email=email.lower().strip(),
        password_hash=hash_password(password),
        program=program.strip(),
        face_template_path=(face_template_path.strip() if face_template_path else None),
        must_change_password=True,
        created_at=datetime.now(timezone.utc),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def list_recent_accounts(db: Session, organization_id: int) -> dict[str, list[dict[str, str]]]:
    t_rows = db.execute(
        select(Teacher)
        .where(Teacher.organization_id == organization_id)
        .order_by(Teacher.id.desc())
        .limit(20)
    ).scalars()
    s_rows = db.execute(
        select(Student)
        .where(Student.organization_id == organization_id)
        .order_by(Student.id.desc())
        .limit(20)
    ).scalars()
    return {
        "teachers": [
            {
                "teacher_id": r.teacher_id,
                "full_name": r.full_name,
                "email": r.email,
                "department": r.department,
                "created_at": str(r.created_at),
            }
            for r in t_rows
        ],
        "students": [
            {
                "student_id": r.student_id,
                "full_name": r.full_name,
                "email": r.email,
                "program": r.program,
                "face_template_path": r.face_template_path or "",
                "created_at": str(r.created_at),
            }
            for r in s_rows
        ],
    }


def get_student_by_email(db: Session, email: str) -> Student | None:
    return db.scalar(select(Student).where(Student.email == email.lower().strip()))


def verify_student_login(db: Session, email: str, password: str) -> Student | None:
    student = get_student_by_email(db, email)
    if student is None:
        return None
    if not verify_password(password, student.password_hash):
        return None
    return student


def update_student_password(db: Session, student: Student, new_password: str) -> None:
    student.password_hash = hash_password(new_password)
    student.must_change_password = False
    db.add(student)
    db.commit()


def update_student_face_path(db: Session, student: Student, face_template_path: str) -> None:
    student.face_template_path = face_template_path
    db.add(student)
    db.commit()


def get_student_dashboard_payload(db: Session, student: Student) -> dict[str, object]:
    # Fetch enrolled classes with teacher names
    enrollments = db.execute(
        select(ClassEnrollment).where(ClassEnrollment.student_id == student.id)
    ).scalars().all()

    classes = []
    class_ids = []
    for e in enrollments:
        cls = db.get(Class, e.class_id)
        if cls is None:
            continue
        class_ids.append(cls.id)
        teacher = db.get(Teacher, cls.teacher_id)
        classes.append({
            "class_id": cls.id,
            "class_name": cls.name,
            "class_code": cls.class_code,
            "teacher_name": teacher.full_name if teacher else "Unknown",
            "teacher_department": teacher.department if teacher else "",
            "course_structure_json": cls.course_structure_json,
            "enrolled_at": str(e.enrolled_at),
        })

    # Fetch active quizzes for enrolled classes
    upcoming_quizzes = []
    for cid in class_ids:
        quizzes = db.execute(
            select(Quiz).where(Quiz.class_id == cid, Quiz.is_active == True)
            .order_by(Quiz.created_at.desc())
        ).scalars().all()
        for q in quizzes:
            cls = db.get(Class, q.class_id)
            # Check if student already completed this quiz
            existing_attempt = db.scalar(
                select(QuizAttempt).where(
                    QuizAttempt.quiz_id == q.id,
                    QuizAttempt.student_id == student.id,
                    QuizAttempt.status == "completed",
                )
            )
            qcount = len(db.execute(
                select(QuizQuestion).where(QuizQuestion.quiz_id == q.id)
            ).scalars().all())
            upcoming_quizzes.append({
                "quiz_id": q.id,
                "quiz_title": q.title,
                "description": q.description or "",
                "class_name": cls.name if cls else "",
                "class_id": q.class_id,
                "share_token": q.share_token,
                "time_limit_minutes": q.time_limit_minutes,
                "start_time": str(q.start_time) if q.start_time else None,
                "end_time": str(q.end_time) if q.end_time else None,
                "question_count": qcount,
                "status": "completed" if existing_attempt else "active",
                "score": existing_attempt.score if existing_attempt else None,
                "total": existing_attempt.total if existing_attempt else None,
                "attempt_id": existing_attempt.id if existing_attempt else None,
            })

    return {
        "student": {
            "id": student.id,
            "student_id": student.student_id,
            "full_name": student.full_name,
            "email": student.email,
            "face_uploaded": bool(student.face_template_path),
            "must_change_password": bool(student.must_change_password),
        },
        "classes": classes,
        "upcoming_quizzes": upcoming_quizzes,
    }


def _ensure_student_schema() -> None:
    """Small compatibility migration for existing databases."""
    if _engine is None:
        return
    insp = inspect(_engine)
    if "students" not in insp.get_table_names():
        return
    cols = {c["name"] for c in insp.get_columns("students")}
    if "must_change_password" not in cols:
        dialect = _engine.dialect.name
        with _engine.begin() as conn:
            if dialect == "sqlite":
                conn.execute(text("ALTER TABLE students ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 1"))
            elif dialect == "mysql":
                conn.execute(text("ALTER TABLE students ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 1"))
            else:
                conn.execute(text(
                    "ALTER TABLE students ADD must_change_password BIT NOT NULL CONSTRAINT DF_students_mcp DEFAULT 1"
                ))


def _ensure_incident_schema() -> None:
    """Small compatibility migration for existing databases to add appeal_text."""
    if _engine is None:
        return
    insp = inspect(_engine)
    if "cheating_incidents" not in insp.get_table_names():
        return
    cols = {c["name"] for c in insp.get_columns("cheating_incidents")}
    if "appeal_text" not in cols:
        dialect = _engine.dialect.name
        with _engine.begin() as conn:
            if dialect == "sqlite":
                conn.execute(text("ALTER TABLE cheating_incidents ADD COLUMN appeal_text TEXT NULL"))
            elif dialect == "mysql":
                conn.execute(text("ALTER TABLE cheating_incidents ADD COLUMN appeal_text TEXT NULL"))
            else:
                conn.execute(text("ALTER TABLE cheating_incidents ADD appeal_text TEXT NULL"))


def _ensure_quiz_time_schema() -> None:
    """Compatibility migration for existing databases to add start_time and end_time."""
    if _engine is None:
        return
    insp = inspect(_engine)
    if "quizzes" not in insp.get_table_names():
        return
    cols = {c["name"] for c in insp.get_columns("quizzes")}
    with _engine.begin() as conn:
        if "start_time" not in cols:
            conn.execute(text("ALTER TABLE quizzes ADD COLUMN start_time DATETIME NULL"))
        if "end_time" not in cols:
            conn.execute(text("ALTER TABLE quizzes ADD COLUMN end_time DATETIME NULL"))

def _ensure_class_structure_schema() -> None:
    """Compatibility migration for existing databases to add course_structure_json."""
    if _engine is None:
        return
    insp = inspect(_engine)
    if "classes" not in insp.get_table_names():
        return
    cols = {c["name"] for c in insp.get_columns("classes")}
    with _engine.begin() as conn:
        if "course_structure_json" not in cols:
            dialect = _engine.dialect.name
            if dialect == "sqlite":
                conn.execute(text("ALTER TABLE classes ADD COLUMN course_structure_json TEXT NULL"))
            elif dialect == "mysql":
                conn.execute(text("ALTER TABLE classes ADD COLUMN course_structure_json TEXT NULL"))
            else:
                conn.execute(text("ALTER TABLE classes ADD course_structure_json TEXT NULL"))


def _ensure_answer_timing_schema() -> None:
    """Ensure quiz_answer_timings table exists (handled by create_all, this is a no-op guard)."""
    pass  # Table is created by Base.metadata.create_all; keep for consistency.


init_engine()


# ---------------------------------------------------------------------------
# Teacher helpers
# ---------------------------------------------------------------------------

def get_teacher_by_email(db: Session, email: str) -> Teacher | None:
    return db.scalar(select(Teacher).where(Teacher.email == email.lower().strip()))


def verify_teacher_login(db: Session, email: str, password: str) -> Teacher | None:
    teacher = get_teacher_by_email(db, email)
    if teacher is None:
        return None
    if not verify_password(password, teacher.password_hash):
        return None
    return teacher


# ---------------------------------------------------------------------------
# Class helpers
# ---------------------------------------------------------------------------

def _generate_class_code(db: Session) -> str:
    for _ in range(20):
        code = "".join(random.choices(string.ascii_uppercase + string.digits, k=6))
        if not db.scalar(select(Class).where(Class.class_code == code)):
            return code
    raise RuntimeError("Could not generate unique class code")


def create_class(db: Session, *, teacher_id: int, organization_id: int, name: str, password: str) -> Class:
    row = Class(
        teacher_id=teacher_id,
        organization_id=organization_id,
        name=name.strip(),
        class_code=_generate_class_code(db),
        password=password,
        created_at=datetime.now(timezone.utc),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def get_teacher_classes(db: Session, teacher_id: int) -> list[dict]:
    rows = db.execute(
        select(Class).where(Class.teacher_id == teacher_id).order_by(Class.id.desc())
    ).scalars().all()
    result = []
    for c in rows:
        enrolled = db.execute(
            select(ClassEnrollment).where(ClassEnrollment.class_id == c.id)
        ).scalars().all()
        result.append({
            "id": c.id, "name": c.name, "class_code": c.class_code,
            "password": c.password, "student_count": len(enrolled),
            "course_structure_json": c.course_structure_json,
            "created_at": str(c.created_at),
        })
    return result


def enroll_student_in_class(db: Session, class_id: int, student_id: int) -> ClassEnrollment:
    existing = db.scalar(
        select(ClassEnrollment).where(
            ClassEnrollment.class_id == class_id,
            ClassEnrollment.student_id == student_id,
        )
    )
    if existing:
        return existing
    row = ClassEnrollment(
        class_id=class_id, student_id=student_id,
        enrolled_at=datetime.now(timezone.utc),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def join_class_by_code(db: Session, class_code: str, password: str, student_id: int) -> Class | None:
    cls = db.scalar(select(Class).where(Class.class_code == class_code.upper().strip()))
    if cls is None or cls.password != password:
        return None
    enroll_student_in_class(db, cls.id, student_id)
    return cls


# ---------------------------------------------------------------------------
# Quiz helpers
# ---------------------------------------------------------------------------

def create_quiz(db: Session, *, class_id: int, teacher_id: int, title: str,
                description: str | None = None, time_limit_minutes: int | None = None,
                start_time: datetime | None = None, end_time: datetime | None = None) -> Quiz:
    row = Quiz(
        class_id=class_id, teacher_id=teacher_id,
        title=title.strip(),
        description=description,
        share_token=uuid.uuid4().hex,
        is_active=True,
        time_limit_minutes=time_limit_minutes,
        start_time=start_time,
        end_time=end_time,
        created_at=datetime.now(timezone.utc),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def get_teacher_quizzes(db: Session, teacher_id: int) -> list[dict]:
    rows = db.execute(
        select(Quiz).where(Quiz.teacher_id == teacher_id).order_by(Quiz.id.desc())
    ).scalars().all()
    result = []
    for q in rows:
        qcount = len(db.execute(select(QuizQuestion).where(QuizQuestion.quiz_id == q.id)).scalars().all())
        cls = db.get(Class, q.class_id)
        result.append({
            "id": q.id, "title": q.title, "description": q.description or "",
            "class_name": cls.name if cls else "", "class_id": q.class_id,
            "share_token": q.share_token, "is_active": q.is_active,
            "time_limit_minutes": q.time_limit_minutes,
            "start_time": str(q.start_time) if q.start_time else None,
            "end_time": str(q.end_time) if q.end_time else None,
            "question_count": qcount,
            "created_at": str(q.created_at),
        })
    return result

def delete_quiz(db: Session, quiz_id: int) -> bool:
    quiz = db.get(Quiz, quiz_id)
    if not quiz:
        return False
    # Cascade deletes to preserve DB integrity (delete children before parents)
    
    # 1. Delete answers and incidents associated with attempts of this quiz
    attempts = db.execute(select(QuizAttempt.id).where(QuizAttempt.quiz_id == quiz_id)).scalars().all()
    if attempts:
        db.execute(QuizAnswer.__table__.delete().where(QuizAnswer.attempt_id.in_(attempts)))
        db.execute(CheatingIncident.__table__.delete().where(CheatingIncident.attempt_id.in_(attempts)))
        
    # 2. Delete cheating incidents directly linked to this quiz
    db.execute(CheatingIncident.__table__.delete().where(CheatingIncident.quiz_id == quiz_id))
    
    # 3. Delete attempts
    db.execute(QuizAttempt.__table__.delete().where(QuizAttempt.quiz_id == quiz_id))
    
    # 4. Delete questions
    db.execute(QuizQuestion.__table__.delete().where(QuizQuestion.quiz_id == quiz_id))
    
    # 5. Delete quiz
    db.delete(quiz)
    db.commit()
    return True


def delete_class(db: Session, class_id: int) -> bool:
    """Delete a class and cascade to all its quizzes, enrollments, etc."""
    cls = db.get(Class, class_id)
    if not cls:
        return False
    # Delete all quizzes in this class
    quizzes = db.execute(select(Quiz).where(Quiz.class_id == class_id)).scalars().all()
    for q in quizzes:
        delete_quiz(db, q.id)
    # Delete enrollments
    db.execute(Enrollment.__table__.delete().where(Enrollment.class_id == class_id))
    # Delete the class
    db.delete(cls)
    db.commit()
    return True

def add_quiz_question(db: Session, *, quiz_id: int, question_text: str,
                      option_a: str, option_b: str, option_c: str, option_d: str,
                      correct_option: str, image_path: str | None = None,
                      order_index: int = 0) -> QuizQuestion:
    row = QuizQuestion(
        quiz_id=quiz_id, question_text=question_text.strip(),
        image_path=image_path,
        option_a=option_a.strip(), option_b=option_b.strip(),
        option_c=option_c.strip(), option_d=option_d.strip(),
        correct_option=correct_option.lower().strip(),
        order_index=order_index,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def get_quiz_questions(db: Session, quiz_id: int) -> list[dict]:
    rows = db.execute(
        select(QuizQuestion).where(QuizQuestion.quiz_id == quiz_id)
        .order_by(QuizQuestion.order_index)
    ).scalars().all()
    return [{
        "id": q.id, "question_text": q.question_text, "image_path": q.image_path or "",
        "option_a": q.option_a, "option_b": q.option_b,
        "option_c": q.option_c, "option_d": q.option_d,
        "correct_option": q.correct_option, "order_index": q.order_index,
    } for q in rows]


def get_quiz_by_token(db: Session, share_token: str) -> Quiz | None:
    return db.scalar(select(Quiz).where(Quiz.share_token == share_token))


# ---------------------------------------------------------------------------
# Quiz attempt helpers
# ---------------------------------------------------------------------------

def start_quiz_attempt(db: Session, quiz_id: int, student_id: int) -> QuizAttempt:
    existing = db.scalar(
        select(QuizAttempt).where(
            QuizAttempt.quiz_id == quiz_id,
            QuizAttempt.student_id == student_id,
            QuizAttempt.status == "in_progress",
        )
    )
    if existing:
        return existing
    q = db.get(Quiz, quiz_id)
    total = len(db.execute(select(QuizQuestion).where(QuizQuestion.quiz_id == quiz_id)).scalars().all())
    row = QuizAttempt(
        quiz_id=quiz_id, student_id=student_id,
        started_at=datetime.now(timezone.utc),
        score=0, total=total, status="in_progress",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def submit_quiz_answer(db: Session, attempt_id: int, question_id: int, selected_option: str) -> QuizAnswer:
    question = db.get(QuizQuestion, question_id)
    is_correct = question is not None and question.correct_option == selected_option.lower().strip()
    existing = db.scalar(
        select(QuizAnswer).where(
            QuizAnswer.attempt_id == attempt_id,
            QuizAnswer.question_id == question_id,
        )
    )
    if existing:
        existing.selected_option = selected_option.lower().strip()
        existing.is_correct = is_correct
        db.commit()
        db.refresh(existing)
        return existing
    row = QuizAnswer(
        attempt_id=attempt_id, question_id=question_id,
        selected_option=selected_option.lower().strip(),
        is_correct=is_correct,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def complete_quiz_attempt(db: Session, attempt_id: int) -> QuizAttempt:
    attempt = db.get(QuizAttempt, attempt_id)
    if attempt is None:
        raise ValueError("Attempt not found")
    answers = db.execute(
        select(QuizAnswer).where(QuizAnswer.attempt_id == attempt_id)
    ).scalars().all()
    attempt.score = sum(1 for a in answers if a.is_correct)
    attempt.completed_at = datetime.now(timezone.utc)
    attempt.status = "completed"
    db.commit()
    db.refresh(attempt)
    return attempt


# ---------------------------------------------------------------------------
# Answer timing helpers
# ---------------------------------------------------------------------------

def record_question_timing(db: Session, attempt_id: int, question_id: int,
                           entered_at: datetime, answered_at: datetime | None) -> QuizAnswerTiming:
    duration = 0.0
    if answered_at and entered_at:
        duration = max(0.0, (answered_at - entered_at).total_seconds())
    existing = db.scalar(
        select(QuizAnswerTiming).where(
            QuizAnswerTiming.attempt_id == attempt_id,
            QuizAnswerTiming.question_id == question_id,
        )
    )
    if existing:
        existing.entered_at = entered_at
        existing.answered_at = answered_at
        existing.duration_seconds = duration
        db.commit()
        db.refresh(existing)
        return existing
    row = QuizAnswerTiming(
        attempt_id=attempt_id, question_id=question_id,
        entered_at=entered_at, answered_at=answered_at,
        duration_seconds=duration,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def get_attempt_timings(db: Session, attempt_id: int) -> list[dict]:
    rows = db.execute(
        select(QuizAnswerTiming).where(QuizAnswerTiming.attempt_id == attempt_id)
    ).scalars().all()
    return [{
        "question_id": r.question_id,
        "entered_at": str(r.entered_at),
        "answered_at": str(r.answered_at) if r.answered_at else None,
        "duration_seconds": r.duration_seconds,
    } for r in rows]


def get_attempt_review_data(db: Session, attempt_id: int) -> dict:
    """Return full review payload: questions, student answers, timings, quiz info."""
    attempt = db.get(QuizAttempt, attempt_id)
    if attempt is None:
        return {}
    quiz = db.get(Quiz, attempt.quiz_id)
    if quiz is None:
        return {}
    cls = db.get(Class, quiz.class_id)
    questions = get_quiz_questions(db, quiz.id)
    answers = db.execute(
        select(QuizAnswer).where(QuizAnswer.attempt_id == attempt_id)
    ).scalars().all()
    answer_map = {a.question_id: a for a in answers}
    timings = db.execute(
        select(QuizAnswerTiming).where(QuizAnswerTiming.attempt_id == attempt_id)
    ).scalars().all()
    timing_map = {t.question_id: t.duration_seconds for t in timings}

    total_questions = len(questions)
    time_per_question = (quiz.time_limit_minutes * 60 / total_questions) if quiz.time_limit_minutes and total_questions else None

    result_questions = []
    for q in questions:
        ans = answer_map.get(q["id"])
        time_spent = timing_map.get(q["id"], 0.0)
        is_overtime = time_per_question is not None and time_spent > time_per_question * 1.3  # 30% grace
        result_questions.append({
            "question_id": q["id"],
            "question_text": q["question_text"],
            "option_a": q["option_a"], "option_b": q["option_b"],
            "option_c": q["option_c"], "option_d": q["option_d"],
            "correct_option": q["correct_option"],
            "student_answer": ans.selected_option if ans else None,
            "is_correct": ans.is_correct if ans else False,
            "time_spent_seconds": round(time_spent, 1),
            "expected_time_seconds": round(time_per_question, 1) if time_per_question else None,
            "is_overtime": is_overtime,
        })

    return {
        "attempt_id": attempt_id,
        "quiz_id": quiz.id,
        "quiz_title": quiz.title,
        "class_id": quiz.class_id,
        "class_name": cls.name if cls else "",
        "score": attempt.score,
        "total": attempt.total,
        "percentage": round(attempt.score / attempt.total * 100, 1) if attempt.total else 0,
        "time_limit_minutes": quiz.time_limit_minutes,
        "questions": result_questions,
    }


# ---------------------------------------------------------------------------
# Grades helpers
# ---------------------------------------------------------------------------

def get_quiz_grades(db: Session, quiz_id: int) -> list[dict]:
    attempts = db.execute(
        select(QuizAttempt).where(QuizAttempt.quiz_id == quiz_id)
        .order_by(QuizAttempt.completed_at.desc())
    ).scalars().all()
    result = []
    for a in attempts:
        student = db.get(Student, a.student_id)
        result.append({
            "attempt_id": a.id,
            "student_id": student.student_id if student else "",
            "student_name": student.full_name if student else "",
            "student_email": student.email if student else "",
            "score": a.score, "total": a.total,
            "percentage": round(a.score / a.total * 100, 1) if a.total else 0,
            "status": a.status,
            "started_at": str(a.started_at),
            "completed_at": str(a.completed_at) if a.completed_at else "",
        })
    return result


def get_class_grades(db: Session, class_id: int) -> list[dict]:
    quizzes = db.execute(
        select(Quiz).where(Quiz.class_id == class_id)
    ).scalars().all()
    result = []
    for q in quizzes:
        grades = get_quiz_grades(db, q.id)
        result.append({"quiz_id": q.id, "quiz_title": q.title, "grades": grades})
    return result


# ---------------------------------------------------------------------------
# Cheating incident helpers
# ---------------------------------------------------------------------------

def record_cheating_incident(db: Session, *, student_id: int, cheat_probability: float,
                             snapshot_b64: str | None = None, attempt_id: int | None = None,
                             quiz_id: int | None = None, teacher_id: int | None = None) -> CheatingIncident:
    row = CheatingIncident(
        attempt_id=attempt_id, student_id=student_id,
        quiz_id=quiz_id, teacher_id=teacher_id,
        snapshot_b64=snapshot_b64,
        cheat_probability=cheat_probability,
        detected_at=datetime.now(timezone.utc),
        acknowledged=False,
        appeal_text=None,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def file_cheating_appeal(db: Session, attempt_id: int, student_id: int, appeal_text: str) -> None:
    incidents = db.execute(
        select(CheatingIncident).where(
            CheatingIncident.attempt_id == attempt_id,
            CheatingIncident.student_id == student_id
        )
    ).scalars().all()
    for incident in incidents:
        incident.appeal_text = appeal_text
    db.commit()


def is_attempt_flagged(db: Session, attempt_id: int) -> bool:
    count = db.scalar(
        select(func.count(CheatingIncident.id)).where(
            CheatingIncident.attempt_id == attempt_id,
            CheatingIncident.cheat_probability >= 0.8 # Or whatever threshold
        )
    )
    return count is not None and count > 0


def get_teacher_notifications(db: Session, teacher_id: int) -> list[dict]:
    rows = db.execute(
        select(CheatingIncident).where(CheatingIncident.teacher_id == teacher_id)
        .order_by(CheatingIncident.detected_at.desc()).limit(50)
    ).scalars().all()
    result = []
    for r in rows:
        student = db.get(Student, r.student_id)
        quiz = db.get(Quiz, r.quiz_id) if r.quiz_id else None
        result.append({
            "id": r.id,
            "student_name": student.full_name if student else "",
            "student_email": student.email if student else "",
            "quiz_title": quiz.title if quiz else "",
            "cheat_probability": r.cheat_probability,
            "snapshot_b64": r.snapshot_b64 or "",
            "detected_at": str(r.detected_at),
            "acknowledged": r.acknowledged,
            "appeal_text": r.appeal_text or "",
        })
    return result


def acknowledge_notification(db: Session, incident_id: int) -> None:
    row = db.get(CheatingIncident, incident_id)
    if row:
        row.acknowledged = True
        db.commit()