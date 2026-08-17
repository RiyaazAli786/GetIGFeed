'use strict';

/**
 * Small shared helpers.
 */

/** Promise-based delay (equivalent of Task.Delay). */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build the mobile-request Bearer authorization header, matching the C#:
 *   Bearer IGT:2:<base64({"ds_user_id":"...","sessionid":"..."})>
 */
function buildMobileAuthorization(dsUserId, sessionId) {
  const payload = JSON.stringify({ ds_user_id: dsUserId, sessionid: sessionId });
  const token = Buffer.from(payload, 'utf8').toString('base64');
  return `Bearer IGT:2:${token}`;
}



/**
 * Promise.all with a ceiling on how many run at once, results in input order.
 * Used for the per-highlight media lookups, where one upstream call per
 * highlight would otherwise fan out unbounded.
 *
 * @param {Array} items
 * @param {number} limit max concurrent calls
 * @param {(item: any, index: number) => Promise<any>} fn
 * @returns {Promise<Array>}
 */
async function mapWithConcurrency(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let cursor = 0;

  const worker = async () => {
    for (; ;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      results[index] = await fn(list[index], index);
    }
  };

  const size = Math.max(1, Math.min(limit || 1, list.length));
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}

module.exports = { sleep, buildMobileAuthorization, mapWithConcurrency };
