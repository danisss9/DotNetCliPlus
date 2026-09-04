import * as vscode from 'vscode';
import type { ProjectOutdatedPackages } from './types';
import { resolveDotnetWorkspace, pickBuildTarget, spawnDotnet } from './utils';
import { listOutdatedPackages } from './nuget';
import { nugetOutput } from './state';
import { escapeHtml, ANALYSIS_PANEL_CSP, createAnalysisPanel, type AnalysisPanel } from './webview-utils';

interface PackageUpdateRow {
  project: string;
  projectPath: string;
  id: string;
  current: string;
  latest: string;
}

interface WebviewMessage {
  command: 'reload' | 'update';
  packages?: PackageUpdateRow[];
}

interface PanelState {
  panel: AnalysisPanel;
  root: string;
}

export async function showPackageUpdates(): Promise<void> {
  const ws = await resolveDotnetWorkspace();
  if (!ws) {
    return;
  }
  const target = await pickBuildTarget(ws, '.NET: Update Packages', {
    allowSolution: true,
    commandKey: 'updatePackages',
  });
  if (!target) {
    return;
  }
  const targetPath = target.kind === 'solution' ? target.path : target.entry.csprojPath;
  const targetLabel = target.kind === 'solution' ? target.name : target.entry.name;

  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Checking outdated packages (${targetLabel})…`, cancellable: false },
    async () => {
      const outdated = await listOutdatedPackages(targetPath, ws.root);
      if (outdated.length === 0) {
        const fallback = await spawnDotnet(['list', targetPath, 'package', '--outdated'], ws.root, {
          channel: nugetOutput,
        });
        if (
          fallback.exitCode === 0 &&
          fallback.stdout.trim().length > 0 &&
          !/has no (updated|outdated) packages|no packages found/i.test(fallback.stdout)
        ) {
          nugetOutput.clear();
          nugetOutput.appendLine(`> dotnet list package --outdated (${targetLabel})`);
          nugetOutput.append(fallback.stdout);
          nugetOutput.show(true);
        }
      }
      return outdated;
    },
  );

  const state: PanelState = { panel: createAnalysisPanel('dotnetPackageUpdates', packageUpdatesTitle(results)), root: ws.root };
  renderInto(state, results, targetPath);
  state.panel.onMessage((message: WebviewMessage) => handleMessage(state, message, targetPath));
}

function packageUpdatesTitle(results: ProjectOutdatedPackages[]): string {
  const total = results.reduce((sum, r) => sum + r.packages.length, 0);
  return `Package Updates (${total})`;
}

function renderInto(state: PanelState, results: ProjectOutdatedPackages[], targetPath: string): void {
  state.panel.setTitle(packageUpdatesTitle(results));
  state.panel.setHtml(buildWebviewHtml(results, targetPath));
}

async function reloadPanel(state: PanelState, targetPath: string): Promise<void> {
  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Re-checking outdated packages…', cancellable: false },
    async () => listOutdatedPackages(targetPath, state.root),
  );
  renderInto(state, results, targetPath);
}

async function handleMessage(state: PanelState, message: WebviewMessage, targetPath: string): Promise<void> {
  switch (message.command) {
    case 'reload':
      await reloadPanel(state, targetPath);
      return;
    case 'update': {
      const packages = message.packages ?? [];
      if (packages.length === 0) {
        return;
      }
      let updated = 0;
      let failed = 0;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Updating ${packages.length} package${packages.length !== 1 ? 's' : ''}…`,
          cancellable: false,
        },
        async (progress) => {
          for (let i = 0; i < packages.length; i++) {
            const pkg = packages[i];
            progress.report({
              message: `${pkg.id} (${pkg.project}) ${i + 1}/${packages.length}`,
              increment: (1 / packages.length) * 100,
            });
            const result = await spawnDotnet(
              ['add', pkg.projectPath, 'package', pkg.id, '--version', pkg.latest],
              state.root,
              { channel: nugetOutput },
            );
            if (result.exitCode === 0) {
              updated++;
            } else {
              failed++;
            }
          }
        },
      );
      if (failed > 0) {
        vscode.window.showWarningMessage(
          `Updated ${updated}, failed ${failed}. See the DotNet CLI Plus: nuget output.`,
        );
      } else {
        vscode.window.showInformationMessage(`Updated ${updated} package${updated !== 1 ? 's' : ''}.`);
      }
      await reloadPanel(state, targetPath);
      return;
    }
  }
}

const RELOAD_SVG =
  '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13"><path d="M13.5 8A5.5 5.5 0 1 1 8 2.5c1.8 0 3.4.87 4.4 2.2L11 6h3.5V2.5L13 4a7 7 0 1 0 .5 4H13.5z" fill="currentColor"/></svg>';

function projectSection(project: ProjectOutdatedPackages): string {
  const rows = project.packages
    .map(
      (p) => /* html */ `
        <tr>
          <td class="check-cell"><input type="checkbox" class="pkg-check" data-project="${escapeHtml(project.project)}" data-path="${escapeHtml(project.projectPath)}" data-id="${escapeHtml(p.id)}" data-current="${escapeHtml(p.current)}" data-latest="${escapeHtml(p.latest)}" checked></td>
          <td class="name-cell">${escapeHtml(p.id)}</td>
          <td class="ver-cell current">${escapeHtml(p.current)}</td>
          <td class="arrow-cell">→</td>
          <td class="ver-cell latest">${escapeHtml(p.latest)}</td>
        </tr>`,
    )
    .join('');

  return /* html */ `
    <div class="section">
      <div class="section-header">
        <h2>${escapeHtml(project.project)}</h2>
        <span class="count-badge">${project.packages.length}</span>
        <span class="section-subtitle">${escapeHtml(project.projectPath)}</span>
        <button class="update-btn" data-project="${escapeHtml(project.project)}">Update checked</button>
      </div>
      <table class="pkg-table">
        <thead>
          <tr>
            <th class="check-cell"><input type="checkbox" class="select-all" data-project="${escapeHtml(project.project)}" checked></th>
            <th class="name-cell">Package</th>
            <th class="ver-cell">Current</th>
            <th class="arrow-cell"></th>
            <th class="ver-cell">Latest</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function buildWebviewHtml(results: ProjectOutdatedPackages[], targetPath: string): string {
  const total = results.reduce((sum, r) => sum + r.packages.length, 0);
  const body =
    total === 0
      ? /* html */ `<div class="all-clear">
          <h1>All NuGet packages are up to date</h1>
          <button class="reload-btn" id="reloadBtn">${RELOAD_SVG}Check again</button>
        </div>`
      : results.map(projectSection).join('');

  return /* html */ `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${ANALYSIS_PANEL_CSP}">
    <title>Package Updates</title>
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
      .badge {
        display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 18px;
        padding: 0 6px; border-radius: 9px; font-size: 0.75em; font-weight: 700;
        background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
      }
      .subtitle { font-size: 0.82em; color: var(--vscode-descriptionForeground); }
      .spacer { flex: 1; }
      .reload-btn, .update-btn {
        display: inline-flex; align-items: center; gap: 5px; padding: 4px 12px;
        border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px;
        font-size: 0.8em; font-family: var(--vscode-font-family); cursor: pointer; white-space: nowrap;
      }
      .reload-btn {
        background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.15));
        color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      }
      .reload-btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.25)); }
      .update-btn {
        margin-left: auto;
        background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      }
      .update-btn:hover { background: var(--vscode-button-hoverBackground); }
      .update-btn:disabled { opacity: 0.5; cursor: default; }
      .section { margin-bottom: 28px; }
      .section-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
      h2 { font-size: 1em; font-weight: 600; }
      .count-badge {
        font-size: 0.72em; font-weight: 700; padding: 1px 8px; border-radius: 8px;
        background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
      }
      .section-subtitle { font-size: 0.78em; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); }
      .pkg-table { width: 100%; border-collapse: collapse; border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: hidden; }
      .pkg-table thead th {
        text-align: left; font-size: 0.75em; font-weight: 600; text-transform: uppercase;
        color: var(--vscode-descriptionForeground);
        padding: 8px 12px; background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.08));
        border-bottom: 1px solid var(--vscode-panel-border);
      }
      .pkg-table tbody tr { border-bottom: 1px solid var(--vscode-panel-border); }
      .pkg-table tbody tr:last-child { border-bottom: none; }
      .pkg-table tbody tr:hover { background: var(--vscode-list-hoverBackground); }
      .pkg-table td { padding: 7px 12px; font-size: 0.88em; vertical-align: middle; }
      .check-cell { width: 28px; text-align: center; }
      .name-cell { font-family: var(--vscode-editor-font-family, monospace); }
      .ver-cell { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; white-space: nowrap; }
      .ver-cell.current { color: var(--vscode-descriptionForeground); }
      .ver-cell.latest { color: var(--vscode-testing-iconPassed, #4ec27a); }
      .arrow-cell { color: var(--vscode-descriptionForeground); text-align: center; width: 24px; }
      .all-clear { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 60px 0; text-align: center; }
    </style>
  </head>
  <body>
    <div class="header">
      <h1>NuGet Package Updates</h1>
      <span class="badge">${total}</span>
      <span class="subtitle">${escapeHtml(targetPath)}</span>
      <span class="spacer"></span>
      ${total > 0 ? '<button class="update-btn" id="updateAllBtn">Update all</button>' : ''}
      <button class="reload-btn" id="reloadBtn">${RELOAD_SVG}Reload</button>
    </div>
    ${body}
    <script>
      const vscode = acquireVsCodeApi();

      document.getElementById('reloadBtn').addEventListener('click', function () {
        vscode.postMessage({ command: 'reload' });
      });

      const updateAllBtn = document.getElementById('updateAllBtn');
      if (updateAllBtn) {
        updateAllBtn.addEventListener('click', function () {
          sendUpdate(document.querySelectorAll('.pkg-check'));
        });
      }

      function sendUpdate(checkboxes) {
        const packages = [];
        checkboxes.forEach(function (cb) {
          if (cb.checked) {
            packages.push({
              project: cb.getAttribute('data-project'),
              projectPath: cb.getAttribute('data-path'),
              id: cb.getAttribute('data-id'),
              current: cb.getAttribute('data-current'),
              latest: cb.getAttribute('data-latest')
            });
          }
        });
        if (packages.length === 0) { return; }
        vscode.postMessage({ command: 'update', packages: packages });
      }

      document.querySelectorAll('.select-all').forEach(function (master) {
        master.addEventListener('change', function () {
          const project = master.getAttribute('data-project');
          document.querySelectorAll('.pkg-check[data-project="' + project + '"]').forEach(function (cb) {
            cb.checked = master.checked;
          });
        });
      });

      document.querySelectorAll('.update-btn[data-project]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const project = btn.getAttribute('data-project');
          sendUpdate(document.querySelectorAll('.pkg-check[data-project="' + project + '"]'));
        });
      });
    </script>
  </body>
  </html>`;
}
