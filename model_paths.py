"""Resolve path to YOLO classification weights for the proctor API."""
from __future__ import annotations

import os
from pathlib import Path


def _is_demo_synthetic_weights(path: Path) -> bool:
    """Synthetic tiny-dataset runs used only for wiring; prefer real Roboflow training when both exist."""
    parts = path.parts
    return "demo_quiz" in parts


def _train4_weight_paths(project_root: Path) -> list[Path]:
    """Your Roboflow ~92% run — always checked before any other weights (except PROCTOR_MODEL_PATH)."""
    return [
        project_root / "runs/classify/runs/classify/train4/weights/best.pt",
        project_root / "runs/classify/runs/classify/train4/weights/last.pt",
        project_root / "runs/classify/train4/weights/best.pt",
        project_root / "runs/classify/train4/weights/last.pt",
    ]


def discover_best_weights(project_root: Path) -> Path | None:
    """
    Resolution order:
    1) train4 (Roboflow run): best.pt then last.pt in each standard layout — always first
    2) ./weights/best.pt
    3) train3, train2, train (best.pt only)
    4) Any other runs/**/weights/best.pt (non-demo preferred over demo_quiz)
    5) runs/classify/demo_quiz/weights/best.pt, then last.pt
    """
    for p in _train4_weight_paths(project_root):
        if p.is_file():
            return p

    preferred = project_root / "weights" / "best.pt"
    if preferred.is_file():
        return preferred

    roboflow_priority = [
        project_root / "runs/classify/runs/classify/train3/weights/best.pt",
        project_root / "runs/classify/runs/classify/train2/weights/best.pt",
        project_root / "runs/classify/runs/classify/train/weights/best.pt",
        project_root / "runs/classify/train3/weights/best.pt",
        project_root / "runs/classify/train2/weights/best.pt",
        project_root / "runs/classify/train/weights/best.pt",
    ]
    for p in roboflow_priority:
        if p.is_file():
            return p

    candidates: list[Path] = []
    runs = project_root / "runs"
    if runs.is_dir():
        for p in runs.rglob("weights/best.pt"):
            try:
                if p.is_file():
                    candidates.append(p)
            except OSError:
                continue
    if candidates:

        def sort_key(p: Path) -> tuple[bool, float]:
            # False (not demo) sorts before True; then larger mtime first via negation for min().
            return (_is_demo_synthetic_weights(p), -p.stat().st_mtime)

        return min(candidates, key=sort_key)

    # No weights/best.pt under runs — e.g. only last.pt saved, or nonstandard layout.
    demo_dir = project_root / "runs/classify/demo_quiz/weights"
    for fname in ("best.pt", "last.pt"):
        p = demo_dir / fname
        if p.is_file():
            return p
    return None


def effective_model_path(project_root: Path) -> Path:
    """PROCTOR_MODEL_PATH overrides; otherwise discover or fall back to legacy default."""
    raw = os.environ.get("PROCTOR_MODEL_PATH", "").strip()
    if raw:
        return Path(raw)
    found = discover_best_weights(project_root)
    if found is not None:
        return found
    return project_root / "runs" / "classify" / "runs" / "classify" / "train4" / "weights" / "best.pt"
