/** Focused latest-game API checks with mocked HTTP; no real account requests. */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { fetchLatestGame } = require('../electron/chesscom') as typeof import('../electron/chesscom');
const originalFetch = globalThis.fetch;
const archive = 'https://api.chess.com/pub/player/Alice/games/';
const calls: string[] = [];
const game = (id: number, result = '1-0', rules = 'chess') => ({url:`https://www.chess.com/game/live/${id}`,rules,end_time:id,white:{username:'Alice'},black:{username:'Bob'},pgn:`[White "Alice"]\n[Black "Bob"]\n[Result "${result}"]\n\n1. e4 e5 ${result}`});
let responses: Record<string, unknown> = {};
globalThis.fetch = async input => {
  const url = String(input); calls.push(url);
  assert.ok(url in responses, 'Unexpected request: '+url);
  const value = responses[url];
  return new Response(JSON.stringify(value), {status:value === '404' ? 404 : 200,headers:{'content-type':'application/json'}});
};
try {
  responses = {[archive+'archives']:{archives:[archive+'2026/09',archive+'2026/10']},[archive+'2026/10']:{games:[game(10),game(30,'1-0','chess960'),game(40,'*'),game(20)]}};
  assert.equal((await fetchLatestGame('Alice'))?.url,'https://www.chess.com/game/live/20');
  assert.equal(calls.length,2,'Stop after latest month with a supported game');
  calls.length=0;
  responses = {[archive+'archives']:{archives:[archive+'2024/12',archive+'2026/10']},[archive+'2026/10']:{games:[]},[archive+'2024/12']:{games:[game(7)]}};
  assert.equal((await fetchLatestGame('Alice'))?.endTime,7,'Find older last game after inactive months');
  responses = {[archive+'archives']:{archives:[]}};
  assert.equal(await fetchLatestGame('Alice'),null);
  responses = {[archive+'archives']:'404'};
  await assert.rejects(fetchLatestGame('Alice'),/nicht gefunden/);
  await assert.rejects(fetchLatestGame('../bad'),/gültigen Chess.com/);
  console.log('Latest-game API: exact newest standard game, old archives, empty account and errors passed.');
} finally { globalThis.fetch=originalFetch; }
