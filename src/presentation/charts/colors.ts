/** Series slot to CSS colour. Slot 0 is the grey "Other" fold. */
export const seriesColor = (slot: number) => (slot > 0 ? `var(--color-series-${slot})` : 'var(--color-series-other)')
