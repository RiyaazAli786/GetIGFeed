const INSTAGRAM_URL = 'https://www.instagram.com/';

function sameSiteValue(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'no_restriction' || v === 'lax' || v === 'strict' || v === 'unspecified') {
    return v;
  }
  if (v === 'none') return 'no_restriction';
  return 'unspecified';
}

function cookieDetails(cookie) {
  const details = {
    url: INSTAGRAM_URL,
    name: String(cookie.name || ''),
    value: String(cookie.value || ''),
    domain: cookie.domain || '.instagram.com',
    path: cookie.path || '/',
    secure: cookie.secure !== false,
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: sameSiteValue(cookie.sameSite),
  };

  const expirationDate = Number(cookie.expirationDate || cookie.expires);
  if (Number.isFinite(expirationDate) && expirationDate > Date.now() / 1000) {
    details.expirationDate = expirationDate;
  }

  return details;
}

function removeCookie(cookie) {
  const protocol = cookie.secure ? 'https://' : 'http://';
  const domain = String(cookie.domain || '').replace(/^\./, '');
  return chrome.cookies.remove({
    url: protocol + domain + (cookie.path || '/'),
    name: cookie.name,
    storeId: cookie.storeId,
  });
}

function clearInstagramCookies() {
  return chrome.cookies.getAll({ domain: 'instagram.com' })
    .then(function (cookies) {
      return Promise.all(cookies.map(removeCookie));
    });
}

function setInstagramCookies(cookies) {
  return Promise.all(cookies.map(function (cookie) {
    if (!cookie || !cookie.name || cookie.value === undefined || cookie.value === null) {
      return Promise.resolve(null);
    }
    return chrome.cookies.set(cookieDetails(cookie));
  }));
}

function verifySessionCookie(expectedValue) {
  return chrome.cookies.get({
    url: INSTAGRAM_URL,
    name: 'sessionid',
  }).then(function (cookie) {
    if (!cookie) {
      throw new Error('Chrome did not store the Instagram sessionid cookie.');
    }
    if (expectedValue && cookie.value !== expectedValue) {
      throw new Error('Chrome stored a different Instagram sessionid cookie than the selected session.');
    }
    return cookie;
  });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== 'GETIGFEED_OPEN_INSTAGRAM') return false;

  const cookies = Array.isArray(message.cookies) ? message.cookies : [];
  const targetUrl = message.url || INSTAGRAM_URL;
  const sessionCookie = cookies.find(function (cookie) {
    return cookie && cookie.name === 'sessionid';
  });

  clearInstagramCookies()
    .then(function () {
      return setInstagramCookies(cookies);
    })
    .then(function () {
      return verifySessionCookie(sessionCookie && String(sessionCookie.value));
    })
    .then(function () {
      if (sender.tab && sender.tab.id) {
        return chrome.tabs.update(sender.tab.id, { url: targetUrl });
      }
      return chrome.tabs.create({ url: targetUrl });
    })
    .then(function () {
      sendResponse({ success: true });
    })
    .catch(function (err) {
      sendResponse({ success: false, error: err && err.message ? err.message : String(err) });
    });

  return true;
});
