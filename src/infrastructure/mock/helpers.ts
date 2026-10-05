/** Rounds to a multiple of `step`; steps below 1 round to cents without float noise. */
export const round = (value: number, step = 1) =>
  step < 1 ? Math.round(value * 100) / 100 : Math.round(value / step) * step

/** Resolves after `ms`, standing in for network latency. */
export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
