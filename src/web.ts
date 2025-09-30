import { WebPlugin } from '@capacitor/core';

import type { CapacitorSocketIOPlugin } from './definitions';

export class CapacitorSocketIOWeb extends WebPlugin implements CapacitorSocketIOPlugin {
  async echo(options: { value: string }): Promise<{ value: string }> {
    console.log('ECHO', options);
    return options;
  }
}
