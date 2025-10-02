// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "ZenzigCapacitorSocketIo",
    platforms: [.iOS(.v14)],
    products: [
        .library(
            name: "ZenzigCapacitorSocketIo",
            targets: ["CapacitorSocketIOPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "7.0.0"),
    .package(url: "https://github.com/socketio/socket.io-client-swift", from: "16.1.1")
    ],
    targets: [
        .target(
            name: "CapacitorSocketIOPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "SocketIO", package: "socket.io-client-swift")
            ],
            path: "ios/Sources/CapacitorSocketIOPlugin"),
        .testTarget(
            name: "CapacitorSocketIOPluginTests",
            dependencies: ["CapacitorSocketIOPlugin"],
            path: "ios/Tests/CapacitorSocketIOPluginTests")
    ]
)