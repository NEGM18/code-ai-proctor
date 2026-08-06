// =============================================================================
// Secure Model Loader — AI Observer Extension
// Downloads ONNX model as encrypted chunks, reassembles, and verifies integrity.
// =============================================================================

/**
 * @class SecureModelLoader
 * Handles chunked, XOR-obfuscated model downloads with SHA-256 verification.
 *
 * Security Model:
 *   The ONNX model is split into N chunks on the server. Each chunk is XOR'd
 *   with a key derived from a server-provided nonce + chunk index. This prevents
 *   casual DevTools inspection of the raw model weights. After reassembly, a
 *   SHA-256 hash is verified against the server manifest to detect tampering.
 */
/* =============================================================================
 * ⚠ TIMEOUTS ARE LOAD-BEARING. `fetch()` HAS NO DEFAULT ONE.
 *
 * Both callers already handle a *failed* load gracefully — onnx_inference.js
 * and vision_engine.js each catch and fall back to a direct model URL. What
 * neither can handle is a load that never settles, and until these constants
 * existed that was the outcome whenever the FastAPI host was reachable but not
 * responding: TCP connects, no bytes come back, `fetch` waits on Chrome's
 * network timeout (minutes), the catch never runs, the fallback never happens
 * and extension initialisation stalls with no error in the console.
 *
 * A closed port is not the dangerous case — that rejects in milliseconds. The
 * dangerous cases are a hung Python process, a suspended container, a VPN
 * black-holing packets, and a laptop that slept mid-download.
 *
 * The chunk budget is deliberately much larger than the manifest budget: the
 * manifest is a few hundred bytes and should be near-instant, while a chunk is
 * up to ~512 KB and may legitimately be slow on a loaded machine. Setting both
 * to the same small number would turn a slow-but-working download into a
 * spurious failure, which is the opposite mistake.
 * ========================================================================== */

/** Manifest is tiny — if it has not arrived in 8 s, the server is not well. */
const MANIFEST_TIMEOUT_MS = 8000;

/** One chunk, on a slow disk over a slow link. Generous on purpose. */
const CHUNK_TIMEOUT_MS = 20000;

/**
 * Error codes on thrown errors, so a caller can tell "this host is dead" from
 * "this model is corrupt" — they warrant completely different fallbacks, and
 * `err.message` string-matching is not a contract.
 */
const LOADER_ERROR = {
  /** Timed out, aborted, or the connection could not be established. */
  UNREACHABLE: 'MODEL_SERVER_UNREACHABLE',
  /** Server answered, but not with a 2xx. It is alive; the route is wrong. */
  HTTP: 'MODEL_HTTP_ERROR',
  /** Downloaded whole, hash mismatch. */
  INTEGRITY: 'MODEL_INTEGRITY_FAILED',
};

class SecureModelLoader {
  /**
   * @param {string} serverUrl - Base URL of the AI Observer backend.
   * @param {string|null} [modelName] - Named model ('best' | 'pose' | 'detect').
   *   Omit for the legacy single-model routes, which the backend keeps serving
   *   as 'best' for compatibility with already-deployed extensions.
   */
  constructor(serverUrl, modelName = null) {
    this.serverUrl = serverUrl.replace(/\/+$/, '');
    this.modelName = modelName;
    this.manifest = null;
    this.modelBuffer = null;
    this.isLoaded = false;
    /** Loader-wide kill switch, so one dead chunk cancels its siblings. */
    this.abort = null;
  }

  /**
   * `fetch` with a hard deadline, and with the loader-wide abort wired in.
   *
   * The second half matters as much as the first. `downloadChunks` runs three
   * workers concurrently; without a shared signal, one worker timing out leaves
   * the other two pulling megabytes from a server we have already given up on,
   * for the full length of their own timeouts.
   *
   * @param {string} url
   * @param {number} timeoutMs
   * @param {string} label - what we were fetching, for the error message.
   * @returns {Promise<Response>}
   */
  async _fetch(url, timeoutMs, label) {
    const controller = new AbortController();
    const parent = this.abort;

    const onParentAbort = () => controller.abort();
    if (parent) {
      if (parent.signal.aborted) controller.abort();
      else parent.signal.addEventListener('abort', onParentAbort, { once: true });
    }

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

    try {
      return await fetch(url, { signal: controller.signal, cache: 'no-store' });
    } catch (err) {
      // AbortError (ours or a sibling's) and TypeError ("Failed to fetch",
      // i.e. DNS/refused/offline) are the same actionable fact to a caller:
      // this host cannot serve the model right now.
      const reason = timedOut
        ? `timed out after ${timeoutMs} ms`
        : (err && err.name === 'AbortError' ? 'aborted' : 'connection failed');
      const wrapped = new Error(
        `[SecureLoader] ${label} ${reason} (${url}). Is the model server running?`
      );
      wrapped.code = LOADER_ERROR.UNREACHABLE;
      wrapped.cause = err;
      throw wrapped;
    } finally {
      clearTimeout(timer);
      if (parent) parent.signal.removeEventListener('abort', onParentAbort);
    }
  }

  /** Base path for this loader's model routes. */
  _base() {
    return this.modelName
      ? `${this.serverUrl}/api/model/${encodeURIComponent(this.modelName)}`
      : `${this.serverUrl}/api/model`;
  }

  /**
   * Fetch the model manifest from the backend.
   * @returns {Promise<{chunk_count: number, chunk_size: number, sha256_hash: string, nonce: string}>}
   */
  async fetchManifest() {
    console.log('[SecureLoader] Fetching model manifest...');
    const response = await this._fetch(`${this._base()}/manifest`, MANIFEST_TIMEOUT_MS, 'manifest');
    if (!response.ok) {
      const err = new Error(`Failed to fetch model manifest: HTTP ${response.status}`);
      err.code = LOADER_ERROR.HTTP;
      throw err;
    }
    this.manifest = await response.json();
    console.log('[SecureLoader] Manifest received:', {
      chunks: this.manifest.chunk_count,
      chunkSize: this.manifest.chunk_size,
      hash: this.manifest.sha256_hash.substring(0, 16) + '...',
    });
    return this.manifest;
  }

  /**
   * Download all model chunks in parallel (with concurrency limit).
   * @param {Function} [onProgress] - Callback(downloaded, total) for progress reporting.
   * @returns {Promise<Uint8Array[]>} Array of raw (still encrypted) chunk buffers.
   */
  async downloadChunks(onProgress) {
    if (!this.manifest) {
      await this.fetchManifest();
    }

    const { chunk_count } = this.manifest;
    const chunks = new Array(chunk_count);
    let downloaded = 0;
    const CONCURRENCY = 3;

    // Download chunks with limited concurrency
    const queue = Array.from({ length: chunk_count }, (_, i) => i);

    const downloadOne = async () => {
      while (queue.length > 0) {
        const index = queue.shift();
        if (index === undefined) break;

        const response = await this._fetch(
          `${this._base()}/chunks/${index}`, CHUNK_TIMEOUT_MS, `chunk ${index}`
        );
        if (!response.ok) {
          const err = new Error(`Failed to download chunk ${index}: HTTP ${response.status}`);
          err.code = LOADER_ERROR.HTTP;
          throw err;
        }

        const buffer = await response.arrayBuffer();
        chunks[index] = new Uint8Array(buffer);

        downloaded++;
        if (onProgress) {
          onProgress(downloaded, chunk_count);
        }
        console.log(`[SecureLoader] Chunk ${index + 1}/${chunk_count} downloaded (${chunks[index].length} bytes)`);
      }
    };

    // Launch concurrent workers
    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, chunk_count); i++) {
      workers.push(downloadOne());
    }
    await Promise.all(workers);

    return chunks;
  }

  /**
   * Derive the per-chunk XOR key the server used:
   * SHA-256(nonce || little-endian uint32 index).
   * @param {number} chunkIndex
   * @param {Uint8Array} nonceBytes
   * @returns {Promise<Uint8Array>} 32 key bytes.
   */
  async deriveChunkKey(chunkIndex, nonceBytes) {
    const indexBytes = new Uint8Array(4);
    new DataView(indexBytes.buffer).setUint32(0, chunkIndex, true); // little-endian

    const keyInput = new Uint8Array(nonceBytes.length + 4);
    keyInput.set(nonceBytes, 0);
    keyInput.set(indexBytes, nonceBytes.length);

    const keyHash = await crypto.subtle.digest('SHA-256', keyInput);
    return new Uint8Array(keyHash);
  }

  /**
   * Decrypt a single chunk using XOR with a key derived from nonce + index.
   * @param {Uint8Array} encryptedChunk - The XOR-encrypted chunk bytes.
   * @param {number} chunkIndex - The chunk's index (used in key derivation).
   * @param {Uint8Array} nonceBytes - The server-provided nonce bytes.
   * @returns {Promise<Uint8Array>} The decrypted chunk bytes.
   */
  async decryptChunk(encryptedChunk, chunkIndex, nonceBytes) {
    const keyBytes = await this.deriveChunkKey(chunkIndex, nonceBytes);
    const decrypted = new Uint8Array(encryptedChunk.length);
    for (let j = 0; j < encryptedChunk.length; j++) {
      decrypted[j] = encryptedChunk[j] ^ keyBytes[j % keyBytes.length];
    }
    return decrypted;
  }

  /**
   * Reassemble decrypted chunks into a single ArrayBuffer.
   *
   * Memory: this used to hold the encrypted chunks, a full array of decrypted
   * chunks, AND the merged buffer live at the same time — a ~3x transient spike
   * (~18 MB for a 6 MB model) during startup, on the machine least able to
   * afford it. Now each chunk is XOR'd straight into the destination buffer and
   * its source reference is dropped immediately, so the peak is ~1x plus one
   * in-flight chunk.
   *
   * @param {Uint8Array[]} encryptedChunks - Array of encrypted chunk buffers. Consumed in place.
   * @returns {Promise<ArrayBuffer>} The complete decrypted model buffer.
   */
  async reassemble(encryptedChunks) {
    console.log('[SecureLoader] Decrypting and reassembling model...');

    const nonceHex = this.manifest.nonce;
    const nonceBytes = new Uint8Array(nonceHex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));

    const totalSize = encryptedChunks.reduce((sum, chunk) => sum + (chunk ? chunk.length : 0), 0);
    const merged = new Uint8Array(totalSize);

    let offset = 0;
    for (let i = 0; i < encryptedChunks.length; i++) {
      const src = encryptedChunks[i];
      if (!src) throw new Error(`Chunk ${i} is missing from the download set.`);

      const keyBytes = await this.deriveChunkKey(i, nonceBytes);
      const keyLen = keyBytes.length;
      for (let j = 0; j < src.length; j++) {
        merged[offset + j] = src[j] ^ keyBytes[j % keyLen];
      }
      offset += src.length;

      // Release the encrypted chunk as soon as it is consumed.
      encryptedChunks[i] = null;
    }

    console.log(`[SecureLoader] Model reassembled: ${totalSize} bytes (${(totalSize / 1024 / 1024).toFixed(2)} MB)`);
    return merged.buffer;
  }

  /**
   * Verify the SHA-256 hash of the reassembled model against the manifest.
   * @param {ArrayBuffer} buffer - The complete decrypted model buffer.
   * @returns {Promise<boolean>} True if the hash matches.
   */
  async verify(buffer) {
    console.log('[SecureLoader] Verifying model integrity (SHA-256)...');

    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const computedHash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    const expectedHash = this.manifest.sha256_hash;
    const valid = computedHash === expectedHash;

    if (valid) {
      console.log('[SecureLoader] ✓ Model integrity verified.');
    } else {
      console.error('[SecureLoader] ✗ Model integrity check FAILED!');
      console.error(`  Expected: ${expectedHash}`);
      console.error(`  Computed: ${computedHash}`);
    }

    return valid;
  }

  /**
   * Full pipeline: fetch manifest → download chunks → decrypt → reassemble → verify.
   * @param {Function} [onProgress] - Progress callback(downloaded, total).
   * @returns {Promise<ArrayBuffer>} The verified model ArrayBuffer ready for ONNX Runtime.
   */
  async loadModel(onProgress) {
    // One controller for the whole load. Any failure below trips it, which
    // cancels every in-flight sibling request instead of leaving workers
    // downloading from a server we have already written off.
    this.abort = new AbortController();

    try {
      return await this._loadModelInner(onProgress);
    } catch (err) {
      this.abort.abort();
      throw err;
    }
  }

  /** @private — the actual pipeline; loadModel owns the abort lifecycle. */
  async _loadModelInner(onProgress) {
    // 1. Fetch manifest
    await this.fetchManifest();

    // 2. Download encrypted chunks
    const encryptedChunks = await this.downloadChunks(onProgress);

    // 3. Decrypt and reassemble
    const modelBuffer = await this.reassemble(encryptedChunks);

    // 4. Verify integrity
    const valid = await this.verify(modelBuffer);
    if (!valid) {
      const err = new Error('Model integrity verification failed. The model may have been tampered with.');
      err.code = LOADER_ERROR.INTEGRITY;
      throw err;
    }

    // 5. Store and clean up intermediate references
    this.modelBuffer = modelBuffer;
    this.isLoaded = true;

    return modelBuffer;
  }

  /**
   * Release the model buffer from memory.
   */
  dispose() {
    // Abort first: a caller disposing mid-load (the fallback path in
    // onnx_inference.js does exactly this) must not leave chunk requests
    // running against a buffer nobody will read.
    try { this.abort?.abort(); } catch { /* already aborted */ }
    this.abort = null;
    this.modelBuffer = null;
    this.manifest = null;
    this.isLoaded = false;
    console.log('[SecureLoader] Model buffer released from memory.');
  }
}

// ---------------------------------------------------------------------------
// Export to window for cross-script communication
// ---------------------------------------------------------------------------
window.SecureModelLoader = SecureModelLoader;
