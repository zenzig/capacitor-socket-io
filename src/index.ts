import { registerPlugin } from '@capacitor/core';

import type { CapacitorSocketIOPlugin } from './definitions';

const CapacitorSocketIO = registerPlugin<CapacitorSocketIOPlugin>('CapacitorSocketIO', {
  web: () => import('./web').then((m) => new m.CapacitorSocketIOWeb()),
});

export * from './definitions';
export { CapacitorSocketIO };
