import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EXCLUDE_GLOB } from './utils';
import {
  isCodeBehindFile,
  markupCompanionCandidates,
  sourceBaseForTestFile,
  testFileCandidates,
} from './pure-utils';

interface FileItem extends vscode.QuickPickItem {
  filePath: string;
}

function codiconFor(filePath: string): string {
  const name = path.basename(filePath).toLowerCase();
  if (/tests?\.cs$|facts\.cs$/.test(name)) {
    return '$(beaker)';
  }
  if (name.endsWith('.razor') || name.endsWith('.razor.cs')) {
    return '$(flame)';
  }
  if (name.endsWith('.xaml') || name.endsWith('.xaml.cs')) {
    return '$(preview)';
  }
  if (name.endsWith('.cshtml') || name.endsWith('.cshtml.cs')) {
    return '$(symbol-misc)';
  }
  if (name.endsWith('.cs')) {
    return '$(symbol-class)';
  }
  return '$(file)';
}

async function searchWorkspace(pattern: string): Promise<string[]> {
  const uris = await vscode.workspace.findFiles(pattern, EXCLUDE_GLOB, 10);
  return uris.map((u) => u.fsPath);
}

export async function switchFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('Open a file first.');
    return;
  }
  const currentPath = editor.document.uri.fsPath;
  const fileName = path.basename(currentPath);
  const dir = path.dirname(currentPath);
  const column = editor.viewColumn ?? vscode.ViewColumn.Active;

  const candidates = new Set<string>();
  const currentKey = process.platform === 'win32' ? currentPath.toLowerCase() : currentPath;

  for (const companion of markupCompanionCandidates(fileName)) {
    const candidate = path.join(dir, companion);
    if (fs.existsSync(candidate)) {
      candidates.add(candidate);
    }
  }

  for (const pattern of testFileCandidates(fileName)) {
    const sibling = path.join(dir, pattern);
    if (fs.existsSync(sibling)) {
      candidates.add(sibling);
    } else {
      for (const found of await searchWorkspace(`**/${pattern}`)) {
        candidates.add(found);
      }
    }
  }

  const sourceBase = sourceBaseForTestFile(fileName);
  if (sourceBase) {
    for (const found of await searchWorkspace(`**/${sourceBase}.cs`)) {
      candidates.add(found);
    }
  }

  const valid = [...candidates].filter(
    (c) => (process.platform === 'win32' ? c.toLowerCase() : c) !== currentKey && fs.existsSync(c),
  );

  if (valid.length === 0) {
    vscode.window.showInformationMessage(`No companion file found for "${fileName}".`);
    return;
  }

  let chosen: string;
  if (valid.length === 1) {
    chosen = valid[0];
  } else {
    const items: FileItem[] = valid.map((filePath) => ({
      label: `${codiconFor(filePath)}  ${path.basename(filePath)}`,
      description: vscode.workspace.asRelativePath(filePath, false),
      filePath,
    }));
    items.sort((a, b) => a.label.localeCompare(b.label));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Switch to file',
      title: `Companions of ${fileName}`,
      matchOnDescription: true,
    });
    if (!picked) {
      return;
    }
    chosen = picked.filePath;
  }

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(chosen));
  void vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });
}
