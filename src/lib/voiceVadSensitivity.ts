import { createContext } from 'react';

export const DEFAULT_VAD_SENSITIVITY = 50;
export const MIN_VAD_SENSITIVITY = 0;
export const MAX_VAD_SENSITIVITY = 100;
export const VAD_SENSITIVITY_STEP = 5;

export const VoiceVadSensitivityContext = createContext(DEFAULT_VAD_SENSITIVITY);
