import { registerPlugin } from '@capacitor/core';

import type { CapacitorSocketIOPlugin } from './definitions';

/**
 * Runtime accessor for the Capacitor Socket.IO bridge across native and web layers.
 */
const CapacitorSocketIO = registerPlugin<CapacitorSocketIOPlugin>('CapacitorSocketIO', {
  web: () => import('./web').then((m) => new m.CapacitorSocketIOWeb()),
});

export * from './definitions';
export { CapacitorSocketIO };
