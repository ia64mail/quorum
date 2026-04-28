import { AgentRole } from '@app/common';

/** Per-role timeout constants (ms). Architectural design decisions, not env-configurable. */
export const ROLE_TIMEOUTS: Partial<Record<AgentRole, number>> = {
  [AgentRole.moderator]: 5 * 60_000, // 5 min — user clarification via elicitation
  // Architect: research/design tasks observed 5–12 min (2026-04-25 SDK
  // investigation); bumped to 15 min to absorb the long tail. See QRM6-BUG-010.
  [AgentRole.architect]: 15 * 60_000, // 15 min — design review / research
  [AgentRole.teamlead]: 10 * 60_000, // 10 min — ticket creation
  [AgentRole.developer]: 30 * 60_000, // 30 min — implementation
  [AgentRole.qa]: 15 * 60_000, // 15 min — test execution
  [AgentRole.productowner]: 2 * 60_000, // 2 min — clarification
};
