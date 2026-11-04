/** Voice estimates are in USD; keep their currency and precision explicit. */
export const formatUsd = (value: number): string => value > 0 && value < 0.0001 ? '< USD 0.0001' : `USD ${value.toFixed(4)}`;
