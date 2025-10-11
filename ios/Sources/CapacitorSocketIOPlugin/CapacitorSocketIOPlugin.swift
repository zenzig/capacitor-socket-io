import Capacitor
import Foundation

@objc(CapacitorSocketIOPlugin)
public class CapacitorSocketIOPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CapacitorSocketIOPlugin"
    public let jsName = "CapacitorSocketIO"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "emit", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "on", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeAllListeners", returnType: CAPPluginReturnPromise)
    ]

    private let socketManager = CapacitorSocketIO()
    private let workerQueue = DispatchQueue(label: "com.zenzig.plugins.socketio.worker", qos: .userInitiated)

    override public func load() {
        super.load()

        socketManager.setEventListener { [weak self] event, args, socketId in
            var payload: JSObject = [
                "event": event,
                "args": args
            ]

            if let socketId {
                payload["id"] = socketId
            }

            self?.notify(eventName: event, payload: payload)
        }
    }

    @objc func connect(_ call: CAPPluginCall) {
        workerQueue.async { [weak self] in
            guard let self else { return }

            do {
                let configuration = try self.parseConnectConfiguration(from: call)
                try self.socketManager.connect(configuration: configuration)
                self.resolve(call, with: [
                    "status": "connecting",
                    "url": configuration.url.absoluteString
                ])
            } catch {
                self.reject(call, message: "Failed to initiate connection", error: error)
            }
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        workerQueue.async { [weak self] in
            guard let self else { return }

            self.socketManager.disconnect()
            self.resolve(call, with: [
                "status": "disconnected"
            ])
        }
    }

    @objc func emit(_ call: CAPPluginCall) {
        guard let event = call.getString("event")?.trimmingCharacters(in: .whitespacesAndNewlines), !event.isEmpty else {
            call.reject("Event name is required")
            return
        }

        let payload = buildEmitPayload(call: call)

        workerQueue.async { [weak self] in
            guard let self else { return }

            do {
                try self.socketManager.emit(event: event, items: payload)
                self.resolve(call, with: [
                    "status": "emitted",
                    "event": event
                ])
            } catch {
                self.reject(call, message: "Failed to emit event", error: error)
            }
        }
    }

    @objc func on(_ call: CAPPluginCall) {
        guard let event = call.getString("event")?.trimmingCharacters(in: .whitespacesAndNewlines), !event.isEmpty else {
            call.reject("Event name is required")
            return
        }

        workerQueue.async { [weak self] in
            guard let self else { return }

            self.socketManager.listen(to: event)
            self.resolve(call, with: [
                "status": "listening",
                "event": event
            ])
        }
    }

    @objc override public func removeAllListeners(_ call: CAPPluginCall) {
        super.removeAllListeners(call)

        workerQueue.async { [weak self] in
            guard let self else { return }

            self.socketManager.removeAllDynamicListeners()
        }
    }

    deinit {
        socketManager.destroy()
    }

    private func parseConnectConfiguration(from call: CAPPluginCall) throws -> CapacitorSocketIO.ConnectConfiguration {
        let urlString = (call.getString("url")?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 } ?? CapacitorSocketIO.defaultURLString

        guard let url = URL(string: urlString) else {
            throw CapacitorSocketIO.SocketError.invalidURL(urlString)
        }

        let options = call.getObject("options") ?? JSObject()

        let secure = options["secure"] as? Bool
        let reconnection = options["reconnection"] as? Bool
        let reconnectionAttempts = extractInteger(options["reconnectionAttempts"])
        let timeout = extractDouble(options["timeout"])
        let reconnectionDelay = extractDouble(options["reconnectionDelay"])
        let reconnectionDelayMax = extractDouble(options["reconnectionDelayMax"])
        let path = options["path"] as? String
        let query = parseQuery(options["query"])
        let authPayload = parseAuthPayload(options["auth"])
        let transports = (options["transports"] as? [Any])?.compactMap { $0 as? String }
        let allowSelfSigned = options["allowSelfSigned"] as? Bool ?? false

        return CapacitorSocketIO.ConnectConfiguration(
            url: url,
            secure: secure,
            reconnection: reconnection,
            reconnectionAttempts: reconnectionAttempts,
            timeout: timeout,
            reconnectionDelay: reconnectionDelay,
            reconnectionDelayMax: reconnectionDelayMax,
            path: path,
            query: query,
            authPayload: authPayload,
            transports: transports,
            allowSelfSigned: allowSelfSigned
        )
    }

    private func buildEmitPayload(call: CAPPluginCall) -> [Any] {
        if let args = call.getArray("args"), !args.isEmpty {
            return args.map { $0 }
        }

        if let data = call.getObject("data"), !data.isEmpty {
            return [data]
        }

        return []
    }

    private func extractInteger(_ value: Any?) -> Int? {
        switch value {
        case let int as Int:
            return int
        case let double as Double:
            return Int(double)
        case let string as String:
            return Int(string)
        default:
            return nil
        }
    }

    private func extractDouble(_ value: Any?) -> Double? {
        switch value {
        case let int as Int:
            return Double(int)
        case let double as Double:
            return double
        case let string as String:
            return Double(string)
        default:
            return nil
        }
    }

    private func parseQuery(_ value: Any?) -> [String: String]? {
        if let dict = value as? [String: Any] {
            var converted: [String: String] = [:]
            for (key, value) in dict {
                converted[key] = String(describing: value)
            }
            return converted
        }

        if let string = value as? String {
            var params: [String: String] = [:]
            for pair in string.split(separator: "&") {
                let keyValue = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                guard !keyValue.isEmpty else { continue }
                let rawKey = String(keyValue[0])
                let decodedKey = rawKey.removingPercentEncoding ?? rawKey
                let rawValue = keyValue.count > 1 ? String(keyValue[1]) : ""
                let decodedValue = rawValue.removingPercentEncoding ?? rawValue
                params[decodedKey] = decodedValue
            }
            return params
        }

        return nil
    }

    private func parseAuthPayload(_ value: Any?) -> [String: Any]? {
        if let dictionary = value as? [String: Any], !dictionary.isEmpty {
            return dictionary
        }

        if let dictionary = value as? NSDictionary, dictionary.count > 0 {
            var converted: [String: Any] = [:]
            for (key, rawValue) in dictionary {
                guard let keyString = key as? String else { continue }
                converted[keyString] = rawValue
            }
            return converted.isEmpty ? nil : converted
        }

        if let string = value as? String {
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : ["token": trimmed]
        }

        if let number = value as? NSNumber {
            return ["token": number]
        }

        return nil
    }

    private func resolve(_ call: CAPPluginCall, with data: JSObject) {
        DispatchQueue.main.async {
            call.resolve(data)
        }
    }

    private func reject(_ call: CAPPluginCall, message: String, error: Error) {
        DispatchQueue.main.async {
            call.reject(message, nil, error)
        }
    }

    private func notify(eventName: String, payload: JSObject) {
        DispatchQueue.main.async { [weak self] in
            self?.notifyListeners(eventName, data: payload)
        }
    }
}
