import Foundation
import FoundationModels

// Usage:
//   fm-bridge serve              JSON-lines server on stdin/stdout (used by the VS Code extension)
//   fm-bridge --check            print availability as JSON, exit 0 if available
//   fm-bridge --prompt "text"    one-shot streamed answer to stdout (handy for testing)

let args = Array(CommandLine.arguments.dropFirst())

switch args.first {
case "--check", "check":
    let info = currentAvailability()
    Wire.send(["type": "availability", "available": info.available,
               "code": info.code, "message": info.message, "contextSize": contextSize()])
    exit(info.available ? 0 : 1)

case "--prompt":
    let text = args.dropFirst().joined(separator: " ")
    let info = currentAvailability()
    guard info.available else {
        FileHandle.standardError.write(Data((info.message + "\n").utf8))
        exit(1)
    }
    let req = WireRequest(id: nil, type: "chat", system: nil, prompt: text, temperature: nil, maxTokens: nil, text: nil)
    do {
        try await streamChat(req) { FileHandle.standardOutput.write(Data($0.utf8)) }
        FileHandle.standardOutput.write(Data("\n".utf8))
        exit(0)
    } catch {
        let d = describe(error)
        FileHandle.standardError.write(Data("\(d.code): \(d.message)\n".utf8))
        exit(1)
    }

case "serve", nil:
    let decoder = JSONDecoder()
    // Blocking read on the main thread; chat work runs in Tasks on the cooperative pool.
    while let line = readLine(strippingNewline: true) {
        guard !line.isEmpty,
              let data = line.data(using: .utf8),
              let req = try? decoder.decode(WireRequest.self, from: data) else { continue }
        handle(req)
    }
    // stdin closed (extension host went away, or piped input ended): let in-flight replies finish.
    while !registry.isIdle {
        try? await Task.sleep(nanoseconds: 50_000_000)
    }
    exit(0)

default:
    FileHandle.standardError.write(Data("Unknown argument: \(args[0])\nUsage: fm-bridge [serve|--check|--prompt <text>]\n".utf8))
    exit(2)
}
