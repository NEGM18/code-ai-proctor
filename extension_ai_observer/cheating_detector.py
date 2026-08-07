from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Union

import numpy as np
from ultralytics import YOLO

logger = logging.getLogger(__name__)

ImageInput = Union[str, Path, np.ndarray]


def center_crop_square(img: np.ndarray) -> np.ndarray:
    """Crop the largest centred square from an HxWxC array."""
    h, w = img.shape[:2]
    if h == w:
        return img
    side = min(h, w)
    y0 = (h - side) // 2
    x0 = (w - side) // 2
    return img[y0 : y0 + side, x0 : x0 + side]


@dataclass
class Prediction:
    label: str
    confidence: float
    probs: dict[str, float]

    def as_dict(self) -> dict[str, Any]:
        return {"label": self.label, "confidence": self.confidence, "probs": self.probs}


class CheatingDetector:
    def __init__(
        self,
        weights: str | Path,
        device: str | None = None,
        imgsz: int | None = None,
    ) -> None:
        self._model = YOLO(str(weights))
        self._device = device

        # Read the image size the model was trained with; fall back to 640.
        if imgsz is not None:
            self._imgsz = imgsz
        else:
            train_args = getattr(self._model, "overrides", {})
            self._imgsz = int(train_args.get("imgsz", 640))

        logger.info(
            "CheatingDetector loaded  weights=%s  device=%s  imgsz=%d  classes=%s",
            weights, device, self._imgsz, self._model.names,
        )

    def predict(self, image: ImageInput) -> Prediction:
        # Centre-crop numpy arrays to a square so YOLO doesn't pad with
        # black bars (webcam frames are typically 640×480, 4:3).
        if isinstance(image, np.ndarray) and image.ndim >= 2:
            h, w = image.shape[:2]
            if h != w:
                image = center_crop_square(image)
                logger.debug("Centre-cropped %dx%d → %dx%d", w, h, image.shape[1], image.shape[0])

        results = self._model.predict(
            source=image,
            imgsz=self._imgsz,
            verbose=False,
            device=self._device,
        )
        if not results:
            raise RuntimeError("No results returned from model")

        r = results[0]
        if r.probs is None:
            raise RuntimeError("Model is not a classification checkpoint (missing probs)")

        probs_tensor = r.probs.data
        names: Mapping[int, str] = r.names
        idx = int(probs_tensor.argmax().item())
        label = str(names[idx])
        confidence = float(probs_tensor[idx].item())

        probs: dict[str, float] = {}
        for i, name in names.items():
            probs[str(name)] = float(probs_tensor[int(i)].item())

        return Prediction(label=label, confidence=confidence, probs=probs)

    def predict_topk(self, image: ImageInput, k: int = 2) -> list[tuple[str, float]]:
        pred = self.predict(image)
        ranked = sorted(pred.probs.items(), key=lambda x: x[1], reverse=True)
        return ranked[:k]

    def predict_batch(
        self,
        images: list[np.ndarray],
        threshold: float = 0.5,
    ) -> "BatchResult":
        """Run inference on a list of frames and aggregate into a window verdict.

        Parameters
        ----------
        images : list[np.ndarray]
            Decoded frames (HxWxC uint8 numpy arrays).
        threshold : float
            P(cheating) threshold — the *average* across the window is
            compared to this value to decide whether the window is an alert.

        Returns
        -------
        BatchResult
            Aggregated statistics, per-frame probabilities, and the index
            of the frame with the highest cheating probability.
        """
        if not images:
            raise ValueError("predict_batch requires at least one image")

        predictions: list[Prediction] = []
        cheat_probs: list[float] = []

        for img in images:
            pred = self.predict(img)
            predictions.append(pred)
            cheat_probs.append(pred.probs.get("cheating", 0.0))

        avg_p = sum(cheat_probs) / len(cheat_probs)

        

        avg_p = max(0.0, min(1.0, avg_p))

        max_idx = int(np.argmax(cheat_probs))

        return BatchResult(
            predictions=predictions,
            cheat_probs=cheat_probs,
            avg_cheat_probability=avg_p,
            max_cheat_probability=max(cheat_probs),
            min_cheat_probability=min(cheat_probs),
            best_frame_index=max_idx,
            alert=avg_p >= threshold,
            window_size=len(images),
        )


@dataclass
class BatchResult:
    """Aggregated result from a batch of frames."""

    predictions: list[Prediction]
    cheat_probs: list[float]
    avg_cheat_probability: float
    max_cheat_probability: float
    min_cheat_probability: float
    best_frame_index: int
    alert: bool
    window_size: int

