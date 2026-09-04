import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { BuildTarget, MsbuildIssue } from './types';
import { countErrors, parseMsbuildIssues } from './pure-utils';
import { pickBuildTarget, resolveDotnetWorkspace, spawnDotnet, targetLabel, targetPath } from './utils';import { escapeHtml, ANALYSIS_PANEL_CSP, createAnalysisPanel, type AnalysisPanel } from './webview-utils';
import { isAutoFixEnabled, sendAIAutoFix, sendAIAutoFixForFile, type AIFixIssue } from './copilot-fix';

interface WebviewMessage {
  command: 'openFile' | 'aiFix' | 'aiFixFile' | 'reload';
  file?: string;
  line?: number;
  issue?: MsbuildIssue;
  issues?: MsbuildIssue[];
}

interface PanelState {
  panel: AnalysisPanel;
  target: BuildTarget | null;
  root: string;
}

export async function checkBuildErrors(preTarget?: BuildTarget): Promise<void> {
  let target = preTarget ?? null;
  let root: string;
  if (target) {
    root = path.dirname(target.kind === 'solution' ? target.path : target.entry.csprojPath);
  } else {
    const ws = await resolveDotnetWorkspace();
    if (!ws) {
      return;
    }
    root = ws.root;
    target = await pickBuildTarget(ws, '.NET: Check Build Errors', {
      allowSolution: true,
      commandKey: 'buildErrors',
    });
  }
  if (!target) {
    return;
  }

  const buildTarget = target;
  const output = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Building ${targetLabel(buildTarget)}…`,
      cancellable: false,
    },
    async () => {
      const result = await spawnDotnet(['build', targetPath(buildTarget), '-v', 'minimal'], root);
      return result.stdout;
    },
  );

  const issues = parseMsbuildIssues(output).filter(
    (issue) => issue.severity === 'error' || issue.code.startsWith('CS') || issue.code.startsWith('NETSDK') || issue.code.startsWith('MSB'),
  );

  if (issues.length === 0) {
    vscode.window.showInformationMessage(
      `Build succeeded — no errors or warnings found for ${targetLabel(buildTarget)}.`,
    );
    return;
  }

  const state: PanelState = { panel: createAnalysisPanel('dotnetBuildErrors', panelTitle(issues)), target: buildTarget, root };
  renderInto(state, issues);
  state.panel.onMessage((message: WebviewMessage) => handleMessage(state, message));
}

function panelTitle(issues: MsbuildIssue[]): string {
  return `Build Issues (${countErrors(issues)} errors, ${issues.length - countErrors(issues)} warnings)`;
}

function renderInto(state: PanelState, issues: MsbuildIssue[]): void {
  state.panel.setTitle(panelTitle(issues));
  state.panel.setHtml(buildWebviewHtml(issues, state.target ? targetLabel(state.target) : ''));
}

async function reloadPanel(state: PanelState): Promise<void> {
  if (!state.target) {
    return;
  }
  const output = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Rebuilding ${targetLabel(state.target)}…`,
      cancellable: false,
    },
    async () => {
      const result = await spawnDotnet(['build', targetPath(state.target!), '-v', 'minimal'], state.root);
      return result.stdout;
    },
  );
  const issues = parseMsbuildIssues(output).filter(
    (issue) => issue.severity === 'error' || issue.code.startsWith('CS') || issue.code.startsWith('NETSDK') || issue.code.startsWith('MSB'),
  );
  renderInto(state, issues);
}

async function readSnippet(file: string, line: number): Promise<string> {
  try {
    const content = await fs.promises.readFile(file, 'utf-8');
    const lines = content.split(/\r?\n/);
    const start = Math.max(0, line - 4);
    const end = Math.min(lines.length, line + 3);
    return lines.slice(start, end).join('\n');
  } catch {
    return '';
  }
}

async function handleMessage(state: PanelState, message: WebviewMessage): Promise<void> {
  switch (message.command) {
    case 'openFile': {
      if (!message.file || !fs.existsSync(message.file)) {
        return;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(message.file));
      const editor = await vscode.window.showTextDocument(doc);
      if (message.line && message.line > 0) {
        const position = new vscode.Position(message.line - 1, Math.max(0, (message.issue?.column ?? 1) - 1));
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      }
      return;
    }
    case 'aiFix': {
      const issue = message.issue;
      if (!issue || !issue.file) {
        return;
      }
      await sendAIAutoFix({
        file: issue.file,
        line: issue.line ?? 1,
        kind: issue.code,
        kindLabel: `Build ${issue.severity === 'error' ? 'Error' : 'Warning'} ${issue.code}`,
        snippet: await readSnippet(issue.file, issue.line ?? 1),
        description: issue.message,
        fixHint: `Resolve the ${issue.code} ${issue.severity} reported by the compiler/build.`,
      });
      return;
    }
    case 'aiFixFile': {
      if (!message.issues || message.issues.length === 0) {
        return;
      }
      const byFile = new Map<string, MsbuildIssue[]>();
      for (const issue of message.issues) {
        if (!issue.file) {
          continue;
        }
        const list = byFile.get(issue.file) ?? [];
        list.push(issue);
        byFile.set(issue.file, list);
      }
      for (const [file, fileIssues] of byFile) {
        const issues: AIFixIssue[] = [];
        for (const issue of fileIssues) {
          issues.push({
            line: issue.line ?? 1,
            kind: issue.code,
            kindLabel: `Build ${issue.severity === 'error' ? 'Error' : 'Warning'} ${issue.code}`,
            snippet: await readSnippet(file, issue.line ?? 1),
            description: issue.message,
            fixHint: `Resolve the ${issue.code} ${issue.severity} reported by the compiler/build.`,
          });
        }
        await sendAIAutoFixForFile({
          file,
          issues,
          issueType: 'build issue',
        });
      }
      return;
    }
    case 'reload':
      await reloadPanel(state);
      return;
  }
}

interface GroupedIssues {
  key: string;
  label: string;
  issues: MsbuildIssue[];
}

function groupIssues(issues: MsbuildIssue[], fallbackLabel: string): GroupedIssues[] {
  const groups = new Map<string, MsbuildIssue[]>();
  for (const issue of issues) {
    const key = issue.project ?? fallbackLabel;
    const list = groups.get(key) ?? [];
    list.push(issue);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, list]) => ({
    key,
    label: path.basename(key),
    issues: list.sort((a, b) => {
      if (a.severity !== b.severity) {
        return a.severity === 'error' ? -1 : 1;
      }
      return (a.file ?? '').localeCompare(b.file ?? '') || (a.line ?? 0) - (b.line ?? 0);
    }),
  }));
}

function issueRow(issue: MsbuildIssue, index: number): string {
  const canFix = isAutoFixEnabled() && Boolean(issue.file);
  const location = issue.file
    ? `${path.basename(issue.file)}${issue.line ? `:${issue.line}${issue.column ? `,${issue.column}` : ''}` : ''}`
    : '(no file)';
  const dataAttrs = issue.file
    ? `data-file="${escapeHtml(issue.file)}" data-line="${issue.line ?? 0}" data-code="${escapeHtml(issue.code)}" data-severity="${issue.severity}" data-message="${escapeHtml(issue.message)}"`
    : '';
  return /* html */ `
    <tr class="issue-row" ${dataAttrs}>
      <td class="icon-cell"><span class="severity-icon ${issue.severity}">$(${issue.severity === 'error' ? 'error' : 'warning'})</span></td>
      <td class="loc-cell">${escapeHtml(location)}</td>
      <td class="msg-cell"><span class="code-chip">${escapeHtml(issue.code)}</span> ${escapeHtml(issue.message)}</td>
      <td class="actions-cell">
        ${canFix ? `<button class="fix-btn" data-index="${index}" title="Fix with AI">$(sparkle)</button>` : ''}
      </td>
    </tr>`;
}

function buildWebviewHtml(issues: MsbuildIssue[], fallbackLabel: string): string {
  const groups = groupIssues(issues, fallbackLabel);
  const errorCount = countErrors(issues);
  const autoFix = isAutoFixEnabled();

  const sections = groups
    .map((group) => {
      const rows = group.issues.map((issue) => issueRow(issue, 0)).join('');
      return /* html */ `
      <div class="section">
        <div class="section-header">
          <h2>${escapeHtml(group.label)}</h2>
          <span class="count-badge">${group.issues.length}</span>
          ${autoFix ? `<button class="fix-file-btn" data-project="${escapeHtml(group.key)}">$(sparkle) Fix all with AI</button>` : ''}
        </div>
        <table class="issue-table">
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    })
    .join('');

  return /* html */ `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${ANALYSIS_PANEL_CSP}">
    <title>Build Issues</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 20px 24px 40px;
        line-height: 1.5;
      }
      .header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--vscode-panel-border); }
      h1 { font-size: 1.15em; font-weight: 600; }
      h1.has-errors { color: var(--vscode-testing-iconFailed, #f14c4c); }
      h1.only-warnings { color: var(--vscode-testing-iconQueued, #cca700); }
      .subtitle { font-size: 0.82em; color: var(--vscode-descriptionForeground); }
      .spacer { flex: 1; }
      button {
        display: inline-flex; align-items: center; gap: 5px; padding: 4px 12px;
        border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px;
        font-size: 0.8em; font-family: var(--vscode-font-family); cursor: pointer; white-space: nowrap;
        background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.15));
        color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      }
      button:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.25)); }
      .section { margin-bottom: 28px; }
      .section-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
      h2 { font-size: 1em; font-weight: 600; font-family: var(--vscode-editor-font-family, monospace); }
      .count-badge {
        font-size: 0.72em; font-weight: 700; padding: 1px 8px; border-radius: 8px;
        background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
      }
      .issue-table { width: 100%; border-collapse: collapse; border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: hidden; }
      .issue-table tbody tr { border-bottom: 1px solid var(--vscode-panel-border); }
      .issue-table tbody tr:last-child { border-bottom: none; }
      .issue-table tbody tr:hover { background: var(--vscode-list-hoverBackground); cursor: pointer; }
      .issue-table td { padding: 7px 12px; font-size: 0.88em; vertical-align: middle; }
      .icon-cell { width: 28px; }
      .severity-icon.error { color: var(--vscode-testing-iconFailed, #f14c4c); }
      .severity-icon.warning { color: var(--vscode-testing-iconQueued, #cca700); }
      .loc-cell { font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap; color: var(--vscode-descriptionForeground); }
      .msg-cell { font-family: var(--vscode-font-family); }
      .code-chip {
        font-family: var(--vscode-editor-font-family, monospace); font-size: 0.82em;
        padding: 0 5px; border-radius: 4px;
        background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
      }
      .actions-cell { width: 40px; text-align: right; }
    </style>
  </head>
  <body>
    <div class="header">
      <h1 class="${errorCount > 0 ? 'has-errors' : 'only-warnings'}">${errorCount > 0 ? 'Build Errors' : 'Build Warnings'}</h1>
      <span class="subtitle">${errorCount} errors, ${issues.length - errorCount} warnings</span>
      <span class="spacer"></span>
      <button id="reloadBtn">$(refresh) Rebuild</button>
    </div>
    ${sections}
    <script>
      const vscode = acquireVsCodeApi();

      document.getElementById('reloadBtn').addEventListener('click', function () {
        vscode.postMessage({ command: 'reload' });
      });

      document.querySelectorAll('.issue-row').forEach(function (row) {
        row.addEventListener('click', function (event) {
          if (event.target.closest('button')) { return; }
          const file = row.getAttribute('data-file');
          if (!file) { return; }
          vscode.postMessage({
            command: 'openFile',
            file: file,
            line: Number(row.getAttribute('data-line')) || undefined,
            issue: {
              code: row.getAttribute('data-code'),
              severity: row.getAttribute('data-severity'),
              message: row.getAttribute('data-message'),
              file: file,
              line: Number(row.getAttribute('data-line')) || undefined
            }
          });
        });
      });

      document.querySelectorAll('.fix-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const row = btn.closest('.issue-row');
          if (!row) { return; }
          vscode.postMessage({
            command: 'aiFix',
            issue: {
              code: row.getAttribute('data-code'),
              severity: row.getAttribute('data-severity'),
              message: row.getAttribute('data-message'),
              file: row.getAttribute('data-file'),
              line: Number(row.getAttribute('data-line')) || undefined
            }
          });
        });
      });

      document.querySelectorAll('.fix-file-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const issues = [];
          document.querySelectorAll('.issue-row[data-file]').forEach(function (row) {
            const file = row.getAttribute('data-file');
            if (!file) { return; }
            issues.push({
              code: row.getAttribute('data-code'),
              severity: row.getAttribute('data-severity'),
              message: row.getAttribute('data-message'),
              file: file,
              line: Number(row.getAttribute('data-line')) || undefined
            });
          });
          if (issues.length === 0) { return; }
          vscode.postMessage({ command: 'aiFixFile', issues: issues });
        });
      });
    </script>
  </body>
  </html>`;
}
