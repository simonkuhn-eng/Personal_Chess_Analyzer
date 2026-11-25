import React from 'react';
import { createRoot } from 'react-dom/client';
import { Chess } from 'chess.js';
import { StorageStatus } from '../src/components/StorageStatus';
import { App } from '../src/App';
import { PgnImportModal } from '../src/components/PgnImportModal';
import { TrainingDeckView } from '../src/components/TrainingDeckView';
import { APP_SETTINGS_DEFAULTS } from '../src/types/chess';
import { annotateMissedOpportunities } from '../src/utils/missedOpportunities';
import { EvalBar } from '../src/components/EvalBar';
import '../src/index.css';

const mode=new URLSearchParams(location.search).get('case')||'fresh';
window.__audit={saved:0,completed:0,engineCalls:0,statsCalls:0,latestCalls:0,opened:[],hold:mode==='modal'||mode==='latest-cancel',quotaWrites:0,failQuota:true,contexts:[]};
const info={version:1,jobs:[],knownIds:[]};
const normalEval=(fen)=>{const board=new Chess(fen),move=board.moves({verbose:true})[0],uci=move?move.from+move.to+(move.promotion||''):'';
 return {scoreCp:10,bestMoveUci:uci,pv:uci?[uci]:[],depth:14,actualDepth:14,status:'complete',bound:'exact'};};
window.electronAPI={
 db:{getGames:async()=>mode.startsWith('review')?[{...game,blunderCount:mode==='review'?1:0,mistakeCount:0}]:[],getGame:async id=>mode.startsWith('review')?game:mode==='latest-existing'?{...game,id}:null,saveGame:async game=>{window.__audit.saved++;return game;},getReviewIdMap:async()=>({}),getPlayerStats:async()=>{window.__audit.statsCalls++;return {totalGames:0};},getStableGameIds:async()=>[]},
 settings:{get:async()=>({...APP_SETTINGS_DEFAULTS,...(mode.startsWith('review')?{playerName:'Alice',profileId:'browser-profile'}:{})}),save:async value=>({...APP_SETTINGS_DEFAULTS,...value})},
 engine:{getStatus:async()=>({installed:false,ready:false,path:'engine/stockfish.exe',engineName:'Stockfish'}),evaluateFen:async(start,depth,history,current)=>{
  window.__audit.engineCalls++;if(window.__audit.hold){window.__audit.waiting=true;await new Promise(resolve=>window.__audit.release=()=>{window.__audit.hold=false;window.__audit.waiting=false;resolve();});}
  if(mode==='training'||mode==='quota')return {...normalEval(start),scoreCp:-1000};
  return normalEval(current||start);
 },evaluateFenMultiPv:async(start,depth,pv,history,current)=>{window.__audit.contexts.push({start,history,current});const chess=new Chess(start);for(const uci of history||[])chess.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]});if(chess.fen()!==current)throw Error('Engine history/FEN mismatch');const value=normalEval(current),result={...value,moves:value.bestMoveUci?[{uci:value.bestMoveUci,...value}]:[]};if(mode==='review-hold')return new Promise(resolve=>{window.__audit.pendingEvals??=[];window.__audit.pendingEvals.push(scoreCp=>resolve({...result,scoreCp}));});return result;}},
 chesscom:{listJobs:async()=>info,claimNextJob:async()=>null,markJob:async()=>null,fetchLatestGame:async name=>{window.__audit.latestCalls++;return {pgn:'[Site "https://www.chess.com/game/live/123456789"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 1-0',white:'Alice',black:'Bob',result:'1-0',endTime:1792750000,timeClass:'blitz'};}},
 lichess:{listJobs:async()=>info,claimNextJob:async()=>null,markJob:async()=>null},
 data:{getPath:async()=>'isolated-fixture',openFolder:async()=>{},createBackup:async()=>({path:'fixture',files:0})},
};
const board=new Chess(),initial=board.fen();board.move('f3');
const zero={brilliant:0,great:0,best:0,excellent:0,good:0,book:0,inaccuracy:0,mistake:0,blunder:0,miss:0};
const move={ply:1,moveNumber:1,color:'w',san:'f3',uci:'f2f3',from:'f2',to:'f3',piece:'p',isCheck:false,isCheckmate:false,fenBefore:initial,fenAfter:board.fen(),
 evalBefore:{scoreCp:0,bestMoveUci:'e2e4',pv:['e2e4','e7e5','g1f3','b8c6'],depth:14,actualDepth:14,status:'complete'},evalAfter:{scoreCp:-1000,bestMoveUci:'e7e5',pv:['e7e5','g2g4','d8h4'],depth:14,actualDepth:14,status:'complete'},quality:'blunder',winChanceBefore:50,winChanceAfter:2.5,winChanceDrop:47.5};
let game={id:'audit_training',white:'Alice',black:'Opponent',pgn:'1. f3 *',result:'*',date:'2026.10.21',createdAt:'2026-10-21T12:00:00Z',accuracyWhite:30,accuracyBlack:90,summaryWhite:{...zero,blunder:1},summaryBlack:zero,moves:[move]};
if(mode==='chance'||mode==='review-chance'){
 const fen='6k1/8/8/3q4/8/8/8/3Q2K1 w - - 0 1',position=new Chess(fen);position.move('Kf1');
 const chance={...move,san:'Kf1',uci:'g1f1',from:'g1',to:'f1',piece:'k',fenBefore:fen,fenAfter:position.fen(),quality:'mistake',openingAnnotation:'Teststellung',winChanceDrop:17.4,
  evalBefore:{...move.evalBefore,scoreCp:1410,bestMoveUci:'d1d5',pv:['d1d5','g8h8']},evalAfter:{...move.evalAfter,scoreCp:410,bestMoveUci:'d5a5',pv:['d5a5']}};
 game=annotateMissedOpportunities({...game,id:'audit_chance',pgn:`[SetUp "1"]\n[FEN "${fen}"]\n\n1. Kf1 *`,summaryWhite:{...zero,mistake:1},moves:[chance]});
}
if(mode==='quota'){
 const original=Storage.prototype.setItem;
 Storage.prototype.setItem=function(key,value){if(window.__audit.failQuota&&key.includes('reviews-v1:')){window.__audit.quotaWrites++;throw new DOMException('Audit quota failure','QuotaExceededError');}return original.call(this,key,value);};
}
if(mode==='review-arrows'){
 const board=new Chess();
 const alternatives=['f2f4','e7e5','e2e4','d7d5'];
 const played=['f2f3','e7e6','g1h3','d7d6'];
 const moves=played.map((uci,index)=>{
  const fenBefore=board.fen(),step=board.move({from:uci.slice(0,2),to:uci.slice(2,4)});
  return {...move,ply:index+1,moveNumber:Math.floor(index/2)+1,color:step.color,san:step.san,uci,from:step.from,to:step.to,piece:step.piece,fenBefore,fenAfter:board.fen(),
   evalBefore:{...normalEval(fenBefore),bestMoveUci:alternatives[index],pv:[alternatives[index]]},evalAfter:normalEval(board.fen()),quality:'good',winChanceBefore:50,winChanceAfter:48,winChanceDrop:2};
 });
 game={...game,id:'audit_review_arrows',pgn:board.pgn(),moves,accuracyWhite:90,accuracyBlack:90,summaryWhite:{...zero,good:2},summaryBlack:{...zero,good:2}};
}
if(mode.startsWith('review-why')){
 const fen='3q2k1/3r2pp/8/2B5/8/8/8/3R1RK1 w - - 0 1',position=new Chess(fen),step=position.move('Rxd7');
 game={...game,id:'why_ui',pgn:`[SetUp "1"]\n[FEN "${fen}"]\n\n1. Rxd7 *`,moves:[{...move,fenBefore:fen,fenAfter:position.fen(),san:step.san,uci:'d1d7',from:'d1',to:'d7',piece:'r',quality:'good',
  evalBefore:{...move.evalBefore,bestMoveUci:'d1d7',pv:['d1d7','d8e8'],scoreCp:400},evalAfter:{...normalEval(position.fen()),scoreCp:400}}]};
 window.__audit.whyCalls=[];window.__audit.cancelledWhy=[];window.__audit.pendingWhy=[];
 window.electronAPI.engine.getStatus=async()=>({installed:true,ready:false,path:'fixture',engineName:'Fixture'});
 window.electronAPI.engine.cancelRequest=async id=>{window.__audit.cancelledWhy.push(id);};
 window.electronAPI.engine.evaluateFen=async(start,depth,history=[],current,options)=>{
  window.__audit.whyCalls.push({start,depth,history:[...history],current,options});
  const board=new Chess(start);history.forEach(uci=>board.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]}));
  if(board.fen()!==current)throw Error('Why history/FEN mismatch');
  let uci=options?.searchMoves?.[0]||'d1d7',pv=uci==='d1d7'?['d1d7','d8e8']:[uci],scoreCp=uci==='d1d7'?400:100,mate;
  if(history.length===2&&history[1]==='d8d7'){uci='f1f8';pv=['f1f8'];scoreCp=100000;mate=1;}
  else if(history.length) {const first=board.moves({verbose:true})[0];uci=first?first.from+first.to+(first.promotion||''):'';pv=uci?[uci]:[];}
  const value={scoreCp,mate,bestMoveUci:uci,pv,depth,actualDepth:depth,status:'complete',bound:'exact'};
  if(mode==='review-why-empty')return {...value,status:'unavailable',actualDepth:0,pv:[],bestMoveUci:''};
  if(mode==='review-why-hold')return new Promise(resolve=>window.__audit.pendingWhy.push(()=>resolve(value)));
  return value;
 };
}
window.__audit.originalGame=JSON.stringify(game);window.__audit.getGame=()=>JSON.stringify(game);
function EvalBarHarness(){const[value,setValue]=React.useState({scoreCp:180,resetKey:'first'});window.__audit.setBar=setValue;return <div style={{height:400,padding:20}}><EvalBar {...value}/></div>;}
function Harness(){const[open,setOpen]=React.useState(true);
 if(mode==='evalbar')return <EvalBarHarness/>;
 if(mode==='fresh'||mode.startsWith('review'))return <App/>;
 if(mode==='modal'||mode.startsWith('latest'))return <div style={{padding:20}}>{open?<PgnImportModal defaultPlayerName="Alice" defaultDepth={14} onClose={()=>setOpen(false)} onOpenExistingGame={async id=>{window.__audit.opened.push(id);}} onAnalysisComplete={async game=>{window.__audit.completed++;window.__audit.loadedGame=game;if(mode.startsWith('latest'))setOpen(false);}}/>:<h2>Dialog geschlossen</h2>}</div>;
 return <div style={{height:'100vh',padding:18,display:'flex',flexDirection:'column',gap:16}}><StorageStatus/><button className="btn-secondary" onClick={()=>setOpen(value=>!value)}>{open?'Verlassen':'Training öffnen'}</button>{open?<TrainingDeckView games={[game]} targetPlayer="Alice" onClearFilter={()=>{}}/>:<h2>Training verlassen</h2>}</div>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
