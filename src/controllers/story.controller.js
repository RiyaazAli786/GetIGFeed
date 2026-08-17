'use strict';

const service = require('../services/instagramStory.service');
const downloads = require('../services/download.service');
const { flag, detailsById } = require('../services/feedStoryMerge');

/**
 * Stories & highlights endpoints (merged in from the GetInstaStoryHighlight
 * service). These talk to third-party story viewers rather than Instagram's
 * private API, so they need neither a pooled session nor a proxy.
 */

/**
 * POST /api/instagram/search   body: { username, includeHighlightDetails? }
 * GET  /api/instagram/search?username=
 * GET  /api/instagram/search/:username
 * GET  /api/instagram/stories/:username   (alias)
 *
 * Every highlight bubble is expanded into its media by default (the same as the
 * feed endpoint), returned as the `highlight_details` node keyed by highlight id.
 * Send `includeHighlightDetails=false` for just the bubbles, or
 * `highlightDetailLimit=<n>` to expand only the first n.
 */
async function searchUserId(req, res, next) {
  try {
    const src = { ...(req.params || {}), ...(req.query || {}), ...(req.body || {}) };
    const username = src.username || src.instaUsername || src.userId;
    const withDetails = flag(src.includeHighlightDetails ?? src.highlightDetails, true);

    if (!withDetails) {
      const result = await service.searchUserId(username);
      return res.json({
        success: true,
        status: result.status,
        source: result.source,
        // Stories and highlights fall back independently, so the highlight list
        // may have come from the other source.
        highlightSource: result.highlightSource,
        // Set only when the matching list is empty *because* a source failed
        // (throttled, expired session) rather than having nothing to return.
        storiesError: result.storiesError || null,
        highlightsError: result.highlightsError || null,
        data: result.data,
      });
    }

    if (!username || !String(username).trim()) {
      return res.status(400).json({ success: false, error: 'Username is required.' });
    }

    const bundle = await service.collectStoryBundle(username, {
      includeHighlightDetails: true,
      // 0 (the default) expands every highlight.
      highlightDetailLimit: parseInt(src.highlightDetailLimit, 10) || 0,
    });
    if (bundle.error && !bundle.profile) {
      return res.status(502).json({ success: false, error: bundle.error });
    }

    return res.json({
      success: true,
      status: 'Fetched Stories',
      source: bundle.source,
      highlightSource: bundle.highlightSource,
      storiesError: bundle.storiesError || null,
      highlightsError: bundle.highlightsError || null,
      // Same field names as the non-detailed shape, so one client handles both.
      data: {
        ...bundle.profile,
        stories: bundle.stories,
        highlights: bundle.highlights,
      },
      highlight_details: {
        available: bundle.highlightDetails.some((d) => d.count > 0),
        count: bundle.highlightDetails.length,
        truncated: bundle.truncated,
        error: bundle.highlightsError || null,
        // One node per highlight, keyed by highlight id.
        items: detailsById(bundle.highlightDetails),
      },
    });
  } catch (error) {
    return next(error);
  }
}

/** GET /api/instagram/highlights/:highlightId?username=&userId= */
async function highlightDetails(req, res, next) {
  try {
    const { highlightId } = req.params;
    const { username, userId } = req.query || {};
    const result = await service.getHighlightDetails(highlightId, username, userId);

    res.json({
      success: true,
      source: result.source,
      title: result.title,
      count: result.items.length,
      // Names the failed source when the bubble came back empty.
      reason: result.error || null,
      data: result.items,
    });
  } catch (error) {
    next(error);
  }
}

/** GET /api/instagram/media?url=&filename=&inline=1 - single download / preview */
async function media(req, res, next) {
  try {
    const { url, filename, inline } = req.query || {};
    await downloads.pipeMedia(url, res, { filename, inline: inline === '1' || inline === 'true' });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/instagram/download/zip
 * body: { username, items: [{ url, filename?, type?, kind?, highlightId? }] }
 * Streams a zip named "<normalized-username>.zip".
 */
async function downloadZip(req, res, next) {
  try {
    const { username, items } = req.body || {};
    await downloads.zipToResponse(username, items, res);
  } catch (error) {
    if (res.headersSent) return res.destroy(error);
    next(error);
  }
}

/**
 * POST /api/instagram/download/zip/start
 * Same body as /download/zip, but returns { jobId } and builds the archive in
 * the background so the client can follow per-file progress.
 */
function startZip(req, res, next) {
  try {
    const { username, items } = req.body || {};
    const job = downloads.startZipJob(username, items);
    res.status(202).json({ success: true, jobId: job.id, ...downloads.snapshot(job) });
  } catch (error) {
    next(error);
  }
}

/** GET /api/instagram/download/zip/:jobId/events - SSE progress stream */
function zipEvents(req, res, next) {
  try {
    downloads.streamJobEvents(req.params.jobId, req, res);
  } catch (error) {
    next(error);
  }
}

/** GET /api/instagram/download/zip/:jobId/file - the finished archive */
function zipFile(req, res, next) {
  try {
    downloads.sendJobFile(req.params.jobId, res);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  searchUserId,
  highlightDetails,
  media,
  downloadZip,
  startZip,
  zipEvents,
  zipFile,
};
