const INSTAGRAM_URL = 'https://www.instagram.com/';

function sameSiteValue(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'no_restriction' || v === 'lax' || v === 'strict' || v === 'unspecified') {
    return v;
  }
  if (v === 'none') return 'no_restriction';
  return 'unspecified';
}

function cookieDetails(cookie, storeId) {
  const details = {
    url: INSTAGRAM_URL,
    name: String(cookie.name || ''),
    value: String(cookie.value || ''),
    path: cookie.path || '/',
    secure: cookie.secure !== false,
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: sameSiteValue(cookie.sameSite),
  };
  if (storeId) details.storeId = storeId;

  const expirationDate = Number(cookie.expirationDate || cookie.expires);
  if (Number.isFinite(expirationDate) && expirationDate > Date.now() / 1000) {
    details.expirationDate = expirationDate;
  }

  return details;
}

function cookieStoreIdForTab(tabId) {
  if (!tabId) return Promise.resolve(undefined);
  return chrome.cookies.getAllCookieStores()
    .then(function (stores) {
      const store = stores.find(function (candidate) {
        return Array.isArray(candidate.tabIds) && candidate.tabIds.indexOf(tabId) !== -1;
      });
      return store && store.id;
    });
}

function removeCookie(cookie, storeId) {
  const protocol = cookie.secure ? 'https://' : 'http://';
  const domain = String(cookie.domain || '').replace(/^\./, '');
  const details = {
    url: protocol + domain + (cookie.path || '/'),
    name: cookie.name,
    storeId: storeId || cookie.storeId,
  };
  if (!details.storeId) delete details.storeId;
  return chrome.cookies.remove(details);
}

function clearInstagramCookies(storeId) {
  const query = { domain: 'instagram.com' };
  if (storeId) query.storeId = storeId;
  return chrome.cookies.getAll(query)
    .then(function (cookies) {
      return Promise.all(cookies.map(function (cookie) {
        return removeCookie(cookie, storeId);
      })).then(function () {
        return cookies.length;
      });
    });
}

function setInstagramCookies(cookies, storeId) {
  return Promise.all(cookies.map(function (cookie) {
    if (!cookie || !cookie.name || cookie.value === undefined || cookie.value === null) {
      return Promise.resolve(null);
    }
    return chrome.cookies.set(cookieDetails(cookie, storeId));
  }));
}

function verifySessionCookie(expectedValue, storeId) {
  const details = {
    url: INSTAGRAM_URL,
    name: 'sessionid',
  };
  if (storeId) details.storeId = storeId;
  return chrome.cookies.get(details).then(function (cookie) {
    if (!cookie) {
      throw new Error('Chrome did not store the Instagram sessionid cookie.');
    }
    if (expectedValue && cookie.value !== expectedValue) {
      throw new Error('Chrome stored a different Instagram sessionid cookie than the selected session.');
    }
    return cookie;
  });
}

function listInstagramCookies(storeId) {
  const query = { domain: 'instagram.com' };
  if (storeId) query.storeId = storeId;
  return chrome.cookies.getAll(query).then(function (cookies) {
    return cookies.map(function (cookie) {
      return {
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        session: cookie.session,
        storeId: cookie.storeId,
      };
    }).sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
  });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== 'GETIGFEED_OPEN_INSTAGRAM') return false;

  const cookies = Array.isArray(message.cookies) ? message.cookies : [];
  const targetUrl = message.url || INSTAGRAM_URL;
  const tabId = sender.tab && sender.tab.id;
  const sessionCookie = cookies.find(function (cookie) {
    return cookie && cookie.name === 'sessionid';
  });
  let activeStoreId;
  let removedCount = 0;
  let writtenCount = 0;
  let visibleCookies = [];

  cookieStoreIdForTab(tabId)
    .then(function (storeId) {
      activeStoreId = storeId;
      return clearInstagramCookies(activeStoreId);
    })
    .then(function (count) {
      removedCount = count;
      return setInstagramCookies(cookies, activeStoreId);
    })
    .then(function (written) {
      writtenCount = written.filter(Boolean).length;
      return verifySessionCookie(sessionCookie && String(sessionCookie.value), activeStoreId);
    })
    .then(function () {
      return listInstagramCookies(activeStoreId);
    })
    .then(function (cookiesAfterWrite) {
      visibleCookies = cookiesAfterWrite;
      if (message.debug === true) return null;
      if (tabId) {
        return chrome.tabs.update(tabId, { url: targetUrl });
      }
      return chrome.tabs.create({ url: targetUrl });
    })
    .then(function () {
      sendResponse({
        success: true,
        storeId: activeStoreId || 'default',
        removed: removedCount,
        written: writtenCount,
        cookies: visibleCookies,
      });
    })
    .catch(function (err) {
      sendResponse({ success: false, error: err && err.message ? err.message : String(err) });
    });

  return true;
});
