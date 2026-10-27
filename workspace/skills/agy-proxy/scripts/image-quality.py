#!/usr/bin/env python3
"""Validate visual evidence and compute the anatomy-heavy score locally."""
import argparse
import json
import math
import hashlib
import os
from pathlib import Path
import sys

POLICY_VERSION = "anatomy-v1"
BOOL_FIELDS = (
    "all_expected_characters_present", "no_extra_characters", "scene_and_actions_match",
    "identity_mapping_confident", "source_pose_and_layout_replaced", "scene_directed_pose_and_gaze",
    "anatomy_consistent",
)


def evaluate(data, expected_count=0):
    if not isinstance(data, dict) or type(data.get("visible_character_count")) is not int or data["visible_character_count"] < 0:
        raise ValueError("Invalid character count")
    for field in BOOL_FIELDS:
        if type(data.get(field)) is not bool:
            raise ValueError("Invalid boolean evidence")
    for field in ("anatomy_score", "compliance_score"):
        score = data.get(field)
        if type(score) not in (int, float) or not math.isfinite(score) or not 0 <= score <= 100:
            raise ValueError("Invalid score evidence")
    for field in ("failures", "severe_anatomy_errors"):
        if not isinstance(data.get(field), list) or any(not isinstance(x, str) or not x.strip() for x in data[field]):
            raise ValueError("Invalid failure evidence")
    if data["anatomy_score"] < 90 and data["anatomy_consistent"] and not data["failures"] and not data["severe_anatomy_errors"]:
        # A low anatomy score with explicitly sound anatomy and no diagnosed
        # issue is contradictory, not evidence that another billed image is needed.
        raise ValueError("Low anatomy score without any diagnosed structural issue")
    raw_weighted = 0.7 * data["anatomy_score"] + 0.3 * data["compliance_score"]
    weighted = round(raw_weighted, 2)
    reasons = list(data["failures"])
    reasons += ["Severe anatomy error: " + item for item in data["severe_anatomy_errors"]]
    if data["anatomy_score"] < 90:
        reasons.append("Anatomy score below 90")
        findings = data.get("anatomy_findings", [])
        if not isinstance(findings, list) or any(not isinstance(item, str) for item in findings):
            raise ValueError("Invalid anatomy findings")
        reasons.extend("Anatomy finding: " + item for item in findings if item.strip())
    if raw_weighted < 85:
        reasons.append("Weighted score below 85")
    for field in BOOL_FIELDS:
        if not data[field]:
            reasons.append("Failed check: " + field)
    if expected_count > 0 and data["visible_character_count"] != expected_count:
        reasons.append("Incorrect character count")
    # A model reporting explicit failures cannot override them with high scores.
    passed = not reasons
    return {**data, "policy_version": POLICY_VERSION, "anatomy_weight": 0.7,
            "weighted_score": weighted, "passed": passed, "rejection_reasons": list(dict.fromkeys(reasons))}


def extract_response(response):
    parts = response.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    text = "\n".join(p.get("text", "") for p in parts if p.get("thought") is not True).strip()
    if text.startswith("```json") and text.endswith("```"):
        text = text[7:-3].strip()
    elif text.startswith("```") and text.endswith("```"):
        text = text[3:-3].strip()
    return json.loads(text)


def checked_assessment(data):
    count = data.get("expected_count", 0)
    if type(count) is not int or count < 0:
        raise ValueError("Invalid expected count")
    result = evaluate(data, count)
    if data.get("policy_version") != POLICY_VERSION or data.get("passed") is not result["passed"]:
        raise ValueError("Invalid assessment conclusion")
    if data.get("weighted_score") != result["weighted_score"]:
        raise ValueError("Invalid weighted score")
    return result


def validate_delivery(data, image_path):
    image_hash = hashlib.sha256(Path(image_path).read_bytes()).hexdigest()
    if data.get("image_sha256") != image_hash:
        raise ValueError("Image hash mismatch")
    assessment = checked_assessment(data)
    if assessment["passed"]:
        return data
    selection = data.get("selection", {})
    candidates = selection.get("candidates", [])
    if (data.get("accepted_for_delivery") is not True or selection.get("policy") != "best-of-three-v1"
            or selection.get("candidate_count") != 3 or len(candidates) != 3):
        raise ValueError("Three scored candidates are required")
    assessed = [checked_assessment(item) for item in candidates]
    if any(item["passed"] for item in assessed):
        raise ValueError("A passing candidate must be selected directly")
    if any(not isinstance(item.get("image_sha256"), str) or len(item["image_sha256"]) != 64 for item in candidates):
        raise ValueError("Invalid candidate hash")
    expected_counts = {item.get("expected_count", 0) for item in candidates}
    if len(expected_counts) != 1 or data.get("expected_count", 0) not in expected_counts:
        raise ValueError("Inconsistent candidate targets")
    # Ties select the earliest candidate, matching selection at generation time.
    best_index = max(range(3), key=lambda i: (assessed[i]["anatomy_score"] * 0.7 + assessed[i]["compliance_score"] * 0.3))
    best = candidates[best_index]
    if selection.get("selected_index") != best_index or best["image_sha256"] != image_hash:
        raise ValueError("Selected image is not the highest-scoring candidate")
    # Preserve the real failed assessment; selection never rewrites it as passed.
    for field in (*BOOL_FIELDS, "anatomy_score", "compliance_score", "visible_character_count", "severe_anatomy_errors", "failures"):
        if data.get(field) != best.get(field):
            raise ValueError("Selected assessment mismatch")
    return data


def select_best(bank):
    paths = [Path(line) for line in (Path(bank) / "candidates.txt").read_text().splitlines() if line]
    if len(paths) != 3 or len(set(paths)) != 3:
        raise ValueError("Exactly three successful scored generations are required")
    candidates = []
    for path in paths:
        data = json.loads(Path(str(path) + ".quality.json").read_text())
        if hashlib.sha256(path.read_bytes()).hexdigest() != data.get("image_sha256"):
            raise ValueError("Candidate image changed")
        result = checked_assessment(data)
        if result["passed"]:
            raise ValueError("A passing candidate should already have been returned")
        data.pop("selection", None)
        data.pop("accepted_for_delivery", None)
        candidates.append(data)
    index = max(range(3), key=lambda i: candidates[i]["anatomy_score"] * 0.7 + candidates[i]["compliance_score"] * 0.3)
    selected = {**candidates[index], "accepted_for_delivery": True,
                "selection": {"policy": "best-of-three-v1", "candidate_count": 3,
                              "selected_index": index, "candidates": candidates}}
    validate_delivery(selected, paths[index])
    receipt = Path(str(paths[index]) + ".quality.json")
    temporary = receipt.with_name(receipt.name + ".tmp")
    temporary.write_text(json.dumps(selected, ensure_ascii=False, allow_nan=False) + "\n")
    os.chmod(temporary, 0o600)
    temporary.replace(receipt)
    print(json.dumps({"image_path": str(paths[index]), "receipt_path": str(receipt), "score": selected["weighted_score"]}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("file", nargs="?")
    parser.add_argument("--expected-count", type=int, default=0)
    parser.add_argument("--envelope", action="store_true")
    parser.add_argument("--select-best")
    parser.add_argument("--delivery-image")
    args = parser.parse_args()
    try:
        if args.select_best:
            select_best(args.select_best)
            return
        data = json.loads(Path(args.file).read_text())
        if args.delivery_image:
            print(json.dumps(validate_delivery(data, args.delivery_image), ensure_ascii=False, allow_nan=False))
            return
        if args.envelope:
            data = extract_response(data)
        result = evaluate(data, args.expected_count)
        result["expected_count"] = args.expected_count
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    except (ValueError, TypeError, IndexError, KeyError, AttributeError, OSError):
        print("Invalid visual-verification evidence", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
