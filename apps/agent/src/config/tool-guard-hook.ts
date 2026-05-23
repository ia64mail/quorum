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
  const allowedSkills = profile.allowedSkills;

  return (
    toolName: string,
    toolInput: Record<string, unknown>,
  ): ToolGuardResult => {
    // --- Skill filtering ---
    if (toolName === 'Skill') {
      const skillName = toolInput.skill as string | undefined;
      // CC CLI emits plugin-provided skills as "<plugin>:<skill>" — strip the
      // namespace before checking against the role's bare-name allowlist so
      // role profiles don't have to mirror plugin internals.
      const bareName = skillName?.includes(':')
        ? skillName.slice(skillName.lastIndexOf(':') + 1)
        : skillName;
      if (bareName && !allowedSkills.includes(bareName)) {
        return {
          allowed: false,
          reason: `Skill '${skillName}' not permitted for this role`,
        };
      }
      return { allowed: true };
    }

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

  while (cmd.startsWith('sudo ')) {
    cmd = cmd.slice(5).trimStart();
  }

  return cmd;
}

/** Extract the file path from a write-tool's input. */
function extractFilePath(
  toolInput: Record<string, unknown>,
): string | undefined {
  // Write / Edit / NotebookEdit all use `file_path` or `filePath`
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

  // Trailing-slash comparison prevents prefix-substring attacks
  // (e.g. /mnt/quorum/workspace-evil matching /mnt/quorum/workspace)
  const wsPrefix = workspaceDir.endsWith('/')
    ? workspaceDir
    : workspaceDir + '/';

  if (resolved !== workspaceDir && !resolved.startsWith(wsPrefix)) {
    return undefined;
  }

  const rel = relative(workspaceDir, resolved);

  // Strip leading './' if present
  return rel.replace(/^\.\//, '');
}
