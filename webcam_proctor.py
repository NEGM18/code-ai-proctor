"""
Live webcam test for the trained YOLO classification model.

Press Q in the preview window to quit (OpenCV window) or close the window (Tk fallback).
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
import torch

from cheating_detector import CheatingDetector
from model_paths import discover_best_weights


def default_weights() -> Path:
    root = Path(__file__).resolve().parent
    found = discover_best_weights(root)
    if found is not None:
        return found
    return root / "weights" / "best.pt"


@dataclass
class FrameState:
    frame_i: int = 0
    last_line: str = "starting…"
    last_cheat_p: float = 0.0
    last_color: tuple[int, int, int] = field(default_factory=lambda: (200, 200, 200))


def annotate_frame(
    frame: np.ndarray,
    detector: CheatingDetector,
    state: FrameState,
    stride: int,
    threshold: float,
) -> np.ndarray:
    state.frame_i += 1
    if state.frame_i % max(1, stride) == 0:
        pred = detector.predict(frame)
        cheat_p = pred.probs.get("cheating", 0.0)
        normal_p = pred.probs.get("normal", 0.0)
        alert = cheat_p >= threshold
        state.last_color = (0, 0, 255) if alert else (0, 200, 0)
        status = "ALERT" if alert else "OK"
        state.last_line = (
            f"{status}  pred={pred.label} ({pred.confidence:.2f})  "
            f"P(cheat)={cheat_p:.2f}  P(normal)={normal_p:.2f}"
        )
        state.last_cheat_p = cheat_p

    out = frame.copy()
    y0 = 28
    cv2.putText(
        out,
        state.last_line,
        (1, y0),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.6,
        state.last_color,
        2,
        cv2.LINE_AA,
    )
    cv2.putText(
        out,
        "Q = quit",
        (1, out.shape[0] - 12),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.5,
        (200, 200, 200),
        1,
        cv2.LINE_AA,
    )
    return out


def run_opencv_loop(cap: cv2.VideoCapture, detector: CheatingDetector, args: argparse.Namespace) -> None:
    state = FrameState()
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            out = annotate_frame(frame, detector, state, args.stride, args.threshold)
            cv2.imshow("Proctor (cheating classifier)", out)
            if cv2.waitKey(1) & 0xFF in (ord("q"), ord("Q")):
                break
    finally:
        cv2.destroyAllWindows()


def run_tk_loop(cap: cv2.VideoCapture, detector: CheatingDetector, args: argparse.Namespace) -> None:
    import tkinter as tk
    from PIL import Image, ImageTk

    state = FrameState()
    root = tk.Tk()
    root.title("Proctor (cheating classifier)")
    label = tk.Label(root)
    label.pack()

    closing = {"v": False}

    def on_close() -> None:
        closing["v"] = True
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)

    def tick() -> None:
        if closing["v"]:
            return
        ok, frame = cap.read()
        if not ok:
            on_close()
            return
        out = annotate_frame(frame, detector, state, args.stride, args.threshold)
        rgb = cv2.cvtColor(out, cv2.COLOR_BGR2RGB)
        im = Image.fromarray(rgb)
        imgtk = ImageTk.PhotoImage(image=im)
        label.imgtk = imgtk  # type: ignore[attr-defined]
        label.configure(image=imgtk)
        root.after(1, tick)

    root.bind("q", lambda _e: on_close())
    root.bind("Q", lambda _e: on_close())
    root.after(0, tick)
    root.mainloop()


def main() -> None:
    parser = argparse.ArgumentParser(description="Webcam live test for cheating classifier")
    parser.add_argument("--weights", type=Path, default=None, help="Path to best.pt")
    parser.add_argument("--camera", type=int, default=0, help="Camera index (0 = default webcam)")
    parser.add_argument(
        "--device",
        type=str,
        default=None,
        help="cuda:0, cuda, or cpu (default: cuda if available)",
    )
    parser.add_argument(
        "--stride",
        type=int,
        default=2,
        help="Run inference every N frames (larger = smoother on weak GPUs)",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=0.7,
        help="P(cheating) above this shows ALERT in red",
    )
    parser.add_argument(
        "--gui",
        choices=("auto", "opencv", "tk"),
        default="auto",
        help="Display backend: auto tries OpenCV then Tk; use tk if cv2.imshow is not built",
    )
    args = parser.parse_args()

    weights = args.weights.resolve() if args.weights else default_weights()
    if not weights.is_file():
        raise SystemExit(
            f"Weights not found: {weights}\n"
            "Pass --weights path\\to\\best.pt (check runs/classify/*/weights/)."
        )

    device = args.device
    if device is None:
        device = "0" if torch.cuda.is_available() else "cpu"

    if sys.platform == "win32":
        cap = cv2.VideoCapture(args.camera, cv2.CAP_DSHOW)
        if not cap.isOpened():
            cap = cv2.VideoCapture(args.camera)
    else:
        cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        raise SystemExit(f"Could not open camera index {args.camera}")

    detector = CheatingDetector(weights, device=device)

    try:
        if args.gui == "tk":
            run_tk_loop(cap, detector, args)
        elif args.gui == "opencv":
            run_opencv_loop(cap, detector, args)
        else:
            try:
                run_opencv_loop(cap, detector, args)
            except cv2.error as e:
                if "not implemented" in str(e).lower() or "cvShowImage" in str(e):
                    print(
                        "OpenCV has no GUI support (often opencv-python-headless). "
                        "Falling back to Tkinter. For native OpenCV windows run:\n"
                        "  pip uninstall -y opencv-python-headless\n"
                        "  pip install opencv-python\n",
                        file=sys.stderr,
                    )
                    run_tk_loop(cap, detector, args)
                else:
                    raise
    finally:
        cap.release()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
