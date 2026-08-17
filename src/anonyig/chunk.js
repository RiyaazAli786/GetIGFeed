'use strict';

/**
 * chunk.js — where the signing chunk comes from, in priority order.
 *
 * ./signer.js runs anonyig's own signing code rather than reimplementing it, so
 * it needs a local copy of that webpack chunk. The chunk is not committed: it is
 * third-party code and it carries the site's HMAC secret, so it is stored at
 * runtime instead. Three places it can come from:
 *
 *   1. disk    — DATA_DIR/anonyig/live_link_chunk.js (ephemeral on free hosts)
 *   2. B2      — the same bucket the pool uses, when B2_* is configured
 *   3. the site — https://anonyig.com/js/app.js -> the chunk it points at
 *
 * (3) is not available everywhere: anonyig.com answers **HTTP 451** to hosts in
 * jurisdictions it refuses to serve, which is what a deployed instance can hit
 * even though a developer machine downloads it fine. That is why (2) exists —
 * run `npm run anonyig:chunk` anywhere the site IS reachable and the chunk is
 * mirrored to B2, from which every instance can then read it. A chunk is only
 * ever stored after ./signer.js has made it produce a real signature.
 *
 * The chunk's cache-busting hash rotates on every deploy, so (3) reads the
 * current one out of the site's entry bundle rather than hardcoding it:
 *
 *   https://anonyig.com/js/app.js
 *     -> webpack's chunk map: i.u = e => "js/" + (54 === e ? "link.chunk" : e)
 *                                       + ".js?ch=" + {54:"<hash>"}[e] + ".js"
 *   https://anonyig.com/js/link.chunk.js?ch=<hash>.js
 *
 * This file deliberately knows nothing about signing — it only moves bytes, so
 * ./signer.js can require it without a cycle.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const ENTRY = `${config.siteOrigin}/js/app.js`;
const SIGNING_CHUNK_ID = 54;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

// ------------------------------------------------------------------ on disk

/** The copy on disk, or null when there is none. */
function read() {
  try {
    return fs.readFileSync(config.chunkPath, 'utf8');
  } catch {
    return null;
  }
}

function save(source) {
  fs.mkdirSync(path.dirname(config.chunkPath), { recursive: true });
  fs.writeFileSync(config.chunkPath, source);
}

// --------------------------------------------------------------------- B2

/**
 * The B2 mirror. Uses the same account as the pool store, under its own key, so
 * an instance that cannot reach anonyig.com still has somewhere to read from.
 */
const remoteConfigured = () =>
  Boolean(
    process.env.B2_KEY_ID &&
      process.env.B2_APPLICATION_KEY &&
      process.env.B2_BUCKET &&
      process.env.B2_ENDPOINT
  );

const remoteKey = () => process.env.B2_ANONYIG_CHUNK_KEY || 'anonyig/live_link_chunk.js';

let s3 = null;
function client() {
  if (!s3) {
    // Lazily required so the SDK is only loaded when B2 is actually configured.
    const { S3Client } = require('@aws-sdk/client-s3');
    s3 = new S3Client({
      endpoint: process.env.B2_ENDPOINT,
      region: process.env.B2_REGION || 'us-east-005',
      credentials: {
        accessKeyId: process.env.B2_KEY_ID,
        secretAccessKey: process.env.B2_APPLICATION_KEY,
      },
    });
  }
  return s3;
}

const isNotFound = (err) =>
  Boolean(err && (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.name === 'NotFound'));

/** The mirrored chunk, or null when B2 is unconfigured or holds no copy yet. */
async function remoteRead() {
  if (!remoteConfigured()) return null;
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  try {
    const res = await client().send(
      new GetObjectCommand({ Bucket: process.env.B2_BUCKET, Key: remoteKey() })
    );
    return await res.Body.transformToString();
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function remoteWrite(source) {
  if (!remoteConfigured()) return false;
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await client().send(
    new PutObjectCommand({
      Bucket: process.env.B2_BUCKET,
      Key: remoteKey(),
      Body: source,
      ContentType: 'application/javascript',
    })
  );
  return true;
}

const describeRemote = () =>
  remoteConfigured() ? `B2 (bucket "${process.env.B2_BUCKET}", key "${remoteKey()}")` : null;

// ------------------------------------------------------------------ the site

async function get(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: `${config.siteOrigin}/` },
  });
  if (!res.ok) {
    // 451 (and 403) mean the host itself is refused, not that the URL is wrong.
    // Say so, because the remedy is completely different from a broken URL.
    if (res.status === 451 || res.status === 403) {
      throw new Error(
        `anonyig.com refuses this host (HTTP ${res.status}) — run \`npm run anonyig:chunk\` ` +
          'somewhere it is reachable to mirror the chunk to B2, which this instance can read'
      );
    }
    throw new Error(`GET ${url} -> HTTP ${res.status}`);
  }
  return res.text();
}

/** Pull the chunk's current `ch=` hash out of webpack's chunk map. */
function findChunkHash(entrySource, chunkId) {
  const patterns = [
    // {54:"92034df91fb20f82", 277:"…"} inside the .u chunk-url builder
    new RegExp(`\\{\\s*${chunkId}\\s*:\\s*"([a-f0-9]{8,})"`),
    // fallback: the id appears anywhere mapped to a hash-looking string
    new RegExp(`${chunkId}\\s*:\\s*"([a-f0-9]{16})"`),
  ];
  for (const re of patterns) {
    const match = entrySource.match(re);
    if (match) return match[1];
  }
  return null;
}

/** Fetch the current chunk from the site. Returns the source without storing it. */
async function download() {
  const entry = await get(ENTRY);
  if (!entry.includes('link.chunk')) {
    throw new Error(
      'anonyig entry bundle no longer references "link.chunk" — the site\'s build ' +
        `layout changed; find the signing chunk manually and save it as ${config.chunkPath}`
    );
  }

  const hash = findChunkHash(entry, SIGNING_CHUNK_ID);
  if (!hash) {
    throw new Error(`could not find a hash for chunk ${SIGNING_CHUNK_ID} in the anonyig entry bundle`);
  }

  const source = await get(`${config.siteOrigin}/js/link.chunk.js?ch=${hash}.js`);

  // The chunk ships its own SHA-256, so its initialisation constants are present
  // even though every identifier and most strings are obfuscated. (Don't grep
  // for "LZString" — it is hex-escaped in the source.)
  if (!source.includes('0x6a09e667') || !source.includes('0x428a2f98')) {
    throw new Error('downloaded file does not look like the anonyig signing chunk');
  }

  return source;
}

// ----------------------------------------------------------------- resolution

/**
 * Where to look, in order.
 *
 * A refresh skips the disk copy — that is the copy being replaced — and prefers
 * the site, falling back to B2 for the hosts the site will not serve.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.refresh]
 * @returns {Array<{name: string, load: () => Promise<?string>}>}
 */
function sources({ refresh = false } = {}) {
  const disk = { name: 'disk', load: async () => read() };
  const remote = { name: 'b2', load: remoteRead };
  const site = { name: 'anonyig.com', load: download };

  if (refresh) return remoteConfigured() ? [site, remote] : [site];
  return remoteConfigured() ? [disk, remote, site] : [disk, site];
}

/**
 * Store a chunk that has just proved it can sign. Always kept on disk; also
 * mirrored to B2 when it came from the site, so the next instance — or one that
 * anonyig.com refuses — can read it without going there.
 *
 * @param {string} source
 * @param {string} from the source name it came from
 */
async function persist(source, from) {
  if (from !== 'disk') {
    try {
      save(source);
    } catch (err) {
      // A read-only or full filesystem is survivable: the chunk is already
      // loaded in memory, it just will not outlive this process.
      // eslint-disable-next-line no-console
      console.warn(`[anonyig] could not write ${config.chunkPath}: ${err.message}`);
    }
  }

  if (from === 'anonyig.com' && remoteConfigured()) {
    try {
      await remoteWrite(source);
      // eslint-disable-next-line no-console
      console.log(`[anonyig] mirrored the signing chunk to ${describeRemote()}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[anonyig] could not mirror the chunk to B2: ${err.message}`);
    }
  }
}

module.exports = {
  read,
  save,
  download,
  sources,
  persist,
  remoteRead,
  remoteWrite,
  remoteConfigured,
  describeRemote,
  entryUrl: ENTRY,
  path: config.chunkPath,
};

// CLI: npm run anonyig:chunk — refresh from the site and mirror it to B2.
if (require.main === module) {
  require('dotenv').config();
  const { getSigner } = require('./signer');
  getSigner({ refresh: true })
    .then((sign) => sign({ username: 'test' }))
    .then((signed) => {
      // eslint-disable-next-line no-console
      console.log(`Stored ${config.chunkPath}`);
      if (remoteConfigured()) {
        // eslint-disable-next-line no-console
        console.log(`Mirrored to ${describeRemote()} — deployed instances read it from there`);
      } else {
        // eslint-disable-next-line no-console
        console.log('B2 is not configured, so nothing was mirrored (set B2_* to share it).');
      }
      // eslint-disable-next-line no-console
      console.log(`Verified: chunk signs requests (_sv ${signed._sv}, _ts ${signed._ts})`);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`anonyig chunk refresh failed: ${err.message}`);
      process.exitCode = 1;
    });
}
