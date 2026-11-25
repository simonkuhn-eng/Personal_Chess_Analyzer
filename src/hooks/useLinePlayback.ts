/**
 * Spielt eine Zugfolge (UCI) animiert auf das Brett — z. B. der Fehlversuch
 * plus die Stockfish-Widerlegung auf Fehlerkarten.
 *
 * Muster wie im OpeningTrainer: Gen-Guard + Timer-Liste, damit laufende
 * Wiedergaben beim Kartenwechsel/Unmount sauber abgebrochen werden.
 * Reset passiert automatisch, wenn sich die Ausgangsstellung ändert.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Chess, Square } from 'chess.js';

export interface LinePlayback {
  /** true, während die Wiedergabe läuft ODER die Endstellung steht. */
  active: boolean;
  playing: boolean;
  finished: boolean;
  /** Aktuelles Anzeige-FEN (nur lesen, wenn active). */
  fen: string;
  lastMove: { from: string; to: string } | null;
  /** Anzahl bereits angewendeter Halbzüge. */
  ply: number;
  total: number;
  start: () => void;
  reset: () => void;
}

const FIRST_STEP_DELAY_MS = 550;

export function useLinePlayback(fenStart: string, lineUci: string[], stepMs = 1000): LinePlayback {
  const [fen, setFen] = useState(fenStart);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [finished, setFinished] = useState(false);
  const [ply, setPly] = useState(0);

  const timersRef = useRef<number[]>([]);
  const genRef = useRef(0);

  const clearTimers = useCallback(() => {
    for (const t of timersRef.current) window.clearTimeout(t);
    timersRef.current = [];
  }, []);

  const reset = useCallback(() => {
    genRef.current += 1;
    clearTimers();
    setPlaying(false);
    setFinished(false);
    setPly(0);
    setFen(fenStart);
    setLastMove(null);
  }, [fenStart, clearTimers]);

  const start = useCallback(() => {
    if (lineUci.length === 0) return;
    const gen = genRef.current + 1;
    genRef.current = gen;
    clearTimers();

    // Linie vorab validieren; ab dem ersten illegalen Zug abbrechen.
    const chess = new Chess(fenStart);
    const steps: { from: string; to: string; fen: string }[] = [];
    for (const uci of lineUci) {
      if (!uci || uci.length < 4) break;
      try {
        const move = chess.move({
          from: uci.substring(0, 2) as Square,
          to: uci.substring(2, 4) as Square,
          promotion: uci[4] as never,
        });
        if (!move) break;
        steps.push({ from: move.from, to: move.to, fen: chess.fen() });
      } catch {
        break;
      }
    }
    if (steps.length === 0) return;

    setPlaying(true);
    setFinished(false);
    setPly(0);
    setFen(fenStart);
    setLastMove(null);

    steps.forEach((step, i) => {
      const timer = window.setTimeout(() => {
        if (genRef.current !== gen) return;
        setFen(step.fen);
        setLastMove({ from: step.from, to: step.to });
        setPly(i + 1);
        if (i === steps.length - 1) {
          setPlaying(false);
          setFinished(true);
        }
      }, FIRST_STEP_DELAY_MS + i * stepMs);
      timersRef.current.push(timer);
    });
  }, [fenStart, lineUci, stepMs, clearTimers]);

  // Automatischer Reset bei Positionswechsel (Kartenwechsel/Requeue/Unmount).
  useEffect(() => {
    reset();
  }, [reset]);

  useEffect(() => {
    return () => {
      genRef.current += 1;
      clearTimers();
    };
  }, [clearTimers]);

  return {
    active: playing || finished,
    playing,
    finished,
    fen,
    lastMove,
    ply,
    total: lineUci.length,
    start,
    reset,
  };
}
