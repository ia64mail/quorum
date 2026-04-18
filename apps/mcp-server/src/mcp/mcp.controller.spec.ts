import { Test, TestingModule } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockMcpService = {
  connect: jest.fn().mockResolvedValue(undefined),
};

function mockReq(
  overrides: Partial<Request> & { headers?: Record<string, string> } = {},
): Request {
  return {
    headers: {},
    body: {},
    ...overrides,
  } as unknown as Request;
}

interface MockResponse {
  status: jest.Mock;
  json: jest.Mock;
  on: jest.Mock;
}

function mockRes(): { res: Response; mock: MockResponse } {
  const mock: MockResponse = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    on: jest.fn().mockReturnThis(),
  };
  return { res: mock as unknown as Response, mock };
}

// ---------------------------------------------------------------------------
// We need to mock StreamableHTTPServerTransport
// ---------------------------------------------------------------------------

const mockTransportInstance = {
  sessionId: 'session-abc',
  handleRequest: jest.fn().mockResolvedValue(undefined),
  onclose: undefined as (() => void) | undefined,
};

jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: jest.fn(() => mockTransportInstance),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('McpController', () => {
  let controller: McpController;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTransportInstance.handleRequest.mockResolvedValue(undefined);
    mockTransportInstance.onclose = undefined;
    mockTransportInstance.sessionId = 'session-abc';

    const module: TestingModule = await Test.createTestingModule({
      controllers: [McpController],
      providers: [{ provide: McpService, useValue: mockMcpService }],
    }).compile();

    controller = module.get<McpController>(McpController);
  });

  describe('POST /mcp', () => {
    it('should create a new session when no session header', async () => {
      const req = mockReq({ body: { jsonrpc: '2.0' } });
      const { res } = mockRes();

      await controller.handlePost(req, res);

      expect(mockMcpService.connect).toHaveBeenCalledWith(
        mockTransportInstance,
      );
      expect(mockTransportInstance.handleRequest).toHaveBeenCalledWith(
        req,
        res,
        req.body,
      );
    });

    it('should reuse existing session transport', async () => {
      const req1 = mockReq({ body: { jsonrpc: '2.0' } });
      const { res: res1 } = mockRes();
      await controller.handlePost(req1, res1);

      // Second request with session header
      const req2 = mockReq({
        headers: { 'mcp-session-id': 'session-abc' },
        body: { jsonrpc: '2.0', method: 'tools/list' },
      });
      const { res: res2 } = mockRes();

      mockMcpService.connect.mockClear();
      await controller.handlePost(req2, res2);

      // Should not create a new connection
      expect(mockMcpService.connect).not.toHaveBeenCalled();
      expect(mockTransportInstance.handleRequest).toHaveBeenCalledWith(
        req2,
        res2,
        req2.body,
      );
    });

    it('should return 404 for unknown session id', async () => {
      const req = mockReq({
        headers: { 'mcp-session-id': 'unknown-session' },
      });
      const { mock } = mockRes();

      await controller.handlePost(req, mock as unknown as Response);

      expect(mock.status).toHaveBeenCalledWith(404);
      expect(mock.json).toHaveBeenCalledWith({ error: 'Session not found' });
    });
  });

  describe('GET /mcp (SSE)', () => {
    it('should delegate to transport for valid session', async () => {
      // First create a session
      const reqPost = mockReq({ body: {} });
      const { res: resPost } = mockRes();
      await controller.handlePost(reqPost, resPost);

      // Then GET with session
      const req = mockReq({
        headers: { 'mcp-session-id': 'session-abc' },
      });
      const { res } = mockRes();

      await controller.handleGet(req, res);

      expect(mockTransportInstance.handleRequest).toHaveBeenCalledWith(
        req,
        res,
      );
    });

    it('should return 404 without session header', async () => {
      const req = mockReq();
      const { mock } = mockRes();

      await controller.handleGet(req, mock as unknown as Response);

      expect(mock.status).toHaveBeenCalledWith(404);
    });

    it('should return 404 for unknown session', async () => {
      const req = mockReq({
        headers: { 'mcp-session-id': 'nonexistent' },
      });
      const { mock } = mockRes();

      await controller.handleGet(req, mock as unknown as Response);

      expect(mock.status).toHaveBeenCalledWith(404);
    });
  });

  describe('DELETE /mcp', () => {
    it('should close transport and remove session', async () => {
      // Create session first
      const reqPost = mockReq({ body: {} });
      const { res: resPost } = mockRes();
      await controller.handlePost(reqPost, resPost);

      // Delete the session
      const req = mockReq({
        headers: { 'mcp-session-id': 'session-abc' },
      });
      const { res } = mockRes();

      await controller.handleDelete(req, res);

      expect(mockTransportInstance.handleRequest).toHaveBeenCalledWith(
        req,
        res,
      );

      // Verify session is removed — GET should now 404
      const reqGet = mockReq({
        headers: { 'mcp-session-id': 'session-abc' },
      });
      const { mock: mockGet } = mockRes();
      await controller.handleGet(reqGet, mockGet as unknown as Response);
      expect(mockGet.status).toHaveBeenCalledWith(404);
    });

    it('should return 404 for unknown session on DELETE', async () => {
      const req = mockReq({
        headers: { 'mcp-session-id': 'ghost' },
      });
      const { mock } = mockRes();

      await controller.handleDelete(req, mock as unknown as Response);

      expect(mock.status).toHaveBeenCalledWith(404);
    });
  });

  describe('session cleanup via onclose', () => {
    it('should remove session when transport fires onclose', async () => {
      const reqPost = mockReq({ body: {} });
      const { res: resPost } = mockRes();
      await controller.handlePost(reqPost, resPost);

      // Trigger the onclose callback
      expect(mockTransportInstance.onclose).toBeDefined();
      mockTransportInstance.onclose!();

      // Session should be gone
      const reqGet = mockReq({
        headers: { 'mcp-session-id': 'session-abc' },
      });
      const { mock: mockGet } = mockRes();
      await controller.handleGet(reqGet, mockGet as unknown as Response);
      expect(mockGet.status).toHaveBeenCalledWith(404);
    });
  });
});
