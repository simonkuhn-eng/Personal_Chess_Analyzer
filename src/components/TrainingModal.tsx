import { resolvePlayerColor } from '../utils/moveInsights';
import { isReliableGameMove } from '../utils/evaluationReliability';
import { useStorageProblem } from '../hooks/useStorageProblem';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import { Chess } from 'chess.js';
import { GameAnalysis, MoveAnalysis } from '../types/chess';
import { moveCategory } from '../utils/analysis';
import { Chessboard } from './Chessboard';
import { sounds } from '../utils/sound';
import { judgeTargetDepth, judgeTrainingAttempt, TrainingJudgement } from '../utils/trainingJudge';
import { ReviewOutcome, ReviewStore, applyReview, formatDueIn, loadReviews, saveReviews } from '../utils/reviews';
import { CheckCircle2, AlertCircle, Eye, ArrowRight, X, Lightbulb, Waypoints } from 'lucide-react';
import { turnToMoveLabel, useI18n } from '../utils/i18n';

interface TrainingModalProps {
  game: GameAnalysis;
  targetPlayer: string;
  onClose: () => void;
}

export const TrainingModal: React.FC<TrainingModalProps> = ({ game, targetPlayer, onClose }) => {
  const { tr } = useI18n();
  // Nur Fehler/Patzer des konfigurierten Spielers trainieren (T13: EXAKTER
  // Namensvergleich — includes() fand fremde Spieler mit Namenspräfix wie
  // "audit-user" vs "audit-user-other"; bei unbekannter Farbe wird NICHT
  // beides trainiert, sondern ehrlich nichts).
  const mistakePuzzles = useMemo(() => {
    const playerColor = resolvePlayerColor(game.white, game.black, targetPlayer, game.site);
    if (!playerColor) return [];
    return game.moves.filter(
      (m) => ['mistake', 'blunder', 'miss'].includes(moveCategory(m))
        && isReliableGameMove(game, m) && m.color === playerColor
        && (m.evalBefore.bestMoveUci || '').length >= 4
    );
  }, [game, targetPlayer]);

  // T15: gemeinsame Review-Persistenz — gleiche Karten-IDs wie das Deck
  // (`gameId:ply`), damit Partie-Modal und Deck EINEN konsistenten
  // Lernfortschritt teilen statt getrennt zu zählen.
  const storageProblem = useStorageProblem();
  const [store, setStore] = useState<ReviewStore>(() => loadReviews(targetPlayer));
  const helpedRef = useRef(false);
  const recordReview = (key: string, outcome: ReviewOutcome) => {
    const next = loadReviews(targetPlayer);
    applyReview(next, key, outcome);
    saveReviews(targetPlayer, next);
    setStore(next);
  };

  const [currentIndex, setCurrentIndex] = useState(0);
  const [userSuccess, setUserSuccess] = useState<boolean | null>(null);
  const [acceptedReason, setAcceptedReason] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [lastTrainingMove, setLastTrainingMove] = useState<{ from: string; to: string } | null>(null);
  const [hintVisible, setHintVisible] = useState(false);
  const [playedArrowVisible, setPlayedArrowVisible] = useState(false);
  // T09: checking = Judge läuft; introLock = 1s-Einblendung des
  // vorigen Gegnerzugs — Brett in beiden Phasen gesperrt.
  const [checking, setChecking] = useState(false);
  const [introLock, setIntroLock] = useState(true);
  const [viewingRefutation, setViewingRefutation] = useState(false);
  const [opponentReplyMove, setOpponentReplyMove] = useState<{ from: string; to: string; san?: string } | null>(null);
  const [boardFen, setBoardFen] = useState<string>(
    mistakePuzzles[0]?.fenBefore || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  );

  // T09: Generationszähler gegen späte Promises (Puzzlewechsel/Unmount).
  const attemptGenRef = useRef(0);

  const currentPuzzle: MoveAnalysis | undefined = mistakePuzzles[currentIndex];

  const currentPuzzleIndex = currentPuzzle ? game.moves.findIndex((move) => move.ply === currentPuzzle.ply) : -1;
  const previousMove = currentPuzzleIndex > 0 ? game.moves[currentPuzzleIndex - 1] : undefined;

  useEffect(() => {
    if (!currentPuzzle) return;

    let animationTimer: number | undefined;
    // T09: neuer Versuch → neue Generation (auch bei identischer Ausgangs-FEN).
    attemptGenRef.current += 1;

    setLastTrainingMove(null);
    setHintVisible(false);
    helpedRef.current = false; // T15: neues Puzzle → Hilfsflag zurücksetzen
    setPlayedArrowVisible(false);
    setViewingRefutation(false);
    setOpponentReplyMove(null);
    setChecking(false);
    setBoardFen(previousMove?.fenBefore || currentPuzzle.fenBefore);

    if (previousMove) {
      setIntroLock(true);
      animationTimer = window.setTimeout(() => {
        setBoardFen(currentPuzzle.fenBefore);
        setLastTrainingMove({ from: previousMove.from, to: previousMove.to });
        setIntroLock(false);
      }, 1000);
    } else {
      setIntroLock(false);
    }

    return () => {
      if (animationTimer !== undefined) window.clearTimeout(animationTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, currentPuzzle?.ply]);

  useEffect(() => {
    return () => {
      // T09: Unmount invalidiert in-flight Judge-/Erklär-Promises.
      attemptGenRef.current += 1;
    };
  }, []);

  const playedMoveSan = currentPuzzle
    ? (() => {
        try {
          const chess = new Chess(currentPuzzle.fenBefore);
          const move = chess.move({
            from: currentPuzzle.uci.substring(0, 2) as import('chess.js').Square,
            to: currentPuzzle.uci.substring(2, 4) as import('chess.js').Square,
            promotion: currentPuzzle.uci[4],
          });
          return move.san;
        } catch {
          return currentPuzzle.san;
        }
      })()
    : '';

  if (!currentPuzzle) {
    return (
      <div className="modal-backdrop">
        <div className="modal-content" style={{ textAlign: 'center' }}>
          <h2 className="modal-title">{tr('Keine Fehler gefunden!', 'No mistakes found!')}</h2>
          <p style={{ color: '#a8a6a0', margin: '16px 0' }}>
            {tr('In dieser Partie wurden keine groben Fehler oder Patzer festgestellt. Hervorragende Leistung!', 'No mistakes or blunders were detected in this game. Great performance!')}
          </p>
          <button className="btn-primary" onClick={onClose} style={{ margin: '0 auto' }}>
            {tr('Zurück zur Analyse', 'Back to Analysis')}
          </button>
        </div>
      </div>
    );
  }

  const isMobileEngine = Boolean(window.electronAPI?.isMobile);

  const evaluateAfter = (fen: string) => {
    const evaluate = window.electronAPI?.engine?.evaluateFen;
    if (!evaluate) return Promise.resolve(null);
    const targetDepth = judgeTargetDepth(currentPuzzle.evalBefore);
    return isMobileEngine
      ? evaluate(fen, targetDepth, undefined, undefined, { maxTimeMs: 1000 })
      : evaluate(fen, targetDepth);
  };

  const showAutoRefutation = (fenAfterUserMove: string, replyUciRaw: string | undefined) => {
    const replyUci = (replyUciRaw || '').trim().toLowerCase();
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(replyUci)) {
      setViewingRefutation(false);
      setOpponentReplyMove(null);
      setBoardFen(currentPuzzle.fenBefore);
      return;
    }
    try {
      const checkReply = new Chess(fenAfterUserMove);
      const playedReply = checkReply.move({
        from: replyUci.slice(0, 2) as import('chess.js').Square,
        to: replyUci.slice(2, 4) as import('chess.js').Square,
        promotion: (replyUci[4] || undefined) as never,
      });
      if (!playedReply) throw new Error('illegal reply');
      setBoardFen(fenAfterUserMove);
      setViewingRefutation(true);
      setOpponentReplyMove({ from: playedReply.from, to: playedReply.to, san: playedReply.san });
    } catch {
      setViewingRefutation(false);
      setOpponentReplyMove(null);
      setBoardFen(currentPuzzle.fenBefore);
    }
  };

  // T07: Schachliche Bewertung statt reiner UCI-Vergleichs.
  const applyJudgement = (judgement: TrainingJudgement, playedUci: string) => {
    setChecking(false);
    if (judgement.verdict.kind === 'uncertain' || judgement.verdict.kind === 'solid') {
      // R03/Option A: Technikproblem oder noch solider Zug — kein Scheduler-Eintrag,
      // ehrliche Meldung; Brett bleibt sofort für einen neuen Versuch frei.
      setViewingRefutation(false);
      setOpponentReplyMove(null);
      setBoardFen(currentPuzzle.fenBefore);
      setAcceptedReason(judgement.verdict.reason);
      return;
    }
    if (judgement.verdict.kind === 'best' || judgement.verdict.kind === 'accepted') {
      // Zug real ausfuehren: vollständige UCI inkl. gewählter Umwandlungsfigur (T07/T08).
      setViewingRefutation(false);
      setOpponentReplyMove(null);
      if (judgement.fenAfter) setBoardFen(judgement.fenAfter);
      setUserSuccess(true);
      setAcceptedReason(judgement.verdict.kind === 'accepted' ? judgement.verdict.reason : null);
      sounds.playSuccess();
      // T15: unabhängige richtige Antwort verlängert das Intervall; mit
      // Hinweis/Lösung nur kurze Wiederholung. Enginefehler zählen nicht.
      recordReview(`${game.id}:${currentPuzzle.ply}`, helpedRef.current ? 'help' : 'correct');
      helpedRef.current = false;
      confetti({
        particleCount: 70,
        spread: 60,
        origin: { y: 0.6 },
      });
    } else {
      // T15: unabhängiger Fehlversuch = Lapse (kurze Wiederholung).
      recordReview(`${game.id}:${currentPuzzle.ply}`, 'wrong');
      helpedRef.current = false;
      setAcceptedReason(judgement.verdict.reason || null);
      setUserSuccess(false);
      sounds.playBlunder();
      showAutoRefutation(judgement.fenAfter || currentPuzzle.fenBefore, judgement.refutationPv?.[0]);
    }
    setLastTrainingMove({ from: playedUci.substring(0, 2), to: playedUci.substring(2, 4) });
  };

  const handleUserMove = (move: { from: string; to: string; promotion?: string }) => {
    // T09: während Prüfung, Intro-Einblendung oder Feedback keine weiteren Versuche.
    if (userSuccess !== null || checking || introLock) return;

    const playedUci = (move.from + move.to + (move.promotion || '')).toLowerCase();
    setLastTrainingMove({ from: move.from, to: move.to });
    try {
      const pre = new Chess(currentPuzzle.fenBefore);
      const played = pre.move({
        from: move.from as import('chess.js').Square,
        to: move.to as import('chess.js').Square,
        promotion: (move.promotion || undefined) as never,
      });
      if (played) setBoardFen(pre.fen());
    } catch {
      // Falls ungültig, entscheidet judgeTrainingAttempt
    }
    setChecking(true);
    const gen = attemptGenRef.current;
    judgeTrainingAttempt(
      currentPuzzle.fenBefore,
      playedUci,
      currentPuzzle.evalBefore.bestMoveUci,
      currentPuzzle.evalBefore,
      {
        evaluateAfter,
        preserveMaterialOpportunity: currentPuzzle.missedOpportunity?.kind === 'material',
        minReliableDepth: isMobileEngine ? 12 : undefined,
      }
    )
      .then((judgement) => {
        if (attemptGenRef.current !== gen) return; // Puzzle gewechselt — verwerfen
        applyJudgement(judgement, playedUci);
      })
      .catch(() => {
        if (attemptGenRef.current !== gen) return;
        setChecking(false);
        setBoardFen(currentPuzzle.fenBefore);
      });
  };

  const handleNextPuzzle = () => {
    setViewingRefutation(false);
    setOpponentReplyMove(null);
    if (currentIndex < mistakePuzzles.length - 1) {
      const nextIdx = currentIndex + 1;
      setCurrentIndex(nextIdx);
      setUserSuccess(null);
      setAcceptedReason(null);
      setRevealed(false);
    } else {
      onClose();
    }
  };

  const handleRevealSolution = () => {
    setViewingRefutation(false);
    setOpponentReplyMove(null);
    setBoardFen(currentPuzzle.fenBefore);
    setRevealed(true);
    helpedRef.current = true; // T15: Lösung gezeigt = unterstützte Antwort
  };

  const handleHint = () => {
    setHintVisible(true);
    helpedRef.current = true; // T15: Hinweis = unterstützte Antwort
  };

  const bestMoveFrom = currentPuzzle.evalBefore.bestMoveUci.substring(0, 2);
  const modalDone = Math.min(mistakePuzzles.length, currentIndex + (userSuccess !== null ? 1 : 0));
  const modalPercent = Math.round((modalDone / mistakePuzzles.length) * 100);

  const displayLastMove =
    userSuccess === true && lastTrainingMove
      ? { ...lastTrainingMove, quality: 'best' as const }
      : lastTrainingMove;

  const bestArrow =
    !viewingRefutation && !checking && (revealed || userSuccess)
      ? {
          from: currentPuzzle.evalBefore.bestMoveUci.substring(0, 2),
          to: currentPuzzle.evalBefore.bestMoveUci.substring(2, 4),
        }
      : null;

  const refutationThreatArrows =
    viewingRefutation && opponentReplyMove ? [{ from: opponentReplyMove.from, to: opponentReplyMove.to }] : [];

  return (
    <div className="modal-backdrop">
      <div
        className="modal-content training-modal"
      >
        <div className="training-titlebar">
          <div className="training-titlebar-main">
            <h2 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>{tr('Fehler trainieren', 'Train Mistakes')}</span>
              <span className="brand-badge">
                {currentIndex + 1}/{mistakePuzzles.length}
              </span>
            </h2>
            <div className="training-turn">
              <span>{tr('Zug', 'Move')} {currentPuzzle.moveNumber}</span>
              <span className={`turn-indicator-pill is-compact ${currentPuzzle.color === 'w' ? 'is-white' : 'is-black'}`}>
                <i className="turn-indicator-swatch" aria-hidden="true" />
                {turnToMoveLabel(currentPuzzle.color)}
              </span>
            </div>
          </div>
          <button className="btn-icon" onClick={onClose} title={tr('Schließen', 'Close')}>
            <X size={18} />
          </button>
        </div>

        <div
          className="training-deck-progress-track"
          role="progressbar"
          aria-label={tr('Trainingsfortschritt', 'Training progress')}
          aria-valuenow={modalDone}
          aria-valuemin={0}
          aria-valuemax={mistakePuzzles.length}
        >
          <div className="training-deck-progress-fill" style={{ width: `${modalPercent}%` }} />
        </div>

        <div className="training-prompt">
          <div className="training-prompt-title">
            {tr('Gespielt:', 'Played:')} <strong>{playedMoveSan}</strong>
            <span className={`training-quality ${moveCategory(currentPuzzle)}`}>
              {moveCategory(currentPuzzle) === 'miss'
                ? tr('Verpasste Chance', 'Missed Win')
                : moveCategory(currentPuzzle) === 'blunder'
                  ? tr('Patzer', 'Blunder')
                  : tr('Fehler', 'Mistake')}
            </span>
            <span className="training-prompt-sub">• {tr('Finde den besten Zug', 'Find the best move')}</span>
          </div>
        </div>

        <div className="training-area">
          <div className="training-board">
            <Chessboard
              fen={boardFen}
              isFlipped={currentPuzzle.color === 'b'}
              bestMoveArrow={bestArrow}
              threatArrows={refutationThreatArrows}
              lastMove={displayLastMove}
              hintSquare={!viewingRefutation && !checking && hintVisible ? bestMoveFrom : null}
              mistakeMoveArrow={!viewingRefutation && playedArrowVisible ? { from: currentPuzzle.from, to: currentPuzzle.to } : null}
              onMove={handleUserMove}
              interactive={userSuccess === null && !checking && !introLock}
            />
          </div>
        </div>

        <div className="training-controls">
          <div className="training-help-actions">
            <button className="btn-secondary" onClick={handleHint} disabled={hintVisible || Boolean(userSuccess)}>
              <Lightbulb size={15} />
              <span>{hintVisible ? `${tr('Beste Figur', 'Best piece')}: ${bestMoveFrom}` : tr('Hinweis', 'Hint')}</span>
            </button>
            <button className="btn-secondary" onClick={() => setPlayedArrowVisible((visible) => !visible)}>
              <Waypoints size={15} />
              <span>{playedArrowVisible ? tr('Fehlerpfeil aus', 'Hide played move') : tr('Fehlerzug zeigen', 'Show played move')}</span>
            </button>
          </div>

          {userSuccess === true && (
            <div className="training-feedback success">
              <CheckCircle2 size={18} />
              <span>
                {acceptedReason ? tr(`Richtig! ${acceptedReason}`, `Correct! ${acceptedReason}`) : tr('Perfekt gelöst!', 'Solved!')}
                {storageProblem
                  ? tr(' Lernstand noch nicht gespeichert.', ' Progress not yet saved.')
                  : ` ${tr('Nächste Wiederholung:', 'Next review:')} ${formatDueIn(store.reviews[`${game.id}:${currentPuzzle.ply}`])}`}
              </span>
            </div>
          )}

          {userSuccess === false && (
            <div className="training-feedback error">
              <AlertCircle size={18} />
              <span>{acceptedReason || tr('Nicht optimal. Nutze den Hinweis oder zeige die Lösung.', 'Not optimal. Use the hint or reveal the solution.')}</span>
            </div>
          )}

          {/* R03/Option A: Technikproblem oder noch solider Zug — kein Scheduler-Eintrag */}
          {userSuccess === null && acceptedReason !== null && (
            <div className="training-feedback warn">
              <AlertCircle size={18} />
              <span>{acceptedReason}</span>
            </div>
          )}

            {/* Actions */}
            <div className="training-actions">
              {!userSuccess && (
                <button className="btn-secondary" onClick={handleRevealSolution} style={{ flex: 1 }}>
                  <Eye size={16} />
                  {tr('Lösung zeigen', 'Show Solution')}
                </button>
              )}

              <button className="btn-primary" onClick={handleNextPuzzle} style={{ flex: 1 }}>
                <span>{currentIndex < mistakePuzzles.length - 1 ? tr('Nächster Fehler', 'Next Mistake') : tr('Training abschließen', 'Finish Training')}</span>
                <ArrowRight size={16} />
              </button>
            </div>
        </div>
      </div>
    </div>
  );
};
