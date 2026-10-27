#!/usr/bin/env bash
# Shared, bounded retry policy. This file performs no requests when sourced.
AGY_IMAGE_DIAGNOSTICS_SCRIPT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/image-diagnostics.py"

image_policy_init() {
  [ "${AGY_IMAGE_POLICY_READY:-0}" = 1 ] && return 0
  local name value maximum
  IMAGE_REQUEST_TIMEOUT="${IMAGE_REQUEST_TIMEOUT:-900}"
  IMAGE_MAX_ATTEMPTS="${IMAGE_MAX_ATTEMPTS:-3}"
  IMAGE_RETRY_DELAY="${IMAGE_RETRY_DELAY:-5}"
  IMAGE_OPTIMIZER_TIMEOUT="${IMAGE_OPTIMIZER_TIMEOUT:-120}"
  IMAGE_VERIFICATION_TIMEOUT="${IMAGE_VERIFICATION_TIMEOUT:-180}"
  IMAGE_WORKFLOW_TIMEOUT="${IMAGE_WORKFLOW_TIMEOUT:-3300}"
  IMAGE_QUALITY_MAX_ATTEMPTS="${IMAGE_QUALITY_MAX_ATTEMPTS:-3}"
  for name in IMAGE_REQUEST_TIMEOUT IMAGE_MAX_ATTEMPTS IMAGE_RETRY_DELAY IMAGE_OPTIMIZER_TIMEOUT IMAGE_VERIFICATION_TIMEOUT IMAGE_WORKFLOW_TIMEOUT IMAGE_QUALITY_MAX_ATTEMPTS; do
    value="${!name}"
    case "$name" in
      IMAGE_REQUEST_TIMEOUT) maximum=1800 ;;
      IMAGE_MAX_ATTEMPTS) maximum=5 ;;
      IMAGE_QUALITY_MAX_ATTEMPTS) maximum=3 ;;
      IMAGE_RETRY_DELAY) maximum=60 ;;
      IMAGE_OPTIMIZER_TIMEOUT|IMAGE_VERIFICATION_TIMEOUT) maximum=600 ;;
      IMAGE_WORKFLOW_TIMEOUT) maximum=3300 ;;
    esac
    if ! [[ "$value" =~ ^[1-9][0-9]*$ ]] || [ "${#value}" -gt 8 ] || [ "$value" -gt "$maximum" ]; then
      printf 'image_policy_error=invalid-%s\n' "$name" >&2
      return 2
    fi
  done
  AGY_IMAGE_POLICY_DEADLINE=$(( $(date +%s) + IMAGE_WORKFLOW_TIMEOUT ))
  AGY_IMAGE_POLICY_READY=1
}

image_stage_timeout() {
  image_policy_init || return $?
  local requested="$1" remaining=$(( AGY_IMAGE_POLICY_DEADLINE - $(date +%s) ))
  if [ "$remaining" -le 0 ]; then
    printf 'image_policy_error=workflow-timeout\n' >&2
    return 1
  fi
  if [ "$requested" -lt "$remaining" ]; then printf '%s' "$requested"; else printf '%s' "$remaining"; fi
}

image_response_is_retryable() {
  local format="$1" body="$2" http="$3" curl_exit="$4"
  # Local argument/file/certificate errors are not transient transport failures.
  if [ "$curl_exit" -ne 0 ]; then
    case "$curl_exit" in 5|6|7|16|18|28|35|52|55|56|92) return 0 ;; *) return 1 ;; esac
  fi
  case "$http" in
    408|425|429|500|502|503|504|520|521|522|523|524) return 0 ;;
    2??) ;;
    *) return 1 ;;
  esac
  if [ "$format" = json ]; then
    jq empty "$body" >/dev/null 2>&1 || return 0
    jq -r '.error? | if type == "object" then [.code,.type,.message] | map(. // "") | join(" ") else . // "" end' "$body" 2>/dev/null \
      | LC_ALL=C grep -qiE 'server_error|upstream_error|rate_limit|overloaded|temporar|service.unavailable'
    return $?
  fi
  # A completed SSE response with no image may be a refusal. Never regenerate
  # it automatically. An interrupted stream without a completion is retryable.
  if jq -Re 'select(startswith("data: ")) | .[6:] | fromjson? | select(.type == "response.completed")' "$body" >/dev/null 2>&1; then
    return 1
  fi
  if { jq -r '.error? | if type == "object" then [.code,.type] | map(. // "") | join(" ") else empty end' "$body" 2>/dev/null;
       jq -Rr 'select(startswith("data: ")) | .[6:] | fromjson? | (.response.error // .error // {}) | [.code,.type] | map(. // "") | join(" ")' "$body" 2>/dev/null; } \
      | LC_ALL=C grep -qiE 'invalid|authentication|permission|content_policy|refusal|insufficient_quota'; then
    return 1
  fi
  return 0
}

image_http_request() {
  local label="$1" format="$2" response_file="$3"
  shift 3
  image_policy_init || return $?
  local attempt http=000 curl_exit=124 timeout_seconds error_file headers_file retry_delay remaining attempt_started retryable outcome
  local -a provider_route=(--noproxy '*')
  if [[ "${!#}" == https://provider.example.invalid/* ]]; then
    provider_route=(--proxy http://127.0.0.1:7890 --noproxy '')
  fi
  for ((attempt=1; attempt<=IMAGE_MAX_ATTEMPTS; attempt++)); do
    timeout_seconds=$(image_stage_timeout "$IMAGE_REQUEST_TIMEOUT") || break
    error_file=$(mktemp /tmp/agy-proxy-image-curl-error.XXXXXX)
    headers_file=$(mktemp /tmp/agy-proxy-image-headers.XXXXXX)
    : > "$response_file"
    printf '%s_attempt=%s/%s timeout_seconds=%s\n' "$label" "$attempt" "$IMAGE_MAX_ATTEMPTS" "$timeout_seconds" >&2
    attempt_started=$(date +%s)
    curl_exit=0
    http=$(curl "${provider_route[@]}" --silent --show-error --connect-timeout 30 --max-time "$timeout_seconds" \
      --dump-header "$headers_file" --output "$response_file" --write-out '%{http_code}' \
      "$@" 2>"$error_file") || curl_exit=$?
    printf '%s' "$curl_exit" > "$response_file.curl-exit"
    chmod 600 "$response_file.curl-exit"
    printf '%s_attempt_http=%s curl_exit=%s\n' "$label" "${http:-000}" "$curl_exit" >&2
    retryable=0
    image_response_is_retryable "$format" "$response_file" "${http:-000}" "$curl_exit" && retryable=1
    outcome=failed
    if [ "$retryable" -eq 1 ]; then
      outcome=retryable-failure
    elif [ "$curl_exit" -eq 0 ] && [[ "$http" = 2* ]]; then
      outcome=success
      if [ "$format" = json ]; then
        if ! jq -e 'type == "object" and .error == null and ((.data[0].b64_json // .data[0].url // "") | type == "string" and length > 0)' "$response_file" >/dev/null 2>&1; then
          outcome=failed
        fi
      elif ! jq -Re 'select(startswith("data: ")) | .[6:] | fromjson? | select(.type == "response.completed" and (.response.error // null) == null) | .response.output[]? | select(.type == "image_generation_call" and ((.result // "") | length > 0))' "$response_file" >/dev/null 2>&1; then
        outcome=failed
      fi
    fi
    AGY_IMAGE_DIAGNOSTIC_ENDPOINT="${!#}" AGY_IMAGE_DIAGNOSTIC_MODEL="${IMAGE_MODEL:-unknown}" \
      /usr/bin/python3 "$AGY_IMAGE_DIAGNOSTICS_SCRIPT" "$label" "$format" "$response_file" "$headers_file" "$error_file" \
      "${http:-000}" "$curl_exit" "$attempt" "$(( $(date +%s) - attempt_started ))" "$outcome" || true
    if [ "$outcome" != success ]; then
      # Permanent failures need evidence too. cp creates a fresh file, so set
      # its permissions explicitly instead of inheriting the caller's umask.
      (umask 077; cp "$response_file" "$response_file.attempt-$attempt")
      chmod 600 "$response_file.attempt-$attempt" "$error_file" "$headers_file"
      printf '%s_failure_response=%s\n%s_failure_stderr=%s\n%s_failure_headers=%s\n' \
        "$label" "$response_file.attempt-$attempt" "$label" "$error_file" "$label" "$headers_file" >&2
    else
      rm -f "$error_file" "$headers_file"
    fi
    if [ "$retryable" -eq 0 ]; then
      printf '%s' "${http:-000}"
      return 0
    fi
    [ "$attempt" -lt "$IMAGE_MAX_ATTEMPTS" ] || break
    retry_delay=$(( IMAGE_RETRY_DELAY * attempt ))
    remaining=$(( AGY_IMAGE_POLICY_DEADLINE - $(date +%s) ))
    [ "$remaining" -gt "$retry_delay" ] || break
    printf '%s_retry_in_seconds=%s\n' "$label" "$retry_delay" >&2
    sleep "$retry_delay"
  done
  # Exhaustion is not success, even when HTTP headers were 200. The caller
  # must check the actual transport result and parse the final response.
  printf '%s' "$curl_exit" > "$response_file.curl-exit"
  chmod 600 "$response_file.curl-exit"
  printf '%s' "${http:-000}"
}
