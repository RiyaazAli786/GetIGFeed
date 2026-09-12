'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const poolStore = require('../src/store/poolStore');
const { getWebParameter } = require('../src/services/webParameter');
const {
  fetchPolarisHoverCardProfile,
  parseInstagramGraphqlPayload,
  extractPolarisHoverCardUser,
  fetchFbDtsgToken,
  createJazoest,
} = require('../src/services/instagram.service');
const { pickCount } = require('../src/utils/mapFeedToWebProfile');
const { X_ASBD_ID, X_IG_APP_ID } = require('../src/config/constants');

const HOVER_DOC_ID = '27756568060663620';
const FRIENDLY_NAME = 'PolarisUserHoverCardContentV2Query';

function usage() {
  return [
    'Usage:',
    '  npm.cmd run test:hover-card -- <username-or-user-id> [testsession.json]',
    '  npm.cmd run test:hover-card -- <username-or-user-id> --pool',
    '',
    'Examples:',
    '  npm.cmd run test:hover-card -- nasa',
    '  npm.cmd run test:hover-card -- 528817151 testsession.json',
    '  npm.cmd run test:hover-card -- realfox63 --pool',
    '',
    'Environment:',
    '  INSTAGRAM_LSD_TOKEN=...   Optional; falls back to the same default used by the service.',
  ].join('\n');
}

function readSessionFile(filePath) {
  const absolute = path.resolve(process.cwd(), filePath || 'testsession.json');
  const parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  const cookies = normalizeCookies(parsed);
  if (!cookies.length) throw new Error(`${absolute} did not contain usable cookies.`);
  return { absolute, cookies };
}

function normalizeCookies(input) {
  if (Array.isArray(input)) {
    return input
      .filter((cookie) => cookie && cookie.name && cookie.value !== undefined)
      .map((cookie) => ({
        name: String(cookie.name),
        value: String(cookie.value),
        domain: String(cookie.domain || 'instagram.com'),
      }));
  }

  if (input && typeof input === 'object') {
    if (Array.isArray(input.cookies)) return normalizeCookies(input.cookies);
    if (input.sessionid || input.sessionId || input.authToken || input.token) {
      return poolStore.buildAccount({
        authToken: input.sessionid || input.sessionId || input.authToken || input.token,
        csrfToken: input.csrftoken || input.csrfToken,
      }).cookies || [];
    }
  }

  if (typeof input === 'string') {
    return poolStore.buildAccount({ authToken: input }).cookies || [];
  }

  return [];
}

function cookieValue(cookies, name) {
  return cookies.find((cookie) => cookie.name === name)?.value || '';
}

function mask(value, keep = 6) {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= keep) return '*'.repeat(s.length);
  return `${s.slice(0, 3)}...${s.slice(-keep)}`;
}

async function resolveTargetUserId(target, param, headers) {
  const clean = String(target || '').trim().replace(/^@/, '');
  if (/^\d+$/.test(clean)) return { userId: clean, username: clean, source: 'argument' };

  const attempts = [];
  const fromUser = (user, source) => {
    const id = user?.id || user?.pk_id || user?.pk;
    if (!id || !/^\d+$/.test(String(id))) return null;
    return { userId: String(id), username: user?.username || clean, source };
  };

  try {
    const url =
      'https://www.instagram.com/api/v1/users/web_profile_info/?' +
      `username=${encodeURIComponent(clean)}`;
    const response = await param.client.get(url, { headers, timeout: 10000 });
    const resolved = fromUser(response.data?.data?.user, 'web_profile_info');
    if (resolved) return resolved;
    attempts.push(`web_profile_info HTTP ${response.status}: no user id`);
  } catch (err) {
    attempts.push(`web_profile_info failed: ${err.message}`);
  }

  try {
    const url =
      `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(clean)}` +
      '/username/?count=12';
    const response = await param.client.get(url, { headers, timeout: 10000 });
    const user = response.data?.user || response.data?.items?.[0]?.user;
    const resolved = fromUser(user, 'feed_user_username');
    if (resolved) return resolved;
    attempts.push(`feed_user_username HTTP ${response.status}: no user id`);
  } catch (err) {
    attempts.push(`feed_user_username failed: ${err.message}`);
  }

  throw new Error(
    `Could not resolve "${clean}" to a numeric Instagram user id.\n` +
      attempts.map((line) => `- ${line}`).join('\n')
  );
}

function hoverHeaders({ csrfToken, lsdToken, claim, referer, cookieHeader }) {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    'Content-Type': 'application/x-www-form-urlencoded',
    'sec-ch-ua-full-version-list':
      '"Not=A?Brand";v="99.0.0.0", "Google Chrome";v="151.0.7922.108", "Chromium";v="151.0.7922.108"',
    'sec-ch-ua-platform': '"Windows"',
    'viewport-width': '1517',
    'sec-ch-ua': '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
    'sec-ch-ua-model': '""',
    'sec-ch-ua-mobile': '?0',
    'X-IG-App-ID': X_IG_APP_ID,
    'X-FB-LSD': lsdToken,
    'X-IG-Max-Touch-Points': '0',
    'X-FB-Friendly-Name': FRIENDLY_NAME,
    dpr: '0.9',
    'sec-ch-prefers-color-scheme': 'dark',
    DNT: '1',
    'sec-ch-ua-platform-version': '"15.0.0"',
    Accept: '*/*',
    Origin: 'https://www.instagram.com',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    Referer: referer,
    'Accept-Language': 'en-US,en;q=0.9',
    ...(csrfToken ? { 'X-CSRFToken': csrfToken, 'x-csrftoken': csrfToken } : {}),
    ...(claim ? { 'X-IG-WWW-Claim': claim, 'x-ig-www-claim': claim } : {}),
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };
}

async function rawHoverCardRequest(param, target) {
  const lsdToken = process.env.INSTAGRAM_LSD_TOKEN || 'toxLtqxo-5GooSYWUv2PJ1';
  const cookieHeader = param.jar.getCookieStringSync('https://www.instagram.com/');
  const referer = /^\d+$/.test(target.username)
    ? 'https://www.instagram.com/'
    : `https://www.instagram.com/${encodeURIComponent(target.username)}/`;
  const headers = hoverHeaders({
    csrfToken: param.csrfToken,
    lsdToken,
    claim: param.xIgClaim,
    referer,
    cookieHeader,
  });
  const body = new URLSearchParams({
    jazoest: createJazoest(target.userId),
    __crn: 'comet.igweb.PolarisProfilePostsTabRoute',
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: FRIENDLY_NAME,
    server_timestamps: 'true',
    variables: JSON.stringify({ userID: target.userId }),
    doc_id: HOVER_DOC_ID,
  });
  const fbDtsg = await fetchFbDtsgToken(param.client, cookieHeader, target.username);
  if (fbDtsg) body.set('fb_dtsg', fbDtsg);

  const response = await param.client.post(
    'https://www.instagram.com/api/graphql',
    body.toString(),
    {
      headers,
      responseType: 'text',
      transformResponse: [(data) => data],
      timeout: 10000,
    }
  );
  const payload = parseInstagramGraphqlPayload(response.data);
  const user = extractPolarisHoverCardUser(payload);
  const text = String(response.data || '');
  return {
    response,
    payload,
    user,
    fbDtsgPresent: Boolean(fbDtsg),
    contentType: response.headers?.['content-type'] || null,
    bodyPreview: user ? null : text.slice(0, 240).replace(/\s+/g, ' ').trim(),
  };
}

function summarizeUser(user) {
  return {
    id: String(user?.pk || user?.id || user?.pk_id || ''),
    username: user?.username || null,
    fullName: user?.full_name || null,
    followerCount: pickCount(user, 'follower_count', 'edge_followed_by', 'followers_count', 'followers') ?? 0,
    followingCount: pickCount(user, 'following_count', 'edge_follow', 'follows_count', 'following') ?? 0,
    mediaCount: pickCount(user, 'media_count', 'edge_owner_to_timeline_media', 'posts_count') ?? 0,
    profilePicUrl: user?.profile_pic_url || user?.profile_pic_url_hd || user?.hd_profile_pic_url_info?.url || null,
    isPrivate: Boolean(user?.is_private),
    isVerified: Boolean(user?.is_verified),
  };
}

async function main() {
  const targetArg = process.argv[2];
  const sessionSource = process.argv[3] || 'testsession.json';
  const usePool = sessionSource === '--pool';
  if (!targetArg || targetArg === '-h' || targetArg === '--help') {
    console.log(usage());
    process.exit(targetArg ? 0 : 1);
  }

  let account;
  let cookies;
  let sourceLabel;
  if (usePool) {
    await poolStore.init();
    account = poolStore.resolveAccount();
    cookies = account?.cookies || [];
    sourceLabel = 'encrypted pool';
    if (!cookies.length) throw new Error('Pool did not provide a session. Add one with /admin or POST /api/sessions.');
  } else {
    const loaded = readSessionFile(sessionSource);
    cookies = loaded.cookies;
    account = { cookies };
    sourceLabel = loaded.absolute;
  }

  const param = getWebParameter(account);
  const baseHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'x-asbd-id': X_ASBD_ID,
    'x-ig-app-id': X_IG_APP_ID,
    ...(param.csrfToken ? { 'x-csrftoken': param.csrfToken } : {}),
    ...(param.xIgClaim ? { 'x-ig-www-claim': param.xIgClaim } : {}),
    ...(param.authorization ? { Authorization: param.authorization } : {}),
    Cookie: param.jar.getCookieStringSync('https://www.instagram.com/'),
  };

  console.log(`Session source: ${sourceLabel}`);
  console.log(`Session user: ds_user_id=${cookieValue(cookies, 'ds_user_id') || '(missing)'}`);
  console.log(`CSRF: ${mask(param.csrfToken) || '(missing)'}`);

  const target = await resolveTargetUserId(targetArg, param, baseHeaders);
  console.log(`Target: ${target.username} (${target.userId}) via ${target.source}`);

  const raw = await rawHoverCardRequest(param, target);
  console.log(
    `Raw ${FRIENDLY_NAME}: HTTP ${raw.response.status}; ` +
      `content-type=${raw.contentType || '(missing)'}; fb_dtsg=${raw.fbDtsgPresent ? 'yes' : 'no'}`
  );
  console.log(`Raw extraction path: ${raw.user ? 'data.xig_user_by_igid_v2.user_dict' : 'not found'}`);
  if (!raw.user && raw.bodyPreview) console.log(`Raw body preview: ${raw.bodyPreview}`);
  console.log(JSON.stringify({ rawExtracted: summarizeUser(raw.user) }, null, 2));

  const serviceUser = await fetchPolarisHoverCardProfile(param.client, target.username, target.userId, baseHeaders);
  console.log(JSON.stringify({ serviceExtracted: summarizeUser(serviceUser) }, null, 2));

  const rawCounts = summarizeUser(raw.user);
  const serviceCounts = summarizeUser(serviceUser);
  const countsMatch =
    rawCounts.followerCount === serviceCounts.followerCount &&
    rawCounts.followingCount === serviceCounts.followingCount;

  if (!raw.user || !serviceUser || !countsMatch) {
    process.exitCode = 2;
    console.error('Cross confirmation failed: raw and service extraction did not match.');
  } else {
    console.log('Cross confirmation passed.');
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
