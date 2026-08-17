'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const archiver = require('archiver');
const config = require('../config/story');
const { request } = require('../utils/httpFetch');
const { sanitizeFileName, mediaExtension, decodeEmbedUrl } = require('../utils/strings');

/**
 * Media fetching + zipping. The C# equivalents (DownloadFileAsync,
 * DownloadMediaExecute, DownloadHightlightsExecute) wrote to a local folder;
 * here the bytes are streamed to the HTTP client instead.
 */

/** SSRF guard - the proxy only forwards to the CDNs these sources use. */
function assertAllowedUrl(rawUrl) {
  let url;
  try {
    url = new URL(decodeEmbedUrl(rawUrl));
  } catch {
    const error = new Error('A valid absolute url is required.');
    error.statusCode = 400;
    throw error;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    const error = new Error('Only http(s) urls can be downloaded.');
    error.statusCode = 400;
    throw error;
  }
  if (!config.download.allowedHosts.some((pattern) => pattern.test(url.hostname))) {
    const error = new Error(`Host not allowed: ${url.hostname}`);
    error.statusCode = 403;
    throw error;
  }
  return url.toString();
}

/** Instagram's CDN is happier with a browser UA + referer. */
function mediaHeaders() {
  return {
    'User-Agent': config.userAgents.chromeWin,
    Accept: '*/*',
    Referer: 'https://www.instagram.com/',
  };
}

async function fetchMediaResponse(rawUrl) {
  const url = assertAllowedUrl(rawUrl);
  const response = await request(url, { headers: mediaHeaders() });
  if (!response.ok) {
    const error = new Error(`Upstream media responded ${response.status}`);
    error.statusCode = response.status === 404 ? 404 : 502;
    throw error;
  }
  return response;
}

/**
 * Reads a media response to a Buffer while reporting byte progress, so the zip
 * job can show how far along the current file is.
 */
async function readWithProgress(response, onProgress) {
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (onProgress) onProgress(buffer.length, buffer.length);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let lastEmit = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    // Throttle: a chatty SSE stream costs more than it tells the user.
    if (onProgress && (received - lastEmit > 65536 || received === total)) {
      lastEmit = received;
      onProgress(received, total);
    }
  }
  if (onProgress) onProgress(received, total || received);
  return Buffer.concat(chunks);
}

/** Single download / inline preview proxy. */
async function pipeMedia(rawUrl, res, { filename, inline } = {}) {
  const response = await fetchMediaResponse(rawUrl);
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  res.setHeader('Content-Type', contentType);

  const length = response.headers.get('content-length');
  // Content-Length lets the browser render a determinate progress bar.
  if (length) res.setHeader('Content-Length', length);

  if (inline) {
    res.setHeader('Cache-Control', 'public, max-age=900');
  } else {
    const name = filename || 'download';
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"`);
  }

  res.end(Buffer.from(await response.arrayBuffer()));
}

/* ------------------------------------------------------------------ *
 * zip entry naming
 * ------------------------------------------------------------------ */

/**
 * Entry paths, mirroring the desktop naming but foldered:
 *   <user>.jpg
 *   Stories/<user>_Story_<n>.<ext>
 *   Highlights/<Highlight Title>/<user>_<Highlight Title>_<n>.<ext>
 *
 * Each highlight gets its own folder named after its (normalized) title, so a
 * highlight's images and videos land together.
 */
function buildEntryPath(safeUser, item, counters) {
  const extension = mediaExtension(item.url, item.type);
  const kind = (item.kind || 'story').toLowerCase();

  const next = (key) => {
    const value = counters.get(key) || 0;
    counters.set(key, value + 1);
    return value;
  };

  if (kind === 'profile') return `${safeUser}.${extension}`;

  if (kind === 'highlight') {
    const folder = sanitizeFileName(item.highlightTitle || item.highlightId || 'Highlight');
    const index = next(`highlight:${folder}`);
    return `Highlights/${folder}/${safeUser}_${folder}_${index}.${extension}`;
  }

  return `Stories/${safeUser}_Story_${next('story')}.${extension}`;
}

function uniqueName(used, name) {
  let candidate = name;
  let counter = 1;
  while (used.has(candidate)) {
    const dot = name.lastIndexOf('.');
    candidate = dot > 0 ? `${name.slice(0, dot)}_${counter}${name.slice(dot)}` : `${name}_${counter}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

function validateItems(items) {
  const list = (items || []).filter((item) => item && item.url);
  if (!list.length) {
    const error = new Error('Nothing to download.');
    error.statusCode = 400;
    throw error;
  }
  if (list.length > config.download.maxZipItems) {
    const error = new Error(`Too many items (max ${config.download.maxZipItems}).`);
    error.statusCode = 400;
    throw error;
  }
  return list;
}

/* ------------------------------------------------------------------ *
 * one-shot zip (no progress) - handy from curl / scripts
 * ------------------------------------------------------------------ */

async function zipToResponse(username, items, res) {
  const safeUser = sanitizeFileName(username || 'instagram');
  const list = validateItems(items);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeUser}.zip"`);

  const archive = archiver('zip', { zlib: { level: 0 }, store: true });
  archive.on('warning', (err) => console.warn('[zip] warning:', err.message));
  archive.on('error', (err) => {
    console.error('[zip] error:', err.message);
    res.destroy(err);
  });
  archive.pipe(res);

  const { failed } = await appendAll(archive, safeUser, list);
  await archive.finalize();
  return { total: list.length, failed: failed.length };
}

/** Shared body of both zip paths: fetch each item, append, collect failures. */
async function appendAll(archive, safeUser, list, onProgress) {
  const used = new Set();
  const counters = new Map();
  const failed = [];

  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    const entry = uniqueName(used, item.filename || buildEntryPath(safeUser, item, counters));
    try {
      if (onProgress) onProgress({ index, entry, received: 0, size: 0 });
      const response = await fetchMediaResponse(item.url);
      const buffer = await readWithProgress(response, (received, size) => {
        if (onProgress) onProgress({ index, entry, received, size });
      });
      archive.append(buffer, { name: entry });
      if (onProgress) onProgress({ index, entry, received: buffer.length, size: buffer.length, done: true });
    } catch (error) {
      failed.push(`${entry}\t${item.url}\t${error.message}`);
      if (onProgress) onProgress({ index, entry, received: 0, size: 0, done: true, error: error.message });
    }
  }

  if (failed.length) {
    archive.append(
      `These files could not be downloaded (the CDN links expire quickly):\n\n${failed.join('\n')}\n`,
      { name: '_failed.txt' }
    );
  }
  return { failed };
}

/* ------------------------------------------------------------------ *
 * zip job + progress stream
 * ------------------------------------------------------------------ */

const jobs = new Map();
const JOB_TTL_MS = 30 * 60 * 1000;

/**
 * Builds the zip into a temp file in the background so the client can watch
 * per-file progress over SSE, then download the finished archive with a known
 * Content-Length (i.e. a determinate progress bar on both halves).
 */
function startZipJob(username, items) {
  const list = validateItems(items);
  const safeUser = sanitizeFileName(username || 'instagram');
  const id = crypto.randomUUID();

  const job = {
    id,
    safeUser,
    filename: `${safeUser}.zip`,
    status: 'running',
    total: list.length,
    completed: 0,
    index: 0,
    entry: null,
    received: 0,
    size: 0,
    failed: 0,
    zipSize: 0,
    error: null,
    filePath: path.join(os.tmpdir(), `gish-${id}.zip`),
    createdAt: Date.now(),
    emitter: new EventEmitter(),
  };
  job.emitter.setMaxListeners(0);
  jobs.set(id, job);

  runZipJob(job, list).catch((error) => {
    job.status = 'error';
    job.error = error.message;
    job.emitter.emit('update', snapshot(job));
  });

  return job;
}

async function runZipJob(job, list) {
  const output = fs.createWriteStream(job.filePath);
  const archive = archiver('zip', { zlib: { level: 0 }, store: true });

  const finished = new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (err) => console.warn('[zip] warning:', err.message));
  });
  archive.pipe(output);

  const { failed } = await appendAll(archive, job.safeUser, list, (progress) => {
    job.index = progress.index;
    job.entry = progress.entry;
    job.received = progress.received;
    job.size = progress.size;
    if (progress.done) job.completed = progress.index + 1;
    job.emitter.emit('update', snapshot(job));
  });

  job.status = 'packaging';
  job.emitter.emit('update', snapshot(job));

  await archive.finalize();
  await finished;

  job.failed = failed.length;
  job.zipSize = fs.statSync(job.filePath).size;
  job.status = 'ready';
  job.emitter.emit('update', snapshot(job));
}

function snapshot(job) {
  return {
    id: job.id,
    status: job.status,
    filename: job.filename,
    total: job.total,
    completed: job.completed,
    index: job.index,
    entry: job.entry,
    received: job.received,
    size: job.size,
    failed: job.failed,
    zipSize: job.zipSize,
    error: job.error,
  };
}

function getJob(id) {
  const job = jobs.get(id);
  if (!job) {
    const error = new Error('Unknown or expired download job.');
    error.statusCode = 404;
    throw error;
  }
  return job;
}

/** Server-sent events: one message per progress update, then close. */
function streamJobEvents(id, req, res) {
  const job = getJob(id);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send(snapshot(job));

  const onUpdate = (data) => {
    send(data);
    if (data.status === 'ready' || data.status === 'error') finish();
  };
  const finish = () => {
    job.emitter.off('update', onUpdate);
    clearInterval(ping);
    res.end();
  };

  // Comment frames keep proxies from closing an idle stream.
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  job.emitter.on('update', onUpdate);
  req.on('close', () => {
    job.emitter.off('update', onUpdate);
    clearInterval(ping);
  });

  if (job.status === 'ready' || job.status === 'error') finish();
}

/** Serves the finished archive, then drops the temp file. */
function sendJobFile(id, res) {
  const job = getJob(id);
  if (job.status === 'error') {
    const error = new Error(job.error || 'Zip failed.');
    error.statusCode = 500;
    throw error;
  }
  if (job.status !== 'ready') {
    const error = new Error('Zip is still being prepared.');
    error.statusCode = 409;
    throw error;
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', job.zipSize);
  res.setHeader('Content-Disposition', `attachment; filename="${job.filename}"`);

  const stream = fs.createReadStream(job.filePath);
  stream.pipe(res);
  stream.on('close', () => dropJob(job.id));
  stream.on('error', () => dropJob(job.id));
}

function dropJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  fs.rm(job.filePath, { force: true }, () => {});
}

// Sweep abandoned jobs (client closed the tab, never fetched the file).
const sweeper = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) if (job.createdAt < cutoff) dropJob(id);
}, 5 * 60 * 1000);
sweeper.unref?.();

module.exports = {
  pipeMedia,
  zipToResponse,
  assertAllowedUrl,
  buildEntryPath,
  startZipJob,
  streamJobEvents,
  sendJobFile,
  snapshot,
};
