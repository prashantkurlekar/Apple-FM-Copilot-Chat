import Foundation
import FoundationModels

// MARK: - Wire protocol (JSON Lines over stdin/stdout)
//
// Requests  (one JSON object per line on stdin):
//   {"id":"1","type":"availability"}
//   {"id":"2","type":"chat","system":"...","prompt":"...","temperature":0.7,"maxTokens":1000}
//        maxTokens = tokens reserved for the reply; the reply may use all room left in the window
//   {"id":"2","type":"cancel"}
//   {"id":"3","type":"count","text":"..."}
//
// Responses (one JSON object per line on stdout):
//   {"id":"1","type":"availability","available":true,"code":"available","message":"...","contextSize":4096}
//   {"id":"2","type":"info","message":"..."}    // e.g. prompt trimmed to fit
//   {"id":"2","type":"delta","text":"..."}      // incremental text, NOT cumulative
//   {"id":"2","type":"done"}
//   {"id":"2","type":"error","code":"context_window","message":"..."}
//   {"id":"3","type":"count","tokens":123}

struct WireRequest: Decodable {
    let id: String?
    let type: String
    let system: String?
    let prompt: String?
    let temperature: Double?
    let maxTokens: Int?
    let text: String?
}

enum Wire {
    private static let lock = NSLock()

    static func send(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}

// MARK: - Availability

struct AvailabilityInfo {
    let available: Bool
    let code: String
    let message: String
}

func currentAvailability() -> AvailabilityInfo {
    switch SystemLanguageModel.default.availability {
    case .available:
        return AvailabilityInfo(available: true, code: "available",
                                message: "Apple Foundation Model is ready.")
    case .unavailable(let reason):
        switch reason {
        case .deviceNotEligible:
            return AvailabilityInfo(available: false, code: "device_not_eligible",
                                    message: "This Mac is not eligible for Apple Intelligence (Apple Silicon is required).")
        case .appleIntelligenceNotEnabled:
            return AvailabilityInfo(available: false, code: "apple_intelligence_disabled",
                                    message: "Apple Intelligence is turned off. Enable it in System Settings > Apple Intelligence & Siri.")
        case .modelNotReady:
            return AvailabilityInfo(available: false, code: "model_not_ready",
                                    message: "The on-device model is still downloading or preparing. Try again shortly.")
        @unknown default:
            return AvailabilityInfo(available: false, code: "unavailable",
                                    message: "The on-device model is unavailable: \(String(describing: reason))")
        }
    @unknown default:
        return AvailabilityInfo(available: false, code: "unavailable", message: "The on-device model is unavailable.")
    }
}

// MARK: - Token accounting

/// Fixed per-request template tokens not covered by `tokenCount(for:)` (measured: 8), plus slack.
let templateOverhead = 16
/// Never leave the reply less room than this, even if the caller reserved less.
let minReplyTokens = 64

func contextSize() -> Int {
    SystemLanguageModel.default.contextSize
}

/// Exact token count on macOS 26.4+, conservative estimate before that.
func countTokens(prompt text: String) async -> Int {
    if #available(macOS 26.4, *), let n = try? await SystemLanguageModel.default.tokenCount(for: text) {
        return n
    }
    return (text.utf8.count + 1) / 2
}

/// Instructions carry the chat template, so count them as Instructions rather than plain text.
func countTokens(instructions text: String) async -> Int {
    if #available(macOS 26.4, *), let n = try? await SystemLanguageModel.default.tokenCount(for: Instructions(text)) {
        return n
    }
    return (text.utf8.count + 1) / 2 + 48
}

/// Keeps the head (40%) and tail (60%) of `text`, dropping the middle, to at most `maxChars` characters.
func clipMiddle(_ text: String, maxChars: Int) -> String {
    guard text.count > maxChars else { return text }
    let marker = "\n…[truncated]…\n"
    let room = max(0, maxChars - marker.count)
    let head = room * 2 / 5
    return String(text.prefix(head)) + marker + String(text.suffix(room - head))
}

/// Trims `prompt` so instructions + prompt leave `reserve` tokens for the reply, and returns the
/// reply limit: everything left in the window.
func fitToWindow(system: String?, prompt: String, reserve: Int) async -> (prompt: String, maxReply: Int, trimmedFrom: Int?) {
    let window = contextSize()
    let systemTokens = await countTokens(instructions: system ?? "")
    let inputBudget = window - templateOverhead - max(reserve, minReplyTokens) - systemTokens

    var fitted = prompt
    var promptTokens = await countTokens(prompt: fitted)
    let original = promptTokens
    var attempts = 0
    while promptTokens > inputBudget, inputBudget > 0, attempts < 6 {
        // Scale by the measured chars-per-token ratio, undershooting slightly so it converges quickly.
        let target = Int(Double(fitted.count) * Double(inputBudget) / Double(promptTokens) * 0.97)
        fitted = clipMiddle(fitted, maxChars: max(0, target))
        promptTokens = await countTokens(prompt: fitted)
        attempts += 1
    }
    let maxReply = max(minReplyTokens, window - templateOverhead - systemTokens - promptTokens)
    return (fitted, maxReply, promptTokens < original ? original : nil)
}

// MARK: - Chat

/// Streams a response, calling `onDelta` with only the newly generated text each time.
/// Stateless by design: a fresh session per request, history is flattened into `prompt` by the extension.
func streamChat(_ req: WireRequest, onInfo: (String) -> Void = { _ in }, onDelta: (String) -> Void) async throws {
    let model = SystemLanguageModel.default
    let fit = await fitToWindow(system: req.system, prompt: req.prompt ?? "", reserve: req.maxTokens ?? 0)
    if let original = fit.trimmedFrom {
        onInfo("Prompt trimmed from \(original) tokens to fit the \(contextSize())-token context window.")
    }

    let session: LanguageModelSession
    if let system = req.system, !system.isEmpty {
        session = LanguageModelSession(model: model, instructions: system)
    } else {
        session = LanguageModelSession(model: model)
    }

    var options = GenerationOptions()
    if let t = req.temperature { options.temperature = t }
    options.maximumResponseTokens = fit.maxReply

    // Snapshots carry the full text generated so far; convert to deltas.
    var emitted = ""
    let stream = session.streamResponse(to: fit.prompt, options: options)
    for try await snapshot in stream {
        try Task.checkCancellation()
        let current = snapshot.content
        if current.count > emitted.count {
            let delta = String(current.dropFirst(emitted.count))
            if !delta.isEmpty { onDelta(delta) }
        }
        emitted = current
    }
}

func describe(_ error: Error) -> (code: String, message: String) {
    if let ge = error as? LanguageModelSession.GenerationError {
        switch ge {
        case .exceededContextWindowSize:
            return ("context_window", "The prompt plus response exceeded the model's \(contextSize())-token context window.")
        case .guardrailViolation:
            return ("guardrail", "Apple's on-device safety guardrails blocked this request or response.")
        case .unsupportedLanguageOrLocale:
            return ("unsupported_language", "The on-device model does not support this language or locale.")
        default:
            return ("generation_error", error.localizedDescription)
        }
    }
    return ("error", error.localizedDescription)
}

// MARK: - Serve mode

final class TaskRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var tasks: [String: Task<Void, Never>] = [:]

    func set(_ id: String, _ task: Task<Void, Never>) {
        lock.lock(); defer { lock.unlock() }
        tasks[id] = task
    }

    func remove(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        tasks[id] = nil
    }

    func cancel(_ id: String) {
        lock.lock()
        let task = tasks[id]
        tasks[id] = nil
        lock.unlock()
        task?.cancel()
    }

    // Counted separately from `tasks`: a fast task can finish before `set` registers it.
    private var inFlight = 0

    func begin() {
        lock.lock(); defer { lock.unlock() }
        inFlight += 1
    }

    func end() {
        lock.lock(); defer { lock.unlock() }
        inFlight -= 1
    }

    var isIdle: Bool {
        lock.lock(); defer { lock.unlock() }
        return inFlight == 0
    }
}

let registry = TaskRegistry()

func serveChat(id: String, req: WireRequest) async {
    let info = currentAvailability()
    guard info.available else {
        Wire.send(["id": id, "type": "error", "code": info.code, "message": info.message])
        return
    }
    do {
        try await streamChat(req, onInfo: { message in
            Wire.send(["id": id, "type": "info", "message": message])
        }) { text in
            Wire.send(["id": id, "type": "delta", "text": text])
        }
        Wire.send(["id": id, "type": "done"])
    } catch is CancellationError {
        Wire.send(["id": id, "type": "done", "cancelled": true])
    } catch {
        let d = describe(error)
        Wire.send(["id": id, "type": "error", "code": d.code, "message": d.message])
    }
}

func handle(_ req: WireRequest) {
    switch req.type {
    case "availability":
        let info = currentAvailability()
        Wire.send(["id": req.id ?? "", "type": "availability",
                   "available": info.available, "code": info.code, "message": info.message,
                   "contextSize": contextSize()])
    case "count":
        let id = req.id ?? ""
        let text = req.text ?? ""
        registry.begin()
        Task {
            Wire.send(["id": id, "type": "count", "tokens": await countTokens(prompt: text)])
            registry.end()
        }
    case "chat":
        guard let id = req.id else { return }
        registry.begin()
        let task = Task {
            await serveChat(id: id, req: req)
            registry.remove(id)
            registry.end()
        }
        registry.set(id, task)
    case "cancel":
        if let id = req.id { registry.cancel(id) }
    default:
        Wire.send(["id": req.id ?? "", "type": "error", "code": "bad_request",
                   "message": "Unknown request type: \(req.type)"])
    }
}
