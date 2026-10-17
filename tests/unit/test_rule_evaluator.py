"""Deterministic, conservative evaluation of claim-backed rules."""

import unittest

from lke.reasoning import evaluate_rule


def rule(**updates):
    value = {
        "rule_id": "rule-1",
        "review_status": "accepted",
        "rule_mode": "require",
        "subject_entity_id": "aria",
        "predicate": "current city",
        "object_value": "Paris",
        "predicate_cardinality": "single",
    }
    value.update(updates)
    return value


def claim(claim_id, value, *, epistemic="known", review="accepted", visibility="public", subject="aria", predicate="current city"):
    return {
        "claim_id": claim_id,
        "subject_entity_id": subject,
        "predicate": predicate,
        "object_value": value,
        "epistemic_status": epistemic,
        "review_status": review,
        "visibility": visibility,
    }


class RuleEvaluatorTests(unittest.TestCase):
    def test_required_known_claim_is_satisfied_and_forbidden_claim_is_violated(self):
        claims = [claim("paris", "Paris")]

        required = evaluate_rule(rule(), claims)
        forbidden = evaluate_rule(rule(rule_mode="forbid"), claims)

        self.assertEqual(required["status"], "satisfied")
        self.assertEqual(required["evidence_claim_ids"], ["paris"])
        self.assertEqual(forbidden["status"], "violated")

    def test_single_value_alternative_can_prove_the_condition_only_when_declared(self):
        claims = [claim("london", "London")]

        required = evaluate_rule(rule(), claims)
        forbidden = evaluate_rule(rule(rule_mode="forbid"), claims)
        multiple = evaluate_rule(rule(predicate_cardinality="multiple"), claims)

        self.assertEqual(required["status"], "violated")
        self.assertEqual(forbidden["status"], "satisfied")
        self.assertEqual(multiple["status"], "unknown")

    def test_conflicting_known_values_remain_unknown(self):
        result = evaluate_rule(rule(), [claim("paris", "Paris"), claim("london", "London")])

        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["reason_code"], "conflicting_known_values")
        self.assertEqual(result["evidence_claim_ids"], ["london", "paris"])

    def test_missing_unreviewed_or_uncertain_claims_do_not_become_false(self):
        missing = evaluate_rule(rule(), [])
        proposal = evaluate_rule(rule(), [claim("proposal", "Paris", review="proposed")])
        believed = evaluate_rule(rule(), [claim("belief", "Paris", epistemic="believed")])

        self.assertEqual(missing["status"], "unknown")
        self.assertEqual(proposal["status"], "unknown")
        self.assertEqual(proposal["unreviewed_claim_ids"], ["proposal"])
        self.assertEqual(believed["status"], "unknown")
        self.assertEqual(believed["uncertain_claim_ids"], ["belief"])

    def test_unreviewed_rule_is_not_active(self):
        result = evaluate_rule(rule(review_status="proposed"), [claim("paris", "Paris")])

        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["reason_code"], "rule_not_accepted")
        self.assertEqual(result["evidence_claim_ids"], [])

    def test_private_claims_do_not_affect_workspace_rule_evaluation(self):
        result = evaluate_rule(rule(), [claim("private-paris", "Paris", visibility="author_only")])

        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["evidence_claim_ids"], [])


if __name__ == "__main__":
    unittest.main()
