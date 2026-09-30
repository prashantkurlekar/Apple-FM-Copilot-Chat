# Changelog

## 1.0.0

First public release.

- Adds Apple's on-device Foundation Model (Apple Intelligence) to the Copilot Chat model picker. It runs locally, works offline and is free.
- Prompts are measured with the model's own tokenizer and fit to the 4096-token context window. History is dropped oldest-first, and `appleFm.maxOutputTokens` is kept free for the reply.
- Works in Ask and Agent modes. The model answers in plain text only; it does not call tools.
- Settings: `appleFm.systemPrompt`, `appleFm.temperature`, `appleFm.maxInputTokens`, `appleFm.maxOutputTokens`, `appleFm.bridgePath`.
- Commands: Check Model Availability, Restart Bridge, Show Logs, Open Settings.
