#!/usr/bin/env python3
"""Pack extension/ into the loadable Chrome MV3 zip.

    python scripts/pack_extension.py

WHY THIS EXISTS. The archive was previously built by hand, and it went stale
without anyone noticing: the committed zip shipped `lib/ort.min.js` (the
WASM-ONLY onnxruntime build) long after manifest.json had switched to
`lib/ort.webgpu.min.js`, and was missing `content/vision/downward_gaze.js`
outright. A stale zip does not fail loudly — it loads fine and silently runs
CPU inference at a GPU cadence, or omits a detector entirely. Building it from
a script that reads the tree means the package cannot drift from the source.

TWO PROPERTIES WORTH KNOWING:

1. REPRODUCIBLE. Entries are sorted and every timestamp is pinned to a fixed
   epoch, so packing the same tree twice produces a BYTE-IDENTICAL archive.
   That is what makes `sha256` a usable answer to "is the deployed build the
   one I just tested?". Without it, mtimes alone change the digest on every
   run and the hash tells you nothing.

2. IT VERIFIES THE MANIFEST BEFORE IT WRITES. Every file listed in
   content_scripts / background / action / icons must exist in the staged set.
   A manifest entry pointing at a missing file makes Chrome drop the whole
   content_scripts block, which presents as the extension silently not running
   at all — a failure that looks nothing like its cause. Better to fail here.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path

# Repo layout: <project>/scripts/pack_extension.py -> <project>/extension
PROJECT_DIR = Path(__file__).resolve().parent.parent
EXT_DIR = PROJECT_DIR / "extension"
DEFAULT_OUT = PROJECT_DIR / "ai-observer-extension-v2.0.0.zip"

# `test/` is developer-only — the suites never run inside Chrome and would add
# weight to every install. Matched at ANY depth, so extension/test/ and a
# hypothetical extension/content/test/ are both dropped.
EXCLUDED_DIRS = {"test", "__pycache__", ".git"}
EXCLUDED_NAMES = {".DS_Store", "Thumbs.db"}
EXCLUDED_SUFFIXES = {".pyc", ".map"}

# Fixed DOS timestamp (1980-01-01 00:00:00), the zip epoch. Any constant works;
# what matters is that it does not vary between runs.
FIXED_DATE_TIME = (1980, 1, 1, 0, 0, 0)


def is_excluded(rel: Path) -> bool:
    """Should this path be kept out of the package?"""
    if any(part in EXCLUDED_DIRS for part in rel.parts[:-1]):
        return True
    if rel.name in EXCLUDED_NAMES:
        return True
    return rel.suffix in EXCLUDED_SUFFIXES


def collect(ext_dir: Path):
    """Every shippable file, as (absolute path, forward-slash archive name).

    Sorted by archive name so the entry order is stable across filesystems —
    rglob order is not guaranteed and would otherwise break reproducibility.
    """
    out = []
    for path in ext_dir.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(ext_dir)
        if is_excluded(rel):
            continue
        out.append((path, rel.as_posix()))
    out.sort(key=lambda pair: pair[1])
    return out


def manifest_requirements(manifest: dict):
    """Paths manifest.json says must be present."""
    required = []
    for entry in manifest.get("content_scripts", []):
        required += entry.get("js", []) + entry.get("css", [])
    worker = manifest.get("background", {}).get("service_worker")
    if worker:
        required.append(worker)
    popup = manifest.get("action", {}).get("default_popup")
    if popup:
        required.append(popup)
    required += list(manifest.get("icons", {}).values())
    return required


def main() -> int:
    parser = argparse.ArgumentParser(description="Pack extension/ into the MV3 zip.")
    parser.add_argument("-o", "--output", type=Path, default=DEFAULT_OUT,
                        help=f"output archive (default: {DEFAULT_OUT.name})")
    args = parser.parse_args()

    if not EXT_DIR.is_dir():
        print(f"error: no extension directory at {EXT_DIR}", file=sys.stderr)
        return 1

    files = collect(EXT_DIR)
    if not files:
        print(f"error: nothing to pack under {EXT_DIR}", file=sys.stderr)
        return 1

    staged = {arc for _, arc in files}

    manifest_path = EXT_DIR / "manifest.json"
    if not manifest_path.is_file():
        print("error: extension/manifest.json is missing", file=sys.stderr)
        return 1
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    # Fail BEFORE writing: a zip missing a declared script is worse than no zip,
    # because it installs cleanly and then does nothing.
    missing = [p for p in manifest_requirements(manifest) if p not in staged]
    if missing:
        print("error: manifest.json references files that are not staged:", file=sys.stderr)
        for path in missing:
            print(f"  - {path}", file=sys.stderr)
        return 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path, arc in files:
            # ZipInfo rather than write(): write() stamps the file's mtime,
            # which changes the digest on every checkout. See property 1.
            info = zipfile.ZipInfo(filename=arc, date_time=FIXED_DATE_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, path.read_bytes())

    size = args.output.stat().st_size
    digest = hashlib.sha256(args.output.read_bytes()).hexdigest()

    print(f"packed {len(files)} files -> {args.output.name}")
    print(f"  size   {size:,} bytes")
    print(f"  sha256 {digest}")
    print(f"  source {EXT_DIR}")
    print("  excluded: " + ", ".join(sorted(EXCLUDED_DIRS | EXCLUDED_NAMES)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
