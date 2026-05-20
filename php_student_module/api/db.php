<?php
// php_student_module/api/db.php
// Database connection for local XAMPP environment

$host = '127.0.0.1';
$db   = 'ai_observer_php';
$user = 'root'; // Default XAMPP username
$pass = '';     // Default XAMPP password is empty
$charset = 'utf8mb4';

$dsn = "mysql:host=$host;dbname=$db;charset=$charset";
$options = [
    PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    PDO::ATTR_EMULATE_PREPARES   => false,
];

try {
    $pdo = new PDO($dsn, $user, $pass, $options);
} catch (\PDOException $e) {
    // In production, do not expose the error message
    header('HTTP/1.1 500 Internal Server Error');
    echo json_encode(["error" => "Database connection failed: " . $e->getMessage()]);
    exit;
}

// Session configuration
session_start();

// Mock login for demonstration if no session exists
if (!isset($_SESSION['student_id'])) {
    // For demo purposes, we log in as STU001 (id = 1)
    $_SESSION['student_id'] = 1; 
    $_SESSION['student_name'] = "John Doe";
}
?>
