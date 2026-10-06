export interface HLC {
  wall: number;
  logical: number;
  actor: string;
}

export function hlcCompare(a: HLC, b: HLC): number {
  if (a.wall !== b.wall) return a.wall - b.wall;
  if (a.logical !== b.logical) return a.logical - b.logical;
  return a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0;
}

export function hlcTick(now: number, prev: HLC | null, actor: string): HLC {
  if (prev === null) return { wall: now, logical: 0, actor };
  if (prev.actor !== actor) return { wall: now, logical: 0, actor };
  if (now > prev.wall) return { wall: now, logical: 0, actor };
  return { wall: prev.wall, logical: prev.logical + 1, actor };
}

export function hlcUpdate(now: number, local: HLC, remote: HLC): HLC {
  const max = Math.max(now, local.wall, remote.wall);
  if (max === local.wall && max === remote.wall) {
    return {
      wall: max,
      logical: Math.max(local.logical, remote.logical) + 1,
      actor: local.actor,
    };
  }
  if (max === local.wall)
    return { wall: max, logical: local.logical + 1, actor: local.actor };
  if (max === remote.wall)
    return { wall: max, logical: remote.logical + 1, actor: local.actor };
  return { wall: max, logical: 0, actor: local.actor };
}
