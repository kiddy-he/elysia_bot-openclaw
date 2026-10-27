import importlib.util
import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("draft", Path(__file__).with_name("qzone-draft.py"))
draft = importlib.util.module_from_spec(spec)
spec.loader.exec_module(draft)


class TimeEvidenceTest(unittest.TestCase):
    def evidence(self, **changes):
        return {"lighting_matches": True, "activity_matches": True, "caption_matches": True, "no_temporal_conflict": True,
                "observed_lighting": "窗外明亮日光", "observed_activity": "坐在窗边看书", "failures": [], **changes}

    def test_evidence_requires_all_checks_and_visible_findings(self):
        self.assertTrue(draft.verify_time_evidence(self.evidence())["passed"])
        for change in ({"lighting_matches": False}, {"activity_matches": False}, {"caption_matches": False}, {"no_temporal_conflict": False}, {"failures": ["夜空不符合午间"]}):
            self.assertFalse(draft.verify_time_evidence(self.evidence(**change))["passed"])
        for change in ({"lighting_matches": "true"}, {"observed_lighting": ""}, {"failures": "bad"}):
            with self.assertRaises(ValueError):
                draft.verify_time_evidence(self.evidence(**change))

    def test_real_negative_evidence_is_final_and_does_not_try_another_model(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self):
                return json.dumps({"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({
                    "lighting_matches": False, "activity_matches": True, "caption_matches": False, "no_temporal_conflict": False,
                    "observed_lighting": "深蓝夜空与星星", "observed_activity": "看书", "failures": ["午间发布了夜景"]})}}]}).encode()
        requests = []
        class Opener:
            def open(self, request, timeout):
                requests.append(json.loads(request.data)); return Response()
        with tempfile.TemporaryDirectory() as root:
            image = Path(root) / "original.png"; image.write_bytes(b"synthetic-image")
            config = {"models": {"providers": {"antigravity": {"baseUrl": "http://127.0.0.1:1/v1", "apiKey": "synthetic-only"}}}}
            context = {"publishAt": "2099-01-02T13:25:00+08:00", "caption": "午间在窗边看看书", "scene": "午间自然日光与窗边阅读"}
            with patch.object(draft.subprocess, "run", return_value=types.SimpleNamespace(stdout=b"jpeg-assessment-only")), patch.object(draft.urllib.request, "build_opener", return_value=Opener()):
                result = draft.verify_image_time(context, str(image), config)
            self.assertFalse(result["passed"]); self.assertEqual(len(requests), 1)
            self.assertEqual(result["period"], "noon"); self.assertEqual(result["image_sha256"], draft.hashlib.sha256(b"synthetic-image").hexdigest())
            self.assertEqual(image.read_bytes(), b"synthetic-image")
            self.assertEqual(requests[0]["model"], "gemini-3.8-flash-high")
            self.assertNotIn("tools", requests[0]); self.assertNotIn("private", requests[0]["messages"][1]["content"][0]["text"])


if __name__ == "__main__":
    unittest.main()
