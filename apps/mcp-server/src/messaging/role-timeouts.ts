import { AgentRole } from '@app/common';

/** Per-role timeout constants (ms). Architectural design decisions, not env-configurable. */
export const ROLE_TIMEOUTS: Partial<Record<AgentRole, number>> = {
  [AgentRole.moderator]: 5 * 60_000, // 5 min — user clarification via elicitation
  [AgentRole.architect]: 5 * 60_000, // 5 min — design review
  [AgentRole.teamlead]: 10 * 60_000, // 10 min — ticket creation
  [AgentRole.developer]: 30 * 60_000, // 30 min — implementation
  [AgentRole.qa]: 15 * 60_000, // 15 min — test execution
  [AgentRole.productowner]: 2 * 60_000, // 2 min — clarification
};
