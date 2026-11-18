// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "StreamDockHID", platforms: [.macOS(.v13)], products: [
  .library(name: "StreamDockHID", targets: ["StreamDockHID"]),
  .executable(name: "streamdock-hid", targets: ["streamdock-hid"]),
], targets: [
  .target(name: "StreamDockHID"),
  .executableTarget(name: "streamdock-hid", dependencies: ["StreamDockHID"]),
  .testTarget(name: "StreamDockHIDTests", dependencies: ["StreamDockHID"]),
])
