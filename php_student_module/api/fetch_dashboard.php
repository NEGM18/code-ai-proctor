<?php
require_once 'db.php';

header('Content-Type: application/json');

if (!isset($_SESSION['student_id'])) {
    echo json_encode(["error" => "Unauthorized"]);
    exit;
}

$student_id = $_SESSION['student_id'];

try {
    // Fetch Enrolled Classes
    $stmt = $pdo->prepare("
        SELECT c.id, c.name as class_name, t.full_name as teacher_name 
        FROM student_classes sc
        JOIN classes c ON sc.class_id = c.id
        JOIN teachers t ON c.teacher_id = t.id
        WHERE sc.student_id = ?
    ");
    $stmt->execute([$student_id]);
    $classes = $stmt->fetchAll();

    // Fetch Pending Quizzes
    $stmt = $pdo->prepare("
        SELECT q.id, q.title, q.time_limit_minutes, c.name as class_name 
        FROM quizzes q
        JOIN student_classes sc ON q.class_id = sc.class_id
        JOIN classes c ON q.class_id = c.id
        LEFT JOIN quiz_attempts qa ON qa.quiz_id = q.id AND qa.student_id = ?
        WHERE sc.student_id = ? AND q.is_active = 1 AND (qa.id IS NULL OR qa.is_completed = 0)
    ");
    $stmt->execute([$student_id, $student_id]);
    $quizzes = $stmt->fetchAll();

    echo json_encode([
        "ok" => true,
        "classes" => $classes,
        "quizzes" => $quizzes
    ]);
} catch (\PDOException $e) {
    echo json_encode(["ok" => false, "error" => "Failed to fetch dashboard data."]);
}
?>
