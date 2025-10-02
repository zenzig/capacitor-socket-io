import Foundation
import SocketIO

/// Thin wrapper around the native Socket.IO client that mirrors the Android implementation and keeps
/// the actual plugin class focused on bridging to Capacitor's APIs.
public final class CapacitorSocketIO {

    public static let defaultURLString = "https://socket-proxy.local/"
    public static let defaultURL = URL(string: CapacitorSocketIO.defaultURLString)!

    public struct ConnectConfiguration {
        public let url: URL
        public let secure: Bool?
        public let reconnection: Bool?
        public let reconnectionAttempts: Int?
        public let timeout: TimeInterval?
        public let reconnectionDelay: TimeInterval?
        public let reconnectionDelayMax: TimeInterval?
        public let path: String?
        public let query: [String: String]?
        public let transports: [String]?
        public let allowSelfSigned: Bool

        public init(
            url: URL,
            secure: Bool? = nil,
            reconnection: Bool? = nil,
            reconnectionAttempts: Int? = nil,
            timeout: TimeInterval? = nil,
            reconnectionDelay: TimeInterval? = nil,
            reconnectionDelayMax: TimeInterval? = nil,
            path: String? = nil,
            query: [String: String]? = nil,
            transports: [String]? = nil,
            allowSelfSigned: Bool = false
        ) {
            self.url = url
            self.secure = secure
            self.reconnection = reconnection
            self.reconnectionAttempts = reconnectionAttempts
            self.timeout = timeout
            self.reconnectionDelay = reconnectionDelay
            self.reconnectionDelayMax = reconnectionDelayMax
            self.path = path
            self.query = query
            self.transports = transports
            self.allowSelfSigned = allowSelfSigned
        }
    }

    public enum SocketError: Error, LocalizedError {
        case invalidURL(String)
        case notConnected

        public var errorDescription: String? {
            switch self {
            case .invalidURL(let value):
                return "The provided Socket.IO endpoint is invalid: \(value)"
            case .notConnected:
                return "Socket is not connected. Call connect() first."
            }
        }
    }

    public typealias EventListener = (_ event: String, _ payload: [Any], _ socketId: String?) -> Void

    private let queue = DispatchQueue(label: "com.zenzig.plugins.socketio.manager", qos: .userInitiated)
    private var socketManager: SocketManager?
    private var socket: SocketIOClient?
    private var requestedEvents = Set<String>()
    private var coreHandlers = [SocketClientEvent: UUID]()
    private var coreStringHandlers = [String: UUID]()
    private var dynamicHandlers = [String: UUID]()
    private var eventListener: EventListener?
    private let trustAllDelegate = TrustingURLSessionDelegate()

    private let coreEventMap: [SocketClientEvent: String] = [
        .connect: "connect",
        .disconnect: "disconnect",
        .error: "error",
        .statusChange: "status_change",
        .reconnect: "reconnect",
        .reconnectAttempt: "reconnect_attempt",
        .ping: "ping",
        .pong: "pong",
        .websocketUpgrade: "websocket_upgrade"
    ]

    private let supplementalCoreEvents: [String] = [
        "message",
        "connect_error",
        "reconnect_error",
        "reconnect_failed",
        "connect_timeout"
    ]

    public init() {}

    public func setEventListener(_ listener: EventListener?) {
        queue.sync {
            self.eventListener = listener
        }
    }

    public func connect(configuration: ConnectConfiguration) throws {
        try queue.sync {
            try connectInternal(configuration: configuration)
        }
    }

    public func disconnect() {
        queue.sync {
            disconnectInternal()
        }
    }

    public func emit(event: String, items: [Any]) throws {
        try queue.sync {
            guard let socket = socket else {
                throw SocketError.notConnected
            }

            if items.isEmpty {
                socket.emit(event)
            } else {
                let payload = items.map { normaliseForSocketData($0) }
                socket.emit(event, with: payload, completion: nil)
            }
        }
    }

    public func listen(to event: String) {
        let trimmed = event.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        queue.sync {
            requestedEvents.insert(trimmed)
            if let socket = socket {
                attachDynamicListener(event: trimmed, socket: socket)
            }
        }
    }

    public func removeAllDynamicListeners() {
        queue.sync {
            detachDynamicListeners()
            requestedEvents.removeAll()
        }
    }

    public func destroy() {
        queue.sync {
            requestedEvents.removeAll()
            disconnectInternal()
            eventListener = nil
        }
    }

    // MARK: - Internal wiring

    private func connectInternal(configuration: ConnectConfiguration) throws {
        disconnectInternal()

        let manager = SocketManager(socketURL: configuration.url, config: buildConfiguration(from: configuration))
        manager.handleQueue = queue

        socketManager = manager
        let client = manager.defaultSocket
        socket = client

        attachCoreListeners(socket: client)
        attachDynamicListeners(socket: client)

        if let timeout = configuration.timeout, timeout > 0 {
            let seconds = max(0, timeout / 1000.0)
            client.connect(timeoutAfter: seconds) { [weak self] in
                self?.dispatch(eventName: "connect_timeout", data: [])
            }
        } else {
            client.connect()
        }
    }

    private func disconnectInternal() {
        guard let client = socket else {
            socketManager = nil
            return
        }

    detachCoreListeners(from: client)
        detachDynamicListeners(from: client)

        client.disconnect()
        client.removeAllHandlers()

        socket = nil
        socketManager = nil
    }

    private func buildConfiguration(from configuration: ConnectConfiguration) -> SocketIOClientConfiguration {
        var config: SocketIOClientConfiguration = [.log(false), .compress, .forceNew(true)]

        let shouldSecure = configuration.secure ?? (configuration.url.scheme == "https")
        config.insert(.secure(shouldSecure))

        if let path = configuration.path {
            config.insert(.path(path))
        }

        if let params = configuration.query {
            config.insert(.connectParams(params))
        }

        if let transports = configuration.transports?.map({ $0.lowercased() }) {
            let websocketOnly = transports.contains("websocket") && !transports.contains("polling")
            let pollingOnly = transports.contains("polling") && !transports.contains("websocket")

            if websocketOnly {
                config.insert(.forceWebsockets(true))
                config.insert(.forcePolling(false))
            } else if pollingOnly {
                config.insert(.forcePolling(true))
                config.insert(.forceWebsockets(false))
            }
        }

        if let reconnect = configuration.reconnection {
            config.insert(.reconnects(reconnect))
        }

        if let attempts = configuration.reconnectionAttempts {
            config.insert(.reconnectAttempts(attempts))
        }

        if let reconnectDelay = configuration.reconnectionDelay {
            let seconds = Int(max(0, reconnectDelay / 1000.0))
            config.insert(.reconnectWait(seconds))
        }

        if let maxReconnectDelay = configuration.reconnectionDelayMax {
            let seconds = Int(max(0, maxReconnectDelay / 1000.0))
            config.insert(.reconnectWaitMax(seconds))
        }

        if configuration.allowSelfSigned {
            config.insert(.selfSigned(true))
            config.insert(.sessionDelegate(trustAllDelegate))
        }

        return config
    }

    private func attachCoreListeners(socket: SocketIOClient) {
        attachClientCoreListeners(socket: socket)
        attachSupplementalCoreListeners(socket: socket)
    }

    private func detachCoreListeners(from socket: SocketIOClient) {
        detachClientCoreListeners(from: socket)
        detachSupplementalCoreListeners(from: socket)
    }

    private func attachClientCoreListeners(socket: SocketIOClient) {
        for (event, name) in coreEventMap where coreHandlers[event] == nil {
            let uuid = socket.on(clientEvent: event) { [weak self] data, _ in
                self?.dispatch(eventName: name, data: data)
            }
            coreHandlers[event] = uuid
        }
    }

    private func detachClientCoreListeners(from socket: SocketIOClient) {
        for (_, uuid) in coreHandlers {
            socket.off(id: uuid)
        }
        coreHandlers.removeAll()
    }

    private func attachSupplementalCoreListeners(socket: SocketIOClient) {
        for event in supplementalCoreEvents where coreStringHandlers[event] == nil {
            let uuid = socket.on(event) { [weak self] data, _ in
                self?.dispatch(eventName: event, data: data)
            }
            coreStringHandlers[event] = uuid
        }
    }

    private func detachSupplementalCoreListeners(from socket: SocketIOClient) {
        for (_, uuid) in coreStringHandlers {
            socket.off(id: uuid)
        }
        coreStringHandlers.removeAll()
    }

    private func attachDynamicListeners(socket: SocketIOClient) {
        for event in requestedEvents {
            attachDynamicListener(event: event, socket: socket)
        }
    }

    private func attachDynamicListener(event: String, socket: SocketIOClient) {
        guard dynamicHandlers[event] == nil else { return }

        let uuid = socket.on(event) { [weak self] data, _ in
            self?.dispatch(eventName: event, data: data)
        }
        dynamicHandlers[event] = uuid
    }

    private func detachDynamicListeners(from socket: SocketIOClient? = nil) {
        guard let socket = socket ?? self.socket else {
            dynamicHandlers.removeAll()
            return
        }

        for (_, uuid) in dynamicHandlers {
            socket.off(id: uuid)
        }
        dynamicHandlers.removeAll()
    }

    private func dispatch(eventName: String, data: [Any]) {
        let normalised = data.map { self.normaliseForJS($0) }
        let socketId = eventName == "connect" ? socket?.sid : nil
        eventListener?(eventName, normalised, socketId)
    }

    private func normaliseForSocketData(_ value: Any) -> SocketData {
        switch value {
        case let data as SocketData:
            return data
        case let number as NSNumber:
            if CFNumberIsFloatType(number) {
                return number.doubleValue
            }
            return number.intValue
        case let bool as Bool:
            return bool
        case let int as Int:
            return int
        case let double as Double:
            return double
        case let string as String:
            return string
        case let data as Data:
            return data
        case is NSNull:
            return NSNull()
        case let array as [Any]:
            return array.map { normaliseForSocketData($0) }
        case let dict as [String: Any]:
            var converted: [String: Any] = [:]
            for (key, element) in dict {
                converted[key] = normaliseForSocketData(element)
            }
            return converted
        case let dict as NSDictionary:
            var converted: [String: Any] = [:]
            for (key, element) in dict {
                guard let keyString = key as? String else { continue }
                converted[keyString] = normaliseForSocketData(element)
            }
            return converted
        default:
            return String(describing: value)
        }
    }

    private func normaliseForJS(_ value: Any) -> Any {
        switch value {
        case is NSNull:
            return NSNull()
        case let number as NSNumber:
            return number
        case let string as String:
            return string
        case let data as Data:
            return String(data: data, encoding: .utf8) ?? data.base64EncodedString()
        case let array as [Any]:
            return array.map { normaliseForJS($0) }
        case let dict as [String: Any]:
            var converted: [String: Any] = [:]
            for (key, value) in dict {
                converted[key] = normaliseForJS(value)
            }
            return converted
        case let dict as NSDictionary:
            var converted: [String: Any] = [:]
            for (key, value) in dict {
                guard let keyString = key as? String else { continue }
                converted[keyString] = normaliseForJS(value)
            }
            return converted
        default:
            return String(describing: value)
        }
    }
}

private final class TrustingURLSessionDelegate: NSObject, URLSessionDelegate {
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        if let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }
}

