# GetIGFeed Session Opener

Chrome extension used by the admin dashboard's `View` button.

## Load it

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this folder: `extension/getigfeed-session-opener`.

After code changes, click Reload on the extension card before testing again.
For Incognito testing, open the extension details and enable Allow in Incognito.

## What it does

When `https://feed.reelsflow.io/instagram-view.html?sessionId=...` opens, the
page fetches the selected session cookies from the authenticated admin API. This
extension receives those cookies, writes them to `instagram.com`, and navigates
the tab to `https://www.instagram.com/`.
