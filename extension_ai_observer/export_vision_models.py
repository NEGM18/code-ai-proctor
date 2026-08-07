"""Export the stock Ultralytics vision models to ONNX for the browser extension.

Two models are exported here — they complement the trained classifier that
export_onnx.py handles:

  * yolo11n-pose.pt -> pose.onnx    (imgsz=256) — COCO 17-keypoint person pose,
    used for head/gaze-direction heuristics in the extension.
  * yolo11n.pt      -> detect.onnx  (imgsz=448) — COCO 80-class detector, used
    to spot phones (class 67 "cell phone") and extra people (class 0 "person").

IMPORTANT: the image sizes below are what the extension preprocesses to. If you
change them here you MUST change them in the extension's inference code too —
a mismatch silently destroys accuracy (see the note in export_onnx.py).

yolo11n.pt is expected at the project root; yolo11n-pose.pt auto-downloads from
Ultralytics on first use.

Each exported model is written to:
  * backend/static/models/<name>.onnx   (served to the extension via /static + secure chunks)
  * weights/<name>.onnx                 (local copy / convenience)
"""
import os
os.environ["CUDA_VISIBLE_DEVICES"] = ""

import argparse
import shutil
import sys
from pathlib import Path

from ultralytics import YOLO

DEFAULT_POSE_IMGSZ = 256
DEFAULT_DETECT_IMGSZ = 448


def export_one(
    project_root: Path,
    weights_name: str,
    out_name: str,
    imgsz: int,
    dynamic: bool = False,
) -> Path:
    """Export a single Ultralytics checkpoint to ONNX and fan it out to both destinations.

    Returns the path of the copy served to the extension.
    """
    print(f"\n=== {weights_name} -> {out_name} (imgsz={imgsz}, dynamic={dynamic}) ===")

    # A bare filename lets Ultralytics auto-download the stock weights if the
    # local copy is missing; a project-root copy always wins when present.
    local_pt = project_root / weights_name
    source = str(local_pt) if local_pt.is_file() else weights_name
    print(f"Loading YOLO model from: {source}")
    model = YOLO(source)
    print(f"Classes: {len(model.names)} — keys 0..4 = {[model.names[i] for i in range(min(5, len(model.names)))]}")

    # Ultralytics native ONNX export keeps correct preprocessing metadata.
    # opset 12 is broadly compatible with onnxruntime-web (WebGPU + WASM).
    exported = model.export(
        format="onnx",
        imgsz=imgsz,
        opset=12,
        simplify=True,
        dynamic=dynamic,
        device="cpu",
    )
    exported_path = Path(exported)
    print(f"Ultralytics exported ONNX to: {exported_path}")

    # Destinations
    served_dir = project_root / "backend" / "static" / "models"
    served_dir.mkdir(parents=True, exist_ok=True)
    served_path = served_dir / out_name

    weights_dir = project_root / "weights"
    weights_dir.mkdir(parents=True, exist_ok=True)
    weights_onnx = weights_dir / out_name

    if exported_path.resolve() != served_path.resolve():
        shutil.copy2(exported_path, served_path)
    if exported_path.resolve() != weights_onnx.resolve():
        shutil.copy2(exported_path, weights_onnx)

    size_mb = served_path.stat().st_size / 1024 / 1024
    print(f"Copied ONNX -> {served_path} ({size_mb:.2f} MB)")
    print(f"Copied ONNX -> {weights_onnx} ({size_mb:.2f} MB)")

    # Ultralytics drops its output next to the .pt (the project root). Both real
    # destinations now hold a copy, so drop the stray to keep the tree clean.
    if exported_path.resolve() not in (served_path.resolve(), weights_onnx.resolve()):
        exported_path.unlink(missing_ok=True)
        print(f"Removed intermediate: {exported_path}")

    return served_path


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--pose-imgsz", type=int, default=DEFAULT_POSE_IMGSZ,
        help=f"Export size for yolo11n-pose (default {DEFAULT_POSE_IMGSZ})",
    )
    parser.add_argument(
        "--detect-imgsz", type=int, default=DEFAULT_DETECT_IMGSZ,
        help=f"Export size for yolo11n detect (default {DEFAULT_DETECT_IMGSZ})",
    )
    parser.add_argument(
        "--dynamic", action="store_true",
        help=(
            "Export with dynamic spatial axes. With a static graph the extension "
            "MUST feed exactly --*-imgsz pixels, so the CPU tier's 320x320 cap "
            "cannot be applied at run time (runtime_profile.clampInputSize falls "
            "back to the baked-in size and logs a warning). Export dynamic, or "
            "re-export with --detect-imgsz 320, to let Tier B actually downscale."
        ),
    )
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parent

    jobs = [
        ("yolo11n-pose.pt", "pose.onnx", args.pose_imgsz),
        ("yolo11n.pt", "detect.onnx", args.detect_imgsz),
    ]

    results = []
    for weights_name, out_name, imgsz in jobs:
        try:
            served_path = export_one(project_root, weights_name, out_name, imgsz, args.dynamic)
        except Exception as exc:  # noqa: BLE001 - surface the failure, keep going
            print(f"Error exporting {weights_name}: {exc}")
            results.append((out_name, imgsz, None))
            continue
        results.append((out_name, imgsz, served_path.stat().st_size / 1024 / 1024))

    print("\n=== Summary ===")
    failed = False
    for out_name, imgsz, size_mb in results:
        if size_mb is None:
            failed = True
            print(f"  {out_name:<12} imgsz={imgsz:<4} FAILED")
        else:
            print(f"  {out_name:<12} imgsz={imgsz:<4} {size_mb:.2f} MB")

    if failed:
        sys.exit(1)
    print("\nDone. Extension inference must use these exact imgsz values to match the models.")


if __name__ == "__main__":
    main()
