import { StoryMechanicsProfile } from "./api";

function nextRuleId(prefix: string, existing: string[]): string {
  let suffix = existing.length + 1;
  let candidate = `${prefix}-${suffix}`;
  while (existing.includes(candidate)) {
    suffix += 1;
    candidate = `${prefix}-${suffix}`;
  }
  return candidate;
}

function normalizeRuleId(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "");
}

export function defaultStoryMechanics(mode: StoryMechanicsProfile["mode"] = "d20"): StoryMechanicsProfile {
  return {
    mode,
    dice: { count: 1, sides: 20, resolution: "sum", success_threshold: null, include_attribute: true },
    difficulties: [
      { difficulty_id: "easy", label: "Easy", target: 8 },
      { difficulty_id: "standard", label: "Standard", target: 12 },
      { difficulty_id: "hard", label: "Hard", target: 16 },
      { difficulty_id: "very-hard", label: "Very hard", target: 20 },
    ],
    encounter_types: [
      { encounter_type: "combat", label: "Combat" },
      { encounter_type: "social", label: "Social" },
      { encounter_type: "exploration", label: "Exploration" },
      { encounter_type: "other", label: "Other" },
    ],
    skills: [],
    experience: { mode: "manual", starting_xp: 0, per_completed_turn: 0, allow_manual_awards: true, maximum_xp: 1_000_000 },
  };
}

export function readStoryMechanics(value: unknown, fallbackMode: StoryMechanicsProfile["mode"] = "d20"): StoryMechanicsProfile {
  const base = defaultStoryMechanics(fallbackMode);
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  const source = value as Partial<StoryMechanicsProfile>;
  const dice = source.dice && typeof source.dice === "object" ? source.dice : {};
  const experience = source.experience && typeof source.experience === "object" ? source.experience : {};
  return {
    ...base,
    ...source,
    dice: { ...base.dice, ...dice },
    difficulties: Array.isArray(source.difficulties) ? source.difficulties : base.difficulties,
    encounter_types: Array.isArray(source.encounter_types) ? source.encounter_types : base.encounter_types,
    skills: Array.isArray(source.skills) ? source.skills : base.skills,
    experience: { ...base.experience, ...experience },
  } as StoryMechanicsProfile;
}

export function StoryMechanicsEditor({
  value, stats, onChange,
}: {
  value: StoryMechanicsProfile;
  stats: string[];
  onChange: (next: StoryMechanicsProfile) => void;
}) {
  const updateDice = (changes: Partial<StoryMechanicsProfile["dice"]>) => onChange({ ...value, dice: { ...value.dice, ...changes } });
  const updateExperience = (changes: Partial<StoryMechanicsProfile["experience"]>) => onChange({ ...value, experience: { ...value.experience, ...changes } });
  const updateDifficulty = (index: number, changes: Partial<StoryMechanicsProfile["difficulties"][number]>) => onChange({
    ...value, difficulties: value.difficulties.map((item, itemIndex) => itemIndex === index ? { ...item, ...changes } : item),
  });
  const updateEncounter = (index: number, changes: Partial<StoryMechanicsProfile["encounter_types"][number]>) => onChange({
    ...value, encounter_types: value.encounter_types.map((item, itemIndex) => itemIndex === index ? { ...item, ...changes } : item),
  });
  const updateSkill = (index: number, changes: Partial<StoryMechanicsProfile["skills"][number]>) => onChange({
    ...value, skills: value.skills.map((item, itemIndex) => itemIndex === index ? { ...item, ...changes } : item),
  });

  return <details className="character-creation-rules story-mechanics-editor">
    <summary>Game mechanics · {value.mode.replaceAll("_", " ")}</summary>
    <p className="field-note">These rules are pinned to each new world version. Lorethra resolves all dice, skill bonuses, targets, and experience totals locally.</p>
    <label className="field-label">Resolution mode<select value={value.mode} onChange={(event) => {
      const mode = event.target.value as StoryMechanicsProfile["mode"];
      onChange({ ...value, mode, ...(mode === "d20" ? { dice: { count: 1, sides: 20, resolution: "sum" as const, success_threshold: null, include_attribute: true } } : {}) });
    }}>
      <option value="d20">Deterministic d20</option><option value="custom_dice">Custom dice</option>
      <option value="narrative_only">Narrative only</option><option value="hybrid">Hybrid · roll or narrate</option>
    </select></label>
    {value.mode !== "narrative_only" && <>
      <div className="character-creation-definition">
        <label className="field-label">Dice per check<input type="number" min={1} max={20} value={value.dice.count} disabled={value.mode === "d20"} onChange={(event) => updateDice({ count: Number(event.target.value) })} /></label>
        <label className="field-label">Sides per die<input type="number" min={2} max={100} value={value.dice.sides} disabled={value.mode === "d20"} onChange={(event) => {
          const sides = Number(event.target.value);
          updateDice({ sides, ...(value.dice.resolution === "success_count"
            ? { success_threshold: Math.min(value.dice.success_threshold || 1, sides) }
            : {}) });
        }} /></label>
        <label className="field-label">Dice resolution<select value={value.dice.resolution} disabled={value.mode === "d20"} onChange={(event) => updateDice({ resolution: event.target.value as StoryMechanicsProfile["dice"]["resolution"], success_threshold: event.target.value === "success_count" ? Math.max(1, value.dice.success_threshold || 5) : null })}>
          <option value="sum">Add all dice</option><option value="highest">Keep highest die</option><option value="success_count">Count successes</option>
        </select></label>
        {value.dice.resolution === "success_count" && <label className="field-label">Success on or above<input type="number" min={1} max={value.dice.sides} value={value.dice.success_threshold || 1} onChange={(event) => updateDice({ success_threshold: Number(event.target.value) })} /></label>}
      </div>
      {value.mode !== "d20" && <label className="control-choice"><input type="checkbox" checked={value.dice.include_attribute} onChange={(event) => updateDice({ include_attribute: event.target.checked })} /><span>Add the selected attribute to this roll</span></label>}
      <h4>Difficulty rules</h4>
      {value.difficulties.map((difficulty, index) => <div className="character-creation-definition" key={`${index}-${difficulty.difficulty_id}`}>
        <label className="field-label">Rule ID<input value={difficulty.difficulty_id} maxLength={60} onChange={(event) => updateDifficulty(index, { difficulty_id: normalizeRuleId(event.target.value) })} /></label>
        <label className="field-label">Display name<input value={difficulty.label} maxLength={80} onChange={(event) => updateDifficulty(index, { label: event.target.value })} /></label>
        <label className="field-label">Target<input type="number" min={1} max={2000} value={difficulty.target} onChange={(event) => updateDifficulty(index, { target: Number(event.target.value) })} /></label>
        <button type="button" className="link-button" disabled={value.difficulties.length <= 1} onClick={() => onChange({ ...value, difficulties: value.difficulties.filter((_, itemIndex) => itemIndex !== index) })}>Remove difficulty</button>
      </div>)}
      <button type="button" className="secondary-button" disabled={value.difficulties.length >= 20} onClick={() => {
        const id = nextRuleId("difficulty", value.difficulties.map((item) => item.difficulty_id));
        onChange({ ...value, difficulties: [...value.difficulties, { difficulty_id: id, label: `Difficulty ${value.difficulties.length + 1}`, target: 12 }] });
      }}>Add difficulty</button>
    </>}
    <h4>Encounter types</h4>
    <p className="field-note">Include social, exploration, or other noncombat scenes when your world uses them.</p>
    {value.encounter_types.map((encounter, index) => <div className="character-creation-definition" key={`${index}-${encounter.encounter_type}`}>
      <label className="field-label">Type ID<input value={encounter.encounter_type} maxLength={80} onChange={(event) => updateEncounter(index, { encounter_type: normalizeRuleId(event.target.value) })} /></label>
      <label className="field-label">Display name<input value={encounter.label} maxLength={100} onChange={(event) => updateEncounter(index, { label: event.target.value })} /></label>
      <button type="button" className="link-button" disabled={value.encounter_types.length <= 1} onClick={() => onChange({ ...value, encounter_types: value.encounter_types.filter((_, itemIndex) => itemIndex !== index) })}>Remove type</button>
    </div>)}
    <button type="button" className="secondary-button" disabled={value.encounter_types.length >= 20} onClick={() => {
      const id = nextRuleId("encounter", value.encounter_types.map((item) => item.encounter_type));
      onChange({ ...value, encounter_types: [...value.encounter_types, { encounter_type: id, label: `Encounter ${value.encounter_types.length + 1}` }] });
    }}>Add encounter type</button>
    <h4>Skills and proficiency</h4>
    {value.skills.map((skill, index) => <fieldset className="exceptional-ability-definition" key={`${index}-${skill.skill_id}`}>
      <legend>{skill.label || `Skill ${index + 1}`}</legend>
      <div className="character-creation-definition">
      <label className="field-label">Skill ID<input value={skill.skill_id} maxLength={80} onChange={(event) => updateSkill(index, { skill_id: normalizeRuleId(event.target.value) })} /></label>
        <label className="field-label">Display name<input value={skill.label} maxLength={100} onChange={(event) => updateSkill(index, { label: event.target.value })} /></label>
        <label className="field-label">Governing attribute<select value={skill.attribute || ""} onChange={(event) => updateSkill(index, { attribute: event.target.value || null })}>
          <option value="">None</option>{stats.map((stat) => <option key={stat} value={stat}>{stat}</option>)}
        </select></label>
        <label className="field-label">Starting rank<input type="number" min={0} max={20} value={skill.starting_rank} onChange={(event) => updateSkill(index, { starting_rank: Number(event.target.value) })} /></label>
        <label className="field-label">Maximum rank<input type="number" min={0} max={20} value={skill.max_rank} onChange={(event) => updateSkill(index, { max_rank: Number(event.target.value) })} /></label>
        <label className="field-label">Bonus per rank<input type="number" min={0} max={100} value={skill.rank_bonus} onChange={(event) => updateSkill(index, { rank_bonus: Number(event.target.value) })} /></label>
        <button type="button" className="link-button" onClick={() => onChange({ ...value, skills: value.skills.filter((_, itemIndex) => itemIndex !== index) })}>Remove skill</button>
      </div>
    </fieldset>)}
    <button type="button" className="secondary-button" disabled={value.skills.length >= 100} onClick={() => {
      const id = `skill_${value.skills.length + 1}`;
      onChange({ ...value, skills: [...value.skills, { skill_id: id, label: `Skill ${value.skills.length + 1}`, attribute: stats[0] || null, starting_rank: 0, max_rank: 5, rank_bonus: 1 }] });
    }}>Add skill</button>
    <h4>Experience</h4>
    <div className="character-creation-definition">
      <label className="field-label">Award mode<select value={value.experience.mode} onChange={(event) => {
        const mode = event.target.value as StoryMechanicsProfile["experience"]["mode"];
        updateExperience({ mode, per_completed_turn: mode === "manual" ? 0 : Math.max(1, value.experience.per_completed_turn), allow_manual_awards: mode !== "automatic" });
      }}><option value="manual">Manual awards</option><option value="automatic">Automatic per player turn</option><option value="hybrid">Automatic and manual</option></select></label>
      <label className="field-label">Starting XP<input type="number" min={0} max={1_000_000_000} value={value.experience.starting_xp} onChange={(event) => updateExperience({ starting_xp: Number(event.target.value) })} /></label>
      {value.experience.mode !== "manual" && <label className="field-label">XP per completed player turn<input type="number" min={1} max={1_000_000} value={value.experience.per_completed_turn} onChange={(event) => updateExperience({ per_completed_turn: Number(event.target.value) })} /></label>}
      <label className="field-label">Maximum XP<input type="number" min={0} max={1_000_000_000} value={value.experience.maximum_xp} onChange={(event) => updateExperience({ maximum_xp: Number(event.target.value) })} /></label>
    </div>
  </details>;
}
