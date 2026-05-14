import { Test, TestingModule } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { InvocationResultStore } from '../messaging';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockMcpServer = { _mockServer: true };

const mockMcpService = {
  connect: jest.fn().mockResolvedValue(mockMcpServer),
  disconnect: jest.fn(),
  touchSession: jest.fn(),
  markSseAlive: jest.fn().mockReturnValue({}),
  markSseDead: jest.fn(),
  isSessionAlive: jest.fn().mockReturnValue(true),
  peekSessionState: jest.fn().mockReturnValue(undefined),
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

interface MockSocket {
  setKeepAlive: jest.Mock;
  destroyed: boolean;
}

interface MockResponse {
  status: jest.Mock;
  json: jest.Mock;
  on: jest.Mock;
  write: jest.Mock;
  writableEnded: boolean;
  socket: MockSocket;
}

function mockRes(): { res: Response; mock: MockResponse } {
  const mock: MockResponse = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    on: jest.fn().mockReturnThis(),
    write: jest.fn().mockReturnValue(true),
    writableEnded: false,
    socket: { setKeepAlive: jest.fn(), destroyed: false },
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
      providers: [
        { provide: McpService, useValue: mockMcpService },
        {
          provide: InvocationResultStore,
          useValue: { reapStaleInvocations: jest.fn() },
        },
      ],
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

  // -------------------------------------------------------------------------
  // QRM7-014: startSseKeepalive (Test Plan #6a–#6d)
  // -------------------------------------------------------------------------

  describe('startSseKeepalive (QRM7-014 Refinement 3+4, Test Plan #6a–#6d)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('#6a — long-lived response: interval ticks fire and touch session (POST-path behavior)', async () => {
      // Create a session
      const reqPost = mockReq({ body: {} });
      const { res: resPost } = mockRes();
      await controller.handlePost(reqPost, resPost);

      // Open SSE stream (stays open — simulates POST-path long-lived response)
      const reqGet = mockReq({
        headers: { 'mcp-session-id': 'session-abc' },
      });
      const { res: resGet, mock: mockGetRes } = mockRes();

      mockMcpService.touchSession.mockClear();
      await controller.handleGet(reqGet, resGet);

      // Immediate `: ready\n\n` write
      expect(mockGetRes.write).toHaveBeenCalledTimes(1);
      expect(mockGetRes.write).toHaveBeenCalledWith(': ready\n\n');

      // Advance 15 s — first keepalive tick writes `: ping`
      jest.advanceTimersByTime(15_000);
      expect(mockGetRes.write).toHaveBeenCalledTimes(2);
      expect(mockGetRes.write).toHaveBeenNthCalledWith(2, ': ping\n\n');

      // Advance another 15 s — second keepalive tick
      jest.advanceTimersByTime(15_000);
      expect(mockGetRes.write).toHaveBeenCalledTimes(3);
      expect(mockGetRes.write).toHaveBeenNthCalledWith(3, ': ping\n\n');

      // touchSession: 1 (GET arrival) + 1 (ready write) + 2 (two ping ticks) = 4
      expect(mockMcpService.touchSession).toHaveBeenCalledTimes(4);

      // TCP keepalive set on socket
      expect(mockGetRes.socket.setKeepAlive).toHaveBeenCalledWith(true, 15_000);
    });

    it('#6b — short-lived response: writableEnded self-clears interval (GET-path behavior)', async () => {
      // Create a session
      const reqPost = mockReq({ body: {} });
      const { res: resPost } = mockRes();
      await controller.handlePost(reqPost, resPost);

      const reqGet = mockReq({
        headers: { 'mcp-session-id': 'session-abc' },
      });
      const { res: resGet, mock: mockGetRes } = mockRes();
      await controller.handleGet(reqGet, resGet);

      // Immediate `: ready` write happened
      expect(mockGetRes.write).toHaveBeenCalledTimes(1);
      expect(mockGetRes.write).toHaveBeenCalledWith(': ready\n\n');

      // Simulate SDK ending the response before first tick
      mockGetRes.writableEnded = true;

      // First tick sees writableEnded=true and self-clears — no `: ping`
      jest.advanceTimersByTime(15_000);
      expect(mockGetRes.write).toHaveBeenCalledTimes(1);

      // Further advancement produces nothing — interval is cleared
      jest.advanceTimersByTime(60_000);
      expect(mockGetRes.write).toHaveBeenCalledTimes(1);
    });

    it('#6c — write failure clears interval', async () => {
      // Create a session
      const reqPost = mockReq({ body: {} });
      const { res: resPost } = mockRes();
      await controller.handlePost(reqPost, resPost);

      const reqGet = mockReq({
        headers: { 'mcp-session-id': 'session-abc' },
      });
      const { res: resGet, mock: mockGetRes } = mockRes();
      await controller.handleGet(reqGet, resGet);

      // Immediate `: ready` succeeded
      expect(mockGetRes.write).toHaveBeenCalledTimes(1);

      // Make subsequent writes throw
      mockGetRes.write.mockImplementation(() => {
        throw new Error('socket gone');
      });

      // First tick tries to write `: ping` and fails → interval cleared
      jest.advanceTimersByTime(15_000);
      expect(mockGetRes.write).toHaveBeenCalledTimes(2); // ready + failed ping attempt

      // Further advancement produces nothing — interval is cleared
      jest.advanceTimersByTime(60_000);
      expect(mockGetRes.write).toHaveBeenCalledTimes(2);
    });

    it('#6d — immediate write throw bails early, no interval scheduled', async () => {
      // Create a session
      const reqPost = mockReq({ body: {} });
      const { res: resPost } = mockRes();
      await controller.handlePost(reqPost, resPost);

      // Open SSE stream with a response that throws on write
      const reqGet = mockReq({
        headers: { 'mcp-session-id': 'session-abc' },
      });
      const { res: resGet, mock: mockGetRes } = mockRes();
      mockGetRes.write.mockImplementation(() => {
        throw new Error('socket gone');
      });
      mockMcpService.touchSession.mockClear();
      await controller.handleGet(reqGet, resGet);

      // write was attempted once (and threw)
      expect(mockGetRes.write).toHaveBeenCalledTimes(1);

      // touchSession NOT called for the ready write (bailed before it)
      // Only the pre-startSseKeepalive touchSession call for GET arrival
      expect(mockMcpService.touchSession).toHaveBeenCalledTimes(1);

      // No interval fires even after time passes
      jest.advanceTimersByTime(60_000);
      expect(mockGetRes.write).toHaveBeenCalledTimes(1);
    });

    it('should set TCP keepalive on SSE socket', async () => {
      // Create a session
      const reqPost = mockReq({ body: {} });
      const { res: resPost } = mockRes();
      await controller.handlePost(reqPost, resPost);

      // Open SSE stream
      const reqGet = mockReq({
        headers: { 'mcp-session-id': 'session-abc' },
      });
      const { res: resGet, mock: mockGetRes } = mockRes();
      await controller.handleGet(reqGet, resGet);

      expect(mockGetRes.socket.setKeepAlive).toHaveBeenCalledWith(true, 15_000);
    });

    it('should not start startSseKeepalive for 404 responses', async () => {
      const reqGet = mockReq({
        headers: { 'mcp-session-id': 'nonexistent' },
      });
      const { mock: mockGetRes } = mockRes();
      await controller.handleGet(reqGet, mockGetRes as unknown as Response);

      jest.advanceTimersByTime(60_000);
      expect(mockGetRes.write).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // QRM7-001: touchSession on POST/GET
  // -------------------------------------------------------------------------

  describe('touchSession on request handling (QRM7-001)', () => {
    it('should call touchSession on POST for existing session', async () => {
      // Create session first
      const req1 = mockReq({ body: { jsonrpc: '2.0' } });
      const { res: res1 } = mockRes();
      await controller.handlePost(req1, res1);

      mockMcpService.touchSession.mockClear();

      // Second request with session header
      const req2 = mockReq({
        headers: { 'mcp-session-id': 'session-abc' },
        body: { jsonrpc: '2.0', method: 'tools/list' },
      });
      const { res: res2 } = mockRes();
      await controller.handlePost(req2, res2);

      expect(mockMcpService.touchSession).toHaveBeenCalledWith(mockMcpServer);
    });

    it('should call touchSession on GET for valid session', async () => {
      // Create session first
      const reqPost = mockReq({ body: {} });
      const { res: resPost } = mockRes();
      await controller.handlePost(reqPost, resPost);

      mockMcpService.touchSession.mockClear();

      // GET with session header
      const reqGet = mockReq({
        headers: { 'mcp-session-id': 'session-abc' },
      });
      const { res: resGet } = mockRes();
      await controller.handleGet(reqGet, resGet);

      expect(mockMcpService.touchSession).toHaveBeenCalledWith(mockMcpServer);
    });

    it('should call markSseAlive on GET for valid session (QRM7-014)', async () => {
      // Create session first
      const reqPost = mockReq({ body: {} });
      const { res: resPost } = mockRes();
      await controller.handlePost(reqPost, resPost);

      mockMcpService.markSseAlive.mockClear();

      // GET with session header (opens SSE long-poll)
      const reqGet = mockReq({
        headers: { 'mcp-session-id': 'session-abc' },
      });
      const { res: resGet } = mockRes();
      await controller.handleGet(reqGet, resGet);

      expect(mockMcpService.markSseAlive).toHaveBeenCalledWith(mockMcpServer);
    });

    it('should register identity-guarded close handler that calls markSseDead with the token (QRM7-014)', async () => {
      // Create session first
      const reqPost = mockReq({ body: {} });
      const { res: resPost } = mockRes();
      await controller.handlePost(reqPost, resPost);

      const sseToken = {};
      mockMcpService.markSseAlive.mockReturnValue(sseToken);
      mockMcpService.markSseDead.mockClear();

      // GET with session header
      const reqGet = mockReq({
        headers: { 'mcp-session-id': 'session-abc' },
      });
      const { res: resGet, mock: mockGetRes } = mockRes();
      await controller.handleGet(reqGet, resGet);

      // Find the 'close' handler registered by handleGet
      const closeCalls = mockGetRes.on.mock.calls as [string, () => void][];
      const closeCall = closeCalls.find((call) => call[0] === 'close');
      expect(closeCall).toBeDefined();

      // Fire the close handler
      closeCall![1]();

      expect(mockMcpService.markSseDead).toHaveBeenCalledWith(
        mockMcpServer,
        sseToken,
      );
    });

    it('should NOT call markSseAlive on POST', async () => {
      // POST should never store the SSE token — only the GET handler does.
      const req1 = mockReq({ body: { jsonrpc: '2.0' } });
      const { res: res1 } = mockRes();
      await controller.handlePost(req1, res1);

      mockMcpService.markSseAlive.mockClear();

      const req2 = mockReq({
        headers: { 'mcp-session-id': 'session-abc' },
        body: { jsonrpc: '2.0', method: 'tools/list' },
      });
      const { res: res2 } = mockRes();
      await controller.handlePost(req2, res2);

      expect(mockMcpService.markSseAlive).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // QRM7-001: Liveness reaper
  // -------------------------------------------------------------------------

  describe('liveness reaper (QRM7-001)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      // Start the reaper under fake timers so advanceTimersByTime controls it
      controller.onModuleInit();
    });

    afterEach(() => {
      controller.onModuleDestroy();
      jest.useRealTimers();
    });

    it('should evict sessions whose isSessionAlive returns false', async () => {
      // Create a session
      const reqPost = mockReq({ body: {} });
      const { res: resPost } = mockRes();
      await controller.handlePost(reqPost, resPost);

      // Mark session as stale
      mockMcpService.isSessionAlive.mockReturnValue(false);

      // Trigger the reaper
      jest.advanceTimersByTime(30_000);

      // Session should be reaped — GET should 404
      const reqGet = mockReq({
        headers: { 'mcp-session-id': 'session-abc' },
      });
      const { mock: mockGetRes } = mockRes();
      await controller.handleGet(reqGet, mockGetRes as unknown as Response);
      expect(mockGetRes.status).toHaveBeenCalledWith(404);

      // disconnect should have been called
      expect(mockMcpService.disconnect).toHaveBeenCalledWith(mockMcpServer);
    });

    it('should NOT evict sessions whose isSessionAlive returns true', async () => {
      // Create a session
      const reqPost = mockReq({ body: {} });
      const { res: resPost } = mockRes();
      await controller.handlePost(reqPost, resPost);

      // Session is alive
      mockMcpService.isSessionAlive.mockReturnValue(true);

      // Trigger the reaper
      jest.advanceTimersByTime(30_000);

      // Session should still exist — GET should work
      const reqGet = mockReq({
        headers: { 'mcp-session-id': 'session-abc' },
      });
      const { res: resGet } = mockRes();
      await controller.handleGet(reqGet, resGet);

      expect(mockTransportInstance.handleRequest).toHaveBeenCalledWith(
        reqGet,
        resGet,
      );
    });

    it('should call disconnect on evicted sessions', async () => {
      // Create a session
      const reqPost = mockReq({ body: {} });
      const { res: resPost } = mockRes();
      await controller.handlePost(reqPost, resPost);

      mockMcpService.disconnect.mockClear();

      // Mark session as stale and trigger reaper
      mockMcpService.isSessionAlive.mockReturnValue(false);
      jest.advanceTimersByTime(30_000);

      expect(mockMcpService.disconnect).toHaveBeenCalledTimes(1);
      expect(mockMcpService.disconnect).toHaveBeenCalledWith(mockMcpServer);
    });

    it('should clear the reaper interval on module destroy', () => {
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

      controller.onModuleDestroy();

      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });

    // Test Plan #4: Dead-moderator end-to-end
    it('dead-moderator end-to-end: SSE closes → timeout → reaper evicts (Test Plan #4)', async () => {
      // Create a session
      const reqPost = mockReq({ body: {} });
      const { res: resPost } = mockRes();
      await controller.handlePost(reqPost, resPost);

      // Session is initially alive (moderator with active SSE)
      mockMcpService.isSessionAlive.mockReturnValue(true);

      // First reaper tick — session survives
      jest.advanceTimersByTime(30_000);
      mockMcpService.disconnect.mockClear();

      // Simulate: SSE closes → 30 min elapses → isSessionAlive returns false
      // (the service-layer tests verify the actual state transitions;
      // here we test the controller's reaper response to the signal)
      mockMcpService.isSessionAlive.mockReturnValue(false);

      // Next reaper tick — session evicted
      jest.advanceTimersByTime(30_000);

      // Verify disconnect was called and session removed
      expect(mockMcpService.disconnect).toHaveBeenCalledWith(mockMcpServer);

      // Session is gone — GET returns 404
      const reqGet = mockReq({
        headers: { 'mcp-session-id': 'session-abc' },
      });
      const { mock: mockGetRes } = mockRes();
      await controller.handleGet(reqGet, mockGetRes as unknown as Response);
      expect(mockGetRes.status).toHaveBeenCalledWith(404);
    });
  });
});
