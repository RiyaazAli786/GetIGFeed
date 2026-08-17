'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Pluggable persistence for the pool blob: the whole `{ sessions, proxies }`
 * object, in which every secret is already AES-256-GCM encrypted per entry
 * (see poolStore / utils/crypto). This module just moves that blob to/from a
 * durable location — it never sees plaintext secrets.
 *
 * Two backends, chosen automatically:
 *   - b2    : Backblaze B2 (S3-compatible) object storage. Selected when
 *             B2_KEY_ID + B2_APPLICATION_KEY + B2_BUCKET are all set.
 *   - local : a JSON file under DATA_DIR (default ./data). The fallback.
 *
 * Backend contract:
 *   loadSync() -> store | null   (optional; sync fast-path, local only)
 *   load()     -> Promise<store>
 *   save(store)-> Promise<void>
 *   describe() -> string         (for startup logging)
 */

const EMPTY = () => ({ sessions: [], proxies: [] });

function normalize(data) {
  return {
    sessions: Array.isArray(data && data.sessions) ? data.sessions : [],
    proxies: Array.isArray(data && data.proxies) ? data.proxies : [],
  };
}

// ---------------------------------------------------------------------------
// Local filesystem backend
// ---------------------------------------------------------------------------

function createLocalBackend() {
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
  const STORE_PATH = path.join(DATA_DIR, 'pool.json');

  function ensureDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  function loadSync() {
    try {
      ensureDir();
      if (!fs.existsSync(STORE_PATH)) return EMPTY();
      return normalize(JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')));
    } catch {
      return EMPTY();
    }
  }

  return {
    loadSync,
    async load() {
      return loadSync();
    },
    async save(store) {
      ensureDir();
      const tmp = `${STORE_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
      fs.renameSync(tmp, STORE_PATH);
    },
    describe() {
      return `local file (${STORE_PATH})`;
    },
  };
}

// ---------------------------------------------------------------------------
// Backblaze B2 (S3-compatible) backend
// ---------------------------------------------------------------------------

function createB2Backend() {
  // Lazily required so the SDK is only loaded when B2 is actually configured.
  const {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
  } = require('@aws-sdk/client-s3');

  const bucket = process.env.B2_BUCKET;
  const key = process.env.B2_POOL_KEY || 'pool.json';
  const endpoint = process.env.B2_ENDPOINT;
  const region = process.env.B2_REGION || 'us-east-005';

  const client = new S3Client({
    endpoint,
    region,
    credentials: {
      accessKeyId: process.env.B2_KEY_ID,
      secretAccessKey: process.env.B2_APPLICATION_KEY,
    },
    // B2's S3 API works with virtual-hosted-style requests (the default).
  });

  // Only a missing OBJECT means "empty pool, first run". A missing bucket (or
  // any other 404) is a real misconfiguration and must surface, not be masked
  // as an empty pool — so match NoSuchKey specifically, never a bare 404.
  const isNotFound = (err) =>
    Boolean(err && (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey'));

  return {
    // No sync fast-path for remote storage — callers rely on init()/load().
    loadSync: null,
    async load() {
      try {
        const res = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key })
        );
        const body = await res.Body.transformToString();
        return normalize(JSON.parse(body));
      } catch (err) {
        if (isNotFound(err)) return EMPTY(); // first run: object not created yet
        throw err;
      }
    },
    async save(store) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: JSON.stringify(store, null, 2),
          ContentType: 'application/json',
        })
      );
    },
    describe() {
      return `Backblaze B2 (bucket "${bucket}", key "${key}")`;
    },
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function b2Configured() {
  return Boolean(
    process.env.B2_KEY_ID &&
      process.env.B2_APPLICATION_KEY &&
      process.env.B2_BUCKET &&
      process.env.B2_ENDPOINT
  );
}

let backend = null;

/** Return the active backend, creating it on first use. */
function getBackend() {
  if (!backend) {
    backend = b2Configured() ? createB2Backend() : createLocalBackend();
  }
  return backend;
}

module.exports = { getBackend, b2Configured, EMPTY };
