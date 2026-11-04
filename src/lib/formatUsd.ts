/** Voice estimates are in USD; keep their currency and precision explicit. */
export const formatUsd = (value: number): string => `USD ${value.toFixed(4)}`;
