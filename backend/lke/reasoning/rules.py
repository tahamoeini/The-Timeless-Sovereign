"""Conservative three-valued evaluation for claim-backed rules."""

from __future__ import annotations

from typing import Any


def evaluate_rule(rule: dict[str, Any], claims: list[dict[str, Any]]) -> dict[str, Any]:
    """Evaluate one rule without treating missing or unreviewed data as false."""
    if rule["review_status"] != "accepted":
        return {
            "status": "unknown",
            "reason_code": "rule_not_accepted",
            "explanation": "This rule is not active until it is accepted.",
            "evidence_claim_ids": [],
            "uncertain_claim_ids": [],
            "unreviewed_claim_ids": [],
        }

    related = [
        claim for claim in claims
        if claim["subject_entity_id"] == rule["subject_entity_id"]
        and claim["predicate"] == rule["predicate"]
    ]
    reviewed = [claim for claim in related if claim["review_status"] == "accepted"]
    known = [claim for claim in reviewed if claim["epistemic_status"] == "known"]
    target = [claim for claim in known if claim["object_value"] == rule["object_value"]]
    alternatives = [claim for claim in known if claim["object_value"] != rule["object_value"]]
    uncertain = [claim for claim in reviewed if claim["epistemic_status"] != "known"]
    unreviewed = [claim for claim in related if claim["review_status"] == "proposed"]

    if rule["predicate_cardinality"] == "single" and target and alternatives:
        return _result(
            "unknown",
            "conflicting_known_values",
            "Accepted known claims give conflicting values for this single-valued property.",
            [claim["claim_id"] for claim in target + alternatives],
            [claim["claim_id"] for claim in uncertain],
            [claim["claim_id"] for claim in unreviewed],
        )

    if target:
        if rule["rule_mode"] == "require":
            return _result(
                "satisfied", "required_claim_known",
                "The required claim is accepted and recorded as known.",
                [claim["claim_id"] for claim in target],
                [claim["claim_id"] for claim in uncertain],
                [claim["claim_id"] for claim in unreviewed],
            )
        return _result(
            "violated", "forbidden_claim_known",
            "A forbidden claim is accepted and recorded as known.",
            [claim["claim_id"] for claim in target],
            [claim["claim_id"] for claim in uncertain],
            [claim["claim_id"] for claim in unreviewed],
        )

    if rule["predicate_cardinality"] == "single" and alternatives:
        distinct_values = {claim["object_value"] for claim in alternatives}
        if len(distinct_values) == 1:
            if rule["rule_mode"] == "require":
                return _result(
                    "violated", "different_known_value",
                    "A different value is accepted and known for this single-valued property.",
                    [claim["claim_id"] for claim in alternatives],
                    [claim["claim_id"] for claim in uncertain],
                    [claim["claim_id"] for claim in unreviewed],
                )
            return _result(
                "satisfied", "different_known_value",
                "A different value is accepted and known for this single-valued property.",
                [claim["claim_id"] for claim in alternatives],
                [claim["claim_id"] for claim in uncertain],
                [claim["claim_id"] for claim in unreviewed],
            )
        return _result(
            "unknown", "conflicting_known_values",
            "Accepted known claims give conflicting values for this single-valued property.",
            [claim["claim_id"] for claim in alternatives],
            [claim["claim_id"] for claim in uncertain],
            [claim["claim_id"] for claim in unreviewed],
        )

    if uncertain:
        explanation = "Related accepted claims are believed, contested, or marked unknown rather than known."
        reason_code = "claim_not_known"
    elif unreviewed:
        explanation = "A related proposal is awaiting review and cannot determine this rule."
        reason_code = "claim_not_reviewed"
    else:
        explanation = "The available records do not establish whether this rule is met."
        reason_code = "insufficient_evidence"
    return _result(
        "unknown", reason_code, explanation, [],
        [claim["claim_id"] for claim in uncertain],
        [claim["claim_id"] for claim in unreviewed],
    )


def _result(
    status: str,
    reason_code: str,
    explanation: str,
    evidence_claim_ids: list[str],
    uncertain_claim_ids: list[str],
    unreviewed_claim_ids: list[str],
) -> dict[str, Any]:
    return {
        "status": status,
        "reason_code": reason_code,
        "explanation": explanation,
        "evidence_claim_ids": sorted(set(evidence_claim_ids)),
        "uncertain_claim_ids": sorted(set(uncertain_claim_ids)),
        "unreviewed_claim_ids": sorted(set(unreviewed_claim_ids)),
    }
