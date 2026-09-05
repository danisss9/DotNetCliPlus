import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  dotnetOutput,
  nugetOutput,
  diagnosticOutput,
  clearTrackedTerminalState,
  extensionTerminals,
  setTrackedTerminalFinished,
  setTrackedTerminalRunning,
  setExtensionContext,
  loadPersistedTerminalEntries,
  removePersistedTerminalEntry,
} from './state';
import { invalidateCsprojCache, EXCLUDE_GLOB } from './utils';
import { killAllManagedChildren } from './spawn';
import {
  restorePackages,
  buildTarget,
  cleanTarget,
  runProject,
  watchProject,
  testProject,
  formatProject,
  clearFinishedTerminals,
} from './commands';
import { manageSolution } from './solutions';
import { runNewProjectWizard, generateTemplate, invalidateTemplateCache } from './templates';
import { manageNuGetPackages } from './nuget';
import { showPackageUpdates } from './package-updates';
import { addProjectReference, removeProjectReference, listProjectReferences } from './references';
import { debugProject } from './debug';
import { runLaunchProfile } from './launch-profiles';
import { switchFile } from './switch-file';
import { checkBuildErrors } from './build-errors';
import { manageUserSecrets } from './user-secrets';
import { manageSdks, checkDotnetOnStartup } from './sdk';
import { setupNuGetAuth } from './nuget-auth';
import { manageConfigs } from './config-manager';
import { publishProject } from './publish';
import { activateTestExplorer, clearCoverageBaseline, refreshAllTests } from './testing/test-controller';
import { setupRestoreCheck, teardownRestoreCheck, teardownAllRestoreChecks } from './restore-check';
import {
  SolutionExplorerProvider,
  asBuildTargetArg,
  asProjectTarget,
  asRefPath,
} from './solution-explorer';

const NEW_TEMPLATE_COMMANDS: Array<{ short: string; label: string }> = [
  { short: 'console', label: 'Console App' },
  { short: 'classlib', label: 'Class Library' },
  { short: 'xunit', label: 'xUnit Test Project' },
  { short: 'nunit', label: 'NUnit Test Project' },
  { short: 'mstest', label: 'MSTest Test Project' },
  { short: 'webapi', label: 'Web API' },
  { short: 'web', label: 'ASP.NET Core Empty' },
  { short: 'webapp', label: 'Razor Pages App' },
  { short: 'mvc', label: 'MVC App' },
  { short: 'blazor', label: 'Blazor Web App' },
  { short: 'worker', label: 'Worker Service' },
  { short: 'grpc', label: 'gRPC Service' },
  { short: 'gitignore', label: '.gitignore' },
  { short: 'editorconfig', label: '.editorconfig' },
  { short: 'globaljson', label: 'global.json' },
  { short: 'nugetconfig', label: 'nuget.config' },
  { short: 'sln', label: 'Solution' },
];

function folderLooksLikeDotnet(root: string): boolean {
  try {
    const entries = fs.readdirSync(root);
    return entries.some(
      (entry) =>
        entry.toLowerCase().endsWith('.sln') ||
        entry.toLowerCase().endsWith('.slnx') ||
        entry.toLowerCase().endsWith('.csproj') ||
        entry.toLowerCase().endsWith('.fsproj') ||
        entry.toLowerCase().endsWith('.vbproj'),
    );
  } catch {
    return false;
  }
}

export function activate(context: vscode.ExtensionContext) {
  setExtensionContext(context);
  activateTestExplorer(context);

  const persisted = loadPersistedTerminalEntries();
  for (const name of Object.keys(persisted)) {
    removePersistedTerminalEntry(name);
  }

  for (const template of NEW_TEMPLATE_COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`dotnet-cli-plus.new.${template.short}`, (uri?: vscode.Uri) =>
        generateTemplate(template.short, template.label, uri),
      ),
    );
  }

  context.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution((event) => {
      if (extensionTerminals.has(event.terminal)) {
        setTrackedTerminalRunning(event.terminal);
      }
    }),
    vscode.window.onDidEndTerminalShellExecution((event) => {
      if (extensionTerminals.has(event.terminal)) {
        setTrackedTerminalFinished(event.terminal, event.exitCode);
      }
    }),
    vscode.commands.registerCommand('dotnet-cli-plus.runProject', (node?: unknown) => runProject(asProjectTarget(node))),
    vscode.commands.registerCommand('dotnet-cli-plus.debugProject', (node?: unknown) => debugProject(asProjectTarget(node))),
    vscode.commands.registerCommand('dotnet-cli-plus.watchProject', (node?: unknown) => watchProject(asProjectTarget(node))),
    vscode.commands.registerCommand('dotnet-cli-plus.buildTarget', (node?: unknown) => buildTarget(false, asBuildTargetArg(node))),
    vscode.commands.registerCommand('dotnet-cli-plus.rebuildTarget', (node?: unknown) => buildTarget(true, asBuildTargetArg(node))),
    vscode.commands.registerCommand('dotnet-cli-plus.cleanTarget', (node?: unknown) => cleanTarget(asBuildTargetArg(node))),
    vscode.commands.registerCommand('dotnet-cli-plus.restoreSolution', (node?: unknown) => restorePackages(asBuildTargetArg(node))),
    vscode.commands.registerCommand('dotnet-cli-plus.testTarget', (node?: unknown) => testProject(asBuildTargetArg(node))),
    vscode.commands.registerCommand('dotnet-cli-plus.formatProject', (node?: unknown) => formatProject(asBuildTargetArg(node))),
    vscode.commands.registerCommand('dotnet-cli-plus.newProject', () => runNewProjectWizard()),
    vscode.commands.registerCommand('dotnet-cli-plus.manageNuGetPackages', (node?: unknown) => manageNuGetPackages(asProjectTarget(node))),
    vscode.commands.registerCommand('dotnet-cli-plus.updatePackages', () => showPackageUpdates()),
    vscode.commands.registerCommand('dotnet-cli-plus.manageSolution', () => manageSolution()),
    vscode.commands.registerCommand('dotnet-cli-plus.checkBuildErrors', () => checkBuildErrors()),
    vscode.commands.registerCommand('dotnet-cli-plus.runLaunchProfile', () => runLaunchProfile()),
    vscode.commands.registerCommand('dotnet-cli-plus.manageUserSecrets', (node?: unknown) => manageUserSecrets(asProjectTarget(node))),
    vscode.commands.registerCommand('dotnet-cli-plus.manageSdks', () => manageSdks()),
    vscode.commands.registerCommand('dotnet-cli-plus.setupNuGetAuth', () => setupNuGetAuth()),
    vscode.commands.registerCommand('dotnet-cli-plus.manageConfigs', () => manageConfigs()),
    vscode.commands.registerCommand('dotnet-cli-plus.publishProject', (node?: unknown) => publishProject(asProjectTarget(node))),
    vscode.commands.registerCommand('dotnet-cli-plus.switchFile', () => switchFile()),
    vscode.commands.registerCommand('dotnet-cli-plus.clearTerminals', () => clearFinishedTerminals()),
    vscode.commands.registerCommand('dotnet-cli-plus.addProjectReference', (node?: unknown) => addProjectReference(asProjectTarget(node))),
    vscode.commands.registerCommand('dotnet-cli-plus.removeProjectReference', (node?: unknown) => removeProjectReference(asProjectTarget(node), asRefPath(node))),
    vscode.commands.registerCommand('dotnet-cli-plus.listProjectReferences', () => listProjectReferences()),
    vscode.commands.registerCommand('dotnet-cli-plus.refreshTests', () => refreshAllTests()),
    vscode.commands.registerCommand('dotnet-cli-plus.clearCoverageBaseline', () => clearCoverageBaseline()),
    vscode.commands.registerCommand('dotnet-cli-plus.openCommandPalette', () =>
      vscode.commands.executeCommand('workbench.action.quickOpen', '>DotNet CLI Plus'),
    ),
  );

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.name = 'DotNet CLI Plus';
  statusBarItem.text = 'dotnet CLI +';
  statusBarItem.tooltip = 'Open the command palette with DotNet CLI Plus commands';
  statusBarItem.command = 'dotnet-cli-plus.openCommandPalette';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const solutionExplorerProvider = new SolutionExplorerProvider();
  context.subscriptions.push(
    solutionExplorerProvider,
    vscode.window.createTreeView('dotnet-cli-plus.solutionExplorer', {
      treeDataProvider: solutionExplorerProvider,
      showCollapseAll: true,
    }),
    vscode.commands.registerCommand('dotnet-cli-plus.solutionExplorer.refresh', () =>
      solutionExplorerProvider.refresh(),
    ),
  );

  const projectFileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{sln,slnx,csproj,fsproj,vbproj}');
  context.subscriptions.push(
    projectFileWatcher,
    projectFileWatcher.onDidChange((uri) => invalidateCsprojCache(uri.fsPath)),
    projectFileWatcher.onDidCreate(() => {
      invalidateCsprojCache();
      invalidateTemplateCache();
    }),
    projectFileWatcher.onDidDelete((uri) => invalidateCsprojCache(uri.fsPath)),
  );

  const setupFolder = (root: string) => {
    setupRestoreCheck(context, root);
    if (folderLooksLikeDotnet(root)) {
      void checkDotnetOnStartup(root);
    } else {
      void vscode.workspace.findFiles('**/*.csproj', EXCLUDE_GLOB, 1).then((uris) => {
        if (uris.length > 0) {
          void checkDotnetOnStartup(root);
        }
      });
    }
  };

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    setupFolder(folder.uri.fsPath);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const folder of e.added) {
        setupFolder(folder.uri.fsPath);
      }
      for (const folder of e.removed) {
        teardownRestoreCheck(folder.uri.fsPath);
      }
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      clearTrackedTerminalState(terminal);
    }),
  );

  context.subscriptions.push(dotnetOutput, nugetOutput, diagnosticOutput);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dotnetCliPlus.restoreCheck.enabled')) {
        const enabled = vscode.workspace
          .getConfiguration('dotnetCliPlus')
          .get<boolean>('restoreCheck.enabled', true);
        if (enabled) {
          for (const folder of vscode.workspace.workspaceFolders ?? []) {
            setupRestoreCheck(context, folder.uri.fsPath);
          }
        } else {
          teardownAllRestoreChecks();
        }
      }
      if (e.affectsConfiguration('dotnetCliPlus.sdk.checkOnStartup')) {
        const enabled = vscode.workspace
          .getConfiguration('dotnetCliPlus')
          .get<boolean>('sdk.checkOnStartup', true);
        if (enabled) {
          for (const folder of vscode.workspace.workspaceFolders ?? []) {
            if (folderLooksLikeDotnet(folder.uri.fsPath)) {
              void checkDotnetOnStartup(folder.uri.fsPath);
            }
          }
        }
      }
    }),
  );
}

export function deactivate() {
  teardownAllRestoreChecks();
  killAllManagedChildren();
}
