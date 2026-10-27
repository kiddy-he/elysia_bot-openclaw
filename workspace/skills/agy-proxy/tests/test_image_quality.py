"""Offline quality scoring and redraw integration tests; no real APIs or QQ writes."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import hashlib
import contextlib
import io

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
spec = importlib.util.spec_from_file_location("image_quality", SCRIPTS / "image-quality.py")
quality = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quality)


def evidence(**changes):
    data = {field: True for field in quality.BOOL_FIELDS}
    data.update(visible_character_count=1, anatomy_score=100, compliance_score=80,
                severe_anatomy_errors=[], failures=[], scene_summary="One coherent character")
    data.update(changes)
    if data["anatomy_score"] < 90 and "anatomy_consistent" not in changes:
        data["anatomy_consistent"] = False
    return data


class QualityScoreTests(unittest.TestCase):
    def test_anatomy_weight_is_computed_locally(self):
        result = quality.evaluate(evidence(), 1)
        self.assertEqual(result["weighted_score"], 94)
        self.assertTrue(result["passed"])
        self.assertFalse(quality.evaluate(evidence(anatomy_score=89, compliance_score=100), 1)["passed"])
        self.assertFalse(quality.evaluate(evidence(anatomy_score=90, compliance_score=70), 1)["passed"])
        self.assertFalse(quality.evaluate(evidence(anatomy_score=100, compliance_score=49.999), 1)["passed"])

    def test_extra_limbs_or_severe_errors_veto_even_perfect_scores(self):
        for changes in [dict(severe_anatomy_errors=["extra arm"]), dict(anatomy_consistent=False),
                        dict(failures=["detached hand"]), dict(visible_character_count=2), dict(no_extra_characters=False)]:
            with self.subTest(changes=changes):
                self.assertFalse(quality.evaluate(evidence(compliance_score=100, **changes), 1)["passed"])

    def test_low_anatomy_score_carries_specific_findings_into_redraw_feedback(self):
        result = quality.evaluate(evidence(anatomy_score=74, anatomy_findings=["left wrist has an impossible joint"]), 1)
        self.assertFalse(result["passed"])
        self.assertIn("Anatomy finding: left wrist has an impossible joint", result["rejection_reasons"])

    def test_contradictory_low_score_is_reinspected_instead_of_billing_another_image(self):
        with self.assertRaises(ValueError):
            quality.evaluate(evidence(anatomy_score=76, anatomy_consistent=True,
                                     anatomy_findings=["All joints, hands and limbs are coherent"]), 1)

    def test_missing_badly_typed_and_out_of_range_evidence_is_not_a_pass(self):
        for field, value in [("anatomy_score", True), ("anatomy_score", float("nan")), ("anatomy_score", 101),
                             ("compliance_score", -1), ("severe_anatomy_errors", None), ("anatomy_consistent", "true"),
                             ("visible_character_count", 1.0)]:
            with self.subTest(field=field, value=value):
                with self.assertRaises(ValueError):
                    quality.evaluate(evidence(**{field: value}), 1)
        old = evidence()
        del old["anatomy_score"]
        with self.assertRaises(ValueError):
            quality.evaluate(old, 1)

    def test_thought_text_is_excluded_and_generic_no_body_scene_can_pass(self):
        envelope = {"candidates": [{"content": {"parts": [
            {"thought": True, "text": "not JSON"}, {"text": "```json\n" + json.dumps(evidence(visible_character_count=0)) + "\n```"}]}}]}
        self.assertTrue(quality.evaluate(quality.extract_response(envelope), 0)["passed"])


class QualityRedrawTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agy-quality-test-")
        self.root = Path(self.temp.name)
        self.env = dict(os.environ, TEST_ROOT=str(self.root), PENDING_REFERENCE_DIR=str(self.root / "pending"))

    def tearDown(self):
        self.temp.cleanup()

    def run_shell(self, body, **env):
        setup = f'source "{SCRIPTS / "image-request-policy.sh"}"\nsource "{SCRIPTS / "image-quality-policy.sh"}"\n'
        return subprocess.run(["bash", "-c", setup + body], env={**self.env, **env}, text=True, capture_output=True, timeout=10)

    def test_rejected_candidate_is_corrected_and_only_final_path_is_exposed(self):
        result = self.run_shell(r'''
generate() {
  local n=$(( $(cat "$TEST_ROOT/count" 2>/dev/null || printf 0) + 1 ))
  printf '%s' "$n" > "$TEST_ROOT/count"
  printf '%s\n' "$1" > "$TEST_ROOT/prompt-$n"
  printf 'image' > "$TEST_ROOT/image-$n.png"
  printf 'image_output=%s\n' "$TEST_ROOT/image-$n.png"
  if [ "$n" = 1 ]; then
    rm "$TEST_ROOT/image-$n.png"
    printf '{"passed":false,"rejection_reasons":["extra detached arm"]}' > "$AGY_IMAGE_QUALITY_FEEDBACK_FILE"
    return 10
  fi
}
image_quality_run generate 'original scene'
''')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "count").read_text(), "2")
        self.assertIn("extra detached arm", (self.root / "prompt-2").read_text())
        self.assertIn("original scene", (self.root / "prompt-2").read_text())
        self.assertEqual(result.stdout.count("image_output="), 1)
        self.assertNotIn("image_output=" + str(self.root / "image-1.png"), result.stdout)
        self.assertFalse((self.root / "image-1.png").exists())

    def test_persistent_rejection_stops_at_three_without_releasing_image(self):
        result = self.run_shell(r'''
generate() {
  printf x >> "$TEST_ROOT/count"
  printf '{"passed":false,"rejection_reasons":["fused legs"]}' > "$AGY_IMAGE_QUALITY_FEEDBACK_FILE"
  return 10
}
image_quality_run generate 'original scene'
''')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / "count").read_text(), "xxx")
        self.assertIn("three-scored-candidates-required", result.stdout)
        self.assertNotIn("image_output=", result.stdout)

    def test_auth_refusal_and_unavailable_verifier_do_not_redraw(self):
        for status in [1, 2, 3]:
            (self.root / "count").unlink(missing_ok=True)
            result = self.run_shell(f'generate() {{ printf x >> "$TEST_ROOT/count"; return {status}; }}\nimage_quality_run generate scene')
            self.assertEqual(result.returncode, status)
            self.assertEqual((self.root / "count").read_text(), "x")

    def test_shared_deadline_blocks_new_candidate_and_attempt_limit_is_validated(self):
        result = self.run_shell('image_policy_init\nAGY_IMAGE_POLICY_DEADLINE=1\ngenerate() { printf WRONG; }\nimage_quality_run generate scene')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("WRONG", result.stdout)
        result = self.run_shell('image_quality_run echo scene', IMAGE_QUALITY_MAX_ATTEMPTS="4")
        self.assertEqual(result.returncode, 2)

    def test_same_gemini_path_is_required_on_redraw(self):
        result = self.run_shell(r'''
generate() {
  if [ "$AGY_IMAGE_QUALITY_CANDIDATE" = 1 ]; then
    printf 'reference_generate_adapter=gemini-plan-images-edit\n'
    printf '{"passed":false,"rejection_reasons":["extra arm"]}' > "$AGY_IMAGE_QUALITY_FEEDBACK_FILE"
    return 10
  fi
  [ "$AGY_REFERENCE_REQUIRE_GEMINI" = 1 ] || return 99
  printf image > "$TEST_ROOT/final.png"
  printf 'image_output=%s\n' "$TEST_ROOT/final.png"
}
image_quality_run generate scene
''')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_reverification_does_not_reset_the_candidate_budget(self):
        script = (SCRIPTS / "agy-proxy-diagnose.sh").read_text().split('\ncase "${1:-all}" in')[0]
        script = script.replace('source "$(dirname "${BASH_SOURCE[0]}")/image-request-policy.sh"', f'source "{SCRIPTS / "image-request-policy.sh"}"')
        for used, expected in [(1, 2), (3, 0)]:
            with self.subTest(used=used):
                pending = self.root / "pending"
                pending.mkdir(exist_ok=True)
                image = self.root / "old.png"
                image.write_text("fixture")
                (pending / "latest.json").write_text(json.dumps({"image_path": str(image), "prompt": "original", "expected_count": 1,
                                                               "references": ["https://example.invalid/ref.png"], "quality_candidate": used}))
                marker = self.root / "remaining"
                marker.unlink(missing_ok=True)
                body = r'''
verify_generated_reference_image() {
  printf '{"passed":false,"rejection_reasons":["extra arm"]}' > "$AGY_IMAGE_QUALITY_FEEDBACK_FILE"
  return 1
}
image_generate_from_references() { printf '%s' "$IMAGE_QUALITY_MAX_ATTEMPTS" > "$TEST_ROOT/remaining"; }
reverify_latest_reference_image
'''
                result = subprocess.run(["bash", "-c", script + body], env=self.env, text=True, capture_output=True, timeout=10)
                if expected:
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertEqual(marker.read_text(), str(expected))
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(marker.exists())
                    self.assertIn("three-scored-candidates-required", result.stdout)

    def test_reference_generator_and_real_verifier_redraw_after_extra_arm(self):
        # Exercise the real reference adapter, Gemini response parsing, local
        # weighted evaluator, rejection code and orchestration together.
        from test_image_request_policy import STUB, PNG
        import base64
        fakebin = self.root / "bin"
        fakebin.mkdir()
        (fakebin / "curl").write_text(STUB)
        (fakebin / "curl").chmod(0o700)
        (self.root / "source.png").write_bytes(base64.b64decode(PNG))
        (self.root / "config.json").write_text(json.dumps({"proxy": {"api_key": "synthetic-key"}}))
        definitions = (SCRIPTS / "agy-proxy-diagnose.sh").read_text().split('\ncase "${1:-all}" in')[0]
        definitions = definitions.replace('source "$(dirname "${BASH_SOURCE[0]}")/image-request-policy.sh"', f'source "{SCRIPTS / "image-request-policy.sh"}"')
        definitions += r'''
CONFIG="$TEST_ROOT/config.json"
download_reference_image() { cp "$TEST_ROOT/source.png" "${!#}"; }
plan_reference_with_gemini() { printf '%s' "$1"; }
image_edit_references() {
  local output
  output=$(mktemp /tmp/agy-proxy-edited.XXXXXX.png)
  cp "$TEST_ROOT/source.png" "$output"
  printf '%s\n' "$output" >> "$TEST_ROOT/candidates"
  printf '%s\n' "$1" >> "$TEST_ROOT/prompts"
  printf 'image_output=%s\n' "$output"
}
image_generate_from_references 'original scene' https://example.invalid/reference.png
'''
        def envelope(data):
            return json.dumps({"candidates": [{"content": {"parts": [{"thought": True, "text": "private reasoning"}, {"text": json.dumps(data)}]}}]})
        scenario = [
            {"body": envelope(evidence(anatomy_score=40, anatomy_consistent=False, severe_anatomy_errors=["extra arm"]))},
            {"body": envelope(evidence())},
        ]
        env = {**self.env, "PATH": str(fakebin) + ":" + os.environ["PATH"], "TEST_SCENARIO": json.dumps(scenario)}
        paths = []
        try:
            result = subprocess.run(["bash", "-c", definitions], env=env, text=True, capture_output=True, timeout=10)
            paths = (self.root / "candidates").read_text().splitlines()
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(len(paths), 2)
            self.assertFalse(Path(paths[0]).exists())
            self.assertTrue(Path(paths[1]).exists())
            self.assertEqual(result.stdout.count("image_output="), 1)
            self.assertIn("extra arm", (self.root / "prompts").read_text())
            receipt = json.loads(Path(paths[1] + ".quality.json").read_text())
            self.assertTrue(receipt["passed"])
            self.assertEqual(receipt["weighted_score"], 94)
            self.assertNotIn("private reasoning", result.stdout)
            self.assertEqual(int((self.root / "count").read_text()), 2)
        finally:
            for name in paths:
                Path(name).unlink(missing_ok=True)
                Path(name + ".quality.json").unlink(missing_ok=True)

    def test_three_scored_failures_release_highest_score_once_and_preserve_failed_result(self):
        result = self.run_shell(r'''
generate() {
  local n="$AGY_IMAGE_QUALITY_CANDIDATE" output="$TEST_ROOT/image-$AGY_IMAGE_QUALITY_CANDIDATE.png" score
  case "$n" in 1) score=40;; 2) score=78;; 3) score=65;; esac
  printf 'image-%s' "$n" > "$output"
  /usr/bin/python3 - "$output" "$score" "$AGY_IMAGE_QUALITY_FEEDBACK_FILE" <<'PY'
import hashlib,json,sys
from pathlib import Path
p=Path(sys.argv[1]);a=float(sys.argv[2]);data={
 'policy_version':'anatomy-v1','expected_count':1,'visible_character_count':1,
 'anatomy_score':a,'compliance_score':80,'weighted_score':round(.7*a+24,2),'passed':False,
 'anatomy_consistent':False,'all_expected_characters_present':True,'no_extra_characters':True,
 'scene_and_actions_match':True,'identity_mapping_confident':True,'source_pose_and_layout_replaced':True,
 'scene_directed_pose_and_gaze':True,'severe_anatomy_errors':['extra hand'], 'failures':['extra hand'],
 'rejection_reasons':['extra hand'],'image_sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
Path(str(p)+'.quality.json').write_text(json.dumps(data));Path(sys.argv[3]).write_text(json.dumps(data))
PY
  image_quality_retain_rejected "$output"
  return 10
}
image_quality_run generate scene
''')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.count("image_output="), 1)
        self.assertIn("image_quality_selection=best-of-three", result.stdout)
        selected = self.root / "image-2.png"
        self.assertIn("image_output=" + str(selected), result.stdout)
        self.assertFalse((self.root / "image-1.png").exists())
        self.assertFalse((self.root / "image-3.png").exists())
        receipt = json.loads(Path(str(selected) + ".quality.json").read_text())
        self.assertFalse(receipt["passed"])
        self.assertTrue(receipt["accepted_for_delivery"])
        self.assertEqual(receipt["selection"]["candidate_count"], 3)
        quality.validate_delivery(receipt, selected)


class BestSelectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agy-best-selection-test-")
        self.root = Path(self.temp.name)
        self.paths = []
        self.candidates = []
        for i, score in enumerate([65, 80, 73]):
            path = self.root / f"image-{i}.png"
            path.write_bytes(f"candidate-{i}".encode())
            data = quality.evaluate(evidence(anatomy_score=score, compliance_score=80,
                                            severe_anatomy_errors=["extra hand"]), 1)
            data.update(expected_count=1, image_sha256=hashlib.sha256(path.read_bytes()).hexdigest())
            Path(str(path) + ".quality.json").write_text(json.dumps(data))
            self.paths.append(path)
            self.candidates.append(data)
        (self.root / "candidates.txt").write_text("\n".join(map(str, self.paths)) + "\n")

    def tearDown(self):
        self.temp.cleanup()

    def select(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            quality.select_best(self.root)
        return json.loads(out.getvalue())

    def test_selection_accepts_best_even_with_anatomy_defects_but_never_fakes_pass(self):
        selected = self.select()
        self.assertEqual(selected["image_path"], str(self.paths[1]))
        receipt = json.loads(Path(selected["receipt_path"]).read_text())
        quality.validate_delivery(receipt, self.paths[1])
        self.assertFalse(receipt["passed"])
        self.assertEqual(receipt["severe_anatomy_errors"], ["extra hand"])

    def test_fewer_candidates_or_changed_images_cannot_select(self):
        (self.root / "candidates.txt").write_text("\n".join(map(str, self.paths[:2])))
        with self.assertRaises(ValueError): self.select()
        (self.root / "candidates.txt").write_text("\n".join(map(str, self.paths)))
        self.paths[0].write_text("modified")
        with self.assertRaises(ValueError): self.select()

    def test_tampered_ranking_and_chosen_hash_are_rejected_on_delivery(self):
        selected = self.select()
        receipt = json.loads(Path(selected["receipt_path"]).read_text())
        receipt["selection"]["selected_index"] = 0
        with self.assertRaises(ValueError): quality.validate_delivery(receipt, self.paths[1])
        receipt["selection"]["selected_index"] = 1
        receipt["selection"]["candidates"][0]["anatomy_score"] = 100
        receipt["selection"]["candidates"][0]["weighted_score"] = 94
        with self.assertRaises(ValueError): quality.validate_delivery(receipt, self.paths[1])


if __name__ == "__main__":
    unittest.main()
