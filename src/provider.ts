import * as vscode from 'vscode';
import { BridgeError, FmBridge } from './bridge';
import { buildPrompt, CHARS_PER_TOKEN, estimateTokens, partsToText } from './messages';

export const VENDOR = 'apple-fm';
const MODEL_ID = 'apple-foundation-model';

/** Used until the bridge reports the real window size. */
const DEFAULT_CONTEXT_SIZE = 4096;

export class AppleFmProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  private contextSize = DEFAULT_CONTEXT_SIZE;
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;

  constructor(
    private readonly bridge: FmBridge,
    private readonly log: vscode.OutputChannel
  ) {}

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  private cfg() {
    const c = vscode.workspace.getConfiguration('appleFm');
    return {
      systemPrompt: c.get<string>('systemPrompt', ''),
      temperature: c.get<number>('temperature', 0.7),
      maxInputTokens: c.get<number>('maxInputTokens', 0),
      maxOutputTokens: c.get<number>('maxOutputTokens', 1000)
    };
  }

  /** Input budget: the whole window minus the reply reserve, unless the user set a smaller cap. */
  private inputBudget(cfg: { maxInputTokens: number; maxOutputTokens: number }): number {
    const auto = Math.max(256, this.contextSize - cfg.maxOutputTokens);
    return cfg.maxInputTokens > 0 ? Math.min(cfg.maxInputTokens, auto) : auto;
  }

  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    try {
      const a = await this.bridge.availability();
      if (!a.available) {
        this.log.appendLine(`[provider] model unavailable: ${a.code} ${a.message}`);
        if (!options.silent) {
          void vscode.window.showWarningMessage(`Apple Foundation Models: ${a.message ?? 'model unavailable'}`);
        }
        return [];
      }
      if (a.contextSize && a.contextSize > 0) {
        this.contextSize = a.contextSize;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[provider] availability check failed: ${message}`);
      if (!options.silent) {
        void vscode.window.showErrorMessage(`Apple Foundation Models: ${message}`);
      }
      return [];
    }

    const cfg = this.cfg();
    const maxInputTokens = this.inputBudget(cfg);
    const maxOutputTokens = Math.max(cfg.maxOutputTokens, this.contextSize - maxInputTokens);
    const info: vscode.LanguageModelChatInformation & { isUserSelectable: boolean } = {
      id: MODEL_ID,
      name: 'Apple Foundation Model',
      family: 'apple-foundation',
      version: '1.0.0',
      maxInputTokens,
      maxOutputTokens,
      tooltip: `Apple on-device foundation model (Apple Intelligence). Runs locally; ${this.contextSize}-token context window.`,
      detail: 'On-device · private',
      // Copilot only lists tool-capable models in its Agent and Ask modes (the classic Ask mode is gone),
      // so advertise tool calling. The model never calls tools: it answers in text, which ends the agent turn.
      capabilities: { toolCalling: true, imageInput: false },
      // Not yet in the stable typings, but honoured by VS Code: show the model in the Copilot Chat picker.
      isUserSelectable: true
    };
    return [info];
  }

  async provideLanguageModelChatResponse(
    _model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const cfg = this.cfg();
    const built = buildPrompt(messages, {
      defaultSystem: cfg.systemPrompt,
      // First pass by estimate; the bridge then trims exactly with the model's tokenizer.
      maxInputChars: this.inputBudget(cfg) * CHARS_PER_TOKEN,
      agentPrompt: (options.tools?.length ?? 0) > 0
    });
    if (built.droppedTurns > 0 || built.truncated) {
      this.log.appendLine(
        `[provider] trimmed context: dropped ${built.droppedTurns} older message(s)` +
          (built.truncated ? ', truncated latest message' : '')
      );
    }
    if (!built.prompt) {
      throw new Error('Apple Foundation Models: empty prompt.');
    }

    try {
      await this.bridge.chat(
        {
          system: built.system,
          prompt: built.prompt,
          temperature: cfg.temperature,
          maxTokens: cfg.maxOutputTokens
        },
        (text) => progress.report(new vscode.LanguageModelTextPart(text)),
        token
      );
    } catch (err) {
      if (err instanceof BridgeError && err.code === 'context_window') {
        throw new Error(
          `The Apple on-device model has a ${this.contextSize}-token limit and this request was too large. ` +
            'Try a shorter message, attach less code, or lower "appleFm.maxOutputTokens".'
        );
      }
      throw err;
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const value = typeof text === 'string' ? text : partsToText(text.content);
    try {
      return await this.bridge.countTokens(value);
    } catch {
      return estimateTokens(value);
    }
  }
}
