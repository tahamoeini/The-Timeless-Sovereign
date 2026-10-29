export type CharacterCreationStat = {
  key: string;
  label: string;
  baseline: number;
  minimum: number;
  maximum: number;
  point_cost: number;
};

export function allocatedCreationPoints(
  definitions: CharacterCreationStat[],
  allocation: Record<string, number>,
): number {
  return definitions.reduce((total, stat) => {
    const value = allocation[stat.key] ?? stat.baseline;
    return total + (value - stat.baseline) * stat.point_cost;
  }, 0);
}

export function randomizeCharacterAllocation(
  definitions: CharacterCreationStat[],
  pointBudget: number,
  allowUnspentPoints: boolean,
): Record<string, number> | null {
  const reachable = Array.from({ length: definitions.length + 1 }, () => new Set<number>());
  reachable[definitions.length].add(0);

  for (let index = definitions.length - 1; index >= 0; index -= 1) {
    const stat = definitions[index];
    for (let value = stat.minimum; value <= stat.maximum; value += 1) {
      const cost = (value - stat.baseline) * stat.point_cost;
      for (const remainder of reachable[index + 1]) {
        reachable[index].add(cost + remainder);
      }
    }
  }

  const targets = [...reachable[0]].filter((points) => allowUnspentPoints ? points <= pointBudget : points === pointBudget);
  if (!targets.length) return null;
  const target = targets[randomIndex(targets.length)];
  let remaining = target;
  const allocation: Record<string, number> = {};
  for (let index = 0; index < definitions.length; index += 1) {
    const stat = definitions[index];
    const options: number[] = [];
    for (let value = stat.minimum; value <= stat.maximum; value += 1) {
      const cost = (value - stat.baseline) * stat.point_cost;
      if (reachable[index + 1].has(remaining - cost)) options.push(value);
    }
    if (!options.length) return null;
    const value = options[randomIndex(options.length)];
    allocation[stat.key] = value;
    remaining -= (value - stat.baseline) * stat.point_cost;
  }
  return remaining === 0 ? allocation : null;
}

function randomIndex(length: number): number {
  if (length <= 1) return 0;
  if (globalThis.crypto?.getRandomValues) {
    const value = new Uint32Array(1);
    globalThis.crypto.getRandomValues(value);
    return value[0] % length;
  }
  return Math.floor(Math.random() * length);
}
