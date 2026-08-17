'use strict';

const service = require('./service');

const flag = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
};

/**
 * GET/POST /api/fastdl
 * Consolidated single hit endpoint: accepts a post URL, profile URL, or username handle,
 * dynamically fetching posts or converted feed data accordingly.
 */
async function fetchAll(req, res, next) {
  try {
    const src = { ...(req.params || {}), ...(req.query || {}), ...(req.body || {}) };
    const input = src.url || src.sf_url || src.link || src.username || src.instaUsername || src.handle;
    
    const result = await service.fetchData(input, {
      pages: src.pages,
      includeHighlightDetails: flag(src.includeHighlightDetails ?? src.highlightDetails, true),
      highlightDetailLimit: src.highlightDetailLimit,
    });

    if (result && Array.isArray(result)) {
      res.json({
        success: true,
        source: 'fastdl',
        data: result,
      });
    } else {
      res.json(result);
    }
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/fastdl/status
 * Diagnostic info for FastDL reachability and signing status.
 */
async function status(req, res, next) {
  try {
    const statusReport = await service.getStatus();
    res.json({
      success: true,
      ...statusReport,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/fastdl/highlights/:highlightId
 * Fetches stories/items for a single highlight bubble.
 */
async function highlightDetails(req, res, next) {
  try {
    const highlightId = req.params.highlightId || req.query.highlightId;
    const result = await service.fetchData(highlightId);
    res.json({
      success: true,
      source: 'fastdl',
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  fetchAll,
  highlightDetails,
  status,
};


