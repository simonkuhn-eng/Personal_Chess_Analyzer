import { useStorageProblem } from '../hooks/useStorageProblem';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  Lightbulb,
  ListFilter,
  RotateCcw,
  Search,
  Shuffle,
  Star,
  Swords,
  X,
} from 'lucide-react';
import { Chessboard } from './Chessboard';
import { EvalBar } from './EvalBar';
import type { OpeningFocus } from '../types/chess';
import { prepareOpeningResponse } from '../utils/openingResponses';
import { applyReview, formatDueIn, isMastered, loadReviews, saveReviews, type ReviewOutcome } from '../utils/reviews';
import {
  advanceOpeningOpponent,
  chooseOpeningBranch,
  getOpeningRepertoire,
  loadRepertoireFavorites,
  loadOpeningScope,
  openingOwnMoveCount,
  playOpeningMove,
  saveOpeningScope,
  saveRepertoireFavorites,
  searchOpeningRepertoires,
  saveResponseRepertoire,
  type OpeningBranch,
  type OpeningRepertoire,
} from '../utils/openingTraining';
import { colorLabel, turnToMoveLabel, useI18n } from '../utils/i18n';

const START_FEN = new Chess().fen();
type Mode = 'lernen' | 'abfragen';
type SessionSheet = 'none' | 'scope' | 'plan';

interface OpeningTrainerProps {
  targetPlayer: string;
  focus?: OpeningFocus | null;
  depth?: number;
  onClearFocus?: () => void;
}

export const OpeningTrainerView: React.FC<OpeningTrainerProps> = (props) => (
  <RepertoireView key={`${props.targetPlayer.trim().toLowerCase()}:${props.focus?.id || ''}`} {...props} />
);

const RepertoireView: React.FC<OpeningTrainerProps> = ({ targetPlayer, focus, depth = 14, onClearFocus }) => {
  const { tr } = useI18n();
  const storageProblem = useStorageProblem();
  const [favorites, setFavorites] = useState(() => loadRepertoireFavorites(targetPlayer));
  const [activeId, setActiveId] = useState(() => (focus ? '' : loadRepertoireFavorites(targetPlayer)[0] || ''));
  const [response, setResponse] = useState<OpeningRepertoire | null>(null);
  const [preparing, setPreparing] = useState(Boolean(focus));
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(20);
  const [error, setError] = useState<string | null>(null);
  const [reviews, setReviews] = useState(() => loadReviews(targetPlayer));
  const [mixed, setMixed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const seenByFamily = useRef<Record<string, string[]>>({});

  const active = response?.id === activeId ? response : getOpeningRepertoire(activeId, targetPlayer);
  const discover = useMemo(
    () =>
      searchOpeningRepertoires(query, targetPlayer).filter(
        (item) => !favorites.includes(item.id) && item.id !== response?.id
      ),
    [query, favorites, response, targetPlayer]
  );

  useEffect(() => {
    if (!focus) return;
    let cancelled = false;
    setPreparing(true);
    setError(null);
    void prepareOpeningResponse(focus, targetPlayer, window.electronAPI?.engine, depth, () => cancelled)
      .then((item) => {
        if (cancelled) return;
        try {
          if (!saveResponseRepertoire(targetPlayer, item)) {
            setError(tr('Antwortpaket vorbereitet, aber noch nicht dauerhaft gespeichert. Bitte Speicherhinweis beachten.', 'Response repertoire prepared, but not yet persisted to disk. See storage alert.'));
          }
        } catch {
          setError(tr('Antwortpaket vorbereitet, konnte aber nicht gespeichert werden.', 'Response repertoire prepared, but could not be saved.'));
        }
        setResponse(item);
        setActiveId(item.id);
        setPreparing(false);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : tr('Antworttraining konnte nicht vorbereitet werden.', 'Could not prepare opening response training.'));
          setPreparing(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [focus?.id, targetPlayer, depth, retry]);

  const recordReview = (branch: OpeningBranch, outcome: ReviewOutcome) => {
    const next = loadReviews(targetPlayer);
    applyReview(next, branch.reviewKey, outcome);
    saveReviews(targetPlayer, next);
    setReviews(next);
  };

  const toggleFavorite = (repertoire: OpeningRepertoire) => {
    const next = favorites.includes(repertoire.id)
      ? favorites.filter((id) => id !== repertoire.id)
      : [...favorites, repertoire.id];
    if (!saveRepertoireFavorites(targetPlayer, next)) {
      setError(tr('Die Auswahl konnte nicht gespeichert werden.', 'Selection could not be saved.'));
      return;
    }
    setFavorites(next);
    setError(null);
    if (!next.includes(activeId)) setActiveId(next[0] || '');
    if (next.includes(repertoire.id)) setActiveId(repertoire.id);
    setMixed(false);
  };

  const nextMixedFamily = () => {
    const pool = favorites.filter((id) => {
      const item = getOpeningRepertoire(id, targetPlayer);
      return id !== activeId && item && loadOpeningScope(targetPlayer, item).length > 0;
    });
    if (mixed && pool.length) {
      setActiveId(pool[Math.floor(Math.random() * pool.length)]);
      return true;
    }
    return false;
  };

  const activeMastered = active
    ? active.branches.filter((item) => isMastered(reviews.reviews[item.reviewKey])).length
    : 0;

  return (
    <div className="opening-trainer-view">
      <div className="opening-trainer-topbar">
        <div className="opening-topbar-title">
          <BookOpen size={17} />
          <strong>{active ? active.name : focus ? focus.name : tr('Eröffnungen', 'Openings')}</strong>
          {active && (
            <span className="opening-color-pill">
              {colorLabel(active.color)} · {activeMastered}/{active.branches.length}
            </span>
          )}
          {focus && !active && (
            <span className="opening-color-pill">{colorLabel(focus.color)}</span>
          )}
        </div>
        <div className="opening-topbar-actions">
          <button
            type="button"
            className={`btn-secondary opening-picker-trigger${pickerOpen ? ' active' : ''}`}
            onClick={() => setPickerOpen(true)}
            aria-expanded={pickerOpen}
          >
            <span>{tr(`Eröffnung wählen (${favorites.length})`, `Select opening (${favorites.length})`)}</span>
            <ChevronDown size={15} />
          </button>
          {focus && (
            <button type="button" className="btn-secondary" onClick={onClearFocus}>
              {tr('Fokus beenden', 'Exit focus')}
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="opening-selection-error" role="alert">
          {error}
        </p>
      )}

      <div className="opening-trainer-main">
        {preparing ? (
          <div className="opening-response-preparing" role="status">
            <strong>{tr('Antworttraining wird vorbereitet …', 'Preparing response training…')}</strong>
            <p>{tr('Es entstehen zusammenhängende Fortsetzungen für deine Spielseite.', 'Generating connected variations for your side.')}</p>
            <button type="button" className="btn-secondary" onClick={onClearFocus}>
              {tr('Abbrechen', 'Cancel')}
            </button>
          </div>
        ) : active && (favorites.includes(activeId) || response?.id === activeId) ? (
          <OpeningSession
            key={active.id}
            repertoire={active}
            reviews={reviews}
            targetPlayer={targetPlayer}
            seenIds={seenByFamily.current[active.id] || []}
            onBranchStarted={(ids) => {
              seenByFamily.current[active.id] = ids;
            }}
            storageProblem={storageProblem}
            onReview={recordReview}
            onNextFamily={nextMixedFamily}
            mixed={mixed}
          />
        ) : (
          <div className="opening-empty-training">
            {focus && error ? (
              <div>
                <p>{error}</p>
                <button type="button" className="btn-secondary" onClick={() => setRetry((value) => value + 1)}>
                  {tr('Erneut vorbereiten', 'Retry preparation')}
                </button>
              </div>
            ) : (
              <div className="opening-empty-card">
                <BookOpen size={28} />
                <h3>{tr('Eröffnungsrepertoire trainieren', 'Train Opening Repertoire')}</h3>
                <p>{tr('Wähle eine Eröffnung aus deinem Repertoire oder dem Katalog.', 'Choose an opening from your repertoire or catalog.')}</p>
                <button type="button" className="btn-primary" onClick={() => setPickerOpen(true)}>
                  {tr('Eröffnung auswählen', 'Choose opening')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {pickerOpen && (
        <div
          className="collapsible-sheet-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={tr('Eröffnungen wählen', 'Choose openings')}
          onClick={() => setPickerOpen(false)}
        >
          <div className="collapsible-sheet opening-picker-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="collapsible-sheet-header">
              <strong>{tr('Eröffnungen & Repertoire', 'Openings & Repertoire')}</strong>
              <button type="button" className="btn-icon" onClick={() => setPickerOpen(false)} aria-label={tr('Schließen', 'Close')}>
                <X size={18} />
              </button>
            </div>
            <div className="collapsible-sheet-body opening-picker-body">
              <section className="opening-favorites-section">
                <h3>{tr('Mein Repertoire', 'My Repertoire')}</h3>
                {response && !favorites.includes(response.id) && (
                  <div className={'opening-favorite-item' + (activeId === response.id ? ' selected' : '')}>
                    <button
                      type="button"
                      className="opening-star-button"
                      aria-label={response.name + tr(' zum Repertoire hinzufügen', ' add to repertoire')}
                      onClick={() => toggleFavorite(response)}
                    >
                      <Star size={17} />
                    </button>
                    <button
                      type="button"
                      className="opening-repertoire-choice"
                      onClick={() => {
                        setActiveId(response.id);
                        setMixed(false);
                        setPickerOpen(false);
                      }}
                    >
                      <strong>{response.name}</strong>
                      <small>{tr('Für dich vorbereitet', 'Prepared for you')} · {tr('mit', 'as')} {colorLabel(response.color)}</small>
                    </button>
                  </div>
                )}
                <div className="opening-favorite-list">
                  {favorites.length === 0 && !response && (
                    <p className="opening-sheet-muted">{tr('Markiere unten eine Eröffnung für dein Training.', 'Star an opening below to start practicing.')}</p>
                  )}
                  {favorites.map((id) => {
                    const item = getOpeningRepertoire(id, targetPlayer);
                    if (!item) return null;
                    return (
                      <div className={'opening-favorite-item' + (activeId === id ? ' selected' : '')} key={id}>
                        <button
                          type="button"
                          className="opening-star-button active"
                          aria-label={item.name + tr(' entfernen', ' remove')}
                          onClick={() => toggleFavorite(item)}
                        >
                          <Star size={17} fill="currentColor" />
                        </button>
                        <button
                          type="button"
                          className="opening-repertoire-choice"
                          onClick={() => {
                            setActiveId(id);
                            setMixed(false);
                            setPickerOpen(false);
                          }}
                          aria-pressed={activeId === id}
                        >
                          <strong>{item.name}</strong>
                          <small>
                            {tr('Mit', 'As')} {colorLabel(item.color)} · {item.branches.length} {tr('Varianten', 'lines')}
                          </small>
                        </button>
                      </div>
                    );
                  })}
                </div>
                {favorites.length > 1 && (
                  <button
                    type="button"
                    className={'btn-secondary opening-mix-button' + (mixed ? ' active' : '')}
                    aria-pressed={mixed}
                    onClick={() => setMixed((value) => !value)}
                  >
                    <Shuffle size={14} /> {mixed ? tr('Gemischtes Repertoire aktiv', 'Mixed repertoire active') : tr('Repertoires gemischt üben', 'Shuffle repertoires')}
                  </button>
                )}
              </section>

              <section className="opening-discover">
                <h3>{tr('Eröffnungen hinzufügen', 'Add Openings')}</h3>
                <label className="opening-search">
                  <Search size={16} />
                  <input
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setVisibleCount(20);
                    }}
                    placeholder={tr('Eröffnung oder ECO suchen', 'Search opening or ECO')}
                    aria-label={tr('Eröffnungen suchen', 'Search openings')}
                  />
                </label>
                <div className="opening-catalog-results">
                  {discover.slice(0, visibleCount).map((item) => (
                    <div className="opening-catalog-item" key={item.id}>
                      <button
                        type="button"
                        className="opening-star-button"
                        disabled={!item.branches.length}
                        aria-label={item.name + tr(' zum Repertoire hinzufügen', ' add to repertoire')}
                        title={
                          item.branches.length
                            ? item.branches.length + tr(' Varianten mit ', ' lines as ') + colorLabel(item.color)
                            : tr('Hier ist noch kein zusammenhängendes Trainingspaket vorhanden.', 'No connected training lines available yet.')
                        }
                        onClick={() => {
                          toggleFavorite(item);
                          setPickerOpen(false);
                        }}
                      >
                        <Star size={17} />
                      </button>
                      <div className="opening-catalog-info">
                        <strong>{item.name}</strong>
                        <small>
                          {item.branches.length
                            ? tr('Mit ', 'As ') +
                              colorLabel(item.color) +
                              ' · ' +
                              item.branches.length +
                              (item.branches.length === 1 ? tr(' Variante · ', ' line · ') : tr(' Varianten · ', ' lines · ')) +
                              (item.curated
                                ? tr('Lernhinweise', 'Study notes')
                                : item.source === 'engine'
                                  ? tr('Engine-Varianten', 'Engine lines')
                                  : tr('Katalogtraining', 'Catalog drill'))
                            : tr('Nur Eröffnungsstellung · kein Variantenpaket', 'Starting position only · no variation pack')}
                        </small>
                      </div>
                    </div>
                  ))}
                  {!discover.length && <p className="opening-sheet-muted">{tr('Keine weiteren passenden Eröffnungen gefunden.', 'No additional matching openings found.')}</p>}
                </div>
                {discover.length > visibleCount && (
                  <button
                    type="button"
                    className="btn-secondary opening-show-more"
                    onClick={() => setVisibleCount((value) => value + 20)}
                  >
                    {tr('Weitere Eröffnungen', 'More openings')}
                  </button>
                )}
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface SessionProps {
  storageProblem: boolean;
  targetPlayer: string;
  repertoire: OpeningRepertoire;
  reviews: ReturnType<typeof loadReviews>;
  seenIds: string[];
  onBranchStarted: (ids: string[]) => void;
  onReview: (branch: OpeningBranch, outcome: ReviewOutcome) => void;
  onNextFamily: () => boolean;
  mixed: boolean;
}

const OpeningSession: React.FC<SessionProps> = ({
  storageProblem,
  repertoire,
  reviews,
  targetPlayer,
  seenIds,
  onBranchStarted,
  onReview,
  onNextFamily,
  mixed,
}) => {
  const { tr } = useI18n();
  const [mode, setMode] = useState<Mode>('abfragen');
  const [enabledIds, setEnabledIds] = useState(() => loadOpeningScope(targetPlayer, repertoire));
  const [roundVersion, setRoundVersion] = useState(0);
  const [branch, setBranch] = useState<OpeningBranch | null>(null);
  const [fen, setFen] = useState(START_FEN);
  const [ply, setPly] = useState(0);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [hint, setHint] = useState(0);
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const [freePlay, setFreePlay] = useState(false);
  const [engineMessage, setEngineMessage] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<{ scoreCp: number; mate?: number }>({ scoreCp: 0 });
  const [activeSheet, setActiveSheet] = useState<SessionSheet>('none');
  const [isCompactViewport, setIsCompactViewport] = useState(() => (typeof window !== 'undefined' ? window.innerWidth <= 768 : false));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 768px)');
    const sync = () => setIsCompactViewport(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const chessRef = useRef(new Chess());
  const timerRef = useRef<number | undefined>(undefined);
  const generation = useRef(0);
  const seen = useRef(seenIds);
  const usedHint = useRef(false);
  const madeMistake = useRef(false);
  const recorded = useRef(false);

  const enabledBranches = repertoire.branches.filter((item) => enabledIds.includes(item.id));
  const complete = Boolean(branch && ply >= branch.moves.length);
  const ownTurn = chessRef.current.turn() === repertoire.color;
  const expected = branch?.moves[ply];
  const showAnswer = mode === 'lernen' || hint >= 2;
  const branchVisible = Boolean(branch && (ply >= branch.revealPly || complete));

  const clearTimer = () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
  };

  const beginRound = (candidates = enabledBranches, explicit?: OpeningBranch) => {
    clearTimer();
    generation.current++;
    if (branch && madeMistake.current && !recorded.current) onReview(branch, 'wrong');
    if (candidates.length && candidates.every((item) => seen.current.includes(item.id))) {
      seen.current = seen.current.slice(-1);
    }
    const next = explicit || chooseOpeningBranch(candidates, reviews, seen.current);
    const chess = new Chess();
    chessRef.current = chess;
    recorded.current = false;
    madeMistake.current = false;
    usedHint.current = mode === 'lernen';
    setFreePlay(false);
    setBusy(false);
    setWrong(false);
    setHint(0);
    setEvaluation({ scoreCp: 0 });
    setRoundVersion((value) => value + 1);
    setEngineMessage(null);
    setBranch(next || null);
    const nextPly = next ? advanceOpeningOpponent(chess, next.moves, repertoire.color, 0) : 0;
    setPly(nextPly);
    setFen(chess.fen());
    const last = chess.history({ verbose: true }).at(-1);
    setLastMove(last ? { from: last.from, to: last.to } : null);
    if (next) {
      seen.current = [...seen.current, next.id];
      onBranchStarted(seen.current);
    }
  };

  useEffect(() => {
    beginRound();
    return () => {
      clearTimer();
      generation.current++;
    };
    // Review updates must not restart a running round.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = (current: OpeningBranch) => {
    if (recorded.current) return;
    recorded.current = true;
    onReview(current, madeMistake.current ? 'wrong' : usedHint.current ? 'help' : 'correct');
  };

  const publish = (chess: Chess, nextPly: number) => {
    setPly(nextPly);
    setFen(chess.fen());
    const last = chess.history({ verbose: true }).at(-1);
    setLastMove(last ? { from: last.from, to: last.to } : null);
  };

  const handleMove = (move: { from: string; to: string; promotion?: string }) => {
    if (!ownTurn || busy || !branch || (!freePlay && complete)) return;
    const uci = move.from + move.to + (move.promotion || '');
    if (!freePlay && uci !== expected) {
      setWrong(true);
      madeMistake.current = true;
      return;
    }
    const chess = chessRef.current;
    try {
      playOpeningMove(chess, uci);
    } catch {
      return;
    }
    setWrong(false);
    setHint(0);
    const nextPly = ply + 1;
    publish(chess, nextPly);
    if (freePlay) return;
    if (nextPly >= branch.moves.length) {
      finish(branch);
      return;
    }
    setBusy(true);
    const gen = generation.current;
    timerRef.current = window.setTimeout(() => {
      if (generation.current !== gen) return;
      const reached = advanceOpeningOpponent(chess, branch.moves, repertoire.color, nextPly);
      publish(chess, reached);
      setBusy(false);
      if (reached >= branch.moves.length) finish(branch);
    }, 550);
  };

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    let cancelled = false;
    const gen = generation.current;
    const requestId = 'opening-' + crypto.randomUUID();
    const opponent = freePlay && chessRef.current.turn() !== repertoire.color && !chessRef.current.isGameOver();
    if (opponent) setBusy(true);
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.engine.evaluateFen(fen, 12, undefined, undefined, { requestId });
        if (cancelled || generation.current !== gen) return;
        setEvaluation(result);
        if (opponent) {
          if (result.status === 'unavailable' || !result.bestMoveUci) throw new Error('Keine Engine-Antwort.');
          playOpeningMove(chessRef.current, result.bestMoveUci);
          publish(chessRef.current, ply + 1);
        }
      } catch {
        if (!cancelled && opponent) {
          setEngineMessage(tr('Die Engine ist gerade nicht verfügbar. Du kannst eine neue Trainingsvariante starten.', 'Engine is currently unavailable. You can start a new training line.'));
        }
      } finally {
        if (!cancelled && opponent) setBusy(false);
      }
    }, opponent ? 450 : 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      void api.engine.cancelRequest?.(requestId).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, freePlay, repertoire.color, roundVersion]);

  const expectedSan = (() => {
    if (!expected || !ownTurn || freePlay || complete) return '';
    try {
      return playOpeningMove(new Chess(fen), expected).san;
    } catch {
      return '';
    }
  })();

  const history = chessRef.current.history();

  const changeScope = (id: string) => {
    const next = enabledIds.includes(id) ? enabledIds.filter((value) => value !== id) : [...enabledIds, id];
    setEnabledIds(next);
    saveOpeningScope(targetPlayer, repertoire.id, next);
    beginRound(repertoire.branches.filter((item) => next.includes(item.id)));
  };

  return (
    <div className="opening-trainer-layout">
      <div className="opening-board-column">
        <div className="opening-board-stage">
          <EvalBar
            scoreCp={evaluation.scoreCp}
            mate={evaluation.mate}
            isFlipped={repertoire.color === 'b'}
            orientation={isCompactViewport ? 'horizontal' : 'vertical'}
          />
          <Chessboard
            fen={fen}
            isFlipped={repertoire.color === 'b'}
            lastMove={lastMove}
            onMove={handleMove}
            interactive={Boolean(branch && ownTurn && !busy && (freePlay || !complete) && !chessRef.current.isGameOver())}
            hintSquare={ownTurn && !complete && hint >= 1 ? expected?.slice(0, 2) : null}
            bestMoveArrow={
              showAnswer && ownTurn && expected && !complete && !freePlay
                ? { from: expected.slice(0, 2), to: expected.slice(2, 4) }
                : null
            }
          />
        </div>
        <div className="opening-progress">
          <span style={{ width: (branch ? Math.min(100, (ply / branch.moves.length) * 100) : 0) + '%' }} />
        </div>
      </div>

      <aside className="opening-trainer-panel">
        <div className="opening-mode-toggle" aria-label={tr('Trainingsmodus', 'Training mode')}>
          <button
            type="button"
            className={mode === 'lernen' ? 'active' : ''}
            aria-pressed={mode === 'lernen'}
            onClick={() => {
              setMode('lernen');
              usedHint.current = true;
            }}
          >
            <BookOpen size={14} /> {tr('Lernen', 'Learn')}
          </button>
          <button
            type="button"
            className={mode === 'abfragen' ? 'active' : ''}
            aria-pressed={mode === 'abfragen'}
            onClick={() => setMode('abfragen')}
          >
            <Lightbulb size={14} /> {tr('Abfragen', 'Quiz')}
          </button>
        </div>

        <div className="opening-trainer-status">
          <div className="opening-trainer-status-head">
            <span>
              {freePlay
                ? tr('Freies Spiel', 'Free play')
                : busy
                  ? tr('Gegner zieht …', 'Opponent thinking…')
                  : complete
                    ? tr('Variante abgeschlossen', 'Line completed')
                    : tr('Repertoirezug', 'Repertoire move')}
            </span>
            <span className={`turn-indicator-pill is-compact ${fen.split(' ')[1] === 'b' ? 'is-black' : 'is-white'}`}>
              <i className="turn-indicator-swatch" aria-hidden="true" />
              {turnToMoveLabel(fen.split(' ')[1] === 'b' ? 'b' : 'w')}
            </span>
          </div>
          <strong>{branchVisible ? branch?.name : tr('Erkenne den Aufbau', 'Recognize the setup')}</strong>
        </div>

        {!branch && <div className="opening-trainer-note">{tr('Wähle über „Varianten“ mindestens eine Variante aus.', 'Select at least one line under "Lines".')}</div>}

        {wrong && (
          <div className="opening-feedback wrong">
            {tr('Anderer Zug. Gesucht ist deine Repertoire-Antwort.', 'Different move. Play your prepared repertoire move.')}
          </div>
        )}

        {complete && !freePlay && (
          <div className="opening-feedback correct">
            <CheckCircle2 size={16} />
            <span>
              {tr('Gelöst!', 'Solved!')}{' '}
              {storageProblem
                ? tr('Noch nicht gespeichert.', 'Not saved yet.')
                : `${tr('Nächste Wiederholung:', 'Next review:')} ${formatDueIn(reviews.reviews[branch!.reviewKey])}`}
            </span>
          </div>
        )}

        {freePlay && chessRef.current.isGameOver() && (
          <p className="opening-trainer-note">{tr('Partie beendet. Starte eine neue Variante.', 'Game over. Start a new line.')}</p>
        )}

        {engineMessage && (
          <p className="opening-trainer-note" role="status">
            {engineMessage}
          </p>
        )}

        {!complete && branch && !freePlay && (
          <div className="opening-next-move">
            <span>{busy ? tr('Gegner am Zug', 'Opponent to move') : tr('Deine Antwort', 'Your response')}</span>
            <strong>{showAnswer ? expectedSan : tr('Zug auf dem Brett ausführen', 'Play move on the board')}</strong>
          </div>
        )}

        {!complete && !freePlay && (
          <div className="opening-hint-buttons">
            <button
              type="button"
              className="btn-secondary"
              disabled={!expected || !ownTurn || busy}
              onClick={() => {
                usedHint.current = true;
                setHint(1);
              }}
            >
              {tr('Figur', 'Piece')}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={!expected || !ownTurn || busy}
              onClick={() => {
                usedHint.current = true;
                setHint(2);
              }}
            >
              {tr('Zug zeigen', 'Show move')}
            </button>
          </div>
        )}

        <div className="opening-primary-actions">
          {complete ? (
            <button
              type="button"
              className="btn-primary"
              disabled={!enabledBranches.length}
              onClick={() => {
                if (!onNextFamily()) beginRound();
              }}
            >
              <ArrowRight size={15} /> {mixed ? tr('Nächste Eröffnung', 'Next opening') : tr('Nächste Variante', 'Next line')}
            </button>
          ) : (
            <button
              type="button"
              className="btn-secondary"
              disabled={!enabledBranches.length}
              onClick={() => beginRound()}
            >
              <Shuffle size={15} /> {tr('Neue Variante', 'New line')}
            </button>
          )}
          {branch && (
            <button type="button" className="btn-secondary" onClick={() => beginRound(enabledBranches, branch)}>
              <RotateCcw size={14} /> {tr('Wiederholen', 'Repeat')}
            </button>
          )}
        </div>

        {complete && !freePlay && (
          <button
            type="button"
            className="btn-secondary opening-stockfish-btn"
            disabled={!window.electronAPI}
            onClick={() => setFreePlay(true)}
          >
            <Swords size={14} /> {tr('Gegen Stockfish weiterspielen', 'Continue vs. Stockfish')}
          </button>
        )}

        <div className="opening-sheet-triggers">
          <button
            type="button"
            className={`btn-secondary${activeSheet === 'scope' ? ' active' : ''}`}
            onClick={() => setActiveSheet((cur) => (cur === 'scope' ? 'none' : 'scope'))}
          >
            <ListFilter size={14} />
            <span>{tr('Varianten', 'Lines')} ({enabledBranches.length})</span>
          </button>
          <button
            type="button"
            className={`btn-secondary${activeSheet === 'plan' ? ' active' : ''}`}
            onClick={() => setActiveSheet((cur) => (cur === 'plan' ? 'none' : 'plan'))}
          >
            <BookOpen size={14} />
            <span>{tr('Plan & Züge', 'Plan & Moves')} ({history.length})</span>
          </button>
        </div>
      </aside>

      {activeSheet !== 'none' && (
        <div
          className="collapsible-sheet-backdrop"
          role="dialog"
          aria-modal="true"
          onClick={() => setActiveSheet('none')}
        >
          <div className="collapsible-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="collapsible-sheet-header">
              <strong>{activeSheet === 'scope' ? `${tr('Trainingsumfang', 'Training scope')} (${enabledBranches.length})` : tr('Plan & gespielte Züge', 'Plan & Played Moves')}</strong>
              <button type="button" className="btn-icon" onClick={() => setActiveSheet('none')} aria-label={tr('Schließen', 'Close')}>
                <X size={18} />
              </button>
            </div>
            <div className="collapsible-sheet-body">
              {activeSheet === 'scope' ? (
                <div className="opening-branch-scope-list">
                  <p className="opening-sheet-muted">
                    {tr('Der Gegner wählt zufällig aus den aktivierten Varianten.', 'The opponent picks randomly from enabled lines.')}
                  </p>
                  {repertoire.branches.map((item) => (
                    <label key={item.id} className="opening-scope-row">
                      <input
                        type="checkbox"
                        checked={enabledIds.includes(item.id)}
                        onChange={() => changeScope(item.id)}
                      />
                      <span>
                        <strong>{item.name}</strong>
                        <small>
                          {openingOwnMoveCount(item.moves, repertoire.color)} {tr('eigene Züge', 'own moves')} ·{' '}
                          {formatDueIn(reviews.reviews[item.reviewKey])}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <div className="opening-plan-sheet">
                  {branchVisible && branch?.note && <div className="opening-dev-note">{branch.note}</div>}
                  {repertoire.plan.length > 0 && (
                    <div className="opening-learning-plan">
                      <strong>{tr('Worauf du achten solltest', 'Key Ideas')}</strong>
                      <ul>
                        {repertoire.plan.map((step) => (
                          <li key={step}>{step}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="opening-played-moves-box">
                    <strong>{tr('Gespielte Züge', 'Moves played')} ({history.length})</strong>
                    <div className="opening-move-list">
                      {history.length === 0 ? (
                        <span className="opening-sheet-muted">{tr('Noch keine Züge gespielt.', 'No moves played yet.')}</span>
                      ) : (
                        history.map((san, i) => (
                          <span key={i} className="played">
                            {i % 2 === 0 ? Math.floor(i / 2) + 1 + '.' : ''}
                            {san}
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                  <p className="opening-sheet-muted">
                    {repertoire.curated
                      ? tr('Lernen und Hilfen zählen als unterstützte Wiederholung. Selbst gelöste Abfragen verlängern den Wiederholungsabstand.', 'Learn mode and hints count as assisted reviews. Unassisted solves extend the spaced-repetition interval.')
                      : repertoire.source === 'engine'
                        ? tr('Enginegestütztes Antwortpaket. Der Gegner variiert seine Antworten; deine vorbereiteten Züge bleiben konsistent.', 'Engine-backed response pack. The opponent varies replies while your repertoire stays consistent.')
                        : tr('Dieses Paket übt Katalog-Zugfolgen.', 'This pack drills catalog move sequences.')}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
