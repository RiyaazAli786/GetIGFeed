'use strict';

/**
 * chunk.js — where the signing chunk for iGram comes from, in priority order.
 *
 * Chunk 909 contains iGram's HMAC signer. Three places it can come from:
 *   1. disk    — DATA_DIR/igram/live_link_chunk.js
 *   2. B2      — B2 bucket, when B2_* is configured
 *   3. the site — https://igram.world/js/app.js -> the chunk 909 it points at
 *
 * Run `npm run igram:chunk` to refresh from the site and mirror to B2.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const config = require('./config');

const ENTRY = `${config.siteOrigin}/js/app.js`;
const SIGNING_CHUNK_ID = 909;

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

const remoteKey = () => process.env.B2_IGRAM_CHUNK_KEY || 'igram/live_link_chunk.js';

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
  const proxy = config.proxy || process.env.IGRAM_PROXY || process.env.ANONYIG_PROXY || null;

  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, referer: `${config.siteOrigin}/` },
    });
    if (res.ok) return await res.text();
  } catch (err) {
    if (!proxy) throw err;
  }

  if (proxy) {
    try {
      const agent = new HttpsProxyAgent(proxy);
      const res = await axios.get(url, {
        headers: { 'user-agent': UA, referer: `${config.siteOrigin}/` },
        httpsAgent: agent,
        proxy: false,
        timeout: 20000,
        responseType: 'text',
      });
      if (res.status === 200 && res.data) {
        return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      }
    } catch (err) {
      const status = err.response?.status;
      if (status === 451 || status === 403) {
        throw new Error(
          `igram.world refuses this host (HTTP ${status}) — run \`npm run igram:chunk\` ` +
            'somewhere it is reachable to mirror the chunk to B2, which this instance can read'
        );
      }
      throw new Error(`GET ${url} -> ${err.message}`);
    }
  }

  throw new Error(
    `igram.world refuses this host — run \`npm run igram:chunk\` ` +
      'somewhere it is reachable to mirror the chunk to B2, which this instance can read'
  );
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

function patchChunkSource(raw) {
  // Bypasses synthetic anti-bot DOM prototype throw
  const targetPattern = /throw new\(_2HoAi\(p88YORO\(_0xH3BJ\[0x27\]\)\+_0xH3BJ\[0x28\]\)\)\(p88YORO\(0x2a5\)\+p88YORO\(0x2a6\)\+p88YORO\(0x2a7\)\+p88YORO\(0x2a8\)\+p88YORO\(0x2a9\)\+_0xH3BJ\[0x51\]\);/;
  if (targetPattern.test(raw)) {
    return raw.replace(
      targetPattern,
      '/* bypassed */ NcfkLHE[p88YORO(_0xH3BJ[0xf5])]=_0xH3BJ[0x58];break;'
    );
  }
  return raw;
}

async function download() {
  const entry = await get(ENTRY);
  if (!entry.includes('link.chunk')) {
    throw new Error(
      'igram entry bundle no longer references "link.chunk" — the site\'s build ' +
        `layout changed; find the signing chunk manually and save it as ${config.chunkPath}`
    );
  }

  const hash = findChunkHash(entry, SIGNING_CHUNK_ID);
  if (!hash) {
    throw new Error(`could not find a hash for chunk ${SIGNING_CHUNK_ID} in the igram entry bundle`);
  }

  const source = await get(`${config.siteOrigin}/js/link.chunk.js?ch=${hash}.js`);

  if (!source.includes('_s') && !source.includes('LZString')) {
    throw new Error('downloaded file does not look like the igram signing chunk');
  }

  return patchChunkSource(source);
}

// ----------------------------------------------------------------- resolution

function sources({ refresh = false } = {}) {
  const disk = { name: 'disk', load: async () => read() };
  const remote = { name: 'b2', load: remoteRead };
  const site = { name: 'igram.world', load: download };

  if (refresh) return remoteConfigured() ? [site, remote] : [site];
  return remoteConfigured() ? [disk, remote, site] : [disk, site];
}

async function persist(source, from) {
  if (from !== 'disk') {
    try {
      save(source);
    } catch (err) {
      console.warn(`[igram] could not write ${config.chunkPath}: ${err.message}`);
    }
  }

  if (from !== 'b2' && remoteConfigured()) {
    try {
      await remoteWrite(source);
      console.log(`[igram] mirrored the signing chunk to ${describeRemote()}`);
    } catch (err) {
      console.warn(`[igram] could not mirror the chunk to B2: ${err.message}`);
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
  patchChunkSource,
};

// CLI: npm run igram:chunk
if (require.main === module) {
  require('dotenv').config();
  const { getSigner } = require('./signer');
  getSigner({ refresh: true })
    .then((sign) => sign({ username: 'instagram' }))
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
      console.error(`igram chunk refresh failed: ${err.message}`);
      process.exitCode = 1;
    });
}
