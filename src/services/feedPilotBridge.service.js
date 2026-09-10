'use strict';

const DEFAULT_TIMEOUT_MS = Number(process.env.FEEDPILOT_BRIDGE_TIMEOUT_MS || 35000);

function bridgeEnabled() {
  return String(process.env.FEEDPILOT_BRIDGE_ENABLED || 'false').toLowerCase() === 'true';
}

function fallbackEnabled() {
  return String(process.env.FEEDPILOT_BRIDGE_FALLBACK || 'true').toLowerCase() !== 'false';
}

function getBridgeConfig() {
  const baseUrl = String(process.env.FEEDPILOT_BRIDGE_URL || '').replace(/\/+$/, '');
  const key = process.env.FEEDPILOT_BRIDGE_KEY;
  return { baseUrl, key };
}

function isRetryableBridgeError(code, status) {
  return (
    status === 503 ||
    status === 504 ||
    [
      'NO_ACTIVE_DEVICE',
      'NO_ACTIVE_SESSION',
      'JOB_TIMEOUT',
      'DEVICE_OFFLINE',
      'TEMPORARY_NETWORK_ERROR',
      'NETWORK_TIMEOUT',
    ].includes(code)
  );
}

async function fetchViaFeedPilotBridge(input) {
  if (!bridgeEnabled()) return { used: false };

  const { baseUrl, key } = getBridgeConfig();
  if (!baseUrl || !key) {
    return {
      used: true,
      ok: false,
      retryable: true,
      code: 'BRIDGE_NOT_CONFIGURED',
      message: 'FeedPilot bridge is enabled but URL/key is missing.',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/api/bridge/feed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Key': key,
        'X-Bridge-Client': 'GetIGFeed',
      },
      body: JSON.stringify({
        requestId: input.requestId,
        username: input.username,
        userId: input.userId,
        limit: input.limit,
        maxId: input.maxId,
        includeStories: input.includeStories,
        client: 'GetIGFeed',
      }),
      signal: controller.signal,
    });

    const payload = await res.json().catch(() => null);
    if (res.ok && payload && payload.success) {
      return { used: true, ok: true, data: payload.data, bridge: payload };
    }

    const code = payload?.code || payload?.Code || `HTTP_${res.status}`;
    return {
      used: true,
      ok: false,
      retryable: isRetryableBridgeError(code, res.status),
      status: res.status,
      code,
      message: payload?.message || payload?.Message || 'FeedPilot bridge request failed.',
      bridge: payload,
    };
  } catch (err) {
    return {
      used: true,
      ok: false,
      retryable: true,
      code: err.name === 'AbortError' ? 'BRIDGE_TIMEOUT' : 'BRIDGE_REQUEST_FAILED',
      message: err.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  bridgeEnabled,
  fallbackEnabled,
  fetchViaFeedPilotBridge,
};
