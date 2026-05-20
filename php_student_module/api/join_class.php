<?php
require_once 'db.php';

header('Content-Type: application/json');

if (!isset($_SESSION['student_id'])) {
    echo json_encode(["error" => "Unauthorized"]);
    exit;
}

$student_id = $_SESSION['student_id'];

$data = json_decode(file_get_contents('php://input'), true);
$class_code = $data['class_code'] ?? '';
$class_password = $data['class_password'] ?? '';

if (empty($class_code) || empty($class_password)) {
    echo json_encode(["ok" => false, "error" => "Class code and password are required."]);
    exit;
}

try {
    $stmt = $pdo->prepare("SELECT id FROM classes WHERE class_code = ? AND class_password = ?");
    $stmt->execute([$class_code, $class_password]);
    $class = $stmt->fetch();

    if ($class) {
        // Check if already enrolled
        $stmt_check = $pdo->prepare("SELECT id FROM student_classes WHERE student_id = ? AND class_id = ?");
        $stmt_check->execute([$student_id, $class['id']]);
        
        if ($stmt_check->fetch()) {
            echo json_encode(["ok" => false, "error" => "You are already enrolled in this class."]);
        } else {
            $stmt_insert = $pdo->prepare("INSERT INTO student_classes (student_id, class_id) VALUES (?, ?)");
            $stmt_insert->execute([$student_id, $class['id']]);
            echo json_encode(["ok" => true, "message" => "Successfully joined the class."]);
        }
    } else {
        echo json_encode(["ok" => false, "error" => "Invalid class code or password."]);
    }
} catch (\PDOException $e) {
    echo json_encode(["ok" => false, "error" => "Failed to join class."]);
}
?>
