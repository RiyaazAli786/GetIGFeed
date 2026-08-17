'use strict';

/**
 * status.js — checks FastDL.app and its worker hub reachability, and
 * validates the signing chunk state.
 */

const fs = require('fs');
const config = require('./config');
const chunk = require('./chunk');
const { getSigner } = require('./signer');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

async function probeSite() {
  try {
    const res = await fetch(chunk.entryUrl, {
      headers: { 'user-agent': UA, referer: `${config.siteOrigin}/` },
    });
    return {
      reachable: res.ok,
      status: res.status,
      note:
        res.status === 451 || res.status === 403
          ? 'refuses this host — mirror the chunk to B2 instead (npm run fastdl:chunk)'
          : null,
    };
  } catch (err) {
    return { reachable: false, status: null, error: err.message };
  }
}

async function chunkStatus() {
  const local = { path: chunk.path, present: false, bytes: null, modified: null };
  try {
    const stat = fs.statSync(chunk.path);
    local.present = true;
    local.bytes = stat.size;
    local.modified = stat.mtime.toISOString();
  } catch {
    /* not present */
  }

  const mirror = { configured: chunk.remoteConfigured(), location: chunk.describeRemote(), present: null };
  if (mirror.configured) {
    try {
      mirror.present = Boolean(await chunk.remoteRead());
    } catch (err) {
      mirror.present = null;
      mirror.error = err.message;
    }
  }

  const signer = { ready: false, error: null };
  try {
    const sign = await getSigner();
    // Test signing a dummy URL
    const signed = await sign('https://www.instagram.com/p/DbbY9pdm6Q2/');
    signer.ready = /^[0-9a-f]{64}$/.test(signed?._s || '');
  } catch (err) {
    signer.error = err.message;
  }

  return { local, mirror, signer };
}

async function report(client) {
  const [site, hub, chunkState] = await Promise.all([probeSite(), client.probe(), chunkStatus()]);
  const proxy = client.proxyInfo();

  let verdict;
  if (!hub.reachable && proxy.enabled) {
    verdict = `the configured proxy did not carry the request — ${hub.error}`;
  } else if (hub.challenged) {
    verdict =
      'the hub is serving a captcha challenge to this host. ' +
      (proxy.enabled
        ? `The proxy in use (${hub.proxy}) is distrusted too — it needs to be a residential address.`
        : 'Route the hub through a residential proxy by setting FASTDL_PROXY or FASTDL_USE_POOL_PROXY=true.');
  } else if (chunkState.signer.ready && hub.reachable) {
    verdict = 'ok — signing works and the hub is reachable';
  } else if (!hub.reachable) {
    verdict =
      'the worker hub is unreachable from this host, so no chunk can help — ' +
      'requests need to leave through a proxy';
  } else if (!chunkState.signer.ready && !site.reachable && !chunkState.mirror.present) {
    verdict =
      'the hub is reachable but there is no signing chunk: this host cannot download one. ' +
      'Run `npm run fastdl:chunk` where fastdl.app IS reachable to mirror it, then retry.';
  } else if (!chunkState.signer.ready) {
    verdict = `no usable signing chunk: ${chunkState.signer.error}`;
  } else {
    verdict = 'signing works';
  }

  return {
    verdict,
    site: { host: config.siteOrigin, ...site },
    hub: { host: config.workerHub, ...hub },
    proxy,
    chunk: chunkState,
  };
}

module.exports = { report, probeSite, chunkStatus };
