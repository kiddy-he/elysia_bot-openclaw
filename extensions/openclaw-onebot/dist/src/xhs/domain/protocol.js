// Verified against the shipped 2026-10-20 index bundle (module 52504) and
// vendor-dynamic security error table. Unknown numbers remain unknown.
export function businessErrorCode(code) {
  if ([-100, -101, -104].includes(code)) return 'login_required';
  if ([-103, -10000, 300011].includes(code)) return 'permission_denied';
  if ([-13002, -13020, 461, 471, 300015].includes(code)) return 'challenge_required';
  if (code === 300012) return 'network_restricted';
  if (code === 300013) return 'rate_limited';
  return 'upstream_business_error';
}
