export enum AgentRole {
  moderator = 'moderator',
  architect = 'architect',
  teamlead = 'teamlead',
  developer = 'developer',
  qa = 'qa',
  productowner = 'productowner',
}

/** The five roles deployable as agent containers (excludes moderator). */
export const DEPLOYABLE_AGENT_ROLES = [
  AgentRole.architect,
  AgentRole.teamlead,
  AgentRole.developer,
  AgentRole.qa,
  AgentRole.productowner,
] as const;

/** All roles that are valid targets for `invoke_agent` (deployable + moderator). */
export const INVOCABLE_AGENT_ROLES = [
  ...DEPLOYABLE_AGENT_ROLES,
  AgentRole.moderator,
] as const;
