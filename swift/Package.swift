// swift-tools-version:6.2
import PackageDescription

let package = Package(
    name: "fm-bridge",
    platforms: [.macOS("26.0")],
    products: [
        .executable(name: "fm-bridge", targets: ["FMBridge"])
    ],
    targets: [
        .executableTarget(
            name: "FMBridge",
            path: "Sources/FMBridge"
        )
    ],
    // Keep Swift 5 language mode: simple top-level code, no strict-concurrency friction.
    swiftLanguageModes: [.v5]
)
