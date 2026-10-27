export class XhsError extends Error {
  constructor(code, details = {}) { super(code); this.name = 'XhsError'; this.code = code; this.details = details; }
}
export const fail = (code, details) => { throw new XhsError(code, details); };
export const TERMINAL = new Set(['network_restricted', 'login_required', 'session_invalid', 'challenge_required', 'rate_limited', 'permission_denied']);
export function safeError(error) {
  return error instanceof XhsError ? { code: error.code, ...error.details } : {
    code: error?.name === 'AbortError' ? 'cancelled' : error?.name === 'TimeoutError' ? 'deadline_exceeded' : 'internal_error',
  };
}
export function checkAbort(signal) { if (signal?.aborted) fail(signal.reason?.name === 'TimeoutError' ? 'deadline_exceeded' : 'cancelled'); }
export function signalFor(signal, timeoutMs) { return AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]); }
