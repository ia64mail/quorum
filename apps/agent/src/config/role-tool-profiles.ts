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

  /** Skills the role is permitted to invoke via the Skill tool.
   *  Empty array = no skills allowed. */
  allowedSkills: string[];

  /** SDK plugins loaded for this role's agent sessions. */
  plugins: Array<{ type: 'local'; path: string }>;
}

/**
 * Path to the code-review plugin's runtime install location.
 *
 * The agent entrypoint (`docker/agent/entrypoint.sh`, added in #29) seeds the
 * plugin into this path on tmpfs at every container boot. The SDK reads
 * `plugin.json` from this location when `plugins: [CODE_REVIEW_PLUGIN]` is
 * passed to `query()` — that's what makes `code-review:code-review` appear
 * in the agent's available-skills list.
 */
export const CODE_REVIEW_PLUGIN = {
  type: 'local' as const,
  path: '/home/quorum/.claude/plugins/cache/claude-plugins-official/code-review/unknown',
};

/**
 * Tools universally denied for all agent roles.
 *
 * Runtime config mutation is NOT gated here — CC CLI 2.1.207 has no SDK
 * tool named `Config` (the `/config` slash command is not an SDK tool and
 * cannot be listed in `disallowedTools`). See #68 Round-2 Finding 2 for
 * the "matches no known tool" warning that resulted from carrying the
 * stale rule. The actual guard chain against runtime config mutation is
 * defense-in-depth outside this list:
 *   (a) `read_only: true` rootfs + tmpfs `~/.config`/`~/.claude`
 *       (docker-compose.yml `x-base-security` / `x-agent-security`);
 *   (b) the role write-guard hook restricting `Write`/`Edit`/`NotebookEdit`
 *       to `allowedWritePaths`;
 *   (c) moderator `permissionMode: 'default'` (docker/moderator/settings.json)
 *       prompting the user before any `/config` invocation.
 */
const COMMON_DISALLOWED_TOOLS: string[] = [
  'AskUserQuestion', // Hangs indefinitely — no interactive user in agent sessions
  'ExitPlanMode', // Agent sessions don't enter plan mode
  // #87: a wakeup can never fire in a single-shot invocation — one query()
  // per invoke_agent, no harness re-invoke — so denying the tool stops the
  // model from ever forming the "harness will wake me later" plan that left
  // /code-review's background sub-agent fan-out stranded (see the PreToolUse
  // `Agent` rewrite in sdk-hooks.factory.ts for the companion fix).
  'ScheduleWakeup',
];

type DeployableRole = (typeof DEPLOYABLE_AGENT_ROLES)[number];

/**
 * Static permission profiles keyed by deployable agent role.
 * Encodes the principle of least privilege — agents get only the
 * capabilities their role requires.
 */
export const ROLE_TOOL_PROFILES: Record<DeployableRole, RoleToolProfile> = {
  developer: {
    // SDK 0.3.x replaced TodoWrite with a family of Task tools for
    // headless/SDK sessions (#68 / agent-sdk 0.3 breaking change). Deny the
    // Task tools to preserve the original QRM4-BUG-010 intent of keeping
    // developers off self-todo tooling; TodoWrite stays in the list to cover
    // any residual emissions on mixed engine versions.
    disallowedTools: [
      ...COMMON_DISALLOWED_TOOLS,
      'TodoWrite',
      'TaskCreate',
      'TaskUpdate',
      'TaskGet',
      'TaskList',
      'TaskStop',
      'TaskOutput',
    ],
    deniedBashCommands: [
      'git commit',
      'git push',
      'git checkout -b',
      'git branch',
      'rm -rf /',
    ],
    allowedSkills: ['simplify'],
    plugins: [],
  },

  architect: {
    disallowedTools: [...COMMON_DISALLOWED_TOOLS, 'NotebookEdit'],
    deniedBashCommands: [
      'git push',
      'git commit',
      'git checkout -b',
      'git branch',
      'rm -rf',
      'npm publish',
    ],
    allowedWritePaths: ['docs/', 'tickets/'],
    allowedSkills: ['code-review', 'review', 'simplify'],
    plugins: [CODE_REVIEW_PLUGIN],
  },

  teamlead: {
    disallowedTools: [...COMMON_DISALLOWED_TOOLS],
    deniedBashCommands: [
      'git commit',
      'git push',
      'git checkout -b',
      'git branch',
      'rm -rf /',
      'npm publish',
    ],
    allowedSkills: ['code-review', 'review', 'simplify'],
    plugins: [CODE_REVIEW_PLUGIN],
  },

  qa: {
    disallowedTools: [...COMMON_DISALLOWED_TOOLS],
    deniedBashCommands: [
      'git push',
      'git commit',
      'git checkout -b',
      'git branch',
      'rm -rf',
      'npm publish',
    ],
    allowedSkills: [],
    plugins: [],
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
    allowedSkills: [],
    plugins: [],
  },
} as const satisfies Record<DeployableRole, RoleToolProfile>;

/** Write-guarded tool names checked by the tool guard hook. */
export const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit'] as const;
