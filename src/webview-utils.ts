import * as vscode from 'vscode';
import { getExtensionContext, logDiagnostic } from './state';

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const ANALYSIS_PANEL_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';";

export interface AnalysisPanel {
  panel: vscode.WebviewPanel;
  isDisposed(): boolean;
  setHtml(html: string): void;
  setTitle(title: string): void;
  onMessage<T>(handler: (message: T) => void | Promise<void>): void;
}

export function createAnalysisPanel(
  viewType: string,
  title: string,
  webviewOptions?: vscode.WebviewPanelOptions & vscode.WebviewOptions,
): AnalysisPanel {
  const panel = vscode.window.createWebviewPanel(viewType, title, vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
    ...webviewOptions,
  });

  let disposed = false;
  panel.onDidDispose(() => {
    disposed = true;
  });
  getExtensionContext().subscriptions.push(panel);

  return {
    panel,
    isDisposed: () => disposed,
    setHtml(html: string) {
      if (!disposed) {
        panel.webview.html = html;
      }
    },
    setTitle(newTitle: string) {
      if (!disposed) {
        panel.title = newTitle;
      }
    },
    onMessage<T>(handler: (message: T) => void | Promise<void>) {
      panel.webview.onDidReceiveMessage((message: T) => {
        void Promise.resolve(handler(message)).catch((err) => {
          logDiagnostic(`Webview message handler failed for ${viewType}: ${err}`);
          vscode.window.showErrorMessage(`Something went wrong: ${err}`);
        });
      });
    },
  };
}
