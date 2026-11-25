/** Focused star/mate-distance checks; no full regression run or user archive. */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');
const { classifyMove, reviewBadgeQuality } = require('../src/utils/analysis');
const { updateMoveClassifications } = require('../src/utils/moveClassification');
const { reviewQualityCounts } = require('../src/utils/moveQuality');
const evaluation = (scoreCp: number, mate?: number) => ({scoreCp,mate,bestMoveUci:'g6g7',pv:['g6g7'],depth:14,actualDepth:14,status:'complete',bound:'exact'});
const result = (color: string, beforeMate: number, afterMate: number, isPlayedMoveBest=false) => classifyMove({color,evalBefore:evaluation(0,beforeMate),evalAfter:evaluation(0,afterMate),isPlayedMoveBest});
assert.equal(result('w',1,2).quality,'excellent');
assert.equal(result('w',1,2,true).quality,'excellent','Even a stale stored best move cannot label a prolonged mate best');
assert.equal(result('w',1,1).quality,'excellent','After moving, remaining M1 means the original mate was delayed');
assert.equal(result('w',3,2).quality,'best','One winning move has already been spent');
assert.equal(result('b',-1,-2).quality,'excellent');
assert.equal(result('b',-3,-2).quality,'best');
assert.equal(result('w',-3,-2).quality,'excellent','Do not reward allowing a faster opposing mate');
assert.equal(result('w',-3,-3).quality,'best');
assert.equal(result('b',3,2).quality,'excellent');
assert.equal(result('b',3,3).quality,'best');
assert.equal(classifyMove({color:'w',evalBefore:evaluation(20),evalAfter:evaluation(20),isPlayedMoveBest:false}).quality,'excellent');
assert.equal(classifyMove({color:'w',evalBefore:evaluation(20),evalAfter:evaluation(20),isPlayedMoveBest:true}).quality,'best');
assert.equal(classifyMove({color:'w',evalBefore:evaluation(1000,1),evalAfter:evaluation(100000,0),isPlayedMoveBest:false,isCheckmate:true}).quality,'best');
assert.equal(classifyMove({color:'b',evalBefore:evaluation(-1000,-1),evalAfter:evaluation(-100000,0),isPlayedMoveBest:false,isCheckmate:true}).quality,'best');
assert.equal(classifyMove({color:'w',evalBefore:evaluation(1000),evalAfter:evaluation(-1000),isPlayedMoveBest:false,isForced:true}).quality,'best');
assert.notEqual(classifyMove({color:'w',evalBefore:evaluation(1000,1),evalAfter:evaluation(1500),isPlayedMoveBest:true}).quality,'best');
const fen = '7k/8/5KQ1/8/8/8/8/8 w - - 0 1', board = new Chess(fen), played = board.move('Qh6+');
const move={ply:1,moveNumber:1,color:'w',san:played.san,uci:'g6h6',from:'g6',to:'h6',piece:'q',isCheck:true,isCheckmate:false,fenBefore:fen,fenAfter:board.fen(),evalBefore:evaluation(1000,1),evalAfter:evaluation(1000,1),quality:'best',winChanceBefore:99.9,winChanceAfter:99.9,winChanceDrop:0};
const zero={brilliant:0,great:0,best:0,excellent:0,good:0,book:0,inaccuracy:0,mistake:0,blunder:0,miss:0};
const game={moves:[move],summaryWhite:{...zero,best:1},summaryBlack:zero,accuracyWhite:100,accuracyBlack:100};
const fixed=updateMoveClassifications(game);
assert.equal(fixed.moves[0].quality,'excellent');
assert.equal(fixed.summaryWhite.best,0);
assert.equal(reviewQualityCounts(fixed.moves).white.best,0);
assert.equal(reviewBadgeQuality(fixed.moves[0]),'excellent');
assert.equal(fixed.accuracyWhite,100,'This label correction does not invent a winning-chance loss');
assert.equal(move.quality,'best','Original input remains untouched');
assert.equal(updateMoveClassifications(fixed),fixed,'Do not repeat correction');
console.log('Best-move smoke: white/black mate distances, terminal mates, alternatives, forced moves and legacy stars passed.');

if(process.argv.includes('--engine')) {
  const Module = (await import('node:module')).default as any;
  const original=Module._load;
  Module._load=function(request: string,parent: unknown,main: boolean){if(request==='electron')return {app:{getAppPath:()=>process.cwd(),getPath:()=>process.cwd()}};return original.call(this,request,parent,main);};
  const {StockfishEngine}=require('../electron/stockfish');
  Module._load=original;
  const engine=new StockfishEngine();
  try {
    const before=await engine.evaluateFen(fen,12,[],fen);
    const after=await engine.evaluateFen(fen,12,['g6h6'],board.fen());
    assert.equal(before.mate,1);
    assert.equal(after.mate,1,'M1 remaining after Qh6+ is slower than immediate Qg7#');
    assert.equal(classifyMove({color:'w',evalBefore:before,evalAfter:after,isPlayedMoveBest:before.bestMoveUci==='g6h6'}).quality,'excellent');
    console.log('Local Stockfish: actual M1 -> delayed Qh6+ verified without a star.');
  } finally { engine.dispose(); }
}
