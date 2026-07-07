"""AI Tutor Service — Gemini-powered knowledge-based tutoring.

Uses teacher-uploaded lecture PDFs as a knowledge base and Google Gemini
to provide personalized tutoring after quiz completion.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

_client = None


def _get_client():
    """Lazy-init the Gemini client."""
    global _client
    if _client is not None:
        return _client
    # Re-read .env every time we try to init, in case key was added after server start
    load_dotenv(override=True)
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set in .env")
    from google import genai
    _client = genai.Client(api_key=api_key)
    return _client


# ---------------------------------------------------------------------------
# PDF text extraction
# ---------------------------------------------------------------------------

def extract_pdf_text(file_path: str) -> str:
    """Extract all text from a PDF file."""
    full_path = ROOT / file_path.lstrip("/")
    if not full_path.is_file():
        logger.warning("PDF not found: %s", full_path)
        return ""
    try:
        from PyPDF2 import PdfReader
        reader = PdfReader(str(full_path))
        pages = []
        for i, page in enumerate(reader.pages):
            text = page.extract_text() or ""
            if text.strip():
                pages.append(f"[Page {i + 1}]\n{text}")
        return "\n\n".join(pages)
    except Exception as e:
        logger.exception("Failed to extract text from %s: %s", file_path, e)
        return ""


def get_class_knowledge_base(db, class_id: int) -> str:
    """Aggregate all lecture PDF text for a class by reading course_structure_json."""
    from database import Class
    cls = db.get(Class, class_id)
    if cls is None or not cls.course_structure_json:
        return ""
    try:
        weeks = json.loads(cls.course_structure_json)
    except (json.JSONDecodeError, TypeError):
        return ""

    texts = []
    for week in weeks:
        for item in week.get("items", []):
            if item.get("type") == "lecture" and item.get("url"):
                label = item.get("label", "Untitled")
                pdf_text = extract_pdf_text(item["url"])
                if pdf_text:
                    texts.append(f"=== LECTURE: {label} ===\n{pdf_text}")
    return "\n\n".join(texts)


# ---------------------------------------------------------------------------
# Quiz performance analysis (AI tutoring)
# ---------------------------------------------------------------------------

def _build_lecture_url_map(db, class_id: int) -> dict[str, str]:
    """Build a map from lecture label to its URL for a class."""
    from database import Class
    cls = db.get(Class, class_id)
    if cls is None or not cls.course_structure_json:
        return {}
    try:
        weeks = json.loads(cls.course_structure_json)
    except (json.JSONDecodeError, TypeError):
        return {}
    url_map = {}
    for week in weeks:
        for item in week.get("items", []):
            if item.get("type") == "lecture" and item.get("url"):
                url_map[item.get("label", "Untitled")] = item["url"]
    return url_map


def analyze_quiz_performance(db, attempt_id: int) -> dict:
    """Analyze a completed quiz attempt and generate AI tutoring for weak questions.

    Returns a dict with the review data + ai_explanations list.
    """
    from database import get_attempt_review_data
    review = get_attempt_review_data(db, attempt_id)
    if not review:
        return {"error": "Attempt not found"}

    # Identify weak questions (wrong OR overtime)
    weak_questions = [q for q in review["questions"] if not q["is_correct"] or q["is_overtime"]]
    if not weak_questions:
        review["ai_explanations"] = []
        review["summary"] = "Great job! You answered all questions correctly and within time."
        return review

    # Build knowledge base
    kb_text = get_class_knowledge_base(db, review["class_id"])
    kb_section = f"\n\nLECTURE CONTENT (Knowledge Base):\n{kb_text}" if kb_text else "\n\n(No lecture materials available for this class.)"

    # Build prompt
    questions_text = ""
    for i, q in enumerate(weak_questions, 1):
        option_labels = {"a": q["option_a"], "b": q["option_b"], "c": q["option_c"], "d": q["option_d"]}
        student_ans_text = option_labels.get(q["student_answer"], "No answer") if q["student_answer"] else "No answer"
        correct_ans_text = option_labels.get(q["correct_option"], "?")

        issues = []
        if not q["is_correct"]:
            issues.append("WRONG ANSWER")
        if q["is_overtime"]:
            issues.append(f"OVERTIME (spent {q['time_spent_seconds']}s, expected ~{q['expected_time_seconds']}s)")

        questions_text += f"""
--- Question {i} [{', '.join(issues)}] ---
Question: {q['question_text']}
A) {q['option_a']}
B) {q['option_b']}
C) {q['option_c']}
D) {q['option_d']}
Student answered: {q['student_answer'].upper() if q['student_answer'] else 'None'}) {student_ans_text}
Correct answer: {q['correct_option'].upper()}) {correct_ans_text}
Time spent: {q['time_spent_seconds']}s (expected: {q['expected_time_seconds'] or 'N/A'}s)
"""

    prompt = f"""You are an expert academic tutor. A student just completed a quiz titled "{review['quiz_title']}" 
and scored {review['score']}/{review['total']} ({review['percentage']}%).

Below are the questions they struggled with (answered wrong or spent too long on).
For each question, provide:
1. A clear, encouraging explanation of WHY their answer was wrong (if applicable)
2. An explanation of the CORRECT answer using the lecture content below
3. A specific reference to WHERE in the lectures they can study this topic (mention the lecture name and page if possible)
4. A brief tip for remembering this concept

IMPORTANT: Be encouraging and supportive. Use the lecture content as the primary source of truth.
If the student got the answer right but took too long, focus on study tips and where to review to gain speed.

{kb_section}

STUDENT'S WEAK QUESTIONS:
{questions_text}

Respond with a JSON array where each element has these fields:
- "question_id": the question number (1-based index from the list above)
- "difficulty_tag": "wrong", "overtime", or "both"
- "explanation": your tutoring explanation (2-4 sentences)
- "correct_answer_explanation": why the correct answer is right, referencing lecture content
- "lecture_reference": a human-readable reference like "Lecture_GAN, Page 11"
- "lecture_filename": EXACTLY the lecture name from the === LECTURE: ... === headers above (e.g. "Lecture_GAN"). Must match exactly.
- "page_number": the page number as an integer (e.g. 11). Use 1 if unsure.
- "highlight_text": a SHORT key phrase (3-8 words) from the lecture content that contains the answer. This will be used to search/highlight in the PDF.
- "study_tip": a brief memory/study tip

Return ONLY the JSON array, no markdown formatting or code blocks."""

    try:
        client = _get_client()
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
        )
        raw = response.text.strip()
        # Clean potential markdown wrapping
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw[:-3]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()

        explanations = json.loads(raw)

        # Map explanations back to question IDs
        for i, exp in enumerate(explanations):
            if i < len(weak_questions):
                exp["original_question_id"] = weak_questions[i]["question_id"]

        # Build lecture URL map from course structure
        lecture_url_map = _build_lecture_url_map(db, review["class_id"])

        # Attach resolved URLs to each explanation
        for exp in explanations:
            fname = exp.get("lecture_filename", "")
            if fname and fname in lecture_url_map:
                exp["lecture_url"] = lecture_url_map[fname]
            else:
                # Try fuzzy match (case-insensitive, partial)
                for lname, lurl in lecture_url_map.items():
                    if fname.lower() in lname.lower() or lname.lower() in fname.lower():
                        exp["lecture_url"] = lurl
                        break

        review["ai_explanations"] = explanations
        review["lecture_url_map"] = lecture_url_map
        review["summary"] = f"You struggled with {len(weak_questions)} out of {review['total']} questions. Let's review them together!"
        return review

    except Exception as e:
        logger.exception("Gemini analysis failed: %s", e)
        # Reset client so next attempt re-creates it
        global _client
        _client = None
        review["ai_explanations"] = []
        review["summary"] = f"AI analysis temporarily unavailable: {str(e)}"
        review["ai_error"] = str(e)
        return review


# ---------------------------------------------------------------------------
# Practice quiz generation
# ---------------------------------------------------------------------------

def generate_practice_quiz(db, attempt_id: int, num_questions: int = 5) -> dict:
    """Generate a practice quiz based on the student's weak areas."""
    from database import get_attempt_review_data
    review = get_attempt_review_data(db, attempt_id)
    if not review:
        return {"error": "Attempt not found"}

    weak_questions = [q for q in review["questions"] if not q["is_correct"] or q["is_overtime"]]
    if not weak_questions:
        weak_questions = review["questions"][:3]  # Fallback: use first 3

    kb_text = get_class_knowledge_base(db, review["class_id"])
    kb_section = f"\n\nLECTURE CONTENT:\n{kb_text}" if kb_text else ""

    topics_text = "\n".join([f"- {q['question_text']}" for q in weak_questions])

    prompt = f"""You are an expert quiz creator for academic courses. A student just took a quiz called "{review['quiz_title']}" 
and struggled with certain topics.

Based on the topics below AND the lecture content, generate {num_questions} NEW multiple-choice questions 
that are SIMILAR to the ones the student struggled with, but NOT identical. The questions should help 
the student practice and reinforce their understanding.

TOPICS THE STUDENT STRUGGLED WITH:
{topics_text}

{kb_section}

Generate {num_questions} questions. Each question must have exactly 4 options (A, B, C, D) with one correct answer.

Respond with a JSON array where each element has:
- "question_text": the question
- "option_a": option A text
- "option_b": option B text
- "option_c": option C text
- "option_d": option D text
- "correct_option": "a", "b", "c", or "d"
- "explanation": brief explanation of why the correct answer is right

Return ONLY the JSON array, no markdown formatting or code blocks."""

    try:
        client = _get_client()
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
        )
        raw = response.text.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw[:-3]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()

        questions = json.loads(raw)
        return {
            "ok": True,
            "quiz_title": f"Practice: {review['quiz_title']}",
            "source_quiz_id": review["quiz_id"],
            "questions": questions,
        }

    except Exception as e:
        logger.exception("Gemini practice quiz generation failed: %s", e)
        return {"ok": False, "error": str(e), "questions": []}


# ---------------------------------------------------------------------------
# Teacher quiz insights (class performance analysis)
# ---------------------------------------------------------------------------

def analyze_quiz_for_teacher(db, quiz_id: int) -> dict:
    """Analyze all student answers for a quiz and generate teaching insights.

    KB = student answer data. Brain = Gemini.
    """
    from database import (Quiz, QuizQuestion, QuizAttempt, QuizAnswer, QuizAnswerTiming,
                          Class, get_quiz_questions, get_quiz_grades)
    from sqlalchemy import select, func

    quiz = db.get(Quiz, quiz_id)
    if quiz is None:
        return {"ok": False, "error": "Quiz not found"}
    cls = db.get(Class, quiz.class_id)

    questions = get_quiz_questions(db, quiz_id)
    grades = get_quiz_grades(db, quiz_id)

    completed = [g for g in grades if g["status"] == "completed"]
    if not completed:
        return {"ok": False, "error": "No completed attempts yet"}

    total_students = len(completed)
    avg_score = sum(g["percentage"] for g in completed) / total_students if total_students else 0

    # Per-question stats
    q_stats = []
    for q in questions:
        qid = q["id"]
        # Get all answers for this question
        answers = db.execute(
            select(QuizAnswer).where(QuizAnswer.question_id == qid)
        ).scalars().all()
        correct_count = sum(1 for a in answers if a.is_correct)
        wrong_count = len(answers) - correct_count

        # Choice distribution
        dist = {"a": 0, "b": 0, "c": 0, "d": 0}
        for a in answers:
            if a.selected_option in dist:
                dist[a.selected_option] += 1

        # Average time
        timings = db.execute(
            select(QuizAnswerTiming).where(QuizAnswerTiming.question_id == qid)
        ).scalars().all()
        avg_time = sum(t.duration_seconds for t in timings) / len(timings) if timings else 0

        pct_correct = round(correct_count / len(answers) * 100, 1) if answers else 0
        q_stats.append({
            "question_id": qid,
            "question_text": q["question_text"],
            "option_a": q["option_a"], "option_b": q["option_b"],
            "option_c": q["option_c"], "option_d": q["option_d"],
            "correct_option": q["correct_option"],
            "total_answers": len(answers),
            "correct_count": correct_count,
            "wrong_count": wrong_count,
            "pct_correct": pct_correct,
            "distribution": dist,
            "avg_time_seconds": round(avg_time, 1),
        })

    # Sort by difficulty (lowest % correct first)
    hardest = sorted(q_stats, key=lambda x: x["pct_correct"])

    # Build prompt for Gemini
    stats_text = ""
    for i, qs in enumerate(q_stats, 1):
        most_chosen = max(qs["distribution"], key=qs["distribution"].get)
        stats_text += f"""
--- Q{i}: {qs['question_text']} ---
Correct answer: {qs['correct_option'].upper()}) {qs['option_' + qs['correct_option']]}
Students who got it right: {qs['correct_count']}/{qs['total_answers']} ({qs['pct_correct']}%)
Most chosen answer: {most_chosen.upper()} (chosen by {qs['distribution'][most_chosen]} students)
Answer distribution: A={qs['distribution']['a']}, B={qs['distribution']['b']}, C={qs['distribution']['c']}, D={qs['distribution']['d']}
Average time spent: {qs['avg_time_seconds']}s
"""

    prompt = f"""You are an expert educational consultant helping a university teacher improve their teaching.

A quiz titled "{quiz.title}" in the class "{cls.name if cls else ''}" was taken by {total_students} students.
The class average was {avg_score:.1f}%.

Below is the per-question performance data from all students:

{stats_text}

Based on this data, provide a comprehensive teaching analysis as a JSON object with these fields:

- "overall_summary": A 2-3 sentence summary of overall class performance. Be direct and professional.
- "class_grade": A letter grade for overall class understanding (A/B/C/D/F)
- "strengths": An array of strings — topics/questions students understood well (high % correct). Be specific about WHAT they understood.
- "weaknesses": An array of strings — topics/questions most students struggled with. Explain WHY they might have struggled (e.g., "Many chose B instead of D, suggesting confusion between X and Y").
- "focus_areas": An array of objects, each with:
  - "question_number": the question number
  - "topic": what topic this question covers  
  - "issue": what went wrong (be specific about the common wrong answer pattern)
  - "recommendation": specific teaching action (e.g., "Revisit this concept with a visual example", "Create a comparison chart between X and Y")
  - "priority": "high", "medium", or "low"
- "teaching_tips": An array of 2-3 actionable suggestions for the teacher to improve student understanding in the next lecture.

Return ONLY the JSON object, no markdown formatting or code blocks."""

    try:
        client = _get_client()
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
        )
        raw = response.text.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw[:-3]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()

        insights = json.loads(raw)
        return {
            "ok": True,
            "quiz_title": quiz.title,
            "class_name": cls.name if cls else "",
            "total_students": total_students,
            "avg_score": round(avg_score, 1),
            "question_stats": q_stats,
            "insights": insights,
        }

    except Exception as e:
        logger.exception("Gemini teacher insights failed: %s", e)
        global _client
        _client = None
        return {"ok": False, "error": str(e), "question_stats": q_stats}
