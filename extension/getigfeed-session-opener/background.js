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
    url: 'https://www.instagram.com/',
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

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== 'GETIGFEED_OPEN_INSTAGRAM') return false;

  const cookies = Array.isArray(message.cookies) ? message.cookies : [];
  const targetUrl = message.url || 'https://www.instagram.com/';

  Promise.all(cookies.map(function (cookie) {
    if (!cookie || !cookie.name || cookie.value === undefined || cookie.value === null) {
      return Promise.resolve();
    }
    return chrome.cookies.set(cookieDetails(cookie));
  }))
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
