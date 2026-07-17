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

      // Per-segment scan (#65): split the command on shell separators,
      // strip leading `cd`/env-assignment/`sudo` per segment, then match
      // each segment's leading command against the denied verbs.
      // Closes prefix-only bypasses: `cd <wt> && git commit …`,
      // `git -C <wt> commit …`, `GIT_AUTHOR_DATE=… git commit …`.
      const segments = splitShellSegments(raw);
      for (const segment of segments) {
        const head = extractSegmentHead(segment);
        if (head === '') continue;

        for (const prefix of deniedPrefixes) {
          if (matchesDeniedVerb(head, prefix)) {
            return {
              allowed: false,
              reason: `Denied bash command: "${prefix}"`,
            };
          }
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
 * Split a bash command into top-level segments on shell separators
 * `&&`, `||`, `;`, `|`, `&`. The split is deliberately naive — we do
 * not parse subshells, heredocs, or quoting — because the goal is
 * defense-in-depth on a short, model-emitted command, not a full shell
 * parser. False-positive splits are harmless: a quoted `&&` inside a
 * commit message would split the segment, but each sub-segment is then
 * matched against denied verbs and only fires on real `git commit` /
 * `git push` / etc. — the worst case is over-denying a contrived
 * commit-message string that the agent is not supposed to author.
 */
function splitShellSegments(raw: string): string[] {
  // Order matters: split on `&&` and `||` before falling through to
  // single-char `&`/`|` which are the bitwise/background variants.
  return raw
    .split(/&&|\|\||;|\||&/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Extract the leading command verb of a single shell segment.
 * Strips leading env assignments (`FOO=bar`), leading `sudo`, and a
 * single leading `cd <path>` (the common bypass form). Returns the
 * remaining text lowercased and whitespace-collapsed; an empty string
 * if nothing is left (e.g. a bare `cd <path>` segment).
 *
 * `git -C <path> <verb>` is normalised to `git <verb>` so the denied
 * verb list still fires on it.
 */
function extractSegmentHead(segment: string): string {
  let s = segment.replace(/\s+/g, ' ').trim();

  // Strip leading env assignments: `FOO=bar BAZ=qux <cmd>`
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(s)) {
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
  }

  // Lowercase after env-strip so we don't mangle env var names in errors.
  s = s.toLowerCase();

  // Strip leading sudo (repeatable).
  while (s.startsWith('sudo ')) {
    s = s.slice(5).trimStart();
  }

  // Strip a leading `cd <path>` (bare `cd` segments collapse to empty).
  if (s === 'cd' || /^cd\s+\S+$/.test(s)) {
    return '';
  }

  // `git [-c <k=v> | -C <path>]… <verb> …` → `git <verb> …`
  // Strip ALL leading config/dir flags, not just the first. After the
  // lowercase above, `-C` and `-c` are identical, and both take exactly one
  // following token (`-c key=value` is one token; `-C path` consumes the next
  // token). git accepts them repeated and interleaved before the subcommand,
  // so loop until no leading `-c <arg>` remains. git rejects the attached
  // forms `-ckey=value` / `-C<path>`, so only the space-separated shape is
  // reachable and one regex covers both flags.
  let prev: string;
  do {
    prev = s;
    s = s.replace(/^git\s+-c\s+\S+\s+/, 'git ');
  } while (s !== prev);

  return s;
}

/**
 * Match a denied verb (already lowercased) against a normalised segment
 * head. The matcher uses a hybrid rule: the segment must start with the
 * verb, and the continuation must respect a word boundary — preventing
 * `git logs` from matching `git log` while allowing `rm -rf /tmp/foo`
 * to match `rm -rf /` (legacy developer-profile entry whose trailing
 * `/` was treated as a path-prefix marker under the old prefix-only
 * matcher; we preserve that behaviour here).
 *
 * Specifically: if the verb ends in an alphanumeric character, the next
 * character of the segment must be a space (or end of string) — this
 * is the standard word-boundary check. If the verb ends in punctuation
 * (e.g. `-b`, `/`), any continuation is accepted, because the verb
 * itself already encodes the boundary the author wanted.
 */
function matchesDeniedVerb(head: string, verb: string): boolean {
  if (!head.startsWith(verb)) return false;
  if (head.length === verb.length) return true;

  const lastVerbChar = verb[verb.length - 1];
  if (/[a-z0-9]/.test(lastVerbChar)) {
    return head[verb.length] === ' ';
  }
  return true;
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
