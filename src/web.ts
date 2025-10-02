import { WebPlugin, type PluginListenerHandle } from '@capacitor/core';
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';

import type {
  CapacitorSocketIOPlugin,
  ConnectOptions,
  ConnectResult,
  EmitOptions,
  EmitResult,
  ListenResult,
  SocketEventPayload,
  SocketIOConnectOptions,
} from './definitions';

const DEFAULT_URL = 'https://socket-proxy.local/';
const CORE_EVENTS = [
  'connect',
  'disconnect',
  'connect_error',
  'error',
  'message',
  'reconnect',
  'reconnect_attempt',
  'reconnect_error',
  'reconnect_failed',
  'reconnecting',
  'ping',
  'pong',
];

const isProductionEnvironment = (): boolean => {
  if (typeof process !== 'undefined' && typeof process.env?.NODE_ENV === 'string') {
    return process.env.NODE_ENV === 'production';
  }

  try {
    const meta = import.meta as { env?: Record<string, string> };
    if (typeof meta.env?.MODE === 'string') {
      return meta.env.MODE === 'production';
    }
  } catch (error) {
    // Accessing import.meta may throw in certain bundlers; ignore for environment detection.
  }

  return false;
};

export class CapacitorSocketIOWeb extends WebPlugin implements CapacitorSocketIOPlugin {
  private socket?: Socket;
  private requestedEvents = new Set<string>();
  private attachedEvents = new Set<string>();

  async connect(options?: ConnectOptions): Promise<ConnectResult> {
    const targetUrl = options?.url ?? DEFAULT_URL;

    this.disconnectInternal();

    const normalisedOptions = this.buildOptions(targetUrl, options?.options);
    this.socket = io(targetUrl, normalisedOptions);

    this.attachCoreListeners();
    this.attachDynamicListeners();

    return { status: 'connecting', url: targetUrl };
  }

  async disconnect(): Promise<{ status: string }> {
    this.disconnectInternal();
    return { status: 'disconnected' };
  }

  async emit(options: EmitOptions): Promise<EmitResult> {
    const socket = this.requireSocket();
    const payload = this.buildEmitPayload(options);
    socket.emit(options.event, ...payload);
    return { status: 'emitted', event: options.event };
  }

  async on({ event }: { event: string }): Promise<ListenResult> {
    const trimmedEvent = event?.trim();
    if (!trimmedEvent) {
      throw new Error('Event name is required');
    }

    this.requestedEvents.add(trimmedEvent);
    this.attachDynamicListener(trimmedEvent);
    return { status: 'listening', event: trimmedEvent };
  }

  async addListener<T extends SocketEventPayload>(
    eventName: string,
    listenerFunc: (event: T) => void,
  ): Promise<PluginListenerHandle> {
    return super.addListener(eventName, listenerFunc);
  }

  private attachCoreListeners(): void {
    if (!this.socket) {
      return;
    }

    CORE_EVENTS.forEach((event) => this.attachListener(event));
  }

  private attachDynamicListeners(): void {
    Array.from(this.requestedEvents).forEach((event) => this.attachDynamicListener(event));
  }

  private attachDynamicListener(event: string): void {
    this.attachListener(event);
  }

  private attachListener(event: string): void {
    const socket = this.socket;
    if (!socket || this.attachedEvents.has(event)) {
      return;
    }

    socket.on(event, (...args: unknown[]) => this.dispatchEvent(event, args));
    this.attachedEvents.add(event);
  }

  private dispatchEvent(event: string, args: unknown[]): void {
    const payload: SocketEventPayload = {
      event,
      args: this.serialiseArgs(args),
    };

    if (event === 'connect' && this.socket) {
      payload.id = this.socket.id;
    }

    this.notifyListeners(event, payload);
  }

  private serialiseArgs(args: unknown[]): unknown[] {
    return args.map((arg) => {
      if (arg instanceof Error) {
        return {
          message: arg.message,
          name: arg.name,
          stack: arg.stack,
        };
      }

      if (arg instanceof ArrayBuffer) {
        return Array.from(new Uint8Array(arg));
      }

      return arg;
    });
  }

  private buildEmitPayload(options: EmitOptions): unknown[] {
    if (options.args && options.args.length > 0) {
      return options.args;
    }

    if (options.data) {
      return [options.data];
    }

    return [];
  }

  private buildOptions(url: string, options?: SocketIOConnectOptions): Partial<ManagerOptions & SocketOptions> {
    const opts: Partial<ManagerOptions & SocketOptions> = {
      forceNew: true,
      secure: url.startsWith('https'),
    };

    if (!options) {
      return opts;
    }

    if (typeof options.secure === 'boolean') {
      opts.secure = options.secure;
    }
    if (typeof options.reconnection === 'boolean') {
      opts.reconnection = options.reconnection;
    }
    if (typeof options.reconnectionAttempts === 'number') {
      opts.reconnectionAttempts = options.reconnectionAttempts;
    }
    if (typeof options.timeout === 'number') {
      opts.timeout = options.timeout;
    }
    if (typeof options.reconnectionDelay === 'number') {
      opts.reconnectionDelay = options.reconnectionDelay;
    }
    if (typeof options.reconnectionDelayMax === 'number') {
      opts.reconnectionDelayMax = options.reconnectionDelayMax;
    }
    if (options.path) {
      opts.path = options.path;
    }
    if ((options.transports?.length ?? 0) > 0) {
      opts.transports = options.transports;
    }
    if (options.query) {
      const queryValue = typeof options.query === 'string' ? options.query : this.toQueryString(options.query);
      opts.query = queryValue as unknown as ManagerOptions['query'];
    }
    if (options.allowSelfSigned) {
      this.assertSelfSignedAllowed();
      opts.rejectUnauthorized = false;
    }

    return opts;
  }

  private toQueryString(query: Record<string, string>): string {
    return Object.entries(query)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');
  }

  private disconnectInternal(): void {
    if (!this.socket) {
      return;
    }

    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.socket.close();
    this.socket = undefined;
    this.attachedEvents.clear();
  }

  private requireSocket(): Socket {
    if (!this.socket) {
      throw new Error('Socket is not connected. Call connect() first.');
    }

    return this.socket;
  }

  private assertSelfSignedAllowed(): void {
    if (isProductionEnvironment()) {
      throw new Error(
        'allowSelfSigned is disabled in production builds. Configure trusted certificates or pinning instead.',
      );
    }
  }
}
