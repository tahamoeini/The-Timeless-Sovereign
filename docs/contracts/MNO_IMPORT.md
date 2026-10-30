# MNO RPG Engine import contract

Status: implemented for `.mno-world` v1 and `.mno-adv` v2. Import preview is read-only; committing an import creates a duplicate world or isolated adventure through the existing command gateway. This contract describes compatibility, not full parity with MNO.

## User flow

1. Preview and import the `.mno-world` file as a new Lorethra world. The preview shows its title, NSFW source warning, stat/tracker/lore/cast counts, source ID, and conversion notes.
2. Preview the matching `.mno-adv` file after the MNO world has been imported. Matching uses the source world ID. A mismatch or missing world is rejected before any write.
3. Inspect the adventure summary and import it as an isolated adventure. Lorethra keeps the source adventure locally for recovery and faithful re-export. Adventure simulation remains off even if the source setting enabled it.
4. Add only the MNO world-cast NPC templates wanted in the adventure. The user action creates the NPC identity/profile atomically. A supported embedded portrait is attached as a local image asset.

## Data mapping

| MNO data | Lorethra representation |
|---|---|
| World lorebook and narrative style | Full original world source is preserved under the immutable world-version content. The world editor provides a searchable, paged list where each valid entry can be always included, keyword matched, or disabled; keywords can be revised independently. Overrides are stored under `mno_import.lorebook_rules` by preserved source index in the next immutable world version. Up to four always entries and four keyword matches are supplied to local story context within 12,000 characters. The saved turn context shows selected entries and excluded counts. Lore remains narrator reference, not evidence of what the protagonist knows; hosted-provider requests omit it. Public world/shareable adventure exports omit the preserved source and overrides; full-private packages retain them and surface them in the export review. |
| Protagonist profile fields | Age, gender, race, appearance, job, persona, extra details, and background are preserved as bounded character-profile fields. Reusable heroes expose them in setup; an imported adventure protagonist exposes them in the active adventure's collapsed Hero identity panel. Editing the adventure actor writes only to that branch snapshot and leaves the main reusable identity and sibling adventures unchanged. The profile is available to local story context; hosted-provider requests omit it. Browser acceptance remains open. |
| Stat definitions and base scores | Stat modifiers use Lorethra's stated conversion `floor((score - averageThreshold) / 2) * modStep`, clamped to `-10..10`. Original definitions and scores remain in the preserved source/profile. MNO formulas and scripts are text only and are never run. |
| Checks and experience | MNO formulas, check settings, and rewards remain preserved source text. New play uses Lorethra's pinned d20 rules, with automatic local rolls and one XP per completed player turn; it does not reproduce MNO's formulas, random-number generation, or reward logic. No manual XP award is required. Existing Lorethra worlds and adventures keep their already-pinned rules. |
| Numeric trackers | Initialized on the adventure sheet with bounded values and maxima. Text trackers are preserved in the source; location initializes the sheet and quest initializes an open thread. |
| `action`, `narrator`, `npc`, `check`, `thought`, `meta` messages | All transcript entries and ordering are retained. Player actions become user turns; other roles become assistant turns with source-role metadata. NPC and narrator turns receive clear speaker labels. Check prose is retained as prose; it is not converted into a verified die result. |
| Inner thoughts and meta messages | Preserved in the local source archive and visible as collapsed author-only transcript content. They are excluded from future model history and the default reader/print view. |
| NPC profiles, secrets, trackers and life fields | Encounter NPCs become profiles. Secrets, relationship trackers, and private-life history remain in author-only profile data. World NPC templates stay available in a collapsed cast list and enter an adventure only after the user chooses them. |
| Map POIs and hero position | Approved locations retain name, type, description, icon and coordinates. The map shows a schematic with an accessible location list. Player-selected travel updates the current location and coordinates through the gateway. |
| Manual/automatic memories and situation | Manual notes remain author-scoped. Automatic event memories and situation drafts require review. No imported prose silently becomes an accepted event fact. |
| Embedded PNG/JPEG/WebP portraits | Validated local character assets with MNO provenance. Unsupported or malformed image data is rejected. |

## Privacy and integrity

- Canonical rows are created only by `CommandGateway`, with workspace/branch checks, expected revisions, idempotency and audit history.
- The source adventure archive is size-bounded and immutable after import. It is not included in generation context.
- Credential-like keys are rejected from imported packages. Imported prompts, formulas, lore, and scripts are untrusted text; nothing from the files is executed.
- Lorebook overrides are validated against source indexes, bounded to 1,000 entries and 50 keywords per entry, and saved through the revisioned world command. Existing adventures remain pinned to their original world version.
- Existing `.lke-world` and `.lke-adventure` validation and import behavior remains available. MNO files are converted to those package contracts before commit.
- Preview does not write canonical data. Duplicate IDs are remapped by the existing adventure package import flow.

## Limits and verification

Only MNO world v1 and adventure v2 are accepted. Lorethra applies its own d20 checks with locally generated dice and deterministic gateway arithmetic; it does not emulate MNO formulas or infer dice from old narration. Newly imported MNO worlds pin automatic checks and one XP per completed turn for future play. Only numeric trackers become live sheet trackers. World-cast templates are opt-in, NPC simulation is always disabled on import, and MNO's original provider settings are never activated. Community features, image generation, arbitrary formula scripting and live MNO gameplay are outside this adapter.

Focused API tests cover preview without writes, version and credential rejection, role/context filtering, package import/export, source-archive immutability, map coordinates, author-only NPC data and schema limits. The supplied world was imported through the gateway; its paired adventure was converted, previewed and imported through authenticated ASGI into an in-memory database: 7 stats, 9 trackers, 15 world-cast templates, 85 turns, 7 map places, 2 images, and 8 author-only thoughts/meta messages. A real browser import, live model session, and Windows desktop interaction remain separate acceptance gates.
