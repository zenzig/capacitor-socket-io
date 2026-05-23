import { WebPlugin, type PluginListenerHandle } from '@capacitor/core';
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';

import type {
  CapacitorSocketIOPlugin,
  ConnectOptions,
  ConnectResult,
  DrainBufferedEventsOptions,
  DrainBufferedEventsResult,
  EmitOptions,
  EmitResult,
  ForegroundServiceStatusResult,
  ListenResult,
  SocketEventPayload,
  SocketIOConnectOptions,
} from './definitions';

/** Default HTTPS endpoint used when no URL override is provided. */
const DEFAULT_URL = 'https://socket-proxy.local/';

/** Core Socket.IO lifecycle events automatically bridged to Capacitor listeners. */
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

/**
 * Detects whether the current runtime should be treated as a production build.
 *
 * @returns True when production heuristics are satisfied.
 */
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

/**
 * Web implementation of the Capacitor Socket.IO plugin mirroring native behaviour.
 */
export class CapacitorSocketIOWeb extends WebPlugin implements CapacitorSocketIOPlugin {
  private socket?: Socket;
  private requestedEvents = new Set<string>();
  private attachedEvents = new Set<string>();

  /**
   * Initiates a Socket.IO connection and sets up listener scaffolding.
   *
   * @param options - Connection parameters including the target URL and client overrides.
   * @returns Connection status metadata describing the target endpoint.
   */
  async connect(options?: ConnectOptions): Promise<ConnectResult> {
    const targetUrl = options?.url ?? DEFAULT_URL;

    this.disconnectInternal();

    const normalisedOptions = this.buildOptions(targetUrl, options?.options);
    this.socket = io(targetUrl, normalisedOptions);

    this.attachCoreListeners();
    this.attachDynamicListeners();

    return { status: 'connecting', url: targetUrl };
  }

  /**
   * Disconnects the current Socket.IO connection if one exists.
   *
   * @returns Disconnection result including the resulting status string.
   */
  async disconnect(): Promise<{ status: string }> {
    this.disconnectInternal();
    return { status: 'disconnected' };
  }

  /**
   * Emits an event to the connected Socket.IO server.
   *
   * @param options - Event descriptor including the event name and payload.
   * @returns Metadata confirming the emit request.
   */
  async emit(options: EmitOptions): Promise<EmitResult> {
    const socket = this.requireSocket();
    const payload = this.buildEmitPayload(options);
    socket.emit(options.event, ...payload);
    return { status: 'emitted', event: options.event };
  }

  /**
   * Subscribes to an event before listeners are registered by the Capacitor bridge.
   *
   * @param options - Event descriptor containing the Socket.IO event name.
   * @returns Status metadata confirming that the event is now tracked.
   * @throws {Error} When the provided event name is empty.
   */
  async on({ event }: { event: string }): Promise<ListenResult> {
    const trimmedEvent = event?.trim();
    if (!trimmedEvent) {
      throw new Error('Event name is required');
    }

    this.requestedEvents.add(trimmedEvent);
    this.attachDynamicListener(trimmedEvent);
    return { status: 'listening', event: trimmedEvent };
  }

  /**
   * Web has no native foreground buffer; this mirrors the native API as a no-op.
   */
  async drainBufferedEvents(_options?: DrainBufferedEventsOptions): Promise<DrainBufferedEventsResult> {
    return { events: [] };
  }

  /**
   * Web has no Android foreground service.
   */
  async isForegroundServiceRunning(): Promise<ForegroundServiceStatusResult> {
    return { running: false };
  }

  /**
   * Web has no Android foreground service to stop.
   */
  async stopForegroundService(): Promise<ForegroundServiceStatusResult> {
    return { running: false };
  }

  /**
   * Proxies the Capacitor listener registration hook for Socket.IO events.
   *
   * @param eventName - Event name requested by consumers.
   * @param listenerFunc - Callback invoked whenever the event fires.
   * @returns Plugin listener handle for later disposal.
   */
  async addListener<T extends SocketEventPayload>(
    eventName: string,
    listenerFunc: (event: T) => void,
  ): Promise<PluginListenerHandle> {
    return super.addListener(eventName, listenerFunc);
  }

  /**
   * Attaches listeners for core Socket.IO lifecycle events.
   */
  private attachCoreListeners(): void {
    if (!this.socket) {
      return;
    }

    CORE_EVENTS.forEach((event) => this.attachListener(event));
  }

  /**
   * Re-attaches any event listeners requested before a socket reconnect.
   */
  private attachDynamicListeners(): void {
    Array.from(this.requestedEvents).forEach((event) => this.attachDynamicListener(event));
  }

  /**
   * Attaches a listener for the provided event if it is not already registered.
   *
   * @param event - Socket.IO event name.
   */
  private attachDynamicListener(event: string): void {
    this.attachListener(event);
  }

  /**
   * Registers a Socket.IO listener and proxies results through the Capacitor event system.
   *
   * @param event - Event name to observe.
   */
  private attachListener(event: string): void {
    const socket = this.socket;
    if (!socket || this.attachedEvents.has(event)) {
      return;
    }

    socket.on(event, (...args: unknown[]) => this.dispatchEvent(event, args));
    this.attachedEvents.add(event);
  }

  /**
   * Dispatches a normalised event payload through the Capacitor listener registry.
   *
   * @param event - Event being dispatched.
   * @param args - Raw arguments received from the Socket.IO client.
   */
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

  /**
   * Serialises Socket.IO arguments into transport-safe structures.
   *
   * @param args - Raw event arguments.
   * @returns Array of serialised arguments.
   */
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

  /**
   * Builds the payload array forwarded to Socket.IO when emitting events.
   *
   * @param options - Emit options containing data or raw arguments.
   * @returns Array representation supplied to `socket.emit`.
   */
  private buildEmitPayload(options: EmitOptions): unknown[] {
    if (options.args && options.args.length > 0) {
      return options.args;
    }

    if (options.data) {
      return [options.data];
    }

    return [];
  }

  /**
   * Normalises Socket.IO client options and applies security safeguards.
   *
   * @param url - Target Socket.IO endpoint.
   * @param options - Caller supplied options.
   * @returns Sanitised Socket.IO client configuration.
   */
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
    if (options.auth && Object.keys(options.auth).length > 0) {
      opts.auth = { ...options.auth } as SocketOptions['auth'];
    }
    if (options.allowSelfSigned) {
      this.assertSelfSignedAllowed();
      opts.rejectUnauthorized = false;
    }

    return opts;
  }

  /**
   * Converts a key/value map to a query-string representation understood by Socket.IO.
   *
   * @param query - Record of query parameters.
   * @returns Encoded query string.
   */
  private toQueryString(query: Record<string, string>): string {
    return Object.entries(query)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');
  }

  /**
   * Tears down the active socket connection and removes registered listeners.
   */
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

  /**
   * Retrieves the active socket instance, throwing when no connection exists.
   *
   * @returns The connected Socket.IO client.
   * @throws {Error} If the socket is not currently connected.
   */
  private requireSocket(): Socket {
    if (!this.socket) {
      throw new Error('Socket is not connected. Call connect() first.');
    }

    return this.socket;
  }

  /**
   * Ensures self-signed certificates are only trusted during development builds.
   *
   * @throws {Error} When invoked under production heuristics.
   */
  private assertSelfSignedAllowed(): void {
    if (isProductionEnvironment()) {
      throw new Error(
        'allowSelfSigned is disabled in production builds. Configure trusted certificates or pinning instead.',
      );
    }
  }
}
