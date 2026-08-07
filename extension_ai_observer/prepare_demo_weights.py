"""
Build a tiny 2-class (cheating / normal) dataset and fine-tune YOLO11n-cls to produce weights/best.pt.

Use this when you do not yet have your own training run, so the web quiz camera can call /api/predict.

Requires: pip install -r requirements.txt (ultralytics, torch, pillow, numpy).
Uses CUDA if available; otherwise CPU (slower but works for a short demo).

Example:
  python prepare_demo_weights.py
  python prepare_demo_weights.py --epochs 25 --imgsz 224
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
DEMO_DATA = ROOT / "demo_proctor_dataset"
WEIGHTS_DIR = ROOT / "weights"


def _write_split_images(split: str, per_class: int) -> None:
    rng = np.random.default_rng(42 if split == "train" else 7)
    for cls, generator in (
        (
            "cheating",
            lambda i: rng.integers(0, 255, size=(224, 224, 3), dtype=np.uint8),
        ),
        (
            "normal",
            lambda i: np.full((224, 224, 3), 28 + (i * 6) % 120, dtype=np.uint8),
        ),
    ):
        out_dir = DEMO_DATA / split / cls
        out_dir.mkdir(parents=True, exist_ok=True)
        for i in range(per_class):
            arr = generator(i)
            Image.fromarray(arr).save(out_dir / f"{cls}_{split}_{i:03d}.jpg", quality=88)


def build_demo_dataset(train_n: int, val_n: int) -> None:
    if DEMO_DATA.exists():
        shutil.rmtree(DEMO_DATA)
    _write_split_images("train", train_n)
    _write_split_images("val", val_n)
    print(f"Wrote demo images under {DEMO_DATA}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Train small cheating/normal classifier and copy weights to ./weights/best.pt")
    parser.add_argument("--epochs", type=int, default=15, help="Fine-tune epochs (demo default 15)")
    parser.add_argument("--imgsz", type=int, default=224, help="Training image size")
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--name", type=str, default="demo_quiz", help="Ultralytics run name under runs/classify/")
    args = parser.parse_args()

    import torch
    from ultralytics import YOLO

    build_demo_dataset(train_n=14, val_n=4)

    device = "0" if torch.cuda.is_available() else "cpu"
    print(f"Using device: {device}")

    model = YOLO("yolo11n-cls.pt")
    model.train(
        data=str(DEMO_DATA),
        epochs=args.epochs,
        imgsz=args.imgsz,
        device=device,
        project=str(ROOT / "runs" / "classify"),
        name=args.name,
        batch=args.batch,
        workers=0 if sys.platform == "win32" else 4,
        exist_ok=True,
        verbose=True,
    )

    trained_best = ROOT / "runs" / "classify" / args.name / "weights" / "best.pt"
    if not trained_best.is_file():
        raise SystemExit(f"Expected weights at {trained_best} — training did not produce best.pt")

    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    dest = WEIGHTS_DIR / "best.pt"
    shutil.copy2(trained_best, dest)
    print(f"Copied demo weights to {dest}")
    print("Start the server: uvicorn backend.main:app --host 127.0.0.1 --port 8000")
    print("Then open the Quiz tab; inference uses this file unless PROCTOR_MODEL_PATH is set.")


if __name__ == "__main__":
    main()
