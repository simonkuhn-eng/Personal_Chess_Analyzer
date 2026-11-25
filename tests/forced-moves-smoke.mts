/** Targeted forced-move check only; no complete regression suite or real engine. */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');
const { annotateMissedOpportunities } = require('../src/utils/missedOpportunities');
const { archiveItem } = require('../src/utils/archive');
const { buildTrainingCards } = require('../src/utils/trainingDeck');
const { analyzePgnGame } = require('../src/utils/analyzeGame');
const zero = {brilliant:0,great:0,best:0,excellent:0,good:0,book:0,inaccuracy:0,mistake:0,blunder:0,miss:0};
const forcedFen = '8/p7/8/8/8/8/5k1r/7K w - - 0 1';
const evaluation = (scoreCp: number, bestMoveUci: string) => ({scoreCp,bestMoveUci,pv:[bestMoveUci],depth:14,actualDepth:14,status:'complete',bound:'exact'});
function oldGame(fen: string) {
  const board = new Chess(fen), played = board.move('Kxh2');
  return {id:'forced-smoke',white:'Alice',black:'Bob',result:'*',date:'2026.10.21',createdAt:'2026-10-21T00:00:00Z',pgn:'',accuracyWhite:1,accuracyBlack:0,summaryWhite:{...zero,blunder:1},summaryBlack:zero,missedOpportunityVersion:1,
    moves:[{ply:1,moveNumber:1,color:'w',san:played.san,uci:'h1h2',from:'h1',to:'h2',piece:'k',captured:'r',isCheck:false,isCheckmate:false,fenBefore:fen,fenAfter:board.fen(),evalBefore:evaluation(1000,'h1h2'),evalAfter:evaluation(-1000,'a7a6'),quality:'blunder',winChanceBefore:99,winChanceAfter:1,winChanceDrop:98}]};
}
assert.equal(new Chess(forcedFen).moves().length, 1);
const legacy = oldGame(forcedFen), fixed = annotateMissedOpportunities(legacy);
assert.equal(fixed.moves[0].isForced, true);
assert.equal(fixed.moves[0].quality, 'best');
assert.equal(fixed.moves[0].winChanceDrop, 0);
assert.equal(fixed.moves[0].evalAfter.scoreCp, -1000, 'real position score is preserved');
assert.equal(fixed.accuracyWhite, 100);
assert.equal(archiveItem(fixed, 'Alice').blunderCount, 0);
assert.equal(buildTrainingCards([fixed], 'Alice').length, 0);
assert.equal(legacy.moves[0].quality, 'blunder', 'do not mutate source object');
assert.equal(annotateMissedOpportunities(fixed), fixed, 'do not repeat legacy correction');
const choiceFen = '8/p7/8/8/8/5k2/7r/7K w - - 0 1';
assert.ok(new Chess(choiceFen).moves().length > 1);
assert.equal(annotateMissedOpportunities(oldGame(choiceFen)).moves[0].quality, 'blunder', 'check or capture alone is not a forced move');
let calls = 0;
(globalThis as any).window = {electronAPI:{engine:{evaluateFen:async()=>calls++===0?evaluation(1000,'h1h2'):evaluation(-1000,'a7a6')}}};
const analyzed = await analyzePgnGame(`[SetUp "1"]\n[FEN "${forcedFen}"]\n[White "Alice"]\n[Black "Bob"]\n\n1. Kxh2 *`,14);
assert.equal(analyzed.moves[0].isForced, true);
assert.equal(analyzed.moves[0].quality, 'best');
assert.equal(analyzed.summaryWhite.blunder, 0);
assert.equal(analyzed.accuracyWhite, 100);
console.log('Forced moves: legacy correction, normal choices and complete new-analysis path passed.');
