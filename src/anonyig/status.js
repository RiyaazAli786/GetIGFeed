'use strict';

/**
 * status.js — what this instance can actually reach, and where its signing
 * chunk stands.
 *
 * The module talks to two different hosts, and they are blocked independently:
 * anonyig.com (the site the chunk comes from) answers HTTP 451 to hosts in
 * jurisdictions it refuses, while api-wh.anonyig.com (the worker hub, where the
 * data comes from) may still answer fine. From a failing request alone the two
 * are indistinguishable — the chunk is fetched first, so a blocked site hides
 * whatever the hub would have said. This probes them separately and says which.
 */

const fs = require('fs');
const config = require('./config');
const chunk = require('./chunk');
const { getSigner } = require('./signer');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

/** Can this host download the chunk from anonyig.com? */
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
          ? 'refuses this host — mirror the chunk to B2 instead (npm run anonyig:chunk)'
          : null,
    };
  } catch (err) {
    return { reachable: false, status: null, error: err.message };
  }
}

/** Where the chunk stands: on disk, mirrored, and whether it currently signs. */
async function chunkStatus() {
  const local = { path: chunk.path, present: false, bytes: null, modified: null };
  try {
    const stat = fs.statSync(chunk.path);
    local.present = true;
    local.bytes = stat.size;
    local.modified = stat.mtime.toISOString();
  } catch {
    /* not stored on this instance */
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
    const signed = await sign({ username: 'probe' });
    signer.ready = /^[0-9a-f]{64}$/.test(signed?._s || '');
  } catch (err) {
    signer.error = err.message;
  }

  return { local, mirror, signer };
}

/**
 * @param {import('./client').AnonyIG} ig
 * @returns {Promise<object>} probes plus a one-line verdict naming the fix
 */
async function report(ig) {
  const [site, hub, chunkState] = await Promise.all([probeSite(), ig.probe(), chunkStatus()]);
  const proxy = ig.proxyInfo();

  let verdict;
  if (!hub.reachable && proxy.enabled) {
    // The proxy itself failed, so nothing was ever asked of the hub. The error
    // already spells out which cause it was.
    verdict = `the configured proxy did not carry the request — ${hub.error}`;
  } else if (hub.challenged) {
    verdict =
      'the hub is serving a captcha challenge to this host — its address is distrusted ' +
      '(any cloud/datacenter IP is). ' +
      (proxy.enabled
        ? `The proxy in use (${hub.proxy}) is distrusted too — it needs to be a residential ` +
          'or mobile address, not another datacenter one.'
        : 'Route the hub through a residential proxy: set ANONYIG_PROXY, or ' +
          'ANONYIG_USE_POOL_PROXY=true to draw one from the pool.');
  } else if (chunkState.signer.ready && hub.reachable) {
    verdict = 'ok — signing works and the hub is reachable';
  } else if (!hub.reachable) {
    verdict =
      'the worker hub is unreachable from this host, so no chunk can help — ' +
      'the requests themselves need to leave through a proxy';
  } else if (!chunkState.signer.ready && !site.reachable && !chunkState.mirror.present) {
    verdict =
      'the hub is reachable but there is no signing chunk: this host cannot download one, ' +
      'and none is mirrored — run `npm run anonyig:chunk` where anonyig.com IS reachable, ' +
      'with the same B2_* credentials, then retry';
  } else if (!chunkState.signer.ready) {
    verdict = `no usable signing chunk: ${chunkState.signer.error}`;
  } else {
    verdict = 'signing works';
  }

  return {
    verdict,
    site: { host: config.siteOrigin, ...site },
    hub: { host: config.workerHub, ...hub },
    proxy: ig.proxyInfo(),
    chunk: chunkState,
  };
}

module.exports = { report, probeSite, chunkStatus };
