import type { PluginListenerHandle } from '@capacitor/core';

export interface SocketEventPayload {
  event: string;
  args: unknown[];
  id?: string;
}

export interface SocketIOConnectOptions {
  secure?: boolean;
  reconnection?: boolean;
  reconnectionAttempts?: number;
  timeout?: number;
  reconnectionDelay?: number;
  reconnectionDelayMax?: number;
  path?: string;
  query?: Record<string, string> | string;
  transports?: string[];
  allowSelfSigned?: boolean;
}

export interface ConnectOptions {
  url?: string;
  options?: SocketIOConnectOptions;
}

export interface EmitOptions {
  event: string;
  data?: Record<string, unknown>;
  args?: unknown[];
}

export interface ConnectResult {
  status: string;
  url: string;
}

export interface DisconnectResult {
  status: string;
}

export interface EmitResult {
  status: string;
  event: string;
}

export interface ListenResult {
  status: string;
  event: string;
}

export interface CapacitorSocketIOPlugin {
  connect(options?: ConnectOptions): Promise<ConnectResult>;
  disconnect(): Promise<DisconnectResult>;
  emit(options: EmitOptions): Promise<EmitResult>;
  on(options: { event: string }): Promise<ListenResult>;
  addListener(eventName: string, listenerFunc: (payload: SocketEventPayload) => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
