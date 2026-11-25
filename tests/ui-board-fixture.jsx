import React from 'react';
import { createRoot } from 'react-dom/client';
import { Chess } from 'chess.js';
import { Chessboard } from '../src/components/Chessboard';
import { OpeningTrainerView } from '../src/components/OpeningTrainerView';
import { getOpeningRepertoire, saveOpeningScope, saveRepertoireFavorites } from '../src/utils/openingTraining';
import '../src/index.css';

const params = new URLSearchParams(location.search);
const scenario = params.get('case') || 'capture';
const black = params.get('color') === 'b';
window.__boardAudit = { moves: [] };
if (scenario === 'opening') {
  const repertoire = getOpeningRepertoire('course:caro-kann');
  const branch = repertoire.branches.find(item => item.id === 'caro-kann:panov');
  saveRepertoireFavorites('BoardTest', [repertoire.id]);
  saveOpeningScope('BoardTest', repertoire.id, [branch.id]);
  window.__boardAudit.branch = branch.moves;
  createRoot(document.getElementById('root')).render(<div className="app-main" style={{height:'100vh',padding:16}}><OpeningTrainerView targetPlayer="BoardTest" /></div>);
} else {
  const fens = {
    capture: '6k1/8/8/3p4/4P3/8/8/6NK w - - 0 1',
    source: '6k1/8/8/3p4/5N2/8/8/3R2K1 w - - 0 1',
    castle: `r3k2r/8/8/8/8/8/8/R3K2R ${black ? 'b' : 'w'} KQkq - 0 1`,
    'no-rights': 'r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1',
    'through-check': 'r3kr1r/8/8/8/8/8/8/R3K2R w KQ - 0 1',
    promotion: '1r5k/P7/8/8/8/8/8/7K w - - 0 1',
    'en-passant': '7k/8/8/3pP3/8/8/8/7K w - d6 0 2',
  };
  function BoardFixture() {
    const [fen, setFen] = React.useState(fens[scenario]);
    const [lastMove, setLastMove] = React.useState(null);
    const [interactive, setInteractive] = React.useState(true);
    window.__boardAudit.fen = fen;
    window.__boardAudit.changeFen = setFen;
    window.__boardAudit.setInteractive = setInteractive;
    const onMove = move => {
      const chess = new Chess(fen);
      const played = chess.move(move);
      window.__boardAudit.moves.push(played.from + played.to + (played.promotion || ''));
      setLastMove(move);
      setFen(chess.fen());
    };
    return <div style={{padding:24}}><Chessboard fen={fen} size={560} isFlipped={black} interactive={interactive} lastMove={lastMove} onMove={onMove} /></div>;
  }
  createRoot(document.getElementById('root')).render(<BoardFixture />);
}
