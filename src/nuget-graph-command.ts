import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { getExtensionContext } from './state';
import { createAnalysisPanel } from './webview-utils';
import { loadNugetDependencyGraph } from './nuget-graph-loader';
import { buildNugetGraphHtml } from './nuget-graph-html';
import { reviewPackageSecurityForRoot } from './security-command';

const panels = new Map<string, ReturnType<typeof createAnalysisPanel>>();
export async function showNugetDependencyGraph(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
  if (!folders.length) { void vscode.window.showErrorMessage('Open a filesystem workspace containing .NET projects.'); return; }
  const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
  if (!folder || folder.uri.scheme !== 'file') { return; }
  const root = folder.uri.fsPath, existing = panels.get(root);
  if (existing && !existing.isDisposed()) { existing.panel.reveal(); return; }
  const assets = vscode.Uri.joinPath(getExtensionContext().extensionUri, 'dist');
  const view = createAnalysisPanel('nugetDependencyGraph', 'NuGet Dependency Graph', { localResourceRoots: [assets], enableCommandUris: false });
  panels.set(root, view);
  const controller = new AbortController();
  view.panel.onDidDispose(() => { controller.abort(); panels.delete(root); });
  let busy = false;
  view.onMessage<{ command?: string }>(async message => {
    if (!message) { return; }
    if (message.command === 'securityScan') {
      try { await reviewPackageSecurityForRoot(root); }
      finally { if (!view.isDisposed()) { await view.panel.webview.postMessage({ type: 'securityScanFinished' }); } }
      return;
    }
    if (!['ready', 'refresh'].includes(message.command ?? '') || busy || view.isDisposed()) { return; }
    busy = true;
    await view.panel.webview.postMessage({ type: 'loading' });
    try {
      const graph = await loadNugetDependencyGraph(root, controller.signal);
      if (!view.isDisposed()) { await view.panel.webview.postMessage({ type: 'graph', graph }); }
    } catch (error) {
      if (!view.isDisposed()) { await view.panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
    } finally { busy = false; }
  });
  view.setHtml(buildNugetGraphHtml(view.panel.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'nuget-graph-webview.js')).toString(),
    view.panel.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'nuget-graph-webview.css')).toString(), view.panel.webview.cspSource, randomBytes(24).toString('base64')));
}
