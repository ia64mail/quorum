import { resolve, relative } from 'node:path';
import type { RoleToolProfile } from './role-tool-profiles';
import { WRITE_TOOLS } from './role-tool-profiles';

export interface ToolGuardResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Creates a PreToolUse-compatible hook that enforces both bash command
 * filtering and write path restrictions for a given role's profile.
 *
 * @param profile  The role's tool permission profile.
 * @param workspaceDir  Absolute path to the workspace root (e.g. /mnt/quorum/workspace).
 */
export function createToolGuardHook(
  profile: RoleToolProfile,
  workspaceDir: string,
): (toolName: string, toolInput: Record<string, unknown>) => ToolGuardResult {
  const deniedPrefixes = profile.deniedBashCommands.map((p) => p.toLowerCase());
  const writePaths = profile.allowedWritePaths;

  return (
    toolName: string,
    toolInput: Record<string, unknown>,
  ): ToolGuardResult => {
    // --- Bash command filtering ---
    if (toolName === 'Bash') {
      const raw = toolInput.command;
      if (typeof raw !== 'string') {
        return { allowed: true };
      }

      const normalised = normaliseBashCommand(raw);

      for (const prefix of deniedPrefixes) {
        if (normalised.startsWith(prefix)) {
          return {
            allowed: false,
            reason: `Denied bash command: "${prefix}"`,
          };
        }
      }

      return { allowed: true };
    }

    // --- Write path filtering ---
    if (
      writePaths !== undefined &&
      WRITE_TOOLS.includes(toolName as (typeof WRITE_TOOLS)[number])
    ) {
      const filePath = extractFilePath(toolInput);
      if (filePath === undefined) {
        return { allowed: true };
      }

      const relPath = toWorkspaceRelative(filePath, workspaceDir);
      if (relPath === undefined) {
        return {
          allowed: false,
          reason: `Path is outside workspace: "${filePath}"`,
        };
      }

      const allowed = writePaths.some((prefix) => relPath.startsWith(prefix));
      if (!allowed) {
        return {
          allowed: false,
          reason: `This role can only write to: ${writePaths.join(', ')}`,
        };
      }
    }

    return { allowed: true };
  };
}

/**
 * Normalise a bash command string for prefix matching:
 * - collapse whitespace
 * - strip leading `sudo`
 * - lowercase
 */
function normaliseBashCommand(raw: string): string {
  let cmd = raw.replace(/\s+/g, ' ').trim().toLowerCase();

  if (cmd.startsWith('sudo ')) {
    cmd = cmd.slice(5).trimStart();
  }

  return cmd;
}

/** Extract the file path from a write-tool's input. */
function extractFilePath(
  toolInput: Record<string, unknown>,
): string | undefined {
  // FileWrite / FileEdit / NotebookEdit all use `file_path` or `filePath`
  const candidate = toolInput.file_path ?? toolInput.filePath;
  return typeof candidate === 'string' ? candidate : undefined;
}

/**
 * Resolve a file path to a workspace-relative form.
 * Returns undefined if the resolved path is outside the workspace.
 */
function toWorkspaceRelative(
  filePath: string,
  workspaceDir: string,
): string | undefined {
  const resolved = resolve(workspaceDir, filePath);
  const rel = relative(workspaceDir, resolved);

  // Outside workspace: relative path starts with '..'
  if (rel.startsWith('..') || resolve(rel) === resolved) {
    // Second check: absolute path that doesn't share the workspace prefix
    if (!resolved.startsWith(workspaceDir)) {
      return undefined;
    }
  }

  // Strip leading './' if present
  return rel.replace(/^\.\//, '');
}
