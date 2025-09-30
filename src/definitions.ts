export interface CapacitorSocketIOPlugin {
  echo(options: { value: string }): Promise<{ value: string }>;
}
