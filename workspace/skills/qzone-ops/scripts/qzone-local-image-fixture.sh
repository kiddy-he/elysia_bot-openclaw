#!/usr/bin/env bash
# Test fixture: all upstream HTTP/model calls are synthetic; no publication.
source "$1"
MOCK_ROOT="$2"; shift 2
CONFIG="$MOCK_ROOT/config.json"
AGY_IMAGE_DIAGNOSTICS_SCRIPT="$MOCK_ROOT/noop.py"
image_api_key() { printf synthetic-only; }
if [ "${MOCK_NATIVE:-0}" = 1 ]; then
  IMAGE_RESPONSES_MODEL=gpt-6-luna
  optimize_prompt_llm() { return 1; }
fi
curl() {
  local out="" data="" arg
  while [ "$#" -gt 0 ]; do
    arg="$1"; shift
    case "$arg" in
      --output|-o) out="$1"; shift ;;
      --data-binary) data="${1#@}"; shift ;;
    esac
  done
  if [[ "$out" == *reference-plan-response* ]]; then
    cp "$data" "$MOCK_ROOT/plan.json"
    printf '%s' '{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"{\"action\":\"generate\",\"prompt\":\"New daylight scene with all ordered identities; fresh actions, expressions, poses and composition.\"}"}]}]}' > "$out"
  else
    cp "$data" "$MOCK_ROOT/quality-request.json"
    jq -nc --argjson count "$MOCK_COUNT" '{candidates:[{content:{parts:[{text:({visible_character_count:$count,anatomy_score:100,compliance_score:100,anatomy_consistent:true,all_expected_characters_present:true,no_extra_characters:true,scene_and_actions_match:true,identity_mapping_confident:true,source_pose_and_layout_replaced:true,scene_directed_pose_and_gaze:true,severe_anatomy_errors:[],failures:[]}|tojson)}]}}]}' > "$out"
  fi
  printf 200
}
image_http_request() {
  local operation="$1" format="$2" response="$3" arg source
  shift 3
  if [ "$operation" = reference_generate ]; then
    for arg in "$@"; do
      if [[ "$arg" = @* ]]; then cp "${arg#@}" "$MOCK_ROOT/plan.json"; fi
    done
    printf '%s\n' 'data: {"type":"response.completed","response":{"output":[{"type":"image_generation_call","result":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII="}]}}' > "$response"
    printf 0 > "$response.curl-exit"
    printf 200
    return
  fi
  : > "$MOCK_ROOT/edit-hashes.txt"
  for arg in "$@"; do
    if [[ "$arg" == image=@* || "$arg" == 'image[]=@'* ]]; then
      source="${arg#*@}"; source="${source%;type=*}"
      sha256sum "$source" | cut -d' ' -f1 >> "$MOCK_ROOT/edit-hashes.txt"
    fi
  done
  printf '%s' '{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII="}]}' > "$response"
  printf 0 > "$response.curl-exit"
  printf 200
}
local_image_generate 'Scene with fresh actions and poses' "$@"
