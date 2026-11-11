import type { PluginListenerHandle } from '@capacitor/core';

/**
 * Describes the payload forwarded to Capacitor listeners when Socket.IO events are emitted.
 */
export interface SocketEventPayload {
  /** Name of the Socket.IO event (e.g. `connect`, `broadcast_message`). */
  event: string;
  /** Event arguments serialised for transport across the Capacitor bridge. */
  args: unknown[];
  /** Socket identifier included for lifecycle events when available. */
  id?: string;
}

/**
 * Android foreground-service options used to keep a native Socket.IO session
 * available while the WebView is backgrounded.
 */
export interface SocketIOForegroundServiceOptions {
  /** Enables foreground service mode. Defaults to true when an object is supplied. */
  enabled?: boolean;
  /** Notification title shown while the foreground socket is active. */
  notificationTitle?: string;
  /** Notification body shown while the foreground socket is active. */
  notificationText?: string;
  /** Stable Android notification id for this foreground socket session. */
  notificationId?: number;
  /** Optional Android notifications to post when specific socket events arrive in foreground-service mode. */
  eventNotifications?: SocketIOEventNotificationOptions[];
}

/**
 * Android notification options for a foreground-service socket event.
 */
export interface SocketIOEventNotificationOptions {
  /** Socket.IO event name that should post a completion/status notification. */
  event: string;
  /** Notification title shown for this event. */
  notificationTitle?: string;
  /** Notification body shown for this event. */
  notificationText?: string;
  /** Stable Android notification id for this event notification. */
  notificationId?: number;
  /** Deep-link prefix used with the extracted event id. */
  deepLinkPrefix?: string;
  /** Field name to read from the first event argument. Defaults to `id`. */
  idField?: string;
}

/**
 * Buffered Socket.IO event captured by native code while JS may be suspended.
 */
export interface BufferedSocketEventPayload extends SocketEventPayload {
  /** Unix epoch timestamp in milliseconds when native received the event. */
  receivedAt: number;
}

/**
 * Configuration forwarded to the Socket.IO client during the `connect` handshake.
 */
export interface SocketIOConnectOptions {
  /** Explicit TLS toggle. Defaults to the URL scheme. */
  secure?: boolean;
  /** Enables or disables automatic reconnection attempts. */
  reconnection?: boolean;
  /** Maximum number of reconnection attempts before giving up. */
  reconnectionAttempts?: number;
  /** Connection timeout in milliseconds. */
  timeout?: number;
  /** Initial reconnection delay in milliseconds. */
  reconnectionDelay?: number;
  /** Maximum reconnection delay in milliseconds. */
  reconnectionDelayMax?: number;
  /** Overrides the Socket.IO namespace path (defaults to `/socket.io`). */
  path?: string;
  /** Query string parameters appended to the handshake request. Never put a credential here (proxies log it); use `auth`. */
  query?: Record<string, string> | string;
  /** Transport whitelist (e.g. `['websocket']`). */
  transports?: string[];
  /** Android-only foreground service mode for durable background work. */
  foregroundService?: boolean | SocketIOForegroundServiceOptions;
  /**
   * Authentication payload sent in the Socket.IO CONNECT packet (`socket.handshake.auth`).
   * It is never copied into the URL query on any platform; if a native layer cannot
   * carry it in the CONNECT packet, `connect()` is rejected (Android: `AUTH_INJECTION_FAILED`).
   * Do not put a credential in `url` or `query`: proxies and access logs record them.
   */
  auth?: Record<string, string | number | boolean | null>;
  /**
   * Allows self-signed TLS certificates in debug builds. Throws when enabled in production.
   */
  allowSelfSigned?: boolean;
}

/**
 * Options accepted by {@link CapacitorSocketIOPlugin.connect}.
 */
export interface ConnectOptions {
  /** Socket.IO endpoint to target. Defaults to `https://socket-proxy.local/`. */
  url?: string;
  /** Raw Socket.IO client configuration to forward to the native layer. */
  options?: SocketIOConnectOptions;
}

/**
 * Options accepted by {@link CapacitorSocketIOPlugin.emit}.
 */
export interface EmitOptions {
  /** Socket.IO event to emit. */
  event: string;
  /** Structured data payload merged into the arguments array when provided. */
  data?: Record<string, unknown>;
  /** Pre-serialised argument list forwarded verbatim. */
  args?: unknown[];
}

/**
 * Result returned by {@link CapacitorSocketIOPlugin.connect} once the socket is opening.
 */
export interface ConnectResult {
  /** Connection status. Typically `connecting` immediately after invoking connect. */
  status: string;
  /** URL initially provided to the socket manager. */
  url: string;
  /**
   * True when a live/connecting socket for the same URL and options already existed and was
   * reused untouched (`status` is then `connected` or `connecting`).
   */
  reused?: boolean;
  /** True when `options.foregroundService` was requested and the native service actually started. */
  foregroundService?: boolean;
  /** Machine-readable reason `foregroundService` is false, e.g. `'quota-exhausted'`. */
  reason?: string;
}

/**
 * Result returned by {@link CapacitorSocketIOPlugin.disconnect} when resources are released.
 */
export interface DisconnectResult {
  /** Connection status after disconnection completes. */
  status: string;
}

/**
 * Result returned by {@link CapacitorSocketIOPlugin.emit} for bookkeeping purposes.
 */
export interface EmitResult {
  /** Emit status string. */
  status: string;
  /** Event name originally supplied to the emit call. */
  event: string;
}

/**
 * Result returned by {@link CapacitorSocketIOPlugin.on} once the native layer is listening.
 */
export interface ListenResult {
  /** Listen status string. */
  status: string;
  /** Event name currently being observed. */
  event: string;
}

/**
 * Options accepted by {@link CapacitorSocketIOPlugin.drainBufferedEvents}.
 */
export interface DrainBufferedEventsOptions {
  /** Optional event-name filter. Empty or omitted drains all buffered events. */
  events?: string[];
}

/**
 * Result returned by {@link CapacitorSocketIOPlugin.drainBufferedEvents}.
 */
export interface DrainBufferedEventsResult {
  /** Native buffered events in receive order. */
  events: BufferedSocketEventPayload[];
}

/**
 * Result returned by foreground-service status APIs.
 */
export interface ForegroundServiceStatusResult {
  /** True when the Android foreground socket service is active. */
  running: boolean;
}

/**
 * Config accepted by {@link CapacitorSocketIOPlugin.startForegroundService}. Same
 * shape as {@link SocketIOForegroundServiceOptions} minus `enabled`, which has no
 * meaning outside of `connect()`'s opt-in flag.
 */
export type StartForegroundServiceOptions = Omit<SocketIOForegroundServiceOptions, 'enabled'>;

/**
 * Result returned by {@link CapacitorSocketIOPlugin.startForegroundService}.
 */
export interface StartForegroundServiceResult extends ForegroundServiceStatusResult {
  /** True when the Android foreground service was actually (re)started. */
  started: boolean;
  /**
   * Machine-readable reason `started` is false, e.g. `'quota-exhausted'` when the
   * Android 15+ dataSync foreground-service time budget is currently spent, or
   * `'no-context'` / `'start-failed'` for other native failures. Absent when `started`
   * is true.
   */
  reason?: string;
}

/**
 * Result returned by {@link CapacitorSocketIOPlugin.getForegroundServiceStatus}.
 */
export interface ForegroundServiceQuotaStatusResult extends ForegroundServiceStatusResult {
  /**
   * True when the Android 15+ dataSync foreground-service time budget (roughly 6h
   * per rolling 24h window) is currently exhausted. While true, calls to
   * {@link CapacitorSocketIOPlugin.startForegroundService} (and `connect()` with
   * `foregroundService` requested) will not start the native service — Android
   * replenishes the budget once the app returns to the foreground.
   */
  exhausted: boolean;
  /** Unix epoch ms the quota was last marked exhausted, or -1 if never. */
  exhaustedAt: number;
}

/**
 * Payload delivered on the native-only `foregroundServiceTimeout` Capacitor event
 * (as `args[0]` on the standard listener payload) when Android's dataSync
 * foreground-service time limit is reached and the service stops itself.
 */
export interface ForegroundServiceTimeoutEventPayload {
  /** Unix epoch ms when the OS-enforced time limit was reached. */
  at: number;
}

/**
 * Payload delivered on the native-only `foregroundServiceUnavailable` Capacitor
 * event (as `args[0]` on the standard listener payload) when the foreground
 * service could not be started at all (most commonly because the dataSync quota
 * was already exhausted).
 */
export interface ForegroundServiceUnavailableEventPayload {
  /** Machine-readable failure reason, e.g. `'quota-exhausted'`. */
  reason: string;
}

/**
 * Public API contract exposed by the Capacitor Socket.IO plugin.
 */
export interface CapacitorSocketIOPlugin {
  /**
   * Initiates a Socket.IO connection using optional overrides.
   *
   * @param options - Target endpoint and Socket.IO client configuration.
   * @returns Connection state once the socket begins opening.
   */
  connect(options?: ConnectOptions): Promise<ConnectResult>;
  /**
   * Closes the active Socket.IO connection and releases native resources.
   *
   * @returns Connection status after disconnecting.
   */
  disconnect(): Promise<DisconnectResult>;
  /**
   * Emits an event to the Socket.IO server.
   *
   * @param options - Event name alongside structured data or raw argument list.
   * @returns Emit status metadata including the original event name.
   */
  emit(options: EmitOptions): Promise<EmitResult>;
  /**
   * Subscribes to a server-side event before attaching Capacitor listeners.
   *
   * @param options - Event descriptor containing the Socket.IO event name.
   * @returns Listen status metadata confirming the subscription.
   */
  on(options: { event: string }): Promise<ListenResult>;
  /**
   * Drains native-buffered events captured while JavaScript was suspended.
   *
   * @param options - Optional event-name filter.
   * @returns Buffered events in receive order.
   */
  drainBufferedEvents(options?: DrainBufferedEventsOptions): Promise<DrainBufferedEventsResult>;
  /**
   * Returns whether the Android foreground socket service is active.
   */
  isForegroundServiceRunning(): Promise<ForegroundServiceStatusResult>;
  /**
   * Stops the Android foreground socket service and disconnects the foreground socket.
   */
  stopForegroundService(): Promise<ForegroundServiceStatusResult>;
  /**
   * Starts (or re-starts) the Android foreground socket service independently of
   * {@link connect}. Use this to defer requesting the service until there is an
   * actual reason to keep the socket alive in the background (e.g. app backgrounding
   * with an active watch/job) rather than requesting it unconditionally at connect
   * time — the OS enforces a rolling ~6h/24h time budget on `dataSync` foreground
   * services (Android 15+), so requesting it only when needed conserves the budget.
   * No-ops (and reports `started:false, reason:'quota-exhausted'`) while that budget
   * is currently exhausted; see {@link getForegroundServiceStatus}.
   *
   * @param options - Notification and event-notification config for the service.
   */
  startForegroundService(options?: StartForegroundServiceOptions): Promise<StartForegroundServiceResult>;
  /**
   * Reports whether the Android foreground socket service is running and whether the
   * dataSync time-limit quota is currently exhausted (and since when), so callers can
   * decide whether it is worth attempting {@link startForegroundService}.
   */
  getForegroundServiceStatus(): Promise<ForegroundServiceQuotaStatusResult>;
  /**
   * Registers a listener for a previously subscribed Socket.IO event.
   *
   * @param eventName - Event to observe.
   * @param listenerFunc - Callback handling event payloads.
   * @returns Handle that can be used to unregister the listener.
   */
  addListener(eventName: string, listenerFunc: (payload: SocketEventPayload) => void): Promise<PluginListenerHandle>;
  /**
   * Removes all registered Socket.IO listeners across web and native layers.
   */
  removeAllListeners(): Promise<void>;
}
