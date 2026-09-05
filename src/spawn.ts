import * as cp from 'child_process';
import { quoteShellPath } from './pure-utils';

const activeChildren = new Set<cp.ChildProcess>();

export interface SpawnManagedOptions {
  cwd: string;
  shell: boolean;
  timeoutMs?: number;
  quoteCommand?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  cancellation?: SpawnCancellation;
}

export interface SpawnCancellation {
  onCancellationRequested: (callback: () => void) => void;
  offCancellationRequested?: (callback: () => void) => void;
  isCancellationRequested: () => boolean;
}

export interface SpawnManagedResult {
  stdout: string;
  exitCode: number;
}

export function spawnManaged(
  command: string,
  args: string[],
  options: SpawnManagedOptions,
): Promise<SpawnManagedResult> {
  return new Promise((resolve) => {
    const spawnCommand =
      options.shell && options.quoteCommand !== false ? quoteShellPath(command) : command;
    const proc = cp.spawn(spawnCommand, args, { cwd: options.cwd, shell: options.shell });
    activeChildren.add(proc);

    const cancellation = options.cancellation;
    const cancelCallback = () => proc.kill();
    if (cancellation) {
      if (cancellation.isCancellationRequested()) {
        proc.kill();
      } else {
        cancellation.onCancellationRequested(cancelCallback);
      }
    }

    let out = '';
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    if (options.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        if (!settled) {
          proc.kill();
        }
      }, options.timeoutMs);
    }

    const finish = (result: SpawnManagedResult) => {
      if (settled) {
        return;
      }
      settled = true;
      activeChildren.delete(proc);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      cancellation?.offCancellationRequested?.(cancelCallback);
      resolve(result);
    };

    proc.stdout?.on('data', (d: Buffer) => {
      const text = d.toString();
      out += text;
      options.onStdout?.(text);
    });
    proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString();
      out += text;
      options.onStderr?.(text);
    });
    proc.on('error', (err) => {
      finish({ stdout: out || `Failed to start process: ${err.message}`, exitCode: 1 });
    });
    proc.on('close', (code) => {
      finish({ stdout: out, exitCode: code ?? 1 });
    });
  });
}

export function killAllManagedChildren(): void {
  for (const proc of activeChildren) {
    proc.kill();
  }
  activeChildren.clear();
}
