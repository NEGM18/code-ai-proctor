"""Export the effective YOLO classification weights to ONNX for the browser extension.

IMPORTANT: the model is exported at the SAME image size it was trained at
(read from the checkpoint, default 640). Exporting at 224 while the weights were
trained at 640 collapses accuracy to near-random — that was the original bug.

The exported model is written to:
  * backend/static/models/best.onnx   (served to the extension via /static + secure chunks)
  * weights/best.onnx                  (local copy / convenience)
"""
import os
os.environ["CUDA_VISIBLE_DEVICES"] = ""

import shutil
import sys
from pathlib import Path

import torch
from ultralytics import YOLO

# Import effective_model_path from model_paths.py
sys.path.append(str(Path(__file__).resolve().parent))
from model_paths import effective_model_path


def _resolve_train_imgsz(model: YOLO, default: int = 640) -> int:
    """Read the image size the checkpoint was trained at so export matches training."""
    for src in (getattr(model, "overrides", {}) or {}, getattr(model, "args", {}) or {}):
        val = src.get("imgsz") if isinstance(src, dict) else None
        if isinstance(val, (list, tuple)) and val:
            val = val[0]
        if isinstance(val, int) and val > 0:
            return val
    return default


def main():
    project_root = Path(__file__).resolve().parent
    model_path = effective_model_path(project_root)
    print(f"Effective model path found: {model_path}")

    if not model_path.is_file():
        print(f"Error: Model file does not exist at {model_path}")
        sys.exit(1)

    print("Loading YOLO model...")
    model = YOLO(str(model_path))

    imgsz = _resolve_train_imgsz(model)
    print(f"Exporting at imgsz={imgsz} (matches training) — classes={model.names}")

    # Ultralytics native ONNX export keeps correct preprocessing metadata and a
    # single [1, num_classes] output. opset 12 is broadly compatible with
    # onnxruntime-web (WebGPU + WASM).
    exported = model.export(
        format="onnx",
        imgsz=imgsz,
        opset=12,
        simplify=True,
        dynamic=False,
        device="cpu",
    )
    exported_path = Path(exported)
    print(f"Ultralytics exported ONNX to: {exported_path}")

    # Destinations
    served_dir = project_root / "backend" / "static" / "models"
    served_dir.mkdir(parents=True, exist_ok=True)
    served_path = served_dir / "best.onnx"

    weights_dir = project_root / "weights"
    weights_dir.mkdir(parents=True, exist_ok=True)
    weights_onnx = weights_dir / "best.onnx"

    if exported_path.resolve() != served_path.resolve():
        shutil.copy2(exported_path, served_path)
    if exported_path.resolve() != weights_onnx.resolve():
        shutil.copy2(exported_path, weights_onnx)

    size_mb = served_path.stat().st_size / 1024 / 1024
    print(f"Copied ONNX -> {served_path} ({size_mb:.2f} MB)")
    print(f"Copied ONNX -> {weights_onnx}")
    print(f"\nDone. Extension inference must use imgsz={imgsz} to match this model.")


if __name__ == "__main__":
    main()
