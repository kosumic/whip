import { createContext } from 'react';

export const GlobalCallContext = createContext<() => void>(() => {});
