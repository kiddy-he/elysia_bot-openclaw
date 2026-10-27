import { fail } from '../errors.js';

// Matches the captured frontend's Axios buildURL (vendor module 39160)
// and its getRealUrl apostrophe normalization. Query values are scalar here.
function component(value) {
  return encodeURIComponent(String(value)).replace(/%40/giu, '@').replace(/%3A/giu, ':')
    .replace(/%24/gu, '$').replace(/%2C/giu, ',').replace(/%20/gu, '+')
    .replace(/%5B/giu, '[').replace(/%5D/giu, ']').replace(/'/gu, '%27');
}
export function apiRequestTarget(path, params) {
  if (params === undefined || params === null) return path;
  if (typeof params !== 'object' || Array.isArray(params)) fail('invalid_request');
  const fields = Object.entries(params).map(([key, value]) => {
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) fail('invalid_request');
    return `${component(key)}=${component(value)}`;
  });
  return fields.length ? `${path}?${fields.join('&')}` : path;
}
