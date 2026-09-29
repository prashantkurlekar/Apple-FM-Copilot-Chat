# Apple Foundation Models for Copilot Chat

A VS Code extension that adds Apple's **on-device Foundation Model** (Apple Intelligence) to the Copilot Chat model picker. Private, offline, free.

## How it works

```
Copilot Chat ──► VS Code LM Chat Provider API ──► extension (TypeScript)
                                                     │  JSON Lines over stdin/stdout
                                                     ▼
                                          fm-bridge (Swift, FoundationModels)
```

Apple's FoundationModels framework is Swift-only, so a small CLI (`swift/`) wraps it. No network port is opened.

## Requirements

- Apple Silicon Mac, **macOS 26+**, Apple Intelligence enabled
- Xcode 26+ (to build the bridge), Node 20+
- VS Code 1.104+ with GitHub Copilot Chat

## Build and run

```bash
npm install
npm run build:swift        # builds swift/ and copies to bin/fm-bridge
bin/fm-bridge --check      # is the model available?
bin/fm-bridge --prompt "Say hi in five words"
npm run compile
```

Press **F5** in VS Code to launch an Extension Development Host. In Copilot Chat open the model picker → **Manage Models** → **Apple Foundation Models**, then pick *Apple Foundation Model*.

## Install

```bash
npm run package            # → apple-fm-copilot-provider.vsix (darwin-arm64)
npm run install:vscode     # package + `code --install-extension` (needs `code` on PATH)
```

Or in VS Code: Extensions view → `…` → **Install from VSIX…**. Then reload the window, open Copilot Chat, and pick **Apple Foundation Model** from the model picker (if it isn't listed: **Manage Models** → **Apple Foundation Models** → enable it). It works in the Ask and Agent modes.

If macOS quarantines the binary: `xattr -dr com.apple.quarantine bin/`.

## Limits (v1)

- **4096-token context, input + output combined** (the on-device model's hard limit, read from the OS at runtime). Prompts are measured with the model's own tokenizer (macOS 26.4+) and fill the whole window: history is dropped oldest-first, then the prompt is trimmed to leave `appleFm.maxOutputTokens` for the reply, and the reply may use all remaining room.
- **No real tool calling.** Recent Copilot builds only list tool-capable models (the classic Ask mode is gone), so the model advertises tool calling but always answers in plain text. For agent requests, Copilot's large system prompt and workspace context are dropped; only your messages, attachments and prior replies are sent.
- Stateless: each request builds a fresh session from the trimmed history.
- macOS 27 adds a 32K-token Private Cloud Compute model, but it rejects requests from an unsigned CLI like `fm-bridge` (it appears to require an Apple entitlement), so it isn't used.

## Commands

Apple FM: Check Model Availability · Restart Bridge · Show Logs · Open Settings
