# AI Observer: Online Exam Cheating Detection Platform

## 1. Project Overview
AI Observer is a robust, self-hosted web application and API that leverages computer vision and AI to proctor online exams and detect potential cheating. It captures student webcam frames during live quizzes and uses a custom-trained YOLO (You Only Look Once) classification model to infer whether the student is "cheating" or "normal." 

The project offers a complete ecosystem including:
- **Organization Management**: For institutions to sign up and manage teachers and students.
- **Teacher Dashboard**: For creating classes, assembling quizzes, managing grades, and reviewing live cheating alerts.
- **Student Portal**: For taking online quizzes, uploading face templates, and receiving real-time automated proctoring.
- **AI Inference Engine**: A fast, local computer vision pipeline running YOLO models via PyTorch/CUDA.

---

## 2. Models Used & AI Capabilities

### YOLO Classification Model
- **Base Model**: Ultralytics YOLO11n-cls (Nano classification model) or YOLO26n (depending on weights).
- **Classes**: It uses a binary classification approach: **`cheating`** vs **`normal`**.
- **Execution**: The model runs inference locally (preferably using CUDA/NVIDIA GPU, gracefully falling back to CPU). 
- **Processing**: Frames are pre-processed by `center_crop_square` to avoid aspect ratio distortions (black padding bars) from typical 4:3 webcam feeds, ensuring YOLO infers on a proper square grid.
- **Temporal Analysis (Batching)**: Instead of flagging cheating on a single erratic frame, `predict_batch` aggregates frame probabilities over a defined window size. It uses streak logic (counting consecutive cheating frames vs normal frames) to balance temporary false positives against consistent cheating behavior.

---

## 3. Workflow
The typical lifecycle of using the AI Observer platform is as follows:

1. **Organization Onboarding**
   - An administrator signs up the organization using the web portal (`POST /api/org/signup`).
   - The organization logs in and bulk-creates (or individually creates) Teacher and Student accounts.
   
2. **Teacher Prepares Classes & Exams**
   - The teacher logs in and creates a new Class (`POST /api/teacher/classes`), receiving a unique `class_code` and password.
   - The teacher creates a Quiz (`POST /api/teacher/quizzes`) and populates it with questions and multiple-choice options (`POST /api/teacher/quizzes/{quiz_id}/questions`).
   - A unique share token/link is generated for the quiz.
   
3. **Student Enrollment & Preparation**
   - The student logs in, completes the mandatory password change, and uploads a required Face Template (for future verification).
   - The student uses the `class_code` and class password to enroll in the class (`POST /api/student/join-class`).

4. **Exam Execution & Live Proctoring**
   - The student opens the Quiz Link. The browser prompts for webcam access (`getUserMedia`).
   - The student starts the attempt (`POST /api/quiz/{share_token}/start`).
   - While answering questions, the frontend periodically takes snapshots from the webcam and sends them to the backend inference API (`POST /api/predict`).
   - The backend runs the YOLO classification. If `P(cheating)` exceeds `PROCTOR_CHEAT_THRESHOLD` (e.g., 0.7), it responds with an `alert: true`.
   - If an alert occurs, the frontend captures a high-resolution snapshot and submits a formal incident (`POST /api/cheating/report`).
   
5. **Review & Grading**
   - The teacher receives real-time notifications about cheating incidents.
   - The teacher reviews snapshots, acknowledges alerts, and downloads CSV exports of grades (`GET /api/teacher/grades/{quiz_id}/export`).
   - Students can file an appeal for flagged exams (`POST /api/student/appeal`).

---

## 4. UI Components

The UI is built using plain HTML, CSS, and Vanilla JavaScript with a focus on responsiveness and an intuitive flow.

- **`templates/exam_portal.html`**: The main Single Page Application (SPA). It uses a tabbed navigation system for different user roles:
  - **Organization Tab**: Allows signups, logins, and creating user accounts. Displays a table of recently added teachers and students.
  - **Teacher Tab**: A complex dashboard with sub-views for "Classes", "Quizzes", and "Notifications". Features modal dialogs for creating entities and uploading images for quiz questions.
  - **Student Tab**: A dashboard showing enrolled classes, pending/active quizzes, and a profile section to upload the face template.

- **`templates/quiz_take.html`**: The dedicated exam environment.
  - Displays quiz meta-data (timer, total questions).
  - Shows the student their live webcam feed in a small picture-in-picture window.
  - Contains the core JavaScript loop that captures `<canvas>` frames from the `<video>` element and POSTs them to the AI endpoints.
  
- **`php_student_module/`**: Alternative PHP-based legacy dashboard and quiz UI for environments deploying via Apache/MySQL.

---

## 5. Detailed Function Reference

Below is a breakdown of every major function driving the application across the backend Python files.

### `cheating_detector.py`
The core AI wrapper that interfaces with the Ultralytics YOLO library.

- `center_crop_square(img)`: Crops the largest centered square from a raw numpy array to prevent aspect ratio stretching.
- `CheatingDetector.__init__(weights, device, imgsz)`: Loads the YOLO classification model into memory onto the specified device.
- `CheatingDetector.predict(image)`: Crops the image and passes it to YOLO. Parses the resulting tensor into a `Prediction` data class (label, confidence, all class probabilities).
- `CheatingDetector.predict_topk(image, k)`: Convenience wrapper to return the top K predictions.
- `CheatingDetector.predict_batch(images, threshold)`: Crucial for temporal stability. Processes a list of frames, calculates the average cheating probability, and tracks "cheat streaks" versus "normal streaks" to confidently determine if the window constitutes a verified alert.

### `proctor_app.py`
The FastAPI application serving all HTTP requests.

**Setup & Auth**
- `get_detector()`: Singleton factory that ensures the model is loaded only once and reloads if weights change.
- `require_api_key()`: Dependency for securing `/api/predict`.
- `db_session()`: Dependency injection for providing an active SQLAlchemy database session to endpoints.

**Organization Routes**
- `api_org_signup()`: Registers a new institution.
- `api_org_login()`: Authenticates an institution.
- `api_org_create_teacher()`: Provisions a new teacher account.
- `api_org_create_student()`: Provisions a new student account.
- `api_org_accounts()` / `api_org_accounts_post()`: Retrieves lists of recently provisioned accounts for dashboard display.

**Teacher Routes**
- `api_teacher_login()`: Authenticates a teacher.
- `api_teacher_dashboard()`: Aggregates classes, quizzes, and unread notification counts for the teacher home view.
- `api_teacher_create_class()`: Instantiates a new class with a random join code.
- `api_teacher_create_quiz()`: Sets up an exam container.
- `api_teacher_add_question()`: Appends a multiple-choice question to a quiz, optionally handling an image upload for the question context.
- `api_teacher_get_questions()`: Returns the question set for a quiz.
- `api_teacher_quiz_link()`: Generates the shareable link for students.
- `api_teacher_grades()`: Returns a JSON table of student scores for a quiz.
- `api_teacher_export_grades()`: Converts grades to a downloadable CSV stream.
- `api_teacher_notifications()`: Retrieves cheating incident reports.
- `api_teacher_ack_notification()`: Dismisses a cheating alert.

**Student Routes**
- `api_student_login()`: Authenticates a student.
- `api_student_change_password()`: Forces password update upon first login.
- `api_student_upload_face()`: Receives and stores a reference face image for the student.
- `api_student_dashboard()`: Aggregates enrolled classes and active/completed quizzes for the student home view.
- `api_student_join_class()`: Validates class code/password and registers the `ClassEnrollment`.

**Quiz Execution Routes**
- `api_quiz_by_token()`: Fetches quiz details and sanitizes questions (hides correct answers) before sending them to the frontend.
- `api_quiz_start()`: Opens a `QuizAttempt` record and timestamps it.
- `api_quiz_answer()`: Records a `QuizAnswer` and checks correctness against the DB.
- `api_quiz_complete()`: Closes the attempt, calculates final score, and returns the grade.
- `api_student_appeal()`: Allows a student to dispute an automated cheating flag.

**AI Routes**
- `api_predict()`: The high-frequency AI inference endpoint. Receives multipart image data, decodes to numpy, runs `detector.predict()`, and returns `alert: true/false`.
- `api_cheating_report()`: Receives a finalized cheating event (often containing a base64 snapshot) from the frontend and creates a `CheatingIncident` row in the database, tying it to the active attempt and notifying the teacher.

### `database.py`
The SQLAlchemy ORM configuration and persistence layer.

**Core Infrastructure**
- `init_engine() / create_tables()`: Bootstraps the connection pool and creates tables if they don't exist. Supports SQLite, MySQL, and SQL Server via ODBC.
- `session_scope() / get_db()`: Connection context managers.

**Entity Creators**
- `create_user()`, `create_organization()`, `create_teacher_account()`, `create_student_account()`, `create_class()`, `create_quiz()`.

**Business Logic Queries**
- `join_class_by_code()`: Matches codes and enrolls students.
- `get_student_dashboard_payload()`: Complex join logic to fetch classes, active quizzes, and completed attempt scores.
- `get_teacher_quizzes() / get_teacher_classes()`: Populates teacher views.

**Proctoring Event Queries**
- `log_prediction() / write_prediction_event()`: Records individual AI inferences (for historical audit logs).
- `record_cheating_incident()`: Saves the confirmed cheating alert and base64 snapshot for teacher review.
- `file_cheating_appeal()`: Updates an incident with student justification.

### `webcam_proctor.py`
A local diagnostic desktop script for testing the YOLO model natively without a web browser.
- `annotate_frame()`: Overlays OpenCV text on the frame showing prediction labels, confidence bars, and colors (Green=OK, Red=ALERT).
- `run_opencv_loop()`: Captures camera frames using `cv2.VideoCapture` and renders them in an active native window.
- `run_tk_loop()`: A fallback GUI loop for environments where `opencv-python-headless` is installed and `cv2.imshow` is unavailable. 

### Utilities
- `auth_passwords.py`: `hash_password(pwd)` and `verify_password(pwd, hash)` utilizing `bcrypt` for secure credential storage.
- `export_utils.py`: `grades_to_csv(grades)` which converts a list of grade dictionaries to a valid CSV byte string.
- `model_paths.py`: Contains `effective_model_path()` which uses globbing to dynamically locate the most recently trained `best.pt` weights file inside the `runs/classify/` directories.
