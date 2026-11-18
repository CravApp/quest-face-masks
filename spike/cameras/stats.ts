/** Empareja cada marca izquierda con la derecha más cercana, sin reutilizar, dentro de maxDelta. */
export function pairNearest(
  left: number[],
  right: number[],
  maxDelta: number,
): { deltas: number[]; unmatchedLeft: number; unmatchedRight: number } {
  const leftSorted = [...left].sort((a, b) => a - b);
  const rightSorted = [...right].sort((a, b) => a - b);
  const used = new Array<boolean>(rightSorted.length).fill(false);
  const deltas: number[] = [];
  let start = 0;
  for (const leftTime of leftSorted) {
    while (start < rightSorted.length && rightSorted[start] < leftTime - maxDelta) start++;
    let best = -1;
    let bestAbs = Infinity;
    for (let index = start; index < rightSorted.length; index++) {
      const diff = rightSorted[index] - leftTime;
      if (diff > maxDelta) break;
      if (used[index]) continue;
      const abs = Math.abs(diff);
      if (abs < bestAbs) {
        bestAbs = abs;
        best = index;
      }
    }
    if (best >= 0) {
      used[best] = true;
      deltas.push(rightSorted[best] - leftTime);
    }
  }
  return {
    deltas,
    unmatchedLeft: leftSorted.length - deltas.length,
    unmatchedRight: rightSorted.length - deltas.length,
  };
}

export interface DeltaStats {
  pairs: number;
  unmatchedLeft: number;
  unmatchedRight: number;
  /** Mediana de (derecha − izquierda), con signo, en ms. */
  medianMs: number | null;
  /** Percentil 95 de (derecha − izquierda), con signo, en ms. */
  p95SignedMs: number | null;
  /** Percentil 95 del valor absoluto, en ms. */
  p95AbsMs: number | null;
  meanMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  /** Porcentaje de pares con |Δ| < 1 ms. */
  pctAbsUnder1Ms: number | null;
  buckets: { label: string; count: number }[];
}

export function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - pos) + sorted[hi] * (pos - lo);
}

const ABS_BUCKETS: { max: number; label: string }[] = [
  { max: 0.1, label: '< 0,1 ms' },
  { max: 1, label: '< 1 ms' },
  { max: 2, label: '< 2 ms' },
  { max: 8, label: '< 8 ms' },
  { max: 17, label: '< 17 ms' },
  { max: 34, label: '< 34 ms' },
  { max: Infinity, label: '≥ 34 ms' },
];

export function summarizeDeltas(deltas: number[], unmatchedLeft: number, unmatchedRight: number): DeltaStats {
  const signed = [...deltas].sort((a, b) => a - b);
  const abs = deltas.map((value) => Math.abs(value)).sort((a, b) => a - b);
  const under1 = deltas.filter((value) => Math.abs(value) < 1).length;
  let lower = 0;
  const buckets = ABS_BUCKETS.map((bucket) => {
    const count = abs.filter((value) => value >= lower && value < bucket.max).length;
    lower = bucket.max;
    return { label: bucket.label, count };
  });
  return {
    pairs: deltas.length,
    unmatchedLeft,
    unmatchedRight,
    medianMs: quantile(signed, 0.5),
    p95SignedMs: quantile(signed, 0.95),
    p95AbsMs: quantile(abs, 0.95),
    meanMs: deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : null,
    minMs: signed[0] ?? null,
    maxMs: signed[signed.length - 1] ?? null,
    pctAbsUnder1Ms: deltas.length ? (100 * under1) / deltas.length : null,
    buckets,
  };
}

function shiftToZero(values: number[]): number[] {
  if (!values.length) return [];
  const origin = values.reduce((min, value) => Math.min(min, value), Infinity);
  return values.map((value) => value - origin);
}

export interface SeriesPair {
  /** Emparejado en el reloj tal cual. Sirve si las dos series comparten origen. */
  nearest: DeltaStats;
  /** Resta el primer instante de cada serie. Sirve si los orígenes no coinciden. */
  relativeToFirstFrame: DeltaStats;
}

export function pairSeries(left: number[], right: number[], maxDelta = 50): SeriesPair {
  const raw = pairNearest(left, right, maxDelta);
  const relative = pairNearest(shiftToZero(left), shiftToZero(right), maxDelta);
  return {
    nearest: summarizeDeltas(raw.deltas, raw.unmatchedLeft, raw.unmatchedRight),
    relativeToFirstFrame: summarizeDeltas(relative.deltas, relative.unmatchedLeft, relative.unmatchedRight),
  };
}

export function matchRate(stats: DeltaStats, leftCount: number, rightCount: number): number {
  const denom = Math.min(leftCount, rightCount);
  return denom ? stats.pairs / denom : 0;
}
