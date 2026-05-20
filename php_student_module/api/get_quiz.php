<?php
require_once 'db.php';

header('Content-Type: application/json');

if (!isset($_SESSION['student_id'])) {
    echo json_encode(["error" => "Unauthorized"]);
    exit;
}

$student_id = $_SESSION['student_id'];
$quiz_id = $_GET['id'] ?? null;

if (!$quiz_id) {
    echo json_encode(["ok" => false, "error" => "Quiz ID is required."]);
    exit;
}

try {
    // Verify the student is enrolled in the class for this quiz
    $stmt = $pdo->prepare("
        SELECT q.id, q.title, q.time_limit_minutes, q.is_active 
        FROM quizzes q
        JOIN student_classes sc ON q.class_id = sc.class_id
        WHERE q.id = ? AND sc.student_id = ?
    ");
    $stmt->execute([$quiz_id, $student_id]);
    $quiz = $stmt->fetch();

    if (!$quiz || !$quiz['is_active']) {
        echo json_encode(["ok" => false, "error" => "Quiz not available."]);
        exit;
    }

    // Fetch Questions
    $stmt_questions = $pdo->prepare("
        SELECT id, question_text, image_path, option_a, option_b, option_c, option_d 
        FROM quiz_questions 
        WHERE quiz_id = ?
    ");
    $stmt_questions->execute([$quiz_id]);
    $questions = $stmt_questions->fetchAll();

    // Start an attempt if not already started or completed
    $stmt_attempt = $pdo->prepare("SELECT id, is_completed FROM quiz_attempts WHERE quiz_id = ? AND student_id = ?");
    $stmt_attempt->execute([$quiz_id, $student_id]);
    $attempt = $stmt_attempt->fetch();

    if (!$attempt) {
        $stmt_insert_attempt = $pdo->prepare("INSERT INTO quiz_attempts (quiz_id, student_id, total) VALUES (?, ?, ?)");
        $stmt_insert_attempt->execute([$quiz_id, $student_id, count($questions)]);
        $attempt_id = $pdo->lastInsertId();
    } else {
        $attempt_id = $attempt['id'];
        if ($attempt['is_completed']) {
            echo json_encode(["ok" => false, "error" => "You have already completed this quiz."]);
            exit;
        }
    }

    echo json_encode([
        "ok" => true,
        "quiz" => $quiz,
        "questions" => $questions,
        "attempt_id" => $attempt_id
    ]);

} catch (\PDOException $e) {
    echo json_encode(["ok" => false, "error" => "Failed to load quiz."]);
}
?>
