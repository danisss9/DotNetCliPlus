import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { DotnetTemplate } from './types';
import { findSolutionFiles, invalidateCsprojCache, pickWorkspaceRoot, spawnDotnet } from './utils';
import { getSdks } from './sdk';
import {
  extractJsonObject,
  parseNewListJson,
  parseNewListText,
  validateProjectName,
} from './pure-utils';

const TEMPLATE_CACHE_TTL_MS = 10 * 60 * 1000;

const templateCache = new Map<string, { templates: DotnetTemplate[]; at: number }>();

export function invalidateTemplateCache(): void {
  templateCache.clear();
}

export async function getTemplates(root: string, force = false): Promise<DotnetTemplate[]> {
  const cached = templateCache.get(root);
  if (!force && cached && Date.now() - cached.at < TEMPLATE_CACHE_TTL_MS) {
    return cached.templates;
  }
  const jsonResult = await spawnDotnet(['new', 'list', '--format', 'json'], root, { timeoutMs: 30000 });
  let templates: DotnetTemplate[] = [];
  const jsonText = extractJsonObject(jsonResult.stdout);
  if (jsonText) {
    try {
      templates = parseNewListJson(JSON.parse(jsonText) as unknown);
    } catch {
      templates = [];
    }
  }
  if (templates.length === 0) {
    const textResult = await spawnDotnet(['new', 'list'], root, { timeoutMs: 30000 });
    templates = parseNewListText(textResult.stdout);
  }
  templateCache.set(root, { templates, at: Date.now() });
  return templates;
}

const CATEGORY_ORDER = ['Common', 'Web', 'Test', 'Desktop', 'Services', 'Mobile', 'Files', 'Solution', 'Other'];

export async function runNewProjectWizard(): Promise<void> {
  const root = await pickWorkspaceRoot();
  if (!root) {
    return;
  }

  const templates = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Loading dotnet templates…', cancellable: false },
    async () => getTemplates(root),
  );

  const projectTemplates = templates.filter(
    (t) => t.type === 'project' && t.category !== 'Files' && t.category !== 'Solution',
  );
  if (projectTemplates.length === 0) {
    vscode.window.showErrorMessage('No project templates found. Is the dotnet SDK installed?');
    return;
  }

  type TemplateItem = vscode.QuickPickItem & { template?: DotnetTemplate };
  const items: TemplateItem[] = [];
  const byCategory = new Map<string, DotnetTemplate[]>();
  for (const template of projectTemplates) {
    const list = byCategory.get(template.category) ?? [];
    list.push(template);
    byCategory.set(template.category, list);
  }
  const categories = [...byCategory.keys()].sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a);
    const ib = CATEGORY_ORDER.indexOf(b);
    return (ia === -1 ? CATEGORY_ORDER.length : ia) - (ib === -1 ? CATEGORY_ORDER.length : ib) || a.localeCompare(b);
  });
  for (const category of categories) {
    items.push({ label: `$(folder) ${category}`, template: undefined });
    for (const template of byCategory.get(category) ?? []) {
      items.push({
        label: `    ${template.name}`,
        description: `dotnet new ${template.shortName}`,
        detail: template.languages.join(', '),
        template,
      });
    }
  }

  const quickPick = vscode.window.createQuickPick<TemplateItem>();
  quickPick.items = items;
  quickPick.placeholder = 'Select a project template';
  quickPick.title = '.NET: New Project';
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.activeItems = [items.find((i) => i.template) ?? items[0]];

  const chosen = await new Promise<DotnetTemplate | undefined>((resolve) => {
    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
      if (selected?.template) {
        resolve(selected.template);
        quickPick.hide();
      }
    });
    quickPick.onDidHide(() => resolve(undefined));
    quickPick.show();
  });
  quickPick.dispose();
  if (!chosen) {
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: `Project name (${chosen.name})`,
    validateInput: (value) => validateProjectName(value),
  });
  if (!name) {
    return;
  }

  const outputRootSetting = vscode.workspace.getConfiguration('dotnetCliPlus').get<string>('newProject.outputRoot', '');
  const defaultOutput = path.resolve(root, outputRootSetting && outputRootSetting.trim().length > 0 ? outputRootSetting.trim() : '.');
  const outputDir = await vscode.window.showInputBox({
    prompt: 'Output directory (absolute or relative to the workspace root)',
    value: defaultOutput,
  });
  if (!outputDir) {
    return;
  }

  const sdks = await getSdks(root);
  const majors = [...new Set(sdks.map((s) => s.version.split('.')[0]))].sort((a, b) => Number(b) - Number(a));
  const tfmItems: Array<{ label: string; description?: string; tfm: string | null }> = [
    { label: '$(slash)  Default', description: 'use the template default (latest)', tfm: null },
    ...majors.map((major) => ({ label: `net${major}.0`, tfm: `net${major}.0` })),
  ];
  const tfmPick = await vscode.window.showQuickPick(tfmItems, {
    placeHolder: 'Target framework (-f)',
  });
  if (!tfmPick) {
    return;
  }

  const args = [
    'new',
    chosen.shortName,
    '-n',
    name.trim(),
    '-o',
    outputDir.trim(),
    ...(tfmPick.tfm ? ['-f', tfmPick.tfm] : []),
  ];
  const result = await spawnDotnet(args, root, { reveal: true });
  if (result.exitCode !== 0) {
    vscode.window.showErrorMessage(`dotnet new ${chosen.shortName} failed. See the DotNet CLI Plus: dotnet output.`);
    return;
  }
  invalidateCsprojCache();

  const expectedCsproj = path.resolve(root, outputDir.trim(), `${name.trim()}.csproj`);
  await offerAddToSolution(root, [expectedCsproj]);
  vscode.window.showInformationMessage(`Project ${name} created.`);
}

async function offerAddToSolution(root: string, csprojPaths: string[]): Promise<void> {
  const addToSolution = vscode.workspace
    .getConfiguration('dotnetCliPlus')
    .get<boolean>('newProject.addToSolution', true);
  if (!addToSolution) {
    return;
  }
  const existing = csprojPaths.filter((p) => fs.existsSync(p) && p.toLowerCase().endsWith('.csproj'));
  if (existing.length === 0) {
    return;
  }
  const candidates = await findSolutionFiles(root);
  if (candidates.length === 0) {
    return;
  }
  const slnPath = candidates.length === 1 ? candidates[0] : candidates.find((c) => path.dirname(c) === root) ?? candidates[0];
  const confirm = await vscode.window.showInformationMessage(
    `Add ${existing.length === 1 ? path.basename(existing[0]) : `${existing.length} projects`} to ${path.basename(slnPath)}?`,
    'Add to solution',
  );
  if (confirm !== 'Add to solution') {
    return;
  }
  const result = await spawnDotnet(['sln', slnPath, 'add', ...existing], root, { reveal: true });
  invalidateCsprojCache();
  if (result.exitCode === 0) {
    vscode.window.showInformationMessage(`Added to ${path.basename(slnPath)}.`);
  } else {
    vscode.window.showErrorMessage('dotnet sln add failed. See the DotNet CLI Plus: dotnet output.');
  }
}

const FILE_TEMPLATE_OUTPUT: Record<string, string> = {
  gitignore: '.gitignore',
  editorconfig: '.editorconfig',
  globaljson: 'global.json',
  nugetconfig: 'nuget.config',
};

const NO_NAME_TEMPLATES = new Set(Object.keys(FILE_TEMPLATE_OUTPUT));

export async function generateTemplate(shortName: string, label: string, uri?: vscode.Uri): Promise<void> {
  const targetDir = uri?.fsPath ?? (await pickWorkspaceRoot());
  if (!targetDir) {
    return;
  }

  let name: string | undefined;
  if (!NO_NAME_TEMPLATES.has(shortName)) {
    name = await vscode.window.showInputBox({
      prompt: `${label} — project name`,
      validateInput: (value) => validateProjectName(value),
    });
    if (!name) {
      return;
    }
    name = name.trim();
  }

  const confirm = await vscode.window.showInformationMessage(
    name
      ? `Create "${name}" (${label}) in ${path.basename(targetDir)}?`
      : `Create ${label} in ${path.basename(targetDir)}?`,
    'Create',
  );
  if (confirm !== 'Create') {
    return;
  }

  const args = ['new', shortName, ...(name ? ['-n', name] : [])];
  const result = await spawnDotnet(args, targetDir, { reveal: true });
  if (result.exitCode !== 0) {
    vscode.window.showErrorMessage(`dotnet new ${shortName} failed. See the DotNet CLI Plus: dotnet output.`);
    return;
  }
  invalidateCsprojCache();

  if (name) {
    const expectedCsproj = path.join(targetDir, name, `${name}.csproj`);
    if (fs.existsSync(expectedCsproj)) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(targetDir));
      await offerAddToSolution(workspaceFolder?.uri.fsPath ?? targetDir, [expectedCsproj]);
    }
  } else {
    const created = FILE_TEMPLATE_OUTPUT[shortName];
    if (created) {
      const filePath = path.join(targetDir, created);
      if (fs.existsSync(filePath)) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        void vscode.window.showTextDocument(doc);
      }
    }
  }
  vscode.window.showInformationMessage(`${label} created.`);
}
