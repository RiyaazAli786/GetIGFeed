'use strict';

const service = require('./service');
const flag = (value, fallback) => value === undefined || value === null || value === '' ? fallback : !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());

async function fetchAll(req, res, next) {
  try {
    const input = { ...req.params, ...req.query, ...req.body };
    const result = await service.fetchData(input.url || input.target_url || input.link || input.username || input.instaUsername || input.handle, {
      pages: input.pages, includeHighlightDetails: flag(input.includeHighlightDetails ?? input.highlightDetails, true), highlightDetailLimit: input.highlightDetailLimit,
    });
    res.json(Array.isArray(result) ? { success: true, source: 'igram', data: result } : result);
  } catch (error) { next(error); }
}

async function highlightDetails(req, res, next) {
  try { res.json({ success: true, source: 'igram', data: await service.fetchData(req.params.highlightId || req.query.highlightId) }); }
  catch (error) { next(error); }
}

async function status(req, res, next) {
  try { res.json({ success: true, ...(await service.getStatus()) }); }
  catch (error) { next(error); }
}

module.exports = { fetchAll, highlightDetails, status };
