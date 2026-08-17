'use strict';

const path = require('path');

const poolStore = require('../store/poolStore');
const adminAuth = require('../services/adminAuth');
const { getUserFeed } = require('../services/instagram.service');
const storyService = require('../services/instagramStory.service');
const { flag, detailsById } = require('../services/feedStoryMerge');
const { checkProxy } = require('../services/proxyCheck');
const { logFeed } = require('../store/feedLog');

/**
 * Admin dashboard endpoints: a passcode gate plus full CRUD over the encrypted
 * session and proxy pools. All data mutations reuse poolStore, so secrets stay
 * encrypted at rest exactly as they are for the public /api pool routes.
 */

/** Pull an array of items from a request body, supporting a few shapes. */
function itemsFrom(body, key) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.[key])) return body[key];
  if (body?.[key] != null) return [body[key]];
  const raw = body?.raw ?? body?.text;
  if (typeof raw === 'string') {
    return raw
      .split(/[\r\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

// --- Page + auth -----------------------------------------------------------

/** GET /admin — serve the single-page dashboard. */
function serveDashboard(req, res) {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
}

/** GET /instagram-view.html — serve the Instagram viewer wrapper (uses localStorage for auth). */
function serveInstagramView(req, res) {
  res.sendFile(path.join(__dirname, '..', 'public', 'instagram-view.html'));
}

/** GET /admin/status — is the dashboard configured? (no auth) */
function status(req, res) {
  res.json({
    success: true,
    configured: adminAuth.isConfigured(),
    idleMs: adminAuth.IDLE_MS,
  });
}

/** POST /admin/login — exchange a passcode for a token. */
function login(req, res) {
  if (!adminAuth.isConfigured()) {
    return res.status(503).json({
      success: false,
      error: 'Dashboard disabled: set ADMIN_PASSCODE in the environment.',
    });
  }
  const passcode = req.body?.passcode;
  if (!adminAuth.checkPasscode(passcode)) {
    return res.status(401).json({ success: false, error: 'Incorrect passcode.' });
  }
  const { token, idleMs } = adminAuth.issueToken();
  return res.json({ success: true, token, idleMs });
}

/** POST /admin/logout — revoke the current token (manual lock). */
function logout(req, res) {
  adminAuth.revokeToken(req.adminToken);
  return res.json({ success: true });
}

// --- Feed fetch ------------------------------------------------------------

/**
 * POST /admin/user-feed — fetch a user feed from the dashboard.
 * Uses the encrypted pool for auth/proxy unless an inline authToken/proxy is
 * given. Always 200 with an `ok` flag (false = upstream returned no posts) so
 * the dashboard can render the outcome instead of treating empty as an error.
 */
async function fetchUserFeed(req, res, next) {
  try {
    // Merge sources so one handler serves GET and POST.
    const src = { ...(req.params || {}), ...(req.query || {}), ...(req.body || {}) };
    const {
      userId,
      authToken,
      sessionid,
      token,
      csrfToken,
      proxy,
      maxId = null,
      includeStories,
      includeHighlightDetails,
      highlightDetailLimit,
    } = src;

    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId is required.' });
    }

    // Inline auth wins; otherwise the pool hydrates cookies + proxy.
    let account = null;
    const inlineAuth = authToken || sessionid || token;
    if (inlineAuth || proxy) {
      account = poolStore.buildAccount({ authToken: inlineAuth, csrfToken, proxy });
    }
    if (!account && poolStore.listSessions().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No auth available — add a session, or provide an authToken.',
      });
    }

    const result = await getUserFeed(account, userId, {
      maxId,
      includeStories,
      includeHighlightDetails,
      highlightDetailLimit,
    });
    const user = result?.data?.user || {};
    const edges = user?.edge_owner_to_timeline_media?.edges || [];

    logFeed({
      userId,
      request: { source: inlineAuth || proxy ? 'inline' : 'pool', via: 'admin' },
      result,
    });

    return res.json({
      success: true,
      ok: edges.length > 0,
      userId,
      username: user.username || null,
      count: edges.length,
      // Story/highlight tallies, so the dashboard can label the result without
      // walking the merged JSON.
      storyCount: result.stories?.count ?? 0,
      highlightCount: result.highlights?.count ?? 0,
      reason: result.error || null, // why it's empty (blocked / timeout / …)
      result,
    });
  } catch (err) {
    return next(err);
  }
}

// --- Stories & highlights --------------------------------------------------

/**
 * POST /admin/story-highlight  |  GET /admin/story-highlight[/:username]
 *
 * Stories + highlights for one handle, straight from the story sources (no
 * session or proxy involved). Like the feed fetch this is deliberately not
 * token-gated — it exposes no secrets. Always 200 with an `ok` flag so the
 * dashboard can render "nothing active" without treating it as an error.
 */
async function fetchStoryHighlight(req, res, next) {
  try {
    const src = { ...(req.params || {}), ...(req.query || {}), ...(req.body || {}) };
    const username = src.username || src.userId;

    if (!username || !String(username).trim()) {
      return res.status(400).json({ success: false, error: 'username is required.' });
    }

    const bundle = await storyService.collectStoryBundle(username, {
      includeHighlightDetails: flag(src.includeHighlightDetails, true),
      highlightDetailLimit: parseInt(src.highlightDetailLimit, 10) || 0,
    });

    return res.json({
      success: true,
      ok: bundle.stories.length > 0 || bundle.highlights.length > 0,
      username: bundle.profile?.username || String(username).trim(),
      source: bundle.source,
      highlightSource: bundle.highlightSource,
      storyCount: bundle.stories.length,
      highlightCount: bundle.highlights.length,
      truncated: bundle.truncated,
      // Why it is empty, when it is: the failed source(s) rather than a bare 0.
      reason: bundle.error || bundle.highlightsError || bundle.storiesError || null,
      result: {
        profile: bundle.profile,
        stories: {
          available: bundle.stories.length > 0,
          count: bundle.stories.length,
          source: bundle.source,
          error: bundle.error || bundle.storiesError || null,
          items: bundle.stories,
        },
        highlights: {
          available: bundle.highlights.length > 0,
          count: bundle.highlights.length,
          source: bundle.highlightSource,
          error: bundle.error || bundle.highlightsError || null,
          items: bundle.highlights,
        },
        highlight_details: {
          available: bundle.highlightDetails.some((d) => d.count > 0),
          count: bundle.highlightDetails.length,
          truncated: bundle.truncated,
          error: bundle.error || bundle.highlightsError || null,
          // One node per highlight, keyed by highlight id.
          items: detailsById(bundle.highlightDetails),
        },
      },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /admin/highlight-details/:highlightId?username=&userId=
 * The media inside one highlight bubble, for lazy expansion in the dashboard.
 */
async function fetchHighlightDetails(req, res, next) {
  try {
    const { username, userId } = req.query || {};
    const result = await storyService.getHighlightDetails(
      req.params.highlightId,
      username,
      userId
    );
    return res.json({
      success: true,
      ok: result.items.length > 0,
      source: result.source,
      title: result.title,
      count: result.items.length,
      reason: result.error || null,
      items: result.items,
    });
  } catch (err) {
    return next(err);
  }
}

// --- Sessions --------------------------------------------------------------

function listSessions(req, res, next) {
  try {
    const sessions = poolStore.listSessions();
    return res.json({ success: true, count: sessions.length, sessions });
  } catch (err) {
    return next(err);
  }
}

async function addSessions(req, res, next) {
  try {
    const items = itemsFrom(req.body, 'sessions');
    if (!items.length) {
      return res.status(400).json({ success: false, error: 'No sessions provided.' });
    }
    const result = await poolStore.addSessions(items);
    return res.status(201).json({ success: true, ...result });
  } catch (err) {
    return next(err);
  }
}

async function updateSession(req, res, next) {
  try {
    const updated = await poolStore.updateSession(req.params.id, req.body || {});
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Session not found.' });
    }
    return res.json({ success: true, session: updated });
  } catch (err) {
    return next(err);
  }
}

async function deleteSession(req, res, next) {
  try {
    const { id } = req.params;
    if (!id) {
      const removed = await poolStore.clearSessions();
      return res.json({ success: true, removed });
    }
    const removed = await poolStore.deleteSession(id);
    if (!removed) {
      return res.status(404).json({ success: false, error: 'Session not found.' });
    }
    return res.json({ success: true, removed: 1 });
  } catch (err) {
    return next(err);
  }
}

// --- Proxies ---------------------------------------------------------------

function listProxies(req, res, next) {
  try {
    const proxies = poolStore.listProxies();
    return res.json({ success: true, count: proxies.length, proxies });
  } catch (err) {
    return next(err);
  }
}

async function addProxies(req, res, next) {
  try {
    const items = itemsFrom(req.body, 'proxies');
    if (!items.length) {
      return res.status(400).json({ success: false, error: 'No proxies provided.' });
    }
    const result = await poolStore.addProxies(items);
    return res.status(201).json({ success: true, ...result });
  } catch (err) {
    return next(err);
  }
}

async function updateProxy(req, res, next) {
  try {
    const updated = await poolStore.updateProxy(req.params.id, req.body || {});
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Proxy not found.' });
    }
    return res.json({ success: true, proxy: updated });
  } catch (err) {
    return next(err);
  }
}

/** POST /admin/proxies/:id/check — test whether the proxy is working. */
async function checkProxyStatus(req, res, next) {
  try {
    let secret;
    try {
      secret = poolStore.getProxySecret(req.params.id);
    } catch (e) {
      if (e.code === 'DECRYPT_FAILED') {
        return res.status(500).json({ success: false, error: e.message });
      }
      throw e;
    }
    if (!secret) {
      return res.status(404).json({ success: false, error: 'Proxy not found.' });
    }
    const result = await checkProxy(secret);
    return res.json({ success: true, ...result });
  } catch (err) {
    return next(err);
  }
}

async function deleteProxy(req, res, next) {
  try {
    const { id } = req.params;
    if (!id) {
      const removed = await poolStore.clearProxies();
      return res.json({ success: true, removed });
    }
    const removed = await poolStore.deleteProxy(id);
    if (!removed) {
      return res.status(404).json({ success: false, error: 'Proxy not found.' });
    }
    return res.json({ success: true, removed: 1 });
  } catch (err) {
    return next(err);
  }
}

// --- Instagram View (Proxy) ------------------------------------------------

/**
 * GET /admin/instagram/check-session?sessionId=... — check if a session is valid.
 * Returns whether Instagram recognizes the session as logged in.
 */
async function checkInstagramSession(req, res, next) {
  try {
    const sessionId = req.query?.sessionId;
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId is required.' });
    }

    // Retrieve the session from the pool
    let secret;
    try {
      secret = poolStore.getSessionSecret(sessionId);
    } catch (e) {
      if (e.code === 'DECRYPT_FAILED') {
        return res.status(500).json({ success: false, error: e.message });
      }
      throw e;
    }
    if (!secret) {
      return res.status(404).json({ success: false, error: 'Session not found.' });
    }

    // Build cookies array from the session
    let cookieArray = secret.cookies || [];
    if (!Array.isArray(cookieArray) || cookieArray.length === 0) {
      cookieArray = [];
      if (secret.sessionid) {
        const decodedSessionid = secret.sessionid.includes('%') 
          ? decodeURIComponent(secret.sessionid) 
          : secret.sessionid;
        cookieArray.push({ name: 'sessionid', value: decodedSessionid });
      }
      if (secret.csrftoken) {
        cookieArray.push({ name: 'csrftoken', value: secret.csrftoken });
      }
      if (secret.dsUserId) {
        cookieArray.push({ name: 'ds_user_id', value: secret.dsUserId });
      }
      if (secret.mid) {
        cookieArray.push({ name: 'mid', value: secret.mid });
      }
    }

    const axios = require('axios');
    const { CookieJar } = require('tough-cookie');
    const { createCookieAgent } = require('http-cookie-agent/http');
    const https = require('https');
    const HttpsCookieAgent = createCookieAgent(https.Agent);
    
    const jar = new CookieJar();
    
    for (const cookie of cookieArray) {
      if (cookie && cookie.name && cookie.value !== undefined && cookie.value !== null) {
        try {
          jar.setCookieSync(
            `${cookie.name}=${cookie.value}; Domain=.instagram.com; Path=/`,
            'https://www.instagram.com'
          );
        } catch (e) {
          console.warn(`[Instagram check] Failed to set cookie ${cookie.name}:`, e.message);
        }
      }
    }
    
    const client = axios.create({
      httpsAgent: new HttpsCookieAgent({ cookies: { jar } }),
      timeout: 10000,
      maxRedirects: 3,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      }
    });

    try {
      // Try to fetch the Instagram homepage - if we're logged in, we should get the feed
      const response = await client.get('https://www.instagram.com/');
      
      // Log response details for debugging
      const hasLoginContainer = response.data.includes('loginContainer');
      const hasLoginForm = response.data.includes('<form') && response.data.includes('login');
      const hasXAppId = response.data.includes('X-IG-App-ID');
      const hasSharedData = response.data.includes('window._sharedData');
      const statusCode = response.status;
      
      console.log('[Instagram check] Status:', statusCode, 'hasLoginContainer:', hasLoginContainer, 'hasLoginForm:', hasLoginForm, 'hasXAppId:', hasXAppId, 'hasSharedData:', hasSharedData);
      
      // If we get status 200 and the page loads with shared data, session is likely valid
      // loginContainer appears only on actual login page, not in feed
      const isLoggedIn = statusCode === 200 && 
                         hasSharedData && 
                         !hasLoginContainer;
      
      console.log('[Instagram check] Session valid:', isLoggedIn);
      
      return res.json({
        success: true,
        sessionValid: isLoggedIn,
        status: statusCode,
        message: isLoggedIn ? 'Session is valid and logged in' : 'Session may be expired or not authenticated'
      });
    } catch (err) {
      console.error('[Instagram check error]', err.message);
      return res.json({
        success: true,
        sessionValid: false,
        error: err.message,
        message: 'Failed to verify session validity: ' + err.message
      });
    }
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /admin/instagram?sessionId=... — proxy to Instagram with a session applied.
 * Uses a proper cookie jar to maintain authentication through redirects.
 */
async function proxyInstagram(req, res, next) {
  try {
    const sessionId = req.query?.sessionId;
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId is required.' });
    }

    // Retrieve the session from the pool
    let secret;
    try {
      secret = poolStore.getSessionSecret(sessionId);
    } catch (e) {
      if (e.code === 'DECRYPT_FAILED') {
        return res.status(500).json({ success: false, error: e.message });
      }
      throw e;
    }
    if (!secret) {
      return res.status(404).json({ success: false, error: 'Session not found.' });
    }

    // Build cookies array from the session
    let cookieArray = secret.cookies || [];
    if (!Array.isArray(cookieArray) || cookieArray.length === 0) {
      // Build cookies from sessionid, csrftoken, dsUserId, mid
      cookieArray = [];
      if (secret.sessionid) {
        // Decode URL-encoded sessionid if needed
        const decodedSessionid = secret.sessionid.includes('%') 
          ? decodeURIComponent(secret.sessionid) 
          : secret.sessionid;
        cookieArray.push({ name: 'sessionid', value: decodedSessionid });
      }
      if (secret.csrftoken) {
        cookieArray.push({ name: 'csrftoken', value: secret.csrftoken });
      }
      if (secret.dsUserId) {
        cookieArray.push({ name: 'ds_user_id', value: secret.dsUserId });
      }
      if (secret.mid) {
        cookieArray.push({ name: 'mid', value: secret.mid });
      }
    }

    // Use axios with a proper cookie jar to handle redirects
    const axios = require('axios');
    const { CookieJar } = require('tough-cookie');
    const { createCookieAgent } = require('http-cookie-agent/http');
    const https = require('https');
    const HttpsCookieAgent = createCookieAgent(https.Agent);
    
    const jar = new CookieJar();
    
    // Pre-populate the cookie jar with our session cookies
    for (const cookie of cookieArray) {
      if (cookie && cookie.name && cookie.value !== undefined && cookie.value !== null) {
        try {
          jar.setCookieSync(
            `${cookie.name}=${cookie.value}; Domain=.instagram.com; Path=/`,
            'https://www.instagram.com'
          );
        } catch (e) {
          console.warn(`[Instagram proxy] Failed to set cookie ${cookie.name}:`, e.message);
        }
      }
    }
    
    const client = axios.create({
      httpsAgent: new HttpsCookieAgent({ cookies: { jar } }),
      timeout: 20000,
      maxRedirects: 10,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'max-age=0',
        'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      }
    });

    try {
      const response = await client.get('https://www.instagram.com/');
      
      console.log('[Instagram proxy] Success - status', response.status);
      console.log('[Instagram proxy] Cookies used:', cookieArray.map(c => c.name).join(', '));
      
      // Forward response to client
      res.set('Content-Type', response.headers['content-type'] || 'text/html; charset=utf-8');
      res.send(response.data);
    } catch (err) {
      console.error('[Instagram proxy error]', {
        message: err.message,
        code: err.code,
        status: err.response?.status,
        isRedirectError: err.message.includes('redirect'),
        cookies: cookieArray.map(c => `${c.name}=${c.value.substring(0, 20)}...`),
      });
      return res.status(500).json({
        success: false,
        error: 'Failed to load Instagram: ' + (err.message || 'unknown error'),
      });
    }
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  serveDashboard,
  serveInstagramView,
  status,
  login,
  logout,
  fetchUserFeed,
  fetchStoryHighlight,
  fetchHighlightDetails,
  listSessions,
  addSessions,
  updateSession,
  deleteSession,
  listProxies,
  addProxies,
  updateProxy,
  checkProxyStatus,
  deleteProxy,
  checkInstagramSession,
  proxyInstagram,
};
