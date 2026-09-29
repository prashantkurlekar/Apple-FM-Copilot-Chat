import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import * as vscode from 'vscode';

export interface Availability {
  available: boolean;
  code?: string;
  message?: string;
  /** Model context window in tokens (input + output), as reported by the OS. */
  contextSize?: number;
}

export interface ChatRequest {
  system?: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}

export class BridgeError extends Error {
  constructor(message: string, readonly code: string = 'bridge_error') {
    super(message);
    this.name = 'BridgeError';
  }
}

interface Pending {
  onDelta?: (text: string) => void;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface WireMessage {
  id?: string;
  type: string;
  text?: string;
  code?: string;
  message?: string;
  available?: boolean;
  contextSize?: number;
  tokens?: number;
}

/**
 * Manages the long-lived Swift `fm-bridge serve` child process and speaks JSON Lines to it.
 * The process is started lazily and restarted automatically after a crash.
 */
export class FmBridge implements vscode.Disposable {
  private proc: cp.ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;

  constructor(
    private readonly resolvePath: () => string,
    private readonly log: vscode.OutputChannel
  ) {}

  async availability(): Promise<Availability> {
    const msg = await this.request<WireMessage>({ type: 'availability' }, 15_000);
    return { available: !!msg.available, code: msg.code, message: msg.message, contextSize: msg.contextSize };
  }

  /** Exact token count from the model's tokenizer. */
  async countTokens(text: string): Promise<number> {
    const msg = await this.request<WireMessage>({ type: 'count', text }, 10_000);
    return msg.tokens ?? 0;
  }

  chat(req: ChatRequest, onDelta: (text: string) => void, token: vscode.CancellationToken): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (token.isCancellationRequested) {
        resolve();
        return;
      }
      const id = String(this.nextId++);
      const sub = token.onCancellationRequested(() => {
        if (this.pending.delete(id)) {
          try {
            this.write({ id, type: 'cancel' });
          } catch {
            /* bridge already gone */
          }
          sub.dispose();
          resolve();
        }
      });
      this.pending.set(id, {
        onDelta,
        resolve: () => {
          sub.dispose();
          resolve();
        },
        reject: (e) => {
          sub.dispose();
          reject(e);
        }
      });
      try {
        this.write({ id, type: 'chat', ...req });
      } catch (e) {
        this.pending.delete(id);
        sub.dispose();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  restart(): void {
    this.log.appendLine('[bridge] restart requested');
    this.killProc();
    this.failAll(new BridgeError('The Apple FM bridge was restarted.', 'restarted'));
  }

  dispose(): void {
    this.killProc();
    this.failAll(new BridgeError('The Apple FM bridge was disposed.', 'disposed'));
  }

  // ---- internals ----

  private request<T>(payload: Record<string, unknown>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = String(this.nextId++);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('Timed out waiting for the Apple FM bridge.', 'timeout'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        }
      });
      try {
        this.write({ id, ...payload });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private write(obj: Record<string, unknown>): void {
    const proc = this.ensureStarted();
    proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  private ensureStarted(): cp.ChildProcessWithoutNullStreams {
    if (this.proc) {
      return this.proc;
    }
    const bin = this.resolvePath();
    if (!fs.existsSync(bin)) {
      throw new BridgeError(
        `Apple FM bridge binary not found at "${bin}". Build it with "npm run build:swift" or set "appleFm.bridgePath".`,
        'binary_missing'
      );
    }
    try {
      fs.chmodSync(bin, 0o755); // VSIX extraction can drop the executable bit
    } catch {
      /* best effort */
    }

    this.log.appendLine(`[bridge] starting ${bin} serve`);
    const proc = cp.spawn(bin, ['serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;

    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
    readline.createInterface({ input: proc.stderr }).on('line', (line) => this.log.appendLine(`[bridge:stderr] ${line}`));
    proc.stdin.on('error', (e) => this.log.appendLine(`[bridge] stdin error: ${e.message}`));

    proc.on('error', (e) => {
      this.log.appendLine(`[bridge] spawn error: ${e.message}`);
      if (this.proc === proc) {
        this.proc = undefined;
      }
      this.failAll(new BridgeError(`Could not start the Apple FM bridge: ${e.message}`, 'spawn_failed'));
    });
    proc.on('exit', (code, signal) => {
      this.log.appendLine(`[bridge] exited (code=${code}, signal=${signal})`);
      if (this.proc === proc) {
        this.proc = undefined;
      }
      this.failAll(new BridgeError(`The Apple FM bridge exited unexpectedly (code ${code}).`, 'exited'));
    });
    return proc;
  }

  private onLine(line: string): void {
    let msg: WireMessage;
    try {
      msg = JSON.parse(line) as WireMessage;
    } catch {
      this.log.appendLine(`[bridge:stdout] ${line}`);
      return;
    }
    const p = msg.id ? this.pending.get(msg.id) : undefined;
    if (!msg.id || !p) {
      return; // late message for a cancelled request
    }
    switch (msg.type) {
      case 'delta':
        if (msg.text) {
          p.onDelta?.(msg.text);
        }
        break;
      case 'done':
        this.pending.delete(msg.id);
        p.resolve(undefined);
        break;
      case 'info':
        this.log.appendLine(`[bridge] ${msg.message}`);
        break;
      case 'availability':
      case 'count':
        this.pending.delete(msg.id);
        p.resolve(msg);
        break;
      case 'error':
        this.pending.delete(msg.id);
        p.reject(new BridgeError(msg.message ?? 'Unknown bridge error', msg.code ?? 'error'));
        break;
    }
  }

  private failAll(err: Error): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) {
      p.reject(err);
    }
  }

  private killProc(): void {
    const proc = this.proc;
    this.proc = undefined;
    if (proc) {
      proc.removeAllListeners('exit');
      proc.kill();
    }
  }
}
