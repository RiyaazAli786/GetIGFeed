'use strict';

/**
 * Story / highlight configuration — endpoints and constants lifted from the
 * GetInstaStoryHighlight service (StoryFetcher.cs and
 * InstagramStoryViewModel.FetchMedia).
 *
 * These sources are third-party story viewers, not Instagram's private API, so
 * they need neither a pooled session nor a proxy: they are hit with a plain
 * fetch. That is why this config is separate from ./constants.js, which holds
 * the Instagram private-API values used by the feed.
 */

const int = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const config = {
  // Per-request timeout for the story sources. Deliberately separate from
  // HTTP_TIMEOUT_MS (which bounds proxied Instagram calls) — these hosts are
  // slower but reachable directly.
  requestTimeoutMs: int(process.env.STORY_REQUEST_TIMEOUT_MS, 30000),

  // HEAD-probe the profile picture and swap in the secondary source when the
  // CDN link has expired (the UpdateUI step in the original view model).
  validateProfilePic: process.env.VALIDATE_PROFILE_PIC !== 'false',

  // Both sources fail in recoverable ways: storynavigation invalidates its
  // session ("CSRF token mismatch.") and anonstories throttles ("Too many
  // requests"). Each is retried once — a fresh handshake for the former, a short
  // wait for the latter — before the source is written off.
  retry: {
    enabled: process.env.STORY_RETRY !== 'false',
    // anonstories' throttle window outlasts a short pause, so give it real time.
    delayMs: int(process.env.STORY_RETRY_DELAY_MS, 3000),
  },

  browser: {
    enabled: process.env.ENABLE_BROWSER_FALLBACK === 'true',
    headless: process.env.BROWSER_HEADLESS !== 'false',
    entryUrl: 'https://anonyig.com/en/',
  },

  // How the feed endpoint enriches its response with stories / highlights.
  feed: {
    // Fetch stories + highlights alongside feed requests (disabled by default unless URL param or env is true).
    includeStories: process.env.FEED_INCLUDE_STORIES === 'true',
    // Also expand each highlight bubble into its media items.
    includeHighlightDetails: process.env.FEED_INCLUDE_HIGHLIGHT_DETAILS !== 'false',
    // 0 = expand EVERY highlight (the default). Each one costs an upstream call,
    // so set a positive cap when bounded latency matters more than completeness;
    // anything left out is reported as highlight_details.truncated.
    highlightDetailLimit: int(process.env.FEED_HIGHLIGHT_DETAIL_LIMIT, 0),
    highlightDetailConcurrency: int(process.env.FEED_HIGHLIGHT_DETAIL_CONCURRENCY, 5),
  },

  storyNavigation: {
    baseUrl: 'https://storynavigation.com/',
    origin: 'https://storynavigation.com',
    userProfile: 'https://storynavigation.com/get-user-profile',
    lastStories: 'https://storynavigation.com/get-user-last-stories',
    userHighlights: 'https://storynavigation.com/get-user-highlights',
    highlightStories: 'https://storynavigation.com/get-highlight-stories',
    // cookie name -> cookie domain
    cookies: {
      'XSRF-TOKEN': '.storynavigation.com',
      laravel_session: '.storynavigation.com',
    },
  },

  theAsmn: {
    baseUrl: 'https://i.theasmn.com/',
    origin: 'https://i.theasmn.com',
    referer: 'https://i.theasmn.com/processing',
    userApi: 'https://i.theasmn.com/api/user',
    cookies: {
      'XSRF-TOKEN': 'i.theasmn.com',
      hacking_panel_session: 'i.theasmn.com',
    },
  },

  anonStories: {
    origin: 'https://anonstories.com',
    referer: 'https://anonstories.com/',
    story: 'https://anonstories.com/api/v1/story',
    highlights: 'https://anonstories.com/api/v1/highlights',
    // auth = base64("<userId>::<username>::<highlightId>::<suffix>")
    highlightStories: 'https://anonstories.com/api/v1/highlight/stories',
    // Static token tail taken from StoryFetcher.HitStoryOrHighlights
    authSuffix: 'LTE6Om11cmllbGdhbGxlOjpySlAydEJSS2Y2a3RiUnFQVUJ0UkU5a2xnQldiN2Q-',
    // anonstories proxies media through embed.anonstories.com/<base64 url>
    embedHost: 'embed.anonstories.com',

    // It rate-limits hard: roughly five requests in quick succession earn a 429,
    // and pushing past that earns an HTML block page. Calls are therefore
    // serialized with this much space between them, and successful bodies are
    // cached briefly so repeat lookups and the per-highlight fan-out do not
    // spend the budget on data we already have.
    minIntervalMs: int(process.env.STORY_ANON_MIN_INTERVAL_MS, 900),
    cacheTtlMs: int(process.env.STORY_ANON_CACHE_TTL_MS, 60000),
  },

  download: {
    // SSRF guard: the media proxy only forwards to these hosts.
    allowedHosts: [
      /(^|\.)cdninstagram\.com$/i,
      /(^|\.)fbcdn\.net$/i,
      /(^|\.)instagram\.com$/i,
      /(^|\.)anonstories\.com$/i,
      /(^|\.)storynavigation\.com$/i,
      /(^|\.)theasmn\.com$/i,
      /(^|\.)anonyig\.com$/i,
    ],
    maxZipItems: int(process.env.STORY_MAX_ZIP_ITEMS, 300),
  },

  userAgents: {
    chromeMac:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 12.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.6811.57 Safari/537.36',
    chromeWin:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6829.70 Safari/537.36',
    chromeLinux:
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6784.83 Safari/537.36',
  },
};

module.exports = config;
