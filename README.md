# Online exam cheating detection (YOLO classification)

## Setup

1. Create a virtual environment and install **CUDA PyTorch** for your GPU, then install dependencies.

On Windows, **`pip install torch` from the default PyPI index often installs `+cpu`**, so `torch.cuda.is_available()` stays `False` even with an NVIDIA driver. Always install from the PyTorch CUDA wheel index, and confirm the version string contains **`+cu124`** (or your chosen CUDA flavor), not **`+cpu`**:

```bash
pip uninstall -y torch torchvision torchaudio
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
python -c "import torch; print(torch.__version__); print(torch.cuda.is_available())"
pip install -r requirements.txt
```

The CUDA 12.4 wheel is typically compatible with newer drivers (your `nvidia-smi` “CUDA Version” can be higher). Adjust the index URL if you use a different wheel line from [PyTorch install](https://pytorch.org/get-started/locally/).

**If `import torch` fails** after an interrupted download, re-run only the `pip install torch torchvision --index-url ...` line (the wheel is large, ~2.5 GB).

**If pip prints `No space left on device` / `[Errno 28]`:** the CUDA wheel needs several gigabytes free on the drive where Python and pip cache live (often `C:`). Aim for **at least ~5 GB free** before installing. Free space (Disk Cleanup, empty Recycle Bin, move large files), optionally clear pip cache: `pip cache purge`, then install again.

**Quick check:** `python -c "import torch; print(torch.__version__); print(torch.cuda.is_available())"` — you want a version like `2.x.x+cu124` and `True`, not `+cpu` and `False`.

2. Dataset: `online exam cheating detection.v15i.folder/` (Roboflow export). `Unlabeled` images were moved to `_unlabeled_review/` so training uses two classes only.

## Train (GPU required)

```bash
python train_cheating_yolo.py
```

Optional: `python train_cheating_yolo.py --epochs 50 --model yolo11n-cls.pt`
Low-memory GPU/Windows-safe example:
`python train_cheating_yolo.py --batch 8 --workers 0`

Note: Ultralytics classification expects a dataset **directory**. This script accepts either:
- `--data cheating_dataset.yaml` (default; auto-resolves to dataset folder), or
- `--data "online exam cheating detection.v15i.folder"`

Weights are written under `runs/classify/`.

If you see `WinError 1455` (`paging file is too small`) during training, keep `--workers 0` and lower `--batch` (e.g. `4`), then retry. You can also increase the Windows pagefile size.

### Quick demo weights (try the web quiz camera)

Your Roboflow export folder in this repo may be empty until you add images. To still **run inference end-to-end**, generate a tiny synthetic `cheating` / `normal` dataset, fine-tune `yolo11n-cls` for a few epochs, and copy weights to **`weights/best.pt`**:

```bash
python prepare_demo_weights.py
```

The first run downloads `yolo11n-cls.pt` from Ultralytics (needs internet). Uses **CUDA if available**, otherwise CPU (slower). Then start `uvicorn` — the API auto-resolves **`weights/best.pt`** or the newest `runs/**/weights/best.pt` unless `PROCTOR_MODEL_PATH` is set.

**Your Roboflow `train4` run:** weight resolution **always tries `train4` first** (`best.pt`, then `last.pt`, in both nested and flat Ultralytics layouts), before `weights/best.pt`, other runs, or `demo_quiz`. Set `PROCTOR_MODEL_PATH` only if you want to override that. If `train4` has no `weights/` folder, restore `best.pt` from backup or re-run `python train_cheating_yolo.py`.

## Inference (Python)

```python
from cheating_detector import CheatingDetector

d = CheatingDetector("runs/classify/train/weights/best.pt")
print(d.predict("path/to/image.jpg"))
```

## Live webcam test

Uses your trained `best.pt` and the default webcam (`--camera 0`). Press **Q** in the video window to quit.

```bash
python webcam_proctor.py
```

If weights are not found automatically, pass the path Ultralytics printed at the end of training, e.g.:

```bash
python webcam_proctor.py --weights runs\classify\train2\weights\best.pt
```

On a 4GB GPU, increase `--stride` so inference runs less often (e.g. `--stride 5`). Use `--device cpu` if the GPU is busy.

If OpenCV says **`imshow` / `cvShowImage` is not implemented**, you usually have **`opencv-python-headless`**. Fix:

```bash
python -m pip uninstall -y opencv-python-headless
python -m pip install opencv-python
```

Always use **`python -m pip`** so packages install into the same Python you run scripts with (plain `pip` can target a different install).

If you see **`ModuleNotFoundError: No module named 'cv2'`** even though `pip` says `opencv-python` is installed, the `cv2` files are missing — reinstall:

```bash
python -m pip uninstall -y opencv-python
python -m pip install --no-cache-dir opencv-python
python -c "import cv2; print(cv2.__version__)"
```

Or skip OpenCV windows and use the built-in Tk viewer: `python webcam_proctor.py --gui tk` (still requires a working `cv2` for the camera).

## Web app + API

Set `PROCTOR_API_KEY` (optional but recommended). Set `PROCTOR_MODEL_PATH` only if you want an explicit file; otherwise the app searches `weights/best.pt` then the newest `runs/**/weights/best.pt`.

```bash
set PROCTOR_API_KEY=your-secret
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Open http://127.0.0.1:8000/ for the UI. POST `/api/predict` with multipart field `file` and header `X-API-Key` when configured.

### LMS integration

- **Simple**: Link or iframe `https://your-host/` from Moodle/Canvas/Blackboard.
- **LTI 1.3**: Use a separate LTI tool or middleware that launches your app with signed context; this repo exposes a stable JSON API at `/api/predict` for that integration.

## Azure SQL / database (optional)

The API can persist **registered users** and **prediction audit rows** when `DB_CONNECTION_STRING` is set.

1. Install ODBC **Driver 18 for SQL Server** on the machine that runs the app ([Microsoft ODBC driver](https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server)).
2. Install Python deps: `python -m pip install -r requirements.txt` (includes `sqlalchemy`, `pyodbc`, `bcrypt`).
3. Set the environment variable **only on the server** (never commit it). See [`.env.example`](.env.example) for the shape of the value.
4. Start the app: on startup it runs `CREATE TABLE` for `app_users` and `proctor_predictions` if they do not exist.
5. Check `GET /health`: `database` is `connected`, `disabled`, `error`, or `misconfigured` (env set but connection/schema init failed — see `database_error`).

**If you see `IM002` / “Data source name not found”:** Windows does not have the ODBC driver named in your string (often **ODBC Driver 18 for SQL Server**). Install it from Microsoft, then confirm:

```bash
python -c "import pyodbc; print(pyodbc.drivers())"
```

You should see `ODBC Driver 18 for SQL Server` in the list. If you only have **17**, change `Driver={...}` in `DB_CONNECTION_STRING` to match.

**Azure TLS note:** if you still cannot connect after the driver is installed, try `Encrypt=yes` with `TrustServerCertificate=yes` only for isolated testing (less strict than `no`); prefer proper certificates in production.

**Endpoints**

- `POST /api/register` — JSON body `{"email":"...","password":"...","display_name":null}` creates a user (bcrypt password hash).
- `POST /api/login` — JSON body `{"email":"...","password":"..."}` verifies credentials (returns `user_id`; add JWT/session later if you need full auth).
- `POST /api/predict` — unchanged response; if DB is configured, each call also inserts a row. Optional headers:
  - `X-User-Email` — if it matches a registered user, `user_id` is stored on the row.
  - `X-Client-Reference` — optional LMS/exam id string (max 256 chars).

**Security:** database passwords must not live in source control. If a password was shared in chat or logs, **rotate it** in Azure and update the server environment only.

## Environment variables

| Variable | Description |
|----------|-------------|
| `PROCTOR_MODEL_PATH` | Optional explicit path to `best.pt`. If unset: `weights/best.pt`, else newest `runs/**/weights/best.pt`, else legacy `runs/classify/train/weights/best.pt` |
| `PROCTOR_DEVICE` | `cuda`, `cuda:0`, or `cpu` (default: cuda if available) |
| `PROCTOR_API_KEY` | If set, required as `X-API-Key` for `/api/predict` |
| `PROCTOR_CHEAT_THRESHOLD` | Probability above which label is treated as cheating alert (default `0.5`) |
| `DB_CONNECTION_STRING` | Optional ODBC connection string for Azure SQL / SQL Server |

## Web portal (organization + student + live quiz)

The UI is a normal web page served by FastAPI. Start the API on the machine where your trained weights live:

```bash
uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Then open [http://127.0.0.1:8000/](http://127.0.0.1:8000/) in a browser. The **Quiz & camera** tab captures frames with `getUserMedia` and POSTs them to `/api/predict` on that same host, so **YOLO inference runs in your local Python process** (not a hosted “cloud model” API). Training is still done separately with `train_cheating_yolo.py` on your machine.

Static assets live under `static/`; the main template is `templates/exam_portal.html`. The minimal single-file upload UI remains at `/upload`.

**API flow (same as before, now driven from the portal):**

1. Organization: `POST /api/org/signup`, `POST /api/org/login`
2. Organization creates accounts: `POST /api/org/teachers`, `POST /api/org/students`
3. List recent accounts: **`POST /api/org/accounts`** with JSON `{"org_email","org_password"}` (GET with query parameters still exists for compatibility but avoid it for real passwords).
4. Student: `POST /api/student/login`, first login `POST /api/student/change-password`, face `POST /api/student/face`, dashboard **`POST /api/student/dashboard`** with `{"email","password"}` (GET with query string still supported but discouraged).
5. Live proctoring: `POST /api/predict` — optional `X-API-Key` if `PROCTOR_API_KEY` is set; alert when `cheat_probability >= PROCTOR_CHEAT_THRESHOLD` (default `0.5`; set `PROCTOR_CHEAT_THRESHOLD=0.7` if you want alerts only at 0.7 and up). The portal shows thumbnails when the server returns `alert: true`.

**Demo note:** the portal stores organization and student passwords in `sessionStorage` for convenience on localhost only; do not rely on that for production authentication.
