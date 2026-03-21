import { DEPLOYABLE_AGENT_ROLES } from '@app/common';

/**
 * Per-role configuration controlling which Claude Code built-in tools
 * each agent can use and which bash commands are denied.
 */
export interface RoleToolProfile {
  /** Tools the role cannot use at all (SDK disallowedTools). */
  disallowedTools: string[];

  /** Command prefixes rejected by the bash guard hook. */
  deniedBashCommands: string[];

  /**
   * When set, Write/Edit/NotebookEdit are restricted to files
   * under these workspace-relative path prefixes. Undefined = unrestricted.
   */
  allowedWritePaths?: string[];
}

/** Tools universally denied for all agent roles. */
const COMMON_DISALLOWED_TOOLS: string[] = [
  'AskUserQuestion', // Hangs indefinitely — no interactive user in agent sessions
  'Config', // No runtime config changes inside containers
  'ExitPlanMode', // Agent sessions don't enter plan mode
];

type DeployableRole = (typeof DEPLOYABLE_AGENT_ROLES)[number];

/**
 * Static permission profiles keyed by deployable agent role.
 * Encodes the principle of least privilege — agents get only the
 * capabilities their role requires.
 */
export const ROLE_TOOL_PROFILES: Record<DeployableRole, RoleToolProfile> = {
  developer: {
    disallowedTools: [...COMMON_DISALLOWED_TOOLS],
    deniedBashCommands: ['git push --force', 'git push -f', 'rm -rf /'],
  },

  architect: {
    disallowedTools: [...COMMON_DISALLOWED_TOOLS, 'NotebookEdit'],
    deniedBashCommands: [
      'git push',
      'git commit',
      'git checkout -b',
      'rm -rf',
      'npm publish',
    ],
    allowedWritePaths: ['docs/', 'tickets/'],
  },

  teamlead: {
    disallowedTools: [...COMMON_DISALLOWED_TOOLS],
    deniedBashCommands: [
      'git push --force',
      'git push -f',
      'rm -rf /',
      'npm publish',
    ],
  },

  qa: {
    disallowedTools: [...COMMON_DISALLOWED_TOOLS],
    deniedBashCommands: ['git push', 'git commit', 'rm -rf', 'npm publish'],
  },

  productowner: {
    disallowedTools: [
      ...COMMON_DISALLOWED_TOOLS,
      'NotebookEdit',
      'Bash',
      'EnterWorktree',
      'Agent',
    ],
    deniedBashCommands: [], // Bash fully disabled at tool level
    allowedWritePaths: ['tickets/'],
  },
} as const satisfies Record<DeployableRole, RoleToolProfile>;

/** Write-guarded tool names checked by the tool guard hook. */
export const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit'] as const;
