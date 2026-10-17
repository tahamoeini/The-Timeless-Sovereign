"""Conservative three-valued evaluation for baseline facts and scenario overlays."""

from __future__ import annotations

from typing import Any


def evaluate_rule(
    rule: dict[str, Any],
    claims: list[dict[str, Any]],
    assumptions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Evaluate one rule, keeping hypothetical assumptions separate from claim evidence."""
    if rule["review_status"] != "accepted":
        return _result(
            "unknown", "rule_not_accepted", "This rule is not active until it is accepted.",
            [], [], [], [],
        )

    related_claims = [
        claim for claim in claims
        if claim["subject_entity_id"] == rule["subject_entity_id"]
        and claim["predicate"] == rule["predicate"]
        and claim.get("visibility", "public") == "public"
    ]
    related_assumptions = [
        assumption for assumption in assumptions or []
        if assumption["review_status"] in {"accepted", "proposed"}
        and assumption["subject_entity_id"] == rule["subject_entity_id"]
        and assumption["predicate"] == rule["predicate"]
    ]
    accepted_assumptions = [
        assumption for assumption in related_assumptions
        if assumption["review_status"] == "accepted"
    ]
    replacements = [
        assumption for assumption in accepted_assumptions
        if assumption["assumption_action"] == "replace"
    ]
    if replacements:
        related_claims = []
        accepted_assumptions = replacements

    reviewed = [claim for claim in related_claims if claim["review_status"] == "accepted"]
    known_claims = [claim for claim in reviewed if claim["epistemic_status"] == "known"]
    uncertain = [claim for claim in reviewed if claim["epistemic_status"] != "known"]
    unreviewed = [claim for claim in related_claims if claim["review_status"] == "proposed"]
    proposed_assumptions = [
        assumption for assumption in related_assumptions
        if assumption["review_status"] == "proposed"
    ]
    known_values = [
        ("claim", claim["claim_id"], claim["object_value"]) for claim in known_claims
    ] + [
        ("assumption", assumption["assumption_id"], assumption["object_value"])
        for assumption in accepted_assumptions
    ]
    target = [entry for entry in known_values if entry[2] == rule["object_value"]]
    alternatives = [entry for entry in known_values if entry[2] != rule["object_value"]]
    uncertain_ids = [claim["claim_id"] for claim in uncertain]
    unreviewed_ids = [claim["claim_id"] for claim in unreviewed]
    proposed_assumption_ids = [assumption["assumption_id"] for assumption in proposed_assumptions]

    if rule["predicate_cardinality"] == "single" and target and alternatives:
        return _result(
            "unknown", "conflicting_known_values",
            "Accepted known records give conflicting values for this single-valued property.",
            target + alternatives, uncertain_ids, unreviewed_ids, proposed_assumption_ids,
        )

    if target:
        if rule["rule_mode"] == "require":
            return _result(
                "satisfied", "required_claim_known",
                "The required value is established in the baseline or under this option's accepted assumptions.",
                target, uncertain_ids, unreviewed_ids, proposed_assumption_ids,
            )
        return _result(
            "violated", "forbidden_claim_known",
            "A forbidden value is established in the baseline or under this option's accepted assumptions.",
            target, uncertain_ids, unreviewed_ids, proposed_assumption_ids,
        )

    if rule["predicate_cardinality"] == "single" and alternatives:
        distinct_values = {entry[2] for entry in alternatives}
        if len(distinct_values) == 1:
            if rule["rule_mode"] == "require":
                return _result(
                    "violated", "different_known_value",
                    "A different value is established for this single-valued property.",
                    alternatives, uncertain_ids, unreviewed_ids, proposed_assumption_ids,
                )
            return _result(
                "satisfied", "different_known_value",
                "A different value is established for this single-valued property.",
                alternatives, uncertain_ids, unreviewed_ids, proposed_assumption_ids,
            )
        return _result(
            "unknown", "conflicting_known_values",
            "Accepted known records give conflicting values for this single-valued property.",
            alternatives, uncertain_ids, unreviewed_ids, proposed_assumption_ids,
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
        "unknown", reason_code, explanation, [], uncertain_ids, unreviewed_ids,
        proposed_assumption_ids,
    )


def _result(
    status: str,
    reason_code: str,
    explanation: str,
    evidence: list[tuple[str, str, str]],
    uncertain_claim_ids: list[str],
    unreviewed_claim_ids: list[str],
    unreviewed_assumption_ids: list[str],
) -> dict[str, Any]:
    claim_ids = sorted({record_id for kind, record_id, _ in evidence if kind == "claim"})
    assumption_ids = sorted({record_id for kind, record_id, _ in evidence if kind == "assumption"})
    return {
        "status": status,
        "reason_code": reason_code,
        "explanation": explanation,
        "conditional": bool(assumption_ids),
        "evidence_claim_ids": claim_ids,
        "assumption_ids": assumption_ids,
        "uncertain_claim_ids": sorted(set(uncertain_claim_ids)),
        "unreviewed_claim_ids": sorted(set(unreviewed_claim_ids)),
        "unreviewed_assumption_ids": sorted(set(unreviewed_assumption_ids)),
    }
