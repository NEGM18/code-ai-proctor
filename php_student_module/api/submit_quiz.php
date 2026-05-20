<?php
require_once 'db.php';

header('Content-Type: application/json');

if (!isset($_SESSION['student_id'])) {
    echo json_encode(["error" => "Unauthorized"]);
    exit;
}

$student_id = $_SESSION['student_id'];

$data = json_decode(file_get_contents('php://input'), true);
$attempt_id = $data['attempt_id'] ?? null;
$answers = $data['answers'] ?? []; // format: { question_id: 'a', question_id2: 'c' }

if (!$attempt_id) {
    echo json_encode(["ok" => false, "error" => "Attempt ID is required."]);
    exit;
}

try {
    // Verify attempt belongs to student and is not completed
    $stmt = $pdo->prepare("SELECT id, quiz_id, is_completed FROM quiz_attempts WHERE id = ? AND student_id = ?");
    $stmt->execute([$attempt_id, $student_id]);
    $attempt = $stmt->fetch();

    if (!$attempt) {
        echo json_encode(["ok" => false, "error" => "Invalid attempt."]);
        exit;
    }

    if ($attempt['is_completed']) {
        echo json_encode(["ok" => false, "error" => "Quiz already completed."]);
        exit;
    }

    $quiz_id = $attempt['quiz_id'];

    // Fetch correct answers for the quiz
    $stmt_questions = $pdo->prepare("SELECT id, correct_option FROM quiz_questions WHERE quiz_id = ?");
    $stmt_questions->execute([$quiz_id]);
    $correct_answers = $stmt_questions->fetchAll(PDO::FETCH_KEY_PAIR);

    $score = 0;
    foreach ($answers as $q_id => $selected_option) {
        if (isset($correct_answers[$q_id]) && $correct_answers[$q_id] === $selected_option) {
            $score++;
        }
    }

    // Mark attempt as completed
    $stmt_update = $pdo->prepare("UPDATE quiz_attempts SET score = ?, is_completed = 1, completed_at = CURRENT_TIMESTAMP WHERE id = ?");
    $stmt_update->execute([$score, $attempt_id]);

    echo json_encode(["ok" => true, "score" => $score, "total" => count($correct_answers)]);

} catch (\PDOException $e) {
    echo json_encode(["ok" => false, "error" => "Failed to submit quiz."]);
}
?>
