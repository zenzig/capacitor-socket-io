import XCTest
@testable import CapacitorSocketIOPlugin

final class CapacitorSocketIOPluginTests: XCTestCase {

    func testConnectsToRemoteServerWithoutErrors() throws {
    let socket = CapacitorSocketIO()
    defer { socket.destroy() }
    let connectExpectation = expectation(description: "connect event received")
    let errorDuringConnectExpectation = expectation(description: "no error event during connect")
    errorDuringConnectExpectation.isInverted = true
    let errorDuringPingExpectation = expectation(description: "no error event during ping")
    errorDuringPingExpectation.isInverted = true
    let pongExpectation = expectation(description: "pong event received")

        var capturedPong: [String: Any]?

        let environment = ProcessInfo.processInfo.environment
        let proxyUrlString = environment["SOCKET_IO_PROXY_URL"].map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        let resolvedUrlString: String

        if let proxyUrlString, !proxyUrlString.isEmpty {
            resolvedUrlString = proxyUrlString.hasSuffix("/") ? proxyUrlString : proxyUrlString + "/"
        } else {
            resolvedUrlString = CapacitorSocketIO.defaultURLString
        }

        guard let resolvedUrl = URL(string: resolvedUrlString) else {
            XCTFail("Invalid SOCKET_IO_PROXY_URL provided: \(resolvedUrlString)")
            return
        }

        socket.setEventListener { event, payload, _ in
            switch event {
            case "connect":
                connectExpectation.fulfill()
            case "pong":
                if capturedPong == nil, let first = payload.first as? [String: Any] {
                    capturedPong = first
                    pongExpectation.fulfill()
                }
            case "connect_error", "error":
                errorDuringConnectExpectation.fulfill()
                errorDuringPingExpectation.fulfill()
            default:
                break
            }
        }

        socket.listen(to: "pong")

        let configuration = CapacitorSocketIO.ConnectConfiguration(
            url: resolvedUrl,
            secure: true,
            reconnection: false,
            timeout: 5_000,
            path: "/socket.io",
            transports: ["websocket"],
            allowSelfSigned: true
        )

    try socket.connect(configuration: configuration)

    wait(for: [connectExpectation, errorDuringConnectExpectation], timeout: 20.0)

        let pingMessage = "Hello from Capacitor iOS tests"
        let pingPayload: [String: Any] = [
            "deviceId": "ios-unit-test",
            "alias": "iOS XCTest",
            "origin": "ios-xctest",
            "message": pingMessage,
            "sequence": 1,
            "sentAt": ISO8601DateFormatter().string(from: Date())
        ]

        try socket.emit(event: "ping", items: [pingPayload])

    wait(for: [pongExpectation, errorDuringPingExpectation], timeout: 15.0)

        guard let pong = capturedPong else {
            XCTFail("Expected to capture pong payload")
            return
        }

        XCTAssertEqual(pong["message"] as? String, pingMessage)
        XCTAssertEqual(pong["sequence"] as? Int, 1)

        if let respondedAt = pong["respondedAt"] as? String {
            XCTAssertFalse(respondedAt.isEmpty, "respondedAt should not be empty")
        } else {
            XCTFail("respondedAt timestamp missing from pong payload")
        }

        if let latency = pong["latencyMs"] as? Double {
            XCTAssertGreaterThanOrEqual(latency, 0.0, "latency should be non-negative")
        } else if let latency = pong["latencyMs"] as? Int {
            XCTAssertGreaterThanOrEqual(latency, 0, "latency should be non-negative")
        } else {
            XCTFail("latencyMs missing from pong payload")
        }

    }
}
