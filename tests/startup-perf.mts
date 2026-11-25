/** Focused synthetic startup benchmark. Never reads the user's database. */
import { createRequire } from 'node:module';
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
const root = path.resolve('tmp'); fs.mkdirSync(root, { recursive: true });
const dir = fs.mkdtempSync(path.join(root, 'startup-perf-'));
const loader = Module as unknown as { _load: (...args: any[]) => any };
const original = loader._load;
loader._load = function(request, parent, main) {
  if (request === 'electron') return { app: { getPath: () => dir } };
  return original.call(this, request, parent, main);
};
try {
  const { ChessDatabase } = require('../electron/db');
  const { Chess } = require('chess.js');
  const chess = new Chess();
  const moves = [];
  let seed = 233;
  for (let i = 0; i < 80 && !chess.isGameOver(); i++) {
    const before = chess.fen(), legal = chess.moves({ verbose: true });
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const played = legal[seed % legal.length];
    chess.move(played);
    const reply = chess.moves({ verbose: true })[0];
    const uci = (m: any) => m ? m.from + m.to + (m.promotion || '') : '';
    const evaluation = (best: string) => ({ scoreCp: 10, depth: 14, actualDepth: 14, status: 'complete', bound: 'exact', bestMoveUci: best, pv: best ? [best] : [] });
    moves.push({ ply:i+1,moveNumber:Math.floor(i/2)+1,color:played.color,san:played.san,uci:uci(played),from:played.from,to:played.to,piece:played.piece,captured:played.captured,
      isCheck:false,isCheckmate:false,fenBefore:before,fenAfter:chess.fen(),evalBefore:evaluation(uci(played)),evalAfter:evaluation(uci(reply)),quality:i%11===0?'mistake':'best',winChanceBefore:50,winChanceAfter:50,winChanceDrop:0 });
  }
  const zero = { brilliant:0,great:0,best:0,excellent:0,good:0,book:0,inaccuracy:0,mistake:0,blunder:0,miss:0 };
  const games = Array.from({length:80},(_,i)=>({id:'game_'+i.toString(16).padStart(16,'0'),white:'Alice',black:'Bob',pgn:chess.pgn(),date:'2026.10.20',createdAt:'2026-10-21T00:00:00Z',accuracyWhite:90,accuracyBlack:90,result:'*',analysisVersion:2,missedOpportunityVersion:1,moves,summaryWhite:zero,summaryBlack:zero}));
  fs.writeFileSync(path.join(dir,'games_db.json'),JSON.stringify({games}));
  const start = performance.now(); const db = new ChessDatabase(); const loaded = performance.now();
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 5);
  try {
    if (process.argv.includes('--async')) await db.getGamesAsync('Alice');
    else db.getGames('Alice');
  } finally { clearInterval(heartbeat); }
  const archive = performance.now();
  db.getPlayerStats('Alice'); const stats = performance.now();
  const result = {games:games.length,pliesPerGame:moves.length,loadMs:Math.round(loaded-start),archiveMs:Math.round(archive-loaded),statsMs:Math.round(stats-archive),totalMs:Math.round(stats-start),startupWithoutStatsMs:Math.round(archive-start),archiveYields:ticks};
  console.log(JSON.stringify(result));
  if(process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]),JSON.stringify(result,null,2));
} finally {
  loader._load = original;
  if(path.dirname(path.resolve(dir))!==root||!path.basename(dir).startsWith('startup-perf-')) throw Error('Unsafe test directory');
  fs.rmSync(dir,{recursive:true,force:true});
}
