import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { StockfishMcpEngine } from '../electron/aiCoachMcp';

const require = createRequire(import.meta.url);
const {
  analyzePositionFacts,
  applyMoveSequence,
  describeMoveStructuralDiff,
  pvUciToSan,
} = require('../electron/chessPositionFacts') as typeof import('../electron/chessPositionFacts');
const { AiCoachMcpServer } = require('../electron/aiCoachMcp') as typeof import('../electron/aiCoachMcp');
const { buildCoachPrompt, resolveAgyModelId } = require('../electron/aiCoach') as typeof import('../electron/aiCoach');
const { APP_SETTINGS_DEFAULTS, normalizeAppSettings } = require('../src/types/chess') as typeof import('../src/types/chess');

function runChessPositionFactsTests() {
  // 1. Knight capture creating doubled pawns on the c-file (bxc6 after Nxc6 when c7 pawn exists)
  const fourKnights = applyMoveSequence('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [
    'e4',
    'e5',
    'Nf3',
    'Nc6',
    'd4',
    'exd4',
    'Nxd4',
    'Nf6',
    'Nc3',
    'Bb4',
  ]);
  const tradeDiff = describeMoveStructuralDiff(fourKnights.fen, 'Nxc6');
  assert.equal(tradeDiff.san, 'Nxc6');
  assert.ok(tradeDiff.observations.some((obs) => obs.includes('schlägt')));

  const recaptureDiff = describeMoveStructuralDiff(tradeDiff.fenAfter, 'bxc6');
  assert.ok(
    recaptureDiff.observations.some((obs) => obs.includes('Doppelbauern') && obs.includes('c-Linie')),
    `Expected doubled c-pawn observation, got: ${JSON.stringify(recaptureDiff.observations)}`,
  );

  // 2. Sicilian bxc6 creates an isolated a6 pawn + half-open b-file
  const sicilian = applyMoveSequence('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [
    'e4', 'c5', 'Nf3', 'Nc6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6', 'Nxc6',
  ]);
  const sicilianFacts = analyzePositionFacts(sicilian.fen);
  assert.equal(sicilianFacts.sideToMove, 'b');
  const sicilianRecapture = describeMoveStructuralDiff(sicilian.fen, 'bxc6');
  assert.ok(
    sicilianRecapture.observations.some((obs) => obs.includes('isolierten Bauern') && obs.includes('a6')),
    `Expected isolated a6 pawn observation, got: ${JSON.stringify(sicilianRecapture.observations)}`,
  );

  // Test pvUciToSan stops gracefully on invalid moves
  const sans = pvUciToSan('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', ['e2e4', 'c7c5', 'zzzz', 'g1f3']);
  assert.deepEqual(sans, ['e4', 'c5']);
  console.log('✓ chessPositionFacts unit tests passed');
}

async function runMcpServerTests() {
  const mockEngine: StockfishMcpEngine = {
    async evaluateFen(fen: string) {
      return {
        scoreCp: 35,
        bestMoveUci: fen.includes(' w ') ? 'e2e4' : 'c7c5',
        pv: fen.includes(' w ') ? ['e2e4', 'e7e5'] : ['c7c5', 'g1f3'],
        depth: 14,
        actualDepth: 14,
        bound: 'exact',
        status: 'complete',
      };
    },
    async evaluateFenMultiPv(fen: string) {
      const turnW = fen.includes(' w ');
      return {
        scoreCp: 35,
        bestMoveUci: turnW ? 'e2e4' : 'c7c5',
        pv: turnW ? ['e2e4', 'e7e5'] : ['c7c5', 'g1f3'],
        depth: 14,
        actualDepth: 14,
        bound: 'exact',
        status: 'complete',
        moves: turnW
          ? [
              { uci: 'e2e4', scoreCp: 35, pv: ['e2e4', 'e7e5'] },
              { uci: 'd2d4', scoreCp: 28, pv: ['d2d4', 'd7d5'] },
            ]
          : [
              { uci: 'c7c5', scoreCp: 10, pv: ['c7c5', 'g1f3'] },
              { uci: 'e7e5', scoreCp: 15, pv: ['e7e5', 'g1f3'] },
            ],
      };
    },
    cancelRequest() {},
  };

  const mcp = new AiCoachMcpServer(mockEngine);
  const { url, token } = await mcp.ensureStarted();
  try {
    // 1. Unauthorized check
    const unauth = await fetch(url, { method: 'POST', body: '{}' });
    assert.equal(unauth.status, 401);

    // 2. initialize
    const initRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
    });
    assert.equal(initRes.status, 200);
    const initJson = (await initRes.json()) as { result?: { serverInfo?: { name?: string } } };
    assert.equal(initJson.result?.serverInfo?.name, 'chess-engine');

    // 3. tools/list
    const listRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const listJson = (await listRes.json()) as { result?: { tools?: Array<{ name: string }> } };
    const toolNames = (listJson.result?.tools || []).map((t) => t.name);
    assert.deepEqual(toolNames, ['inspect_position', 'evaluate_position', 'compare_moves']);

    // 4. tools/call -> compare_moves
    const compareRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'compare_moves',
          arguments: {
            fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            candidateMoves: ['e4', 'd4'],
            depth: 12,
          },
        },
      }),
    });
    const compareJson = (await compareRes.json()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    assert.equal(compareJson.result?.isError, false);
    const parsedContent = JSON.parse(compareJson.result?.content?.[0]?.text || '{}') as {
      comparisons?: Array<{ moveSan: string }>;
    };
    assert.deepEqual(
      (parsedContent.comparisons || []).map((c) => c.moveSan),
      ['e4', 'd4'],
    );
  } finally {
    await mcp.stop();
  }
  console.log('✓ AiCoachMcpServer unit tests passed');
}

function runAiCoachModelAndPromptTests() {
  assert.equal(resolveAgyModelId('hydrogen', 'low'), 'gemini-4-hydrogen-high');
  assert.equal(resolveAgyModelId('hydrogen', 'medium'), 'gemini-4-hydrogen-high');
  assert.equal(resolveAgyModelId('hydrogen', 'high'), 'gemini-4-hydrogen-high');
  assert.equal(resolveAgyModelId('hydrogen', 'xhigh'), 'gemini-4-hydrogen-xhigh');
  assert.equal(resolveAgyModelId('neon', 'low'), 'gemini-4-neon-low');
  assert.equal(resolveAgyModelId('neon', 'medium'), 'gemini-4-neon-medium');
  assert.equal(resolveAgyModelId('neon', 'high'), 'gemini-4-neon-high');
  assert.equal(resolveAgyModelId('neon', 'xhigh'), 'gemini-4-neon-xhigh');

  const fenBefore = 'r1bqkb1r/1ppp1ppp/p1n2n2/4p3/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6';
  const seq = applyMoveSequence(fenBefore, ['Nxc6']);
  const prompt = buildCoachPrompt({
    requestId: 'test-1',
    modelFamily: 'hydrogen',
    effort: 'low',
    fenBefore,
    fenAfter: seq.fen,
    moveNumber: 6,
    color: 'w',
    playedSan: 'Sxc6',
    playedUci: 'd4c6',
    quality: 'inaccuracy',
    bestMoveSan: 'Sb3',
    bestMoveUci: 'd4b3',
    evalBeforeText: '+0.40',
    evalAfterText: '0.00',
    winChanceDrop: 4.5,
  });
  assert.ok(prompt.includes('Faustregeln') || prompt.includes('Schachprinzipien'));
  assert.ok(prompt.includes('compare_moves'));
  assert.ok(prompt.includes(fenBefore));

  const followUp = buildCoachPrompt({
    requestId: 'test-2',
    modelFamily: 'neon',
    effort: 'medium',
    fenBefore,
    fenAfter: seq.fen,
    moveNumber: 6,
    color: 'w',
    playedSan: 'Sxc6',
    playedUci: 'd4c6',
    conversationId: '12345678-1234-1234-1234-123456789abc',
    question: 'Warum hilft mir das im Endspiel?',
  });
  assert.ok(followUp.includes('Warum hilft mir das im Endspiel?'));
  assert.ok(followUp.includes('Merkregel'));

  // English prompt & AppSettings language normalization
  const englishPrompt = buildCoachPrompt({
    requestId: 'test-en-1',
    modelFamily: 'hydrogen',
    effort: 'high',
    language: 'en',
    fenBefore,
    fenAfter: seq.fen,
    moveNumber: 6,
    color: 'w',
    playedSan: 'Nxc6',
    playedUci: 'd4c6',
    quality: 'inaccuracy',
    bestMoveSan: 'Nb3',
    bestMoveUci: 'd4b3',
    evalBeforeText: '+0.40',
    evalAfterText: '0.00',
    winChanceDrop: 4.5,
  });
  assert.ok(englishPrompt.includes('Rule of Thumb for Future Games') && englishPrompt.includes('GAME DATA:'));
  assert.equal(APP_SETTINGS_DEFAULTS.language, 'de');
  assert.equal(normalizeAppSettings({ language: 'en' }).language, 'en');
  assert.equal(normalizeAppSettings({ language: 'fr' as unknown as 'de' }).language, 'de');

  // Ensure temp dir reference doesn't break
  const tmpCheck = path.join(os.tmpdir(), 'pca-ai-coach-test-check');
  assert.ok(!fs.existsSync(tmpCheck + '-nonexistent'));
  console.log('✓ aiCoach model allowlist & prompt builder tests passed');
}

async function main() {
  runChessPositionFactsTests();
  await runMcpServerTests();
  runAiCoachModelAndPromptTests();
  console.log('All AI Coach tests passed!');
}

void main();
