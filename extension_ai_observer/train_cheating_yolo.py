from __future__ import annotations
import argparse
import os
from pathlib import Path
import torch
import yaml
from ultralytics import YOLO


def resolve_classify_data_target(data_arg: Path) -> Path:
    data_path = data_arg.resolve()
    if data_path.is_dir():
        return data_path

    if not data_path.is_file():
        raise SystemExit(f"Data path not found: {data_path}")

    with data_path.open("r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}

    base = data_path.parent
    root = cfg.get("path", ".")
    root_path = (base / str(root)).resolve()
    if not root_path.is_dir():
        raise SystemExit(f"Dataset root from YAML does not exist: {root_path}")

    for split in ("train", "valid", "test"):
        split_dir = root_path / split
        if not split_dir.is_dir():
            raise SystemExit(f"Expected split directory missing: {split_dir}")
    return root_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Train YOLO classify on dataset directory or YAML")
    parser.add_argument(
        "--data",
        type=Path,
        default=Path(__file__).resolve().parent / "cheating_dataset.yaml",
        help="Path to dataset directory or YAML (YAML is auto-resolved to its root folder)",
    )
    parser.add_argument("--model", type=str, default="yolo11n-cls.pt", help="Classification checkpoint to fine-tune")
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--device", type=str, default="0", help="CUDA device index, e.g. 0")
    parser.add_argument("--project", type=str, default="runs/classify")
    parser.add_argument("--name", type=str, default="train")
    parser.add_argument(
        "--batch",
        type=int,
        default=8,
        help="Batch size. 4GB GPUs are usually stable with 8 or lower at imgsz=640.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=0 if os.name == "nt" else 8,
        help="Dataloader workers. Default 0 on Windows to avoid paging-file spawn issues.",
    )
    args = parser.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit(
            "CUDA is not available. Install CUDA-enabled PyTorch and an NVIDIA driver, "
            "then verify with: python -c \"import torch; print(torch.cuda.is_available())\""
        )

    data_target = resolve_classify_data_target(args.data)

    model = YOLO(args.model)
    model.train(
        data=str(data_target),
        epochs=args.epochs,
        imgsz=args.imgsz,
        device=args.device,
        project=args.project,
        name=args.name,
        batch=args.batch,
        workers=args.workers,
    )


if __name__ == "__main__":
    main()
