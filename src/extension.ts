import * as vscode from 'vscode';
import { GraphPanel } from './panel.ts';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('archlink.showGraph', () => {
      GraphPanel.show(context, vscode.window.activeTextEditor?.document.uri.fsPath);
    }),
    // Explorer / editor-tab context menu passes the clicked resource.
    vscode.commands.registerCommand('archlink.showGraphForFile', (resource?: vscode.Uri) => {
      GraphPanel.show(context, resource?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath);
    }),
  );
}

export function deactivate(): void {
  // GraphPanel registers everything it owns on context.subscriptions.
}
