import { Injectable } from '@nestjs/common';
import type { AgentRole } from '@app/common';
import { AgentConfigService } from './agent-config.service';
import { ROLE_TOOL_PROFILES, type RoleToolProfile } from './role-tool-profiles';
import { createToolGuardHook, type ToolGuardResult } from './tool-guard-hook';

@Injectable()
export class RolePermissionService {
  private guardHook:
    | ((
        toolName: string,
        toolInput: Record<string, unknown>,
      ) => ToolGuardResult)
    | undefined;

  constructor(private readonly configService: AgentConfigService) {}

  /** Returns the full permission profile for the agent's configured role. */
  getProfile(): RoleToolProfile {
    const role = this.configService.agent.role as AgentRole;
    const profile = ROLE_TOOL_PROFILES[role as keyof typeof ROLE_TOOL_PROFILES];

    if (!profile) {
      throw new Error(`No tool permission profile defined for role: ${role}`);
    }

    return profile;
  }

  /** Convenience accessor for the role's disallowed tools list. */
  getDisallowedTools(): string[] {
    return this.getProfile().disallowedTools;
  }

  /**
   * Returns the pre-built tool guard hook for the agent's role.
   * Lazy-initialised singleton — created once on first call.
   */
  getToolGuardHook(): (
    toolName: string,
    toolInput: Record<string, unknown>,
  ) => ToolGuardResult {
    if (!this.guardHook) {
      this.guardHook = createToolGuardHook(
        this.getProfile(),
        this.configService.agent.workspaceDir,
      );
    }
    return this.guardHook;
  }
}
