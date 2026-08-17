'use strict';

const config = require('../config/story');
const { formatDate, relativeAgeToDate } = require('../utils/strings');

/**
 * Port of StoryFetcher.GetStoryByBrowser - last-resort scrape of anonyig.com
 * when every HTTP source returns nothing for a public account.
 *
 * Optional: requires `npm i puppeteer` and ENABLE_BROWSER_FALLBACK=true.
 * If puppeteer is not installed the model is returned untouched.
 */
async function getStoryByBrowser(username, model) {
  if (!config.browser.enabled || !username) return model;

  let puppeteer;
  try {
    // eslint-disable-next-line global-require
    puppeteer = require('puppeteer');
  } catch {
    return model;
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: config.browser.headless ? 'new' : false,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(config.userAgents.chromeWin);
    await page.goto(config.browser.entryUrl, { waitUntil: 'networkidle2' });

    await page.waitForSelector('input[type="text"]', { timeout: 20000 });
    await page.click('input[type="text"]');
    await page.type('input[type="text"]', username, { delay: 60 });
    await page.click('button.search-form__button');

    await page.waitForSelector('.tabs-component__item', { timeout: 30000 });

    // --- stories tab ---
    await clickTab(page, 'stories');
    const stories = await page.$$eval('li[class*="profile-media-list__item"]', (nodes) =>
      nodes.map((node) => ({
        mediaUrl: node.querySelector('img.media-content__image')?.getAttribute('src') || '',
        videoUrl:
          node
            .querySelector('a.button.button--filled.button__download')
            ?.getAttribute('href') || '',
        date: node.querySelector('p.media-content__meta-time')?.getAttribute('title') || '',
      }))
    );

    const now = new Date();
    const scrapedStories = stories
      .filter((s) => s.mediaUrl)
      .map((s) => {
        // The title reads like "... , 3:12:44" - an age, not a timestamp.
        const agePart = String(s.date).split(',').filter(Boolean).pop()?.trim();
        const date = relativeAgeToDate(agePart, now);
        return {
          username: model.username || username,
          storyUrl: s.mediaUrl,
          videoUrl: s.videoUrl || null,
          type: s.videoUrl && s.videoUrl.endsWith('.mp4') ? 'video' : 'image',
          isVideo: Boolean(s.videoUrl && s.videoUrl.endsWith('.mp4')),
          createdAt: formatDate(date || now),
          storyDate: formatDate(date || now),
        };
      });
    // Only replace what the HTTP sources produced when the scrape found more —
    // an empty scrape must not wipe highlights/stories the fallback already got.
    if (scrapedStories.length) model.stories = scrapedStories;

    // --- highlights tab ---
    await clickTab(page, 'highlights');
    const highlights = await page.$$eval('button[class*="highlight__button"]', (nodes) =>
      nodes.map((node) => ({
        coverUrl: node.querySelector('img.highlight__image')?.getAttribute('src') || '',
        title: node.querySelector('p.highlight__title')?.textContent?.trim() || '',
      }))
    );

    const scrapedHighlights = highlights
      .filter((h) => h.coverUrl)
      .map((h) => ({
        id: null,
        title: h.title || null,
        coverUrl: h.coverUrl,
        username: model.username || username,
      }));
    // A scrape yields no highlight ids, so it cannot be expanded into media —
    // keep the id-carrying bubbles from the HTTP sources whenever we have them.
    if (scrapedHighlights.length && !model.highlights.length) {
      model.highlights = scrapedHighlights;
    }
  } catch {
    // ignored - the fallback is best effort
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignored */
      }
    }
  }
  return model;
}

async function clickTab(page, label) {
  await page.evaluate((text) => {
    const button = [...document.querySelectorAll('button[type="button"]')].find(
      (b) => b.textContent.trim() === text
    );
    if (button) button.click();
  }, label);
  await new Promise((resolve) => setTimeout(resolve, 6000));
}

module.exports = { getStoryByBrowser };
