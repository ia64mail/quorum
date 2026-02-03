# QRM1-001: Instrumental Package Research for Quorum POC

## Summary

Research and validate the core npm packages required to implement the Quorum multi-agent orchestration system. Focus on Anthropic-native solutions for LLM integration, MCP server/client implementation, and terminal UI rendering. Deliver a validated package selection with working proof-of-concept code snippets.

## Problem Statement

The Quorum system design specifies a multi-container architecture with:
- Terminal app with Moderator LLM
- MCP server for agent communication
- Agent containers wrapping Claude Code

Before implementation begins, we need validated answers to:

| Question | Risk if Unanswered |
|----------|-------------------|
| Which SDK for Anthropic LLM integration? | Wrong choice = rewrite core logic |
| How to build MCP server from scratch? | Underestimate complexity, miss features |
| What terminal UI library? | Poor UX, streaming issues, maintenance burden |
| How do MCP ↔ Anthropic types interoperate? | Boilerplate code, type mismatches |

The Anthropic ecosystem has evolved rapidly (2025-2026), and documentation may be fragmented across:
- `@anthropic-ai/sdk` (main API)
- `@anthropic-ai/claude-agent-sdk` (agent framework)
- `@modelcontextprotocol/sdk` (MCP official)
- Various community packages

## Research Objectives

### 1. LLM Integration Package

**Evaluate:** `@anthropic-ai/sdk` vs `@anthropic-ai/claude-agent-sdk`

| Criteria | @anthropic-ai/sdk | @anthropic-ai/claude-agent-sdk |
|----------|-------------------|-------------------------------|
| Streaming support | ? | ? |
| Tool use / function calling | ? | ? |
| MCP type helpers | ? | ? |
| Bundle size | ? | ? |
| Learning curve | ? | ? |
| POC suitability | ? | ? |

**Deliverable:** Recommendation with code sample demonstrating streaming + tool use.

### 2. MCP Server Implementation

**Evaluate:** `@modelcontextprotocol/sdk`

| Aspect | Finding |
|--------|---------|
| Server creation API | ? |
| Transport options (HTTP, stdio, WebSocket) | ? |
| Tool/Resource/Prompt primitives | ? |
| Client library included | ? |
| NestJS integration pattern | ? |
| Auth helpers | ? |

**Deliverable:** Minimal MCP server with 2 tools + client connection sample.

### 3. Terminal UI Library

**Evaluate:** `ink` + `react` (Claude Code's stack)

| Aspect | Finding |
|--------|---------|
| Streaming text rendering | ? |
| Input handling | ? |
| Component model | ? |
| Known issues / workarounds | ? |
| Alternatives considered | ? |

**Deliverable:** Simple chat loop UI with streaming response display.

### 4. Type Interoperability

**Investigate:** MCP ↔ Anthropic SDK type conversion

| Aspect | Finding |
|--------|---------|
| Built-in helpers in @anthropic-ai/sdk | ? |
| Manual conversion needed | ? |
| Zod schema compatibility | ? |

**Deliverable:** Code sample showing MCP tool → Anthropic tool conversion.

## Package Candidates

### Primary Stack (Anthropic-native)

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.71.x",
    "@modelcontextprotocol/sdk": "^1.x",
    "ink": "^5.x",
    "react": "^18.x",
    "zod": "^3.25.x"
  }
}
```

### Secondary Consideration

| Package | Purpose | Evaluate If |
|---------|---------|-------------|
| `@anthropic-ai/claude-agent-sdk` | Full agent capabilities | POC needs file ops, bash execution |
| `commander` | CLI argument parsing | Terminal app needs subcommands |
| `blessed` | Alternative terminal UI | Ink proves problematic |

## Evaluation Criteria

Each package will be evaluated against:

| Criterion | Weight | Description |
|-----------|--------|-------------|
| **Anthropic Alignment** | High | Official or officially recommended |
| **POC Suitability** | High | Minimal setup, quick iteration |
| **Documentation Quality** | Medium | Clear examples, API reference |
| **Maintenance Status** | Medium | Recent updates, active issues |
| **Bundle Size** | Low | Acceptable for Docker containers |
| **Future Compatibility** | Low | Path to production (nice to have) |

## Research Tasks

### Phase 1: SDK Validation

- [ ] Install `@anthropic-ai/sdk` and verify streaming API
- [ ] Test tool use / function calling with simple example
- [ ] Verify MCP helper functions exist and work
- [ ] Document API key configuration pattern

### Phase 2: MCP Server POC

- [ ] Install `@modelcontextprotocol/sdk` with zod peer dependency
- [ ] Create minimal `McpServer` instance
- [ ] Add 2 test tools (e.g., `echo`, `get_time`)
- [ ] Connect with MCP client and invoke tools
- [ ] Test Streamable HTTP transport
- [ ] Document NestJS integration approach

### Phase 3: Terminal UI POC

- [ ] Install `ink` and `react`
- [ ] Create basic chat input/output component
- [ ] Implement streaming text display
- [ ] Test with simulated LLM response stream
- [ ] Document known limitations

### Phase 4: Integration Test

- [ ] Wire Anthropic SDK → MCP tool → Terminal display
- [ ] Verify end-to-end flow works
- [ ] Identify any type conversion gaps
- [ ] Document integration patterns

## Deliverables

### 1. Package Recommendation Document

Update to `docs/package-selection.md`:

```markdown
# Package Selection

## Approved Packages
| Package | Version | Purpose | Validation Status |
|---------|---------|---------|------------------|
| ... | ... | ... | ✅ Validated |

## Rejected Packages
| Package | Reason |
|---------|--------|
| ... | ... |

## Open Questions
- ...
```

### 2. POC Code Samples

Create `poc/` directory with working examples:

```
poc/
├── anthropic-streaming/     # SDK streaming demo
├── mcp-server-minimal/      # Basic MCP server
├── terminal-ui-chat/        # Ink chat component
└── integration-test/        # End-to-end wiring
```

### 3. Risk Assessment

Document any discovered risks:

| Risk | Severity | Mitigation |
|------|----------|------------|
| ... | ... | ... |

## Acceptance Criteria

### Package Validation
- [ ] `@anthropic-ai/sdk` streaming confirmed working
- [ ] `@anthropic-ai/sdk` tool use confirmed working
- [ ] `@anthropic-ai/sdk` MCP helpers documented
- [ ] `@modelcontextprotocol/sdk` server creation working
- [ ] `@modelcontextprotocol/sdk` tool registration working
- [ ] `@modelcontextprotocol/sdk` client connection working
- [ ] `ink` streaming text display working
- [ ] `ink` user input handling working

### Documentation
- [ ] `docs/package-selection.md` created with findings
- [ ] Each POC sample has README with run instructions
- [ ] Integration patterns documented

### Decision Made
- [ ] Final package list approved
- [ ] Any blocking issues identified and documented
- [ ] Ready to proceed with QRM1-002 (project scaffolding)

## Dependencies

### Prerequisites
- [ ] Node.js 22.x installed
- [ ] Anthropic API key available (`ANTHROPIC_API_KEY`)
- [ ] npm/pnpm available

### Blocks
- QRM1-002: Project Scaffolding (cannot start until packages validated)
- QRM1-003: MCP Server Implementation
- QRM1-004: Terminal App Implementation

## References

- [@anthropic-ai/sdk on npm](https://www.npmjs.com/package/@anthropic-ai/sdk)
- [Anthropic TypeScript SDK on GitHub](https://github.com/anthropics/anthropic-sdk-typescript)
- [@modelcontextprotocol/sdk on npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [MCP TypeScript SDK on GitHub](https://github.com/modelcontextprotocol/typescript-sdk)
- [Ink - React for CLI](https://github.com/vadimdemedes/ink)
- [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [How Claude Code is built](https://newsletter.pragmaticengineer.com/p/how-claude-code-is-built)
- [MCP Documentation](https://modelcontextprotocol.io/docs)