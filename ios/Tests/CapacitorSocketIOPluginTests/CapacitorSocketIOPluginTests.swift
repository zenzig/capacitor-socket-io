import XCTest
@testable import CapacitorSocketIOPlugin

final class CapacitorSocketIOPluginTests: XCTestCase {

    func testConnectsToRemoteServerWithoutErrors() throws {
        let socket = CapacitorSocketIO()
        let connectExpectation = expectation(description: "connect event received")
        let errorExpectation = expectation(description: "no error event")
        errorExpectation.isInverted = true

        socket.setEventListener { event, _, _ in
            if event == "connect" {
                connectExpectation.fulfill()
            }

            if event == "connect_error" || event == "error" {
                errorExpectation.fulfill()
            }
        }

        socket.listen(to: "pong")

        let configuration = CapacitorSocketIO.ConnectConfiguration(
            url: CapacitorSocketIO.defaultURL,
            secure: true,
            reconnection: false,
            timeout: 5_000,
            path: "/socket.io",
            transports: ["websocket"],
            allowSelfSigned: true
        )

        try socket.connect(configuration: configuration)

        wait(for: [connectExpectation, errorExpectation], timeout: 20.0)

        try socket.emit(event: "ping", items: [["msg": "Hello from Capacitor iOS tests"]])

        // Allow a short window to ensure no late errors are emitted while connected.
        let settleExpectation = expectation(description: "settle")
        DispatchQueue.global().asyncAfter(deadline: .now() + 5.0) {
            settleExpectation.fulfill()
        }

        wait(for: [settleExpectation], timeout: 6.0)

        socket.destroy()
    }
}
