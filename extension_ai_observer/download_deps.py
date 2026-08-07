import urllib.request
import os
from pathlib import Path

def main():
    project_root = Path(__file__).resolve().parent
    lib_dir = project_root / "extension" / "lib"
    lib_dir.mkdir(parents=True, exist_ok=True)
    
    # ⚠ THE BUNDLE CHOICE IS THE ENTIRE GPU STORY. READ BEFORE EDITING.
    #
    # `ort.min.js` is the WASM-ONLY build. It does not define `ort.env.webgpu`
    # and registers no GPU backend at all, so requesting executionProviders
    # ['webgpu', ...] against it silently drops the EP and runs on CPU — which
    # is exactly the defect logged in CLAUDE.md 2026-08-02 (d): the session
    # reported provider 'webgpu' while executing on CPU at Tier A's cadence.
    # Adding 'webgl' to the chain does not help either; that backend lives in
    # ort.webgl.min.js / ort.all.min.js and is deprecated upstream.
    #
    # `ort.webgpu.min.js` is the JSEP build and IS the fix. It needs the
    # `.jsep.` WASM pair, which is a DIFFERENT artifact from the plain one —
    # loading the JSEP bundle without them gets a runtime that cannot
    # instantiate. manifest.json loads this bundle; keep the two in step.
    #
    # ort.min.js is still fetched so the swap can be reverted with a one-line
    # manifest change if WebGPU misbehaves on a target machine.
    version = "1.19.0"
    base = f"https://cdn.jsdelivr.net/npm/onnxruntime-web@{version}/dist"

    files = {
        # Active bundle (WebGPU/JSEP) + its required WASM pair.
        "ort.webgpu.min.js": f"{base}/ort.webgpu.min.js",
        "ort-wasm-simd-threaded.jsep.mjs": f"{base}/ort-wasm-simd-threaded.jsep.mjs",
        "ort-wasm-simd-threaded.jsep.wasm": f"{base}/ort-wasm-simd-threaded.jsep.wasm",

        # Fallback bundle + its WASM pair, kept for a one-line revert.
        "ort.min.js": f"{base}/ort.min.js",
        "ort-wasm-simd-threaded.mjs": f"{base}/ort-wasm-simd-threaded.mjs",
        "ort-wasm-simd-threaded.wasm": f"{base}/ort-wasm-simd-threaded.wasm",
    }
    
    for filename, url in files.items():
        dest = lib_dir / filename
        print(f"Downloading {filename} from {url}...")
        try:
            urllib.request.urlretrieve(url, str(dest))
            print(f"Saved to {dest}")
        except Exception as e:
            print(f"Error downloading {filename}: {e}")

if __name__ == "__main__":
    main()
