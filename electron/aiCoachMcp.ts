import http from 'node:http';
import crypto from 'node:crypto';
import type { EngineResult, MultiPvResult } from './stockfish';
import type { EngineSearchOptions } from '../src/types/chess';
import {
  analyzePositionFacts,
  applyMoveSequence,
  describeMoveStructuralDiff,
  pvUciToSan,
} from './chessPositionFacts';

export interface StockfishMcpEngine {
  evaluateFen(
    fen: string,
    depth?: number,
    historyUci?: string[],
    currentFen?: string,
    options?: EngineSearchOptions,
  ): Promise<EngineResult>;
  evaluateFenMultiPv(
    fen: string,
    depth?: number,
    multiPv?: number,
    historyUci?: string[],
    currentFen?: string,
    options?: EngineSearchOptions,
  ): Promise<MultiPvResult>;
  cancelRequest(requestId: string): void;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const MAX_BODY_BYTES = 256 * 1024;
const RATE_WINDOW_MS = 60_000;
const MAX_ENGINE_CALLS_PER_WINDOW = 10;

function formatEvalText(scoreCp: number, mate?: number): string {
  if (typeof mate === 'number' && Number.isFinite(mate) && mate !== 0) {
    return mate > 0 ? `+M${mate} (Matt für Weiß)` : `-M${Math.abs(mate)} (Matt für Schwarz)`;
  }
  const pawns = (scoreCp / 100).toFixed(2);
  return scoreCp >= 0 ? `+${pawns}` : pawns;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

const MCP_TOOLS = [
  {
    name: 'inspect_position',
    description:
      'Prüft eine Schachstellung (optional nach einer kurzen Zugfolge) deterministisch auf Bauernstruktur (Doppelbauern, Isolanis, Freibauern), offene Linien, Königssicherheit, Läuferpaar, Figurenaktivität und ungedeckte/angegriffene Figuren. Schnell, ohne Stockfish.',
    inputSchema: {
      type: 'object',
      properties: {
        fen: { type: 'string', description: 'Ausgangsstellung als gültige FEN.' },
        moves: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optionale Zugfolge ab FEN (SAN wie "Sxe5"/"Nxe5" oder UCI wie "f3e5").',
        },
      },
      required: ['fen'],
    },
  },
  {
    name: 'evaluate_position',
    description:
      'Berechnet mit Stockfish die besten Züge und kurzen Varianten (PV in SAN) für eine Stellung oder nach einer kurzen Zugfolge. Nutze dies, um die wichtigsten Gegenantworten oder Alternativen zu prüfen.',
    inputSchema: {
      type: 'object',
      properties: {
        fen: { type: 'string', description: 'Ausgangsstellung als gültige FEN.' },
        moves: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optionale Zugfolge ab FEN (SAN oder UCI), bevor Stockfish bewertet.',
        },
        depth: {
          type: 'integer',
          minimum: 8,
          maximum: 18,
          description: 'Suchtiefe (Standard 14, Bereich 8–18).',
        },
        multiPv: {
          type: 'integer',
          minimum: 1,
          maximum: 4,
          description: 'Anzahl Top-Züge (Standard 3, Bereich 1–4).',
        },
      },
      required: ['fen'],
    },
  },
  {
    name: 'compare_moves',
    description:
      'Vergleicht 1 bis 4 konkrete Kandidatenzüge direkt miteinander: ermittelt für jeden Zug sowohl strukturelle Auswirkungen (z. B. Doppelbauer, offene Linie, hängende Figur) als auch Stockfish-Bewertung und beste gegnerische Antwort.',
    inputSchema: {
      type: 'object',
      properties: {
        fen: { type: 'string', description: 'Stellung VOR den zu vergleichenden Zügen als gültige FEN.' },
        candidateMoves: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: { type: 'string' },
          description: '1 bis 4 legale Züge in dieser Stellung (SAN wie "Nxc6" oder UCI wie "d4c6").',
        },
        depth: {
          type: 'integer',
          minimum: 8,
          maximum: 18,
          description: 'Suchtiefe pro Zug (Standard 14, Bereich 8–18).',
        },
      },
      required: ['fen', 'candidateMoves'],
    },
  },
];

export class AiCoachMcpServer {
  private readonly engine: StockfishMcpEngine;
  private readonly authToken = crypto.randomBytes(24).toString('hex');
  private readonly sessionId = crypto.randomUUID();
  private server: http.Server | null = null;
  private startPromise: Promise<{ url: string; token: string }> | null = null;
  private activeSearchIds = new Set<string>();
  private recentEngineCallTimestamps: number[] = [];

  constructor(engine: StockfishMcpEngine) {
    this.engine = engine;
  }

  async ensureStarted(): Promise<{ url: string; token: string }> {
    if (this.server && this.server.listening) {
      const addr = this.server.address();
      if (addr && typeof addr === 'object') {
        return { url: `http://127.0.0.1:${addr.port}/mcp`, token: this.authToken };
      }
    }
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise<{ url: string; token: string }>((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        void this.handleHttpRequest(req, res);
      });
      srv.on('error', (err) => {
        this.startPromise = null;
        reject(err);
      });
      srv.listen(0, '127.0.0.1', () => {
        this.server = srv;
        const addr = srv.address();
        if (!addr || typeof addr !== 'object') {
          this.startPromise = null;
          reject(new Error('MCP-Server konnte keinen lokalen Port binden.'));
          return;
        }
        resolve({ url: `http://127.0.0.1:${addr.port}/mcp`, token: this.authToken });
      });
    });

    return this.startPromise;
  }

  cancelAllActiveSearches(): void {
    for (const id of this.activeSearchIds) {
      try {
        this.engine.cancelRequest(id);
      } catch {
        // Ignore best-effort cancel error
      }
    }
    this.activeSearchIds.clear();
  }

  async stop(): Promise<void> {
    this.cancelAllActiveSearches();
    this.startPromise = null;
    const srv = this.server;
    this.server = null;
    if (!srv) return;
    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
    });
  }

  private trackEngineRateLimit(): boolean {
    const now = Date.now();
    this.recentEngineCallTimestamps = this.recentEngineCallTimestamps.filter((ts) => now - ts < RATE_WINDOW_MS);
    if (this.recentEngineCallTimestamps.length >= MAX_ENGINE_CALLS_PER_WINDOW) {
      return false;
    }
    this.recentEngineCallTimestamps.push(now);
    return true;
  }

  private async runTrackedEngine<T>(fn: (requestId: string) => Promise<T>): Promise<T> {
    if (!this.trackEngineRateLimit()) {
      throw new Error(
        `Engine-Abfragelimit erreicht (max. ${MAX_ENGINE_CALLS_PER_WINDOW} Aufrufe pro Minute). Erkläre die Stellung jetzt anhand der vorhandenen Daten und Schachregeln.`,
      );
    }
    const requestId = `ai-${crypto.randomUUID()}`;
    this.activeSearchIds.add(requestId);
    try {
      return await fn(requestId);
    } finally {
      this.activeSearchIds.delete(requestId);
    }
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const authHeader = req.headers.authorization || '';
    const expected = `Bearer ${this.authToken}`;
    const authBuf = Buffer.from(authHeader);
    const expBuf = Buffer.from(expected);
    if (authBuf.length !== expBuf.length || !crypto.timingSafeEqual(authBuf, expBuf)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (req.method === 'GET') {
      res.writeHead(405, { Allow: 'POST, DELETE' });
      res.end();
      return;
    }

    if (req.method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, DELETE' });
      res.end();
      return;
    }

    let rawBody = '';
    try {
      rawBody = await this.readBody(req);
    } catch (err) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: err instanceof Error ? err.message : 'Request too large' } }));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }

    const isBatch = Array.isArray(parsed);
    const messages: JsonRpcRequest[] = isBatch ? (parsed as JsonRpcRequest[]) : [parsed as JsonRpcRequest];
    const responses: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') {
        responses.push({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
        continue;
      }
      const response = await this.handleJsonRpcMessage(msg);
      if (response !== null) {
        responses.push(response);
      }
    }

    if (responses.length === 0) {
      res.writeHead(202, { 'Mcp-Session-Id': this.sessionId });
      res.end();
      return;
    }

    const payload = isBatch ? responses : responses[0];
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Mcp-Session-Id': this.sessionId,
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          reject(new Error('Request body exceeds 256 KB limit'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', (err) => reject(err));
    });
  }

  private async handleJsonRpcMessage(msg: JsonRpcRequest): Promise<Record<string, unknown> | null> {
    const hasId = msg.id !== undefined && msg.id !== null;
    const method = msg.method || '';

    // Notifications without id do not receive a JSON-RPC response object
    if (!hasId) {
      return null;
    }

    if (method === 'initialize') {
      const requestedVersion =
        msg.params && typeof msg.params.protocolVersion === 'string'
          ? msg.params.protocolVersion
          : '2025-03-26';
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: requestedVersion,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: 'chess-engine',
            version: '1.0.0',
          },
          instructions:
            'Nutze diese Schach-Tools nur, wenn konkrete Varianten oder Stellungsfakten zur Erklärung helfen.',
        },
      };
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id: msg.id, result: {} };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: MCP_TOOLS },
      };
    }

    if (method === 'tools/call') {
      const toolName = msg.params && typeof msg.params.name === 'string' ? msg.params.name : '';
      const args =
        msg.params && msg.params.arguments && typeof msg.params.arguments === 'object'
          ? (msg.params.arguments as Record<string, unknown>)
          : {};
      try {
        const resultData = await this.executeTool(toolName, args);
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(resultData, null, 2) }],
            isError: false,
          },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          },
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === 'inspect_position') {
      const fen = typeof args.fen === 'string' ? args.fen.trim() : '';
      if (!fen) throw new Error('Parameter "fen" ist erforderlich.');
      const moves = Array.isArray(args.moves) ? (args.moves as string[]) : undefined;
      const seq = applyMoveSequence(fen, moves);
      const facts = analyzePositionFacts(seq.fen);
      return {
        appliedMovesSan: seq.appliedSan,
        facts,
      };
    }

    if (name === 'evaluate_position') {
      const fen = typeof args.fen === 'string' ? args.fen.trim() : '';
      if (!fen) throw new Error('Parameter "fen" ist erforderlich.');
      const moves = Array.isArray(args.moves) ? (args.moves as string[]) : undefined;
      const depth = clampInt(args.depth, 8, 18, 14);
      const multiPv = clampInt(args.multiPv, 1, 4, 3);
      const seq = applyMoveSequence(fen, moves);

      const evalRes = await this.runTrackedEngine((requestId) =>
        this.engine.evaluateFenMultiPv(seq.fen, depth, multiPv, undefined, seq.fen, {
          requestId,
          maxTimeMs: 3000,
        }),
      );

      if (evalRes.status === 'unavailable') {
        throw new Error('Stockfish ist aktuell nicht verfügbar. Erkläre die Stellung anhand von Schachregeln.');
      }

      const lines = (evalRes.moves && evalRes.moves.length > 0
        ? evalRes.moves
        : evalRes.bestMoveUci
          ? [{ uci: evalRes.bestMoveUci, scoreCp: evalRes.scoreCp, mate: evalRes.mate, pv: evalRes.pv }]
          : []
      ).map((line, index) => {
        const pvSan = pvUciToSan(seq.fen, line.pv, 8);
        return {
          rank: index + 1,
          moveSan: pvSan[0] || line.uci,
          moveUci: line.uci,
          evalText: formatEvalText(line.scoreCp, line.mate),
          evalCpWhitePov: line.scoreCp,
          mateWhitePov: line.mate,
          pvSan,
        };
      });

      return {
        fen: seq.fen,
        appliedMovesSan: seq.appliedSan,
        sideToMove: seq.chess.turn(),
        actualDepth: evalRes.actualDepth,
        status: evalRes.status,
        lines,
      };
    }

    if (name === 'compare_moves') {
      const fen = typeof args.fen === 'string' ? args.fen.trim() : '';
      if (!fen) throw new Error('Parameter "fen" ist erforderlich.');
      const rawCandidates = Array.isArray(args.candidateMoves) ? args.candidateMoves : [];
      const candidates = rawCandidates
        .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
        .slice(0, 4);
      if (candidates.length === 0) {
        throw new Error('Parameter "candidateMoves" muss 1 bis 4 Züge enthalten.');
      }
      const depth = clampInt(args.depth, 8, 18, 14);

      const results = [];
      for (const candidate of candidates) {
        const diff = describeMoveStructuralDiff(fen, candidate);
        const evalAfter = await this.runTrackedEngine((requestId) =>
          this.engine.evaluateFen(diff.fenAfter, depth, undefined, diff.fenAfter, {
            requestId,
            maxTimeMs: 2500,
          }),
        );
        const replyPvSan = pvUciToSan(diff.fenAfter, evalAfter.pv, 6);
        results.push({
          moveSan: diff.san,
          moveUci: diff.uci,
          evalAfterText:
            evalAfter.status === 'unavailable'
              ? 'Engine nicht verfügbar'
              : formatEvalText(evalAfter.scoreCp, evalAfter.mate),
          evalCpWhitePov: evalAfter.scoreCp,
          mateWhitePov: evalAfter.mate,
          actualDepth: evalAfter.actualDepth,
          bestReplySan: replyPvSan[0] || null,
          replyLineSan: replyPvSan,
          structuralObservations: diff.observations,
        });
      }

      return {
        fenBefore: fen,
        sideMoving: fen.split(' ')[1] === 'b' ? 'Schwarz' : 'Weiß',
        comparisons: results,
      };
    }

    throw new Error(`Unbekanntes Tool: ${name}`);
  }
}
