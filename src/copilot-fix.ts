import * as vscode from 'vscode';

export type AIProvider = 'copilot' | 'claude';

export interface AIFixIssue {
  line: number;
  kind: string;
  kindLabel: string;
  snippet: string;
  description: string;
  fixHint: string;
}

export interface AIFixOptions extends AIFixIssue {
  file: string;
}

export interface AIFixFileOptions {
  file: string;
  issues: AIFixIssue[];
  issueType: string;
}

export function getAIProvider(): AIProvider {
  const config = vscode.workspace.getConfiguration('dotnetCliPlus');
  const provider = config.get<string>('ai.provider', 'copilot');
  return provider === 'claude' ? 'claude' : 'copilot';
}

export function isAutoFixEnabled(): boolean {
  return vscode.workspace.getConfiguration('dotnetCliPlus').get<boolean>('ai.autoFixEnabled', true);
}

export async function sendAIAutoFix(opts: AIFixOptions): Promise<void> {
  const prompt = buildSinglePrompt(opts);
  await openAIChatWithPrompt(prompt, getAIProvider());
}

export async function sendAIAutoFixForFile(opts: AIFixFileOptions): Promise<void> {
  const prompt = buildFilePrompt(opts);
  await openAIChatWithPrompt(prompt, getAIProvider());
}

async function openAIChatWithPrompt(prompt: string, provider: AIProvider): Promise<void> {
  const providerName = provider === 'claude' ? 'Claude Code' : 'GitHub Copilot';

  try {
    if (provider === 'claude') {
      await vscode.commands.executeCommand(
        'claude-vscode.editor.open',
        undefined,
        prompt,
        vscode.ViewColumn.Active,
      );
    } else {
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: prompt,
      });
    }
  } catch {
    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showWarningMessage(
      `${providerName} does not appear to be available. The fix prompt has been copied to your clipboard.`,
    );
  }
}

function buildSinglePrompt(opts: AIFixOptions): string {
  return [
    `**[DotNet CLI Plus] Auto Fix — ${opts.kindLabel}**`,
    ``,
    `**File:** \`${opts.file}\` (Line ${opts.line})`,
    `**Issue type:** ${opts.kindLabel} (\`${opts.kind}\`)`,
    ``,
    `**Code snippet (line ${opts.line}):**`,
    '```csharp',
    opts.snippet.trim(),
    '```',
    ``,
    `**Problem:** ${opts.description}`,
    ``,
    `**Fix:** ${opts.fixHint}`,
    ``,
    `Please open \`${opts.file}\`, locate line ${opts.line}, and apply the fix described above. ` +
      `Ensure the change is minimal and correct. Do not alter unrelated code.`,
  ].join('\n');
}

function buildFilePrompt(opts: AIFixFileOptions): string {
  const issueCount = opts.issues.length;
  const issueLines = opts.issues
    .map(
      (issue, i) =>
        [
          `### Issue ${i + 1} — ${issue.kindLabel} (Line ${issue.line})`,
          ``,
          `**Code snippet:**`,
          '```csharp',
          issue.snippet.trim(),
          '```',
          ``,
          `**Problem:** ${issue.description}`,
          `**Fix:** ${issue.fixHint}`,
        ].join('\n'),
    )
    .join('\n\n');

  return [
    `**[DotNet CLI Plus] Auto Fix All — ${issueCount} ${opts.issueType}${issueCount !== 1 ? 's' : ''} in \`${opts.file}\`**`,
    ``,
    issueLines,
    ``,
    `Please open \`${opts.file}\` and fix all ${issueCount} issue${issueCount !== 1 ? 's' : ''} listed above. ` +
      `Apply each fix at the correct line. Ensure changes are minimal and correct. Do not alter unrelated code.`,
  ].join('\n');
}
