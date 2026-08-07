import urllib.request
import os
from pathlib import Path

def main():
    project_root = Path(__file__).resolve().parent
    lib_dir = project_root / "extension" / "lib"
    lib_dir.mkdir(parents=True, exist_ok=True)
    
    files = {
        "ort.min.js": "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.0/dist/ort.min.js",
        "ort-wasm-simd-threaded.wasm": "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.0/dist/ort-wasm-simd-threaded.wasm",
        "ort-wasm-threaded.wasm": "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.0/dist/ort-wasm-threaded.wasm",
        "ort-wasm.wasm": "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.0/dist/ort-wasm.wasm",
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
