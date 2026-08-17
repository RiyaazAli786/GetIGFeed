'use strict';

/**
 * Port of JsonHandler.ParseJsonToJObject - never throws, returns {} instead.
 *
 * anonstories sometimes answers with JSON *inside* a JSON string (the body is
 * `"\"{\\\"results\\\":…}\""`), which parses to a string rather than an object,
 * so one level of that wrapping is unwrapped before giving up.
 */
function parseJson(text) {
  if (text && typeof text === 'object') return text;
  try {
    let parsed = JSON.parse(text);
    if (typeof parsed === 'string' && /^\s*[[{]/.test(parsed)) parsed = JSON.parse(parsed);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Port of JsonHandler.GetJTokenValue(token, params object[] path).
 * Walks a nested path and stringifies the leaf; '' when anything is missing.
 */
function getValue(token, ...path) {
  try {
    let current = token;
    for (let i = 0; i < path.length; i++) {
      if (current === null || current === undefined) return '';
      current = current[path[i]];
    }
    if (current === null || current === undefined) return '';
    if (typeof current === 'object') return JSON.stringify(current);
    return String(current);
  } catch {
    return '';
  }
}

/** Port of GetJArrayElement - accepts an array, or a JSON string holding one. */
function getArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    let parsed = JSON.parse(value);
    // Same double-encoding guard as parseJson.
    if (typeof parsed === 'string' && /^\s*\[/.test(parsed)) parsed = JSON.parse(parsed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toInt(value) {
  const parsed = parseInt(String(value ?? '').replace(/[^\d-]/g, ''), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function toBool(value) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

module.exports = { parseJson, getValue, getArray, toInt, toBool };
