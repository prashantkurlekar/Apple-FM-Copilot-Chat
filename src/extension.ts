import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { FmBridge } from './bridge';
import { AppleFmProvider, VENDOR } from './provider';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Apple Foundation Models');

  const resolveBridgePath = (): string => {
    const configured = vscode.workspace.getConfiguration('appleFm').get<string>('bridgePath', '').trim();
    if (configured) {
      return configured;
    }
    const bundled = context.asAbsolutePath('bin/fm-bridge');
    if (fs.existsSync(bundled)) {
      return bundled;
    }
    return context.asAbsolutePath('swift/.build/release/fm-bridge'); // dev checkout fallback
  };

  const bridge = new FmBridge(resolveBridgePath, log);
  const provider = new AppleFmProvider(bridge, log);

  context.subscriptions.push(
    log,
    bridge,
    provider,
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),

    vscode.commands.registerCommand('appleFm.manage', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'appleFm')
    ),
    vscode.commands.registerCommand('appleFm.showLogs', () => log.show()),
    vscode.commands.registerCommand('appleFm.restartBridge', () => {
      bridge.restart();
      provider.refresh();
      void vscode.window.showInformationMessage('Apple FM bridge restarted.');
    }),
    vscode.commands.registerCommand('appleFm.checkAvailability', async () => {
      try {
        const a = await bridge.availability();
        if (a.available) {
          void vscode.window.showInformationMessage('Apple Foundation Model is available.');
        } else {
          void vscode.window.showWarningMessage(`Apple Foundation Model unavailable: ${a.message ?? a.code}`);
        }
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('appleFm.bridgePath')) {
        bridge.restart();
      }
      if (e.affectsConfiguration('appleFm')) {
        provider.refresh();
      }
    })
  );
}

export function deactivate(): void {}
