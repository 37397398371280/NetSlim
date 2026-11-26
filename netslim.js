class NetSlim {
  constructor(options = {}) {
    this.mode = options.mode ?? 'compatible';
    this.format = options.format ?? 'gzip';
    this.autoUnpackResponse = options.autoUnpackResponse ?? true;
    this.brotliDecompress = options.brotliDecompress ?? null;
    this.cacheTtlMs = options.cacheTtlMs ?? 10000;
    this.persistCache = options.persistCache ?? false;
    this.storagePrefix = options.storagePrefix ?? 'netslim:';
    this.stripNulls = options.stripNulls ?? false;
    this.stripEmptyStrings = options.stripEmptyStrings ?? false;
    this.maxImageWidth = options.maxImageWidth ?? 1920;
    this.imageQuality = options.imageQuality ?? 0.85;
    this.compressThreshold = options.compressThreshold ?? 512;
    this.debug = options.debug ?? false;

    this.originalFetch = typeof fetch === 'function' ? fetch.bind(window) : null;
    this.hasCompressStream = typeof CompressionStream !== 'undefined';
    this.hasDecompressStream = typeof DecompressionStream !== 'undefined';

    this.memoryCache = new Map();
    this.inflight = new Map();
    this.stats = {
      requests: 0,
      cacheHits: 0,
      coalesced: 0,
      unpackedResponses: 0,
      bytesSaved: 0
    };
  }

  async compress(input, format = this.format) {
    if (!this.hasCompressStream) {
      throw new Error('CompressionStream is not supported in this runtime.');
    }
    const bytes =
      typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);

    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream(format));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  async decompress(input, format = this.format, asText = true) {
    const bytes =
      typeof input === 'string'
        ? this.base64ToBytes(input)
        : input instanceof Uint8Array
          ? input
          : new Uint8Array(input);

    if (format === 'br') {
      if (typeof this.brotliDecompress !== 'function') {
        throw new Error('Brotli payload received, but no brotliDecompress handler was provided.');
      }
      const decoded = await this.brotliDecompress(bytes);
      if (typeof decoded === 'string') {
        return asText ? decoded : new TextEncoder().encode(decoded);
      }
      const u8 = decoded instanceof Uint8Array ? decoded : new Uint8Array(decoded);
      return asText ? new TextDecoder().decode(u8) : u8;
    }

    if (!this.hasDecompressStream) {
      throw new Error('DecompressionStream is not supported in this runtime.');
    }

    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    const buf = await new Response(stream).arrayBuffer();
    const out = new Uint8Array(buf);
    return asText ? new TextDecoder().decode(out) : out;
  }

  bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async unpackResponseIfNeeded(response) {
    if (!this.autoUnpackResponse || !response || !response.ok) return response;

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/json')) return response;

    try {
      const clone = response.clone();
      const parsed = await clone.json();

      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed._ns === 'string' &&
        typeof parsed.data === 'string'
      ) {
        const unpackedText = await this.decompress(parsed.data, parsed._ns, true);
        this.stats.unpackedResponses += 1;

        if (this.debug) {
          console.log(
            `[NetSlim] Unpacked ${parsed._ns} payload (${parsed.data.length} chars -> ${unpackedText.length} chars)`
          );
        }

        const headers = new Headers(response.headers);
        return new Response(unpackedText, {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      }
    } catch {
    }

    return response;
  }

  _cleanJson(val) {
    if (val === null || val === undefined) return this.stripNulls ? undefined : val;
    if (val === '' && this.stripEmptyStrings) return undefined;
    if (Array.isArray(val)) {
      return val.map((v) => this._cleanJson(v)).filter((v) => v !== undefined);
    }
    if (typeof val === 'object') {
      const next = {};
      for (const [k, v] of Object.entries(val)) {
        const cleaned = this._cleanJson(v);
        if (cleaned !== undefined) next[k] = cleaned;
      }
      return next;
    }
    return val;
  }

  minifyJson(str) {
    if (typeof str !== 'string') return str;
    const trimmed = str.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return str;

    try {
      const parsed = JSON.parse(trimmed);
      const shaped =
        this.stripNulls || this.stripEmptyStrings ? this._cleanJson(parsed) : parsed;
      const compact = JSON.stringify(shaped);
      if (compact.length < str.length) {
        this.stats.bytesSaved += str.length - compact.length;
        return compact;
      }
    } catch {
    }
    return str;
  }

  async optimizeImage(blob) {
    if (!(blob instanceof Blob) || !blob.type.startsWith('image/')) return blob;
    if (blob.type === 'image/gif' || blob.type === 'image/svg+xml') return blob;
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return blob;

    try {
      const bitmap = await createImageBitmap(blob);
      const scale = bitmap.width > this.maxImageWidth ? this.maxImageWidth / bitmap.width : 1;
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();

      const mime = blob.type === 'image/png' ? 'image/webp' : blob.type;
      const outBlob = await new Promise((resolve) =>
        canvas.toBlob(resolve, mime, this.imageQuality)
      );

      if (outBlob && outBlob.size < blob.size) {
        this.stats.bytesSaved += blob.size - outBlob.size;
        return outBlob;
      }
    } catch {
    }
    return blob;
  }

  async _prepareBody(body, headers) {
    if (!body) return body;

    if (typeof body === 'string') {
      const minified = this.minifyJson(body);

      if (
        this.mode === 'compressed' &&
        this.hasCompressStream &&
        minified.length >= this.compressThreshold
      ) {
        const rawLen = new TextEncoder().encode(minified).length;
        const compressed = await this.compress(minified, this.format);
        if (compressed.byteLength < rawLen) {
          headers.set('Content-Encoding', this.format);
          this.stats.bytesSaved += rawLen - compressed.byteLength;
          return compressed;
        }
      }
      return minified;
    }

    if (body instanceof Blob) {
      return this.optimizeImage(body);
    }

    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const nextForm = new FormData();
      for (const [key, val] of body.entries()) {
        if (val instanceof File) {
          nextForm.append(key, await this.optimizeImage(val), val.name);
        } else {
          nextForm.append(key, val);
        }
      }
      return nextForm;
    }

    return body;
  }

  _cacheKey(url, options) {
    const method = (options.method || 'GET').toUpperCase();
    const bodyStr = typeof options.body === 'string' ? options.body : '';
    return `${method}:${String(url)}:${bodyStr}`;
  }

  _readLocalCache(key) {
    if (!this.persistCache || typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(this.storagePrefix + key);
      if (!raw) return null;
      const item = JSON.parse(raw);
      if (Date.now() > item.expiresAt) {
        localStorage.removeItem(this.storagePrefix + key);
        return null;
      }
      return item;
    } catch {
      return null;
    }
  }

  async _writeLocalCache(key, res, expiresAt) {
    if (!this.persistCache || typeof localStorage === 'undefined') return;
    try {
      const clone = res.clone();
      const text = await clone.text();
      localStorage.setItem(
        this.storagePrefix + key,
        JSON.stringify({
          expiresAt,
          status: clone.status,
          statusText: clone.statusText,
          headers: Array.from(clone.headers.entries()),
          body: text
        })
      );
    } catch {
    }
  }

  async fetch(url, options = {}) {
    this.stats.requests += 1;
    const method = (options.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers || {});
    const nextOptions = { ...options, headers };

    if (nextOptions.body) {
      nextOptions.body = await this._prepareBody(nextOptions.body, headers);
    }

    const key = this._cacheKey(url, nextOptions);

    if (method === 'GET' && this.cacheTtlMs > 0) {
      const mem = this.memoryCache.get(key);
      if (mem && mem.expiresAt > Date.now()) {
        this.stats.cacheHits += 1;
        if (this.debug) console.log(`[NetSlim] Cache hit: ${url}`);
        return mem.response.clone();
      }

      const disk = this._readLocalCache(key);
      if (disk) {
        this.stats.cacheHits += 1;
        if (this.debug) console.log(`[NetSlim] Persistent cache hit: ${url}`);
        return new Response(disk.body, {
          status: disk.status,
          statusText: disk.statusText,
          headers: disk.headers
        });
      }
    }

    if (this.inflight.has(key)) {
      this.stats.coalesced += 1;
      if (this.debug) console.log(`[NetSlim] Coalesced duplicate request: ${url}`);
      const shared = await this.inflight.get(key);
      return shared.clone();
    }

    const promise = this.originalFetch(url, nextOptions).then(async (rawRes) => {
      const res = await this.unpackResponseIfNeeded(rawRes);
      if (method === 'GET' && res.ok && this.cacheTtlMs > 0) {
        const expiresAt = Date.now() + this.cacheTtlMs;
        this.memoryCache.set(key, { expiresAt, response: res.clone() });
        await this._writeLocalCache(key, res, expiresAt);
      }
      return res;
    });

    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  getStats() {
    return { ...this.stats };
  }

  enableGlobal() {
    if (!this.originalFetch) return;
    window.fetch = this.fetch.bind(window);
    if (this.debug) console.log(`[NetSlim] Global fetch hooked (${this.mode} mode).`);
  }

  disableGlobal() {
    if (this.originalFetch) window.fetch = this.originalFetch;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = NetSlim;
} else if (typeof window !== 'undefined') {
  window.NetSlim = NetSlim;
}
