import type { MoveAnalysis } from '../types/chess';
import { isReliableMove } from './evaluationReliability';
import { lineEvidence } from './lineEvidence';
import { principalVariationSan } from './reviewPresentation';

export function reviewExplanation(move: MoveAnalysis): string | null {
  if (!isReliableMove(move)) return null;
  if (move.isForced) return 'Erzwungener Zug: Es gab nur einen legalen Zug. Der Bewertungsunterschied wird nicht als Fehler dieses Zuges gewertet.';
  if (move.missedOpportunity) return move.missedOpportunity.description;
  const reply = lineEvidence(move.fenBefore, [move.uci, ...move.evalAfter.pv.slice(0, 12)], move.color);
  const firstReply = principalVariationSan(move.fenAfter, move.evalAfter.pv.slice(0, 1))[0];
  if (reply?.board.isCheckmate() && reply.board.turn() === move.color) return `Nach ${move.san} kann der Gegner mit ${firstReply} eine Mattfolge einleiten. Spiele die Antwortlinie durch.`;
  if (reply?.settled && reply.gain <= -1 && firstReply) return `Die Antwortlinie ab ${firstReply} verliert für ${move.color === 'w' ? 'Weiß' : 'Schwarz'} netto ${-reply.gain} Materialpunkte. Prüfe die Abwicklung auf dem Brett.`;
  return null;
}
