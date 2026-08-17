'use strict';

/**
 * chunk.js — where the signing chunk for FastDL comes from, in priority order.
 *
 * It mirrors the anonyig chunk fetcher. Chunk 54 contains the site's HMAC secret,
 * so it is fetched at runtime rather than committed. Three places it can come from:
 *
 *   1. disk    — DATA_DIR/fastdl/live_link_chunk.js
 *   2. B2      — B2 bucket, when B2_* is configured
 *   3. the site — https://fastdl.app/js/app.js -> the chunk 54 it points at
 *
 * Run `npm run fastdl:chunk` to refresh from the site and mirror to B2.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const ENTRY = `${config.siteOrigin}/js/app.js`;
const SIGNING_CHUNK_ID = 54;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

// ------------------------------------------------------------------ on disk

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

const remoteConfigured = () =>
  Boolean(
    process.env.B2_KEY_ID &&
      process.env.B2_APPLICATION_KEY &&
      process.env.B2_BUCKET &&
      process.env.B2_ENDPOINT
  );

const remoteKey = () => process.env.B2_FASTDL_CHUNK_KEY || 'fastdl/live_link_chunk.js';

let s3 = null;
function client() {
  if (!s3) {
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
    if (res.status === 451 || res.status === 403) {
      throw new Error(
        `fastdl.app refuses this host (HTTP ${res.status}) — run \`npm run fastdl:chunk\` ` +
          'somewhere it is reachable to mirror the chunk to B2, which this instance can read'
      );
    }
    throw new Error(`GET ${url} -> HTTP ${res.status}`);
  }
  return res.text();
}

function findChunkHash(entrySource, chunkId) {
  const patterns = [
    new RegExp(`\\{\\s*${chunkId}\\s*:\\s*"([a-f0-9]{8,})"`),
    new RegExp(`${chunkId}\\s*:\\s*"([a-f0-9]{16})"`),
  ];
  for (const re of patterns) {
    const match = entrySource.match(re);
    if (match) return match[1];
  }
  return null;
}

async function download() {
  const entry = await get(ENTRY);
  if (!entry.includes('link.chunk')) {
    throw new Error(
      'fastdl entry bundle no longer references "link.chunk" — the site\'s build ' +
        `layout changed; find the signing chunk manually and save it as ${config.chunkPath}`
    );
  }

  const hash = findChunkHash(entry, SIGNING_CHUNK_ID);
  if (!hash) {
    throw new Error(`could not find a hash for chunk ${SIGNING_CHUNK_ID} in the fastdl entry bundle`);
  }

  const source = await get(`${config.siteOrigin}/js/link.chunk.js?ch=${hash}.js`);

  if (!source.includes('eLUs3Z') && !source.includes('kEMAwP')) {
    throw new Error('downloaded file does not look like the fastdl signing chunk');
  }

  return source;
}

// ----------------------------------------------------------------- resolution

function sources({ refresh = false } = {}) {
  const disk = { name: 'disk', load: async () => read() };
  const remote = { name: 'b2', load: remoteRead };
  const site = { name: 'fastdl.app', load: download };

  if (refresh) return remoteConfigured() ? [site, remote] : [site];
  return remoteConfigured() ? [disk, remote, site] : [disk, site];
}

async function persist(source, from) {
  if (from !== 'disk') {
    try {
      save(source);
    } catch (err) {
      console.warn(`[fastdl] could not write ${config.chunkPath}: ${err.message}`);
    }
  }

  if (from === 'fastdl.app' && remoteConfigured()) {
    try {
      await remoteWrite(source);
      console.log(`[fastdl] mirrored the signing chunk to ${describeRemote()}`);
    } catch (err) {
      console.warn(`[fastdl] could not mirror the chunk to B2: ${err.message}`);
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

// CLI: npm run fastdl:chunk — refresh from the site and mirror it to B2.
if (require.main === module) {
  require('dotenv').config();
  const { getSigner } = require('./signer');
  getSigner({ refresh: true })
    .then((sign) => sign('https://www.instagram.com/p/DbbY9pdm6Q2/'))
    .then((signed) => {
      console.log(`Stored ${config.chunkPath}`);
      if (remoteConfigured()) {
        console.log(`Mirrored to ${describeRemote()} — deployed instances read it from there`);
      } else {
        console.log('B2 is not configured, so nothing was mirrored (set B2_* to share it).');
      }
      console.log(`Verified: chunk signs requests (_sv ${signed._sv}, _ts ${signed._ts})`);
    })
    .catch((err) => {
      console.error(`fastdl chunk refresh failed: ${err.message}`);
      process.exitCode = 1;
    });
}
