import { Test, TestingModule } from '@nestjs/testing';
import { ContextScope, ContextStore } from '@app/common';
import { McpServerConfigService } from '../config';
import { BootstrapContextService } from './bootstrap-context.service';

describe('BootstrapContextService', () => {
  let service: BootstrapContextService;

  const mockContextStore = {
    getAll: jest.fn(),
  };

  const defaultBootstrapConfig = {
    enabled: true,
    maxTokens: 1000,
    projectRatio: 0.6,
  };

  const mockConfig = {
    bootstrap: { ...defaultBootstrapConfig },
  };

  /** Helper: estimate tokens for a value (matches production formula). */
  function estimateTokens(value: unknown): number {
    return Math.ceil(JSON.stringify(value).length / 4);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockConfig.bootstrap = { ...defaultBootstrapConfig };
    mockContextStore.getAll.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BootstrapContextService,
        { provide: ContextStore, useValue: mockContextStore },
        { provide: McpServerConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<BootstrapContextService>(BootstrapContextService);
  });

  describe('disabled toggle', () => {
    it('should return null when bootstrap is disabled', async () => {
      mockConfig.bootstrap.enabled = false;
      mockContextStore.getAll.mockResolvedValue({ key: 'value' });

      const result = await service.assemble('corr-1');

      expect(result).toBeNull();
    });

    it('should not call getAll when disabled', async () => {
      mockConfig.bootstrap.enabled = false;

      await service.assemble('corr-1');

      expect(mockContextStore.getAll).not.toHaveBeenCalled();
    });
  });

  describe('empty store', () => {
    it('should return null when both scopes return empty objects', async () => {
      mockContextStore.getAll.mockResolvedValue({});

      const result = await service.assemble('corr-1');

      expect(result).toBeNull();
    });

    it('should return null when project is empty and no correlationId', async () => {
      mockContextStore.getAll.mockResolvedValue({});

      const result = await service.assemble();

      expect(result).toBeNull();
    });
  });

  describe('project-only context', () => {
    it('should return BootstrapContext with populated project and empty conversation when no correlationId', async () => {
      mockContextStore.getAll.mockResolvedValue({ 'tech-stack': 'NestJS' });

      const result = await service.assemble();

      expect(result).not.toBeNull();
      expect(result!.project).toEqual({ 'tech-stack': 'NestJS' });
      expect(result!.conversation).toEqual({});
      expect(result!.meta.scopesQueried).toEqual(['project']);
    });

    it('should not call getAll for conversation scope when correlationId is absent', async () => {
      mockContextStore.getAll.mockResolvedValue({ 'tech-stack': 'NestJS' });

      await service.assemble();

      expect(mockContextStore.getAll).toHaveBeenCalledTimes(1);
      expect(mockContextStore.getAll).toHaveBeenCalledWith(
        ContextScope.project,
      );
    });
  });

  describe('conversation-only context', () => {
    it('should return BootstrapContext with empty project and populated conversation', async () => {
      mockContextStore.getAll
        .mockResolvedValueOnce({}) // project
        .mockResolvedValueOnce({ 'task-status': 'in-progress' }); // conversation

      const result = await service.assemble('corr-1');

      expect(result).not.toBeNull();
      expect(result!.project).toEqual({});
      expect(result!.conversation).toEqual({ 'task-status': 'in-progress' });
      expect(result!.meta.scopesQueried).toEqual(['project', 'conversation']);
    });

    it('should always query project scope even when it returns empty', async () => {
      mockContextStore.getAll
        .mockResolvedValueOnce({}) // project
        .mockResolvedValueOnce({ 'task-status': 'done' }); // conversation

      await service.assemble('corr-1');

      expect(mockContextStore.getAll).toHaveBeenCalledWith(
        ContextScope.project,
      );
    });
  });

  describe('mixed context', () => {
    it('should include items from both scopes', async () => {
      mockContextStore.getAll
        .mockResolvedValueOnce({ 'tech-stack': 'NestJS' })
        .mockResolvedValueOnce({ 'task-status': 'in-progress' });

      const result = await service.assemble('corr-1');

      expect(result).not.toBeNull();
      expect(result!.project).toEqual({ 'tech-stack': 'NestJS' });
      expect(result!.conversation).toEqual({
        'task-status': 'in-progress',
      });
    });

    it('should have itemCount equal to sum of project and conversation items', async () => {
      mockContextStore.getAll
        .mockResolvedValueOnce({ a: '1', b: '2' })
        .mockResolvedValueOnce({ c: '3' });

      const result = await service.assemble('corr-1');

      expect(result!.meta.itemCount).toBe(3);
    });

    it('should include both scopes in scopesQueried', async () => {
      mockContextStore.getAll
        .mockResolvedValueOnce({ a: '1' })
        .mockResolvedValueOnce({ b: '2' });

      const result = await service.assemble('corr-1');

      expect(result!.meta.scopesQueried).toEqual(['project', 'conversation']);
    });
  });

  describe('budget enforcement', () => {
    it('should select only a subset of items when total exceeds budget', async () => {
      mockConfig.bootstrap.maxTokens = 50;
      mockConfig.bootstrap.projectRatio = 1; // all budget to project

      // Create items that together exceed 50 tokens
      const items: Record<string, unknown> = {};
      for (let i = 0; i < 10; i++) {
        items[`key-${i}`] = 'x'.repeat(30); // each ~8 tokens
      }

      mockContextStore.getAll.mockResolvedValue(items);

      const result = await service.assemble();

      expect(result).not.toBeNull();
      const selectedCount = Object.keys(result!.project).length;
      expect(selectedCount).toBeGreaterThan(0);
      expect(selectedCount).toBeLessThan(10);
      expect(result!.meta.estimatedTokens).toBeLessThanOrEqual(50);
    });

    it('should skip oversized items but still select smaller subsequent items (greedy bin-packing)', async () => {
      mockConfig.bootstrap.maxTokens = 30;
      mockConfig.bootstrap.projectRatio = 1;

      // Items in insertion order: small, large, small
      // After reversal: small (key-c), large (key-b), small (key-a)
      // key-c fits, key-b too large -> skip, key-a fits
      const smallValue = 'ok'; // estimateTokens("ok") = ceil(4/4) = 1
      const largeValue = 'x'.repeat(200); // way over budget

      const items: Record<string, unknown> = {
        'key-a': smallValue,
        'key-b': largeValue,
        'key-c': smallValue,
      };

      mockContextStore.getAll.mockResolvedValue(items);

      const result = await service.assemble();

      expect(result).not.toBeNull();
      // Both small items should be selected, large one skipped
      expect(result!.project['key-a']).toBe(smallValue);
      expect(result!.project['key-c']).toBe(smallValue);
      expect(result!.project['key-b']).toBeUndefined();
    });
  });

  describe('budget splitting', () => {
    it('should split budget according to projectRatio', async () => {
      mockConfig.bootstrap.maxTokens = 100;
      mockConfig.bootstrap.projectRatio = 0.6;

      // Project budget = floor(100 * 0.6) = 60
      // Create a project item that uses exactly within 60 tokens
      const projectValue = 'a'.repeat(236); // JSON: "aaa...a" (238 chars) -> ceil(238/4) = 60 tokens
      // Conversation budget = 100 - 60 = 40
      const convValue = 'b'.repeat(156); // JSON: "bbb...b" (158 chars) -> ceil(158/4) = 40 tokens

      mockContextStore.getAll
        .mockResolvedValueOnce({ proj: projectValue })
        .mockResolvedValueOnce({ conv: convValue });

      const result = await service.assemble('corr-1');

      expect(result).not.toBeNull();
      expect(result!.project).toHaveProperty('proj');
      expect(result!.conversation).toHaveProperty('conv');
    });

    it('should allocate correct token budgets per scope', async () => {
      mockConfig.bootstrap.maxTokens = 100;
      mockConfig.bootstrap.projectRatio = 0.6;

      // Project budget = 60, conversation budget = 40
      // Project item that exceeds 60 tokens should be excluded
      const tooLargeForProject = 'x'.repeat(300); // way over 60 tokens

      mockContextStore.getAll
        .mockResolvedValueOnce({ proj: tooLargeForProject })
        .mockResolvedValueOnce({ conv: 'small' });

      const result = await service.assemble('corr-1');

      expect(result).not.toBeNull();
      // Project item too large, excluded
      expect(Object.keys(result!.project)).toHaveLength(0);
      // Conversation item fits
      expect(result!.conversation).toHaveProperty('conv');
    });
  });

  describe('budget reclamation', () => {
    it('should reclaim unused project budget for conversation', async () => {
      mockConfig.bootstrap.maxTokens = 100;
      mockConfig.bootstrap.projectRatio = 0.6;

      // Project budget = floor(100 * 0.6) = 60
      // Project uses only a small item (~2 tokens)
      const smallProject = 'hi'; // JSON: "hi" (4 chars) -> ceil(4/4) = 1 token
      const projectTokens = estimateTokens(smallProject); // 1

      // Base conversation budget = 100 - 60 = 40
      // Reclaimed = 40 + (60 - 1) = 99
      // Conversation item needs ~70 tokens — would fail with base 40, succeeds with reclaimed 99
      const largeConv = 'c'.repeat(276); // JSON: "ccc...c" (278 chars) -> ceil(278/4) = 70 tokens
      const convTokens = estimateTokens(largeConv);

      // Verify preconditions
      expect(projectTokens).toBeLessThan(60);
      expect(convTokens).toBeGreaterThan(40); // exceeds base conversation budget
      expect(convTokens).toBeLessThanOrEqual(100 - projectTokens); // fits in reclaimed budget

      mockContextStore.getAll
        .mockResolvedValueOnce({ proj: smallProject })
        .mockResolvedValueOnce({ conv: largeConv });

      const result = await service.assemble('corr-1');

      expect(result).not.toBeNull();
      expect(result!.project).toHaveProperty('proj');
      expect(result!.conversation).toHaveProperty('conv');
    });
  });

  describe('item recency ordering', () => {
    it('should prefer newer items (later in insertion order) when budget is tight', async () => {
      mockConfig.bootstrap.maxTokens = 20;
      mockConfig.bootstrap.projectRatio = 1;

      // Create items where combined total exceeds budget but each fits individually
      const olderBig = 'o'.repeat(50); // JSON: "ooo..." (52 chars) -> ceil(52/4) = 13 tokens
      const newerBig = 'n'.repeat(50); // JSON: "nnn..." (52 chars) -> ceil(52/4) = 13 tokens
      // Combined = 26, budget = 20, so only one fits

      const items: Record<string, unknown> = {
        'old-key': olderBig,
        'new-key': newerBig,
      };

      mockContextStore.getAll.mockResolvedValue(items);

      const result = await service.assemble();

      expect(result).not.toBeNull();
      // Newer item (new-key) should be preferred due to reversed iteration
      expect(result!.project).toHaveProperty('new-key');
      expect(result!.project['old-key']).toBeUndefined();
    });
  });

  describe('metadata accuracy', () => {
    it('should report correct itemCount', async () => {
      mockContextStore.getAll
        .mockResolvedValueOnce({ a: '1', b: '2' })
        .mockResolvedValueOnce({ c: '3' });

      const result = await service.assemble('corr-1');

      expect(result!.meta.itemCount).toBe(3);
    });

    it('should report correct estimatedTokens', async () => {
      const val1 = 'hello';
      const val2 = 'world';
      const val3 = 'test';
      const expectedTokens =
        estimateTokens(val1) + estimateTokens(val2) + estimateTokens(val3);

      mockContextStore.getAll
        .mockResolvedValueOnce({ a: val1, b: val2 })
        .mockResolvedValueOnce({ c: val3 });

      const result = await service.assemble('corr-1');

      expect(result!.meta.estimatedTokens).toBe(expectedTokens);
    });

    it('should report scopesQueried as [project] without correlationId', async () => {
      mockContextStore.getAll.mockResolvedValue({ a: '1' });

      const result = await service.assemble();

      expect(result!.meta.scopesQueried).toEqual(['project']);
    });

    it('should report scopesQueried as [project, conversation] with correlationId', async () => {
      mockContextStore.getAll
        .mockResolvedValueOnce({ a: '1' })
        .mockResolvedValueOnce({});

      const result = await service.assemble('corr-1');

      expect(result!.meta.scopesQueried).toEqual(['project', 'conversation']);
    });
  });
});
