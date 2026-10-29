"""Compile a revision-bound, actor-aware context manifest."""

from __future__ import annotations

import json
from collections import defaultdict
from uuid import uuid4

from ..core.database import Database
from ..core.errors import NotFoundError, ValidationError


class ContextCompiler:
    """Read-only context builder; it never changes canonical records."""

    def __init__(self, database: Database) -> None:
        self.db = database

    def compile_actor_context(
        self,
        workspace_id: str,
        branch_id: str,
        actor_entity_id: str,
        *,
        as_of_narrative_order: int,
        token_budget: int = 4000,
    ) -> dict:
        """Include only reviewed facts this actor has explicitly encountered."""
        if not isinstance(as_of_narrative_order, int) or as_of_narrative_order < 0:
            raise ValidationError("as_of_narrative_order must be a non-negative integer")
        if not isinstance(token_budget, int) or token_budget < 64:
            raise ValidationError("token_budget must be at least 64")
        with self.db.lock:
            connection = self.db.connection
            branch = connection.execute(
                "SELECT head_revision FROM branches WHERE workspace_id=? AND branch_id=?",
                (workspace_id, branch_id),
            ).fetchone()
            if not branch:
                raise NotFoundError("Branch does not exist in this workspace")
            actor = connection.execute(
                "SELECT entity_id,label,entity_type FROM entities WHERE workspace_id=? AND branch_id=? AND entity_id=?",
                (workspace_id, branch_id, actor_entity_id),
            ).fetchone()
            if not actor:
                raise NotFoundError("Actor does not exist in this branch")
            claims = connection.execute(
                "SELECT claim_id,subject_entity_id,predicate,object_value,epistemic_status,review_status,visibility,narrative_order,evidence_json "
                "FROM claims WHERE workspace_id=? AND branch_id=? ORDER BY narrative_order,claim_id",
                (workspace_id, branch_id),
            ).fetchall()
            beliefs = connection.execute(
                "SELECT claim_id,stance,awareness_order FROM actor_beliefs "
                "WHERE workspace_id=? AND branch_id=? AND actor_entity_id=? ORDER BY awareness_order",
                (workspace_id, branch_id, actor_entity_id),
            ).fetchall()
            labels = {
                row["entity_id"]: row["label"]
                for row in connection.execute(
                    "SELECT entity_id,label FROM entities WHERE workspace_id=? AND branch_id=?",
                    (workspace_id, branch_id),
                ).fetchall()
            }
            head = int(branch["head_revision"])

        belief_by_claim: dict[str, list] = defaultdict(list)
        for belief in beliefs:
            belief_by_claim[belief["claim_id"]].append(belief)

        included, excluded = [], []
        used = len(actor["label"]) + 32
        for claim in claims:
            claim_id = claim["claim_id"]
            actor_beliefs = belief_by_claim.get(claim_id, [])
            eligible = [b for b in actor_beliefs if b["awareness_order"] <= as_of_narrative_order]
            if claim["review_status"] != "accepted":
                excluded.append({"claim_id": claim_id, "reason": "not_reviewed"})
                continue
            if claim["narrative_order"] > as_of_narrative_order:
                excluded.append({"claim_id": claim_id, "reason": "future_fact"})
                continue
            if claim["visibility"] == "author_only":
                excluded.append({"claim_id": claim_id, "reason": "author_only"})
                continue
            if not eligible:
                reason = "future_awareness" if actor_beliefs else "actor_unaware"
                excluded.append({"claim_id": claim_id, "reason": reason})
                continue
            latest_order = max(b["awareness_order"] for b in eligible)
            latest_stances = sorted({b["stance"] for b in eligible if b["awareness_order"] == latest_order})
            if latest_stances == ["unaware"]:
                excluded.append({"claim_id": claim_id, "reason": "actor_unaware"})
                continue
            item = {
                "claim_id": claim_id,
                "subject_entity_id": claim["subject_entity_id"],
                "subject": labels.get(claim["subject_entity_id"], ""),
                "predicate": claim["predicate"],
                "object": claim["object_value"],
                "epistemic_status": claim["epistemic_status"],
                "visibility": claim["visibility"],
                "actor_stance": latest_stances[0] if len(latest_stances) == 1 else "contested",
                "narrative_order": claim["narrative_order"],
                "awareness_order": latest_order,
                "evidence_ids": json.loads(claim["evidence_json"]),
            }
            estimate = max(1, (len(json.dumps(item, ensure_ascii=False)) + 3) // 4)
            if used + estimate > token_budget:
                excluded.append({"claim_id": claim_id, "reason": "token_budget"})
                continue
            used += estimate
            included.append(item)

        return {
            "protocol": "lke.context.v1",
            "manifest_id": str(uuid4()),
            "workspace_id": workspace_id,
            "branch_id": branch_id,
            "base_revision": head,
            "actor": {"entity_id": actor["entity_id"], "label": actor["label"], "entity_type": actor["entity_type"]},
            "as_of_narrative_order": as_of_narrative_order,
            "included": included,
            "excluded": excluded,
            "token_estimate": used,
        }
