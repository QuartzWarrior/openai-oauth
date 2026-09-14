/** Weighted load: inflight per unit of account weight (weight >= 1). */
export const weightedLoad = (inflight: number, weight: number): number =>
	inflight / Math.max(1, weight)
