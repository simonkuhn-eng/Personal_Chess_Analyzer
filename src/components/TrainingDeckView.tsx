import { useStorageProblem } from '../hooks/useStorageProblem';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Chess, Square } from 'chess.js';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Eye,
  EyeOff,
  Info,
  Lightbulb,
  Play,
  RotateCcw,
  Shuffle,
  SkipForward,
  SlidersHorizontal,
  Square as StopSquare,
  Target,
  X,
} from 'lucide-react';
import { Chessboard } from './Chessboard';
import { CapturedPieces } from './CapturedPieces';
import { useLinePlayback } from '../hooks/useLinePlayback';
import { GameAnalysis, MissedIdea } from '../types/chess';
import type { OpeningFocus } from '../types/chess';
import type { StatisticsFilter } from '../types/statistics';
import { statisticsFilterLabel } from '../utils/statisticsFilter';
import { moveCategory } from '../utils/analysis';
import { capturedMaterial, capturedMaterialAfterLine } from '../utils/boardPresentation';
import { principalVariationSan } from '../utils/reviewPresentation';
import { sounds } from '../utils/sound';
import { MISSED_IDEA_LABELS } from '../utils/moveInsights';
import { colorLabel, turnToMoveLabel, sideMovesLabel, useI18n } from '../utils/i18n';
import {
  buildTrainingCards,
  describeTrainingCard,
  filterTrainingCardsByOptions,
  loadIgnoredTrainingCards,
  loadTrainingPrefs,
  loadTrainingQualities,
  matchesTrainingQuality,
  saveIgnoredTrainingCards,
  saveTrainingPrefs,
  saveTrainingQualities,
  selectSessionCards,
  TRAINING_MISSION_LABELS,
  TRAINING_PHASE_LABELS,
  TRAINING_QUALITY_OPTIONS,
  type TrainingCard,
  type TrainingDeckPrefs,
  type TrainingFocusMode,
  type TrainingMissionFilter,
  type TrainingPhaseFilter,
  type TrainingQuality,
} from '../utils/trainingDeck';
import { judgeTargetDepth, judgeTrainingAttempt, TrainingJudgement } from '../utils/trainingJudge';
import {
  ReviewOutcome,
  ReviewStore,
  applyReview,
  formatDueIn,
  isMastered,
  loadReviews,
  migrateGameIdKeys,
  migrateLegacySolved,
  readLegacySolvedKeys,
  saveReviews,
} from '../utils/reviews';

interface TrainingDeckViewProps {
  games: GameAnalysis[];
  targetPlayer: string;
  /** T18: Diagnostik → Training — Motivfilter (classifyMissedIdea-Idee). */
  motifFilter?: MissedIdea | null;
  /** T18: Diagnostik → Training — Eröffnungsfilter (openingName || eco). */
  openingFilter?: string | null;
  openingFocus?: OpeningFocus | null;
  openingWindowMoves?: number;
  statisticsFilter?: StatisticsFilter | null;
  onClearFilter?: () => void;
  onOpenGameAt?: (gameId: string, ply: number) => void;
}

const SOLVED_STORAGE_KEY = 'personal-chess-analyzer-solved-training-cards';
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MAX_SESSION_CARDS = 25;

const MISSION_LABELS_EN: Record<TrainingMissionFilter, string> = {
  all: 'All Motifs',
  mate: 'Mate',
  tactic: 'Tactics',
  defense: 'Defense',
  positional: 'Positional',
};

const PHASE_LABELS_EN: Record<TrainingPhaseFilter, string> = {
  all: 'All Phases',
  opening: 'Opening',
  middlegame: 'Middlegame',
  endgame: 'Endgame',
};

const QUALITY_LABELS_EN: Record<TrainingQuality, { label: string; singular: string }> = {
  blunder: { label: 'Blunders', singular: 'Blunder' },
  mistake: { label: 'Mistakes', singular: 'Mistake' },
  inaccuracy: { label: 'Inaccuracies', singular: 'Inaccuracy' },
  miss: { label: 'Missed Wins', singular: 'Missed Win' },
};

const IDEA_LABELS_EN: Record<string, string> = {
  mate: 'Missed mate',
  capture: 'Winning capture',
  fork: 'Missed fork',
  check: 'Strong check',
  quiet: 'Positional improvement',
};

export const TrainingDeckView: React.FC<TrainingDeckViewProps> = props => {
  const [syncRevision, setSyncRevision] = useState(0);

  useEffect(() => {
    const onSyncApplied = () => setSyncRevision(rev => rev + 1);
    window.addEventListener('pca-lan-sync-applied', onSyncApplied);
    return () => window.removeEventListener('pca-lan-sync-applied', onSyncApplied);
  }, []);

  return (
    <FilteredTrainingDeck
      key={`${props.targetPlayer.trim().toLowerCase()}:${props.openingFocus?.id || ''}:${props.openingWindowMoves || ''}:${JSON.stringify(props.statisticsFilter)}:${syncRevision}`}
      {...props}
    />
  );
};

const FilteredTrainingDeck: React.FC<TrainingDeckViewProps> = ({
  games,
  targetPlayer,
  motifFilter,
  openingFilter,
  openingFocus,
  openingWindowMoves = 12,
  statisticsFilter,
  onClearFilter,
  onOpenGameAt,
}) => {
  const { isEn, lang, tr } = useI18n();
  const [qualities, setQualities] = useState<TrainingQuality[]>(() =>
    openingFocus ? TRAINING_QUALITY_OPTIONS.map(option => option.quality) : loadTrainingQualities(targetPlayer),
  );
  const [prefs, setPrefs] = useState<TrainingDeckPrefs>(() => loadTrainingPrefs(targetPlayer));
  const [ignoredKeysList, setIgnoredKeysList] = useState<string[]>(() => loadIgnoredTrainingCards(targetPlayer));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [resetNonce, setResetNonce] = useState(0);

  const hasExternalFilter = Boolean(motifFilter || openingFilter || openingFocus || statisticsFilter);
  const effectiveFocusMode: TrainingFocusMode = hasExternalFilter ? 'all' : prefs.focusMode;
  const effectivePhase: TrainingPhaseFilter = hasExternalFilter ? 'all' : prefs.phase;
  const effectiveMission: TrainingMissionFilter = hasExternalFilter ? 'all' : prefs.mission;

  const ignoredSet = useMemo(() => new Set(ignoredKeysList), [ignoredKeysList]);

  const availableCards = useMemo(
    () =>
      buildTrainingCards(games, targetPlayer, {
        motif: motifFilter,
        opening: openingFilter,
        openingFocus,
        openingWindowMoves,
        statisticsFilter,
      }),
    [games, targetPlayer, motifFilter, openingFilter, openingFocus, openingWindowMoves, statisticsFilter],
  );

  const nonIgnoredCards = useMemo(
    () => availableCards.filter(card => !ignoredSet.has(card.key)),
    [availableCards, ignoredSet],
  );

  const cards = useMemo(
    () =>
      filterTrainingCardsByOptions(nonIgnoredCards, {
        qualities,
        focusMode: effectiveFocusMode,
        phase: effectivePhase,
        mission: effectiveMission,
      }),
    [nonIgnoredCards, qualities, effectiveFocusMode, effectivePhase, effectiveMission],
  );

  const allModeCardsCount = useMemo(
    () =>
      filterTrainingCardsByOptions(nonIgnoredCards, {
        qualities,
        focusMode: 'all',
        phase: 'all',
        mission: 'all',
      }).length,
    [nonIgnoredCards, qualities],
  );

  const clearModeCardsCount = useMemo(
    () =>
      filterTrainingCardsByOptions(nonIgnoredCards, {
        qualities,
        focusMode: 'clear',
        phase: 'all',
        mission: 'all',
      }).length,
    [nonIgnoredCards, qualities],
  );

  const ignoredInScopeCount = availableCards.length - nonIgnoredCards.length;

  const focusBaseCards = useMemo(
    () =>
      filterTrainingCardsByOptions(nonIgnoredCards, {
        qualities,
        focusMode: effectiveFocusMode,
        phase: 'all',
        mission: 'all',
      }),
    [nonIgnoredCards, qualities, effectiveFocusMode],
  );

  const updatePrefs = (patch: Partial<TrainingDeckPrefs>) => {
    setPrefs(prev => {
      const next = { ...prev, ...patch };
      saveTrainingPrefs(targetPlayer, next);
      return next;
    });
  };

  const toggleQuality = (quality: TrainingQuality) => {
    const next = TRAINING_QUALITY_OPTIONS.map(option => option.quality).filter(value =>
      value === quality ? !qualities.includes(value) : qualities.includes(value),
    );
    if (!openingFocus) saveTrainingQualities(targetPlayer, next);
    setQualities(next);
  };

  const handleIgnoreCard = (key: string) => {
    setIgnoredKeysList(prev => {
      if (prev.includes(key)) return prev;
      const next = [...prev, key];
      saveIgnoredTrainingCards(targetPlayer, next);
      return next;
    });
  };

  const handleUnignoreCard = (key: string) => {
    setIgnoredKeysList(prev => {
      const next = prev.filter(item => item !== key);
      saveIgnoredTrainingCards(targetPlayer, next);
      return next;
    });
  };

  const handleRestoreAllIgnored = () => {
    setIgnoredKeysList([]);
    saveIgnoredTrainingCards(targetPlayer, []);
  };

  const filterBadgeParts: string[] = [];
  if (!hasExternalFilter) {
    filterBadgeParts.push(effectiveFocusMode === 'clear' ? tr('Klar', 'Clear') : tr('Alle', 'All'));
    if (effectiveMission !== 'all') filterBadgeParts.push(isEn ? MISSION_LABELS_EN[effectiveMission] : TRAINING_MISSION_LABELS[effectiveMission]);
    if (effectivePhase !== 'all') filterBadgeParts.push(isEn ? PHASE_LABELS_EN[effectivePhase] : TRAINING_PHASE_LABELS[effectivePhase]);
  }
  const filterButtonLabel =
    filterBadgeParts.length > 0
      ? `Filter · ${filterBadgeParts.join(' · ')}`
      : `${tr('Fehlerarten', 'Categories')} (${qualities.length})`;

  return (
    <div className="training-deck-view">
      <div className="training-deck-topbar">
        <div className="training-deck-topbar-title">
          <h2>
            <Shuffle size={18} color="#81b64c" /> {tr('Fehlerkarten', 'Mistake Cards')}
          </h2>
          <span className="training-deck-topbar-count">
            {cards.length} {effectiveFocusMode === 'clear' && !hasExternalFilter ? tr('klare', 'clear') : tr('im Deck', 'in deck')}
          </span>
        </div>

        <div className="training-deck-topbar-actions">
          <button
            type="button"
            className={`btn-secondary btn-sm ${filtersOpen ? 'active' : ''}`}
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen(cur => !cur)}
          >
            <SlidersHorizontal size={14} />
            <span>{filterButtonLabel}</span>
            <ChevronDown size={13} />
          </button>
        </div>
      </div>

      {hasExternalFilter && (
        <div className="training-deck-diagnostic-filter">
          <Target size={14} />
          <span>
            {tr('Trainingsfilter:', 'Training Filter:')}{' '}
            {[
              motifFilter ? (isEn ? (IDEA_LABELS_EN[motifFilter] || MISSED_IDEA_LABELS[motifFilter]) : MISSED_IDEA_LABELS[motifFilter]) : null,
              openingFilter,
              openingFocus
                ? `${openingFocus.name} · ${tr('mit', 'as')} ${colorLabel(openingFocus.color)} · ${tr('eigene Züge', 'own moves')} 1–${openingWindowMoves}`
                : null,
              statisticsFilter ? statisticsFilterLabel(statisticsFilter, lang) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <button className="btn-secondary" onClick={onClearFilter}>
            <X size={12} /> {tr('Filter entfernen', 'Clear filter')}
          </button>
        </div>
      )}

      {/* Neuer Filter = neue Sitzung. Unmount beendet Timer und laufende Prüfungen. */}
      <TrainingDeckSession
        key={JSON.stringify([
          qualities,
          motifFilter,
          openingFilter,
          openingFocus?.id,
          effectiveFocusMode,
          effectivePhase,
          effectiveMission,
          resetNonce,
        ])}
        cards={cards}
        targetPlayer={targetPlayer}
        motifFilter={motifFilter}
        openingFilter={openingFilter}
        onClearFilter={onClearFilter}
        onOpenGameAt={onOpenGameAt}
        hasSelection={qualities.length > 0}
        hasAvailableCards={availableCards.length > 0}
        allModeCardsCount={allModeCardsCount}
        ignoredInScopeCount={ignoredInScopeCount}
        effectiveFocusMode={effectiveFocusMode}
        autoAdvance={prefs.autoAdvance}
        onOpenFilters={() => setFiltersOpen(true)}
        onSwitchToAllFocus={() => updatePrefs({ focusMode: 'all', phase: 'all', mission: 'all' })}
        onResetSubFilters={() => updatePrefs({ phase: 'all', mission: 'all' })}
        onIgnoreCard={handleIgnoreCard}
        onUnignoreCard={handleUnignoreCard}
        onRestoreAllIgnored={handleRestoreAllIgnored}
      />

      {filtersOpen && (
        <div className="collapsible-sheet-backdrop" onClick={() => setFiltersOpen(false)}>
          <div
            className="collapsible-sheet"
            role="dialog"
            aria-label={tr('Filter und Einstellungen für Fehlerkarten', 'Filter and settings for mistake cards')}
            onClick={e => e.stopPropagation()}
          >
            <div className="collapsible-sheet-header">
              <strong>{tr('Fehlerkarten filtern & anpassen', 'Filter & Customize Mistake Cards')}</strong>
              <button type="button" className="btn-icon" aria-label={tr('Dialog schließen', 'Close dialog')} onClick={() => setFiltersOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="collapsible-sheet-body">
              <div className="training-filter-drawer-content">
                {hasExternalFilter && (
                  <p className="training-filter-external-note">
                    {tr(
                      'Hinweis: Ein Diagnose- oder Eröffnungsfilter ist aktiv. Fokus, Motiv und Phase werden daher vorübergehend auf „Alle“ gestellt.',
                      'Note: A diagnostics or opening filter is active. Focus, motif, and phase are temporarily set to "All".',
                    )}
                  </p>
                )}

                <div className="training-filter-section">
                  <span className="training-filter-label">{tr('Auswahlqualität', 'Card Scope')}</span>
                  <div className="training-focus-grid">
                    <button
                      type="button"
                      disabled={hasExternalFilter}
                      className={`training-focus-card ${effectiveFocusMode === 'clear' ? 'active' : ''}`}
                      onClick={() => updatePrefs({ focusMode: 'clear' })}
                    >
                      <div className="training-focus-card-head">
                        <strong>{tr('Klare Fehler', 'Clear Mistakes')}</strong>
                        <small>{clearModeCardsCount}</small>
                      </div>
                      <span>{tr('Blendet schon verlorene (-5) & vorentschiedene Partiestände aus.', 'Hides already lost (-5) and decided positions.')}</span>
                    </button>
                    <button
                      type="button"
                      disabled={hasExternalFilter}
                      className={`training-focus-card ${effectiveFocusMode === 'all' ? 'active' : ''}`}
                      onClick={() => updatePrefs({ focusMode: 'all' })}
                    >
                      <div className="training-focus-card-head">
                        <strong>{tr('Alle Fehler', 'All Mistakes')}</strong>
                        <small>{allModeCardsCount}</small>
                      </div>
                      <span>{tr('Alle analysierten Fehler inklusive schwieriger Grenzfälle.', 'All analyzed errors including tricky borderline positions.')}</span>
                    </button>
                  </div>
                </div>

                <div className="training-filter-section">
                  <span className="training-filter-label">{tr('Aufgabentyp', 'Task Type')}</span>
                  <div className="training-chip-row">
                    {(['all', 'mate', 'tactic', 'defense', 'positional'] as TrainingMissionFilter[]).map(mission => {
                      const count =
                        mission === 'all'
                          ? focusBaseCards.length
                          : focusBaseCards.filter(c => describeTrainingCard(c).mission === mission).length;
                      return (
                        <button
                          key={mission}
                          type="button"
                          disabled={hasExternalFilter}
                          className={`training-chip-btn ${effectiveMission === mission ? 'active' : ''}`}
                          onClick={() => updatePrefs({ mission })}
                        >
                          <span>{isEn ? MISSION_LABELS_EN[mission] : TRAINING_MISSION_LABELS[mission]}</span>
                          <small>{count}</small>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="training-filter-section">
                  <span className="training-filter-label">{tr('Spielphase', 'Game Phase')}</span>
                  <div className="training-chip-row">
                    {(['all', 'opening', 'middlegame', 'endgame'] as TrainingPhaseFilter[]).map(phase => {
                      const count =
                        phase === 'all'
                          ? focusBaseCards.length
                          : focusBaseCards.filter(c => describeTrainingCard(c).phase === phase).length;
                      return (
                        <button
                          key={phase}
                          type="button"
                          disabled={hasExternalFilter}
                          className={`training-chip-btn ${effectivePhase === phase ? 'active' : ''}`}
                          onClick={() => updatePrefs({ phase })}
                        >
                          <span>{isEn ? PHASE_LABELS_EN[phase] : TRAINING_PHASE_LABELS[phase]}</span>
                          <small>{count}</small>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <fieldset className="training-quality-filters">
                  <legend className="training-filter-label">{tr('Fehlerarten', 'Move Categories')}</legend>
                  <div className="training-quality-options-grid">
                    {TRAINING_QUALITY_OPTIONS.map(option => (
                      <label
                        key={option.quality}
                        className="training-quality-option-card"
                        title={
                          option.quality === 'miss'
                            ? tr('Eigene Kategorie: Diese Züge zählen nicht zusätzlich als Patzer oder Fehler.', 'Separate category: not double-counted as mistakes or blunders.')
                            : undefined
                        }
                      >
                        <input
                          type="checkbox"
                          checked={qualities.includes(option.quality)}
                          onChange={() => toggleQuality(option.quality)}
                        />
                        <span>{isEn ? QUALITY_LABELS_EN[option.quality].label : option.label}</span>
                        <small>{nonIgnoredCards.filter(card => matchesTrainingQuality(card.move, option.quality)).length}</small>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <label className="training-toggle-row">
                  <input
                    type="checkbox"
                    checked={prefs.autoAdvance}
                    onChange={e => updatePrefs({ autoAdvance: e.target.checked })}
                  />
                  <span>{tr('Nach richtiger Lösung automatisch zur nächsten Karte', 'Auto-advance after solving correctly')}</span>
                </label>

                <div className="training-filter-drawer-footer">
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() => {
                        const store = loadReviews(targetPlayer);
                        const next: ReviewStore = { version: 1, reviews: { ...store.reviews } };
                        for (const card of cards) delete next.reviews[card.key];
                        saveReviews(targetPlayer, next);
                        setResetNonce(n => n + 1);
                        setFiltersOpen(false);
                      }}
                      disabled={cards.length === 0}
                    >
                      <RotateCcw size={14} />
                      <span>{tr('Fortschritt zurücksetzen', 'Reset progress')}</span>
                    </button>
                    {ignoredKeysList.length > 0 && (
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={handleRestoreAllIgnored}
                      >
                        <Eye size={14} />
                        <span>{tr('Ignorierte wiederherstellen', 'Restore ignored')} ({ignoredKeysList.length})</span>
                      </button>
                    )}
                  </div>
                  <button type="button" className="btn-primary btn-sm" onClick={() => setFiltersOpen(false)}>
                    {tr('Fertig', 'Done')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface TrainingDeckSessionProps extends Omit<TrainingDeckViewProps, 'games'> {
  cards: TrainingCard[];
  hasSelection: boolean;
  hasAvailableCards: boolean;
  allModeCardsCount: number;
  ignoredInScopeCount: number;
  effectiveFocusMode: TrainingFocusMode;
  autoAdvance: boolean;
  onOpenFilters: () => void;
  onSwitchToAllFocus: () => void;
  onResetSubFilters: () => void;
  onIgnoreCard: (key: string) => void;
  onUnignoreCard: (key: string) => void;
  onRestoreAllIgnored: () => void;
}

type SessionFeedback = 'correct' | 'solid' | 'retry' | 'wrong' | 'revealed' | 'uncertain' | null;
type PlaybackKind = 'best' | 'played' | 'attempt';

const TrainingDeckSession: React.FC<TrainingDeckSessionProps> = ({
  cards,
  targetPlayer,
  motifFilter,
  openingFilter,
  onClearFilter,
  onOpenGameAt,
  hasSelection,
  hasAvailableCards,
  allModeCardsCount,
  ignoredInScopeCount,
  effectiveFocusMode,
  autoAdvance,
  onOpenFilters,
  onSwitchToAllFocus,
  onResetSubFilters,
  onIgnoreCard,
  onUnignoreCard,
  onRestoreAllIgnored,
}) => {
  const { isEn, lang, tr } = useI18n();
  const storageProblem = useStorageProblem();
  const [store, setStore] = useState<ReviewStore>(() => loadReviews(targetPlayer));
  const [voluntary, setVoluntary] = useState(false);
  const helpedRef = useRef(false);
  const [queue, setQueue] = useState<string[]>([]);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<SessionFeedback>(null);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [judgementReason, setJudgementReason] = useState<string | null>(null);
  const [conceptHintVisible, setConceptHintVisible] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [hintVisible, setHintVisible] = useState(false);
  const [lastAttempt, setLastAttempt] = useState<{ from: string; to: string } | null>(null);
  const [lastAttemptUci, setLastAttemptUci] = useState<string | null>(null);
  const [attemptRefutationPv, setAttemptRefutationPv] = useState<string[]>([]);
  const [viewingRefutation, setViewingRefutation] = useState(false);
  const [opponentReplyMove, setOpponentReplyMove] = useState<{ from: string; to: string; uci: string; san?: string } | null>(null);
  const [boardFen, setBoardFen] = useState(START_FEN);
  const [contextMove, setContextMove] = useState<{ from: string; to: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [introLock, setIntroLock] = useState(true);
  const [replayNonce, setReplayNonce] = useState(0);
  const [playbackTarget, setPlaybackTarget] = useState<{ kind: PlaybackKind; token: number } | null>(null);
  const [undoIgnored, setUndoIgnored] = useState<{ key: string; label: string } | null>(null);

  const attemptGenRef = useRef(0);
  const solvedHoldRef = useRef(false);
  const advanceTimerRef = useRef<number | undefined>(undefined);
  const sessionQuoteRef = useRef(0);
  const playbackTokenRef = useRef(0);
  const lastStartedTokenRef = useRef(0);
  const pendingRestoreKeyRef = useRef<string | null>(null);

  const [sessionCards, setSessionCards] = useState<TrainingCard[]>(() => {
    const selection = selectSessionCards(cards, store.reviews, { maxCards: MAX_SESSION_CARDS });
    sessionQuoteRef.current = selection.length;
    return selection;
  });
  const [answeredCount, setAnsweredCount] = useState(0);
  const [dueTick, setDueTick] = useState(0);

  useEffect(() => {
    if (pendingRestoreKeyRef.current) {
      const restoreKey = pendingRestoreKeyRef.current;
      const found = cards.find(card => card.key === restoreKey);
      if (found) {
        pendingRestoreKeyRef.current = null;
        setSessionCards(prev => (prev.some(card => card.key === restoreKey) ? prev : [...prev, found]));
        sessionQuoteRef.current += 1;
        setUndoIgnored(null);
      }
    }
  }, [cards]);

  useEffect(() => {
    if (currentKey !== null || answeredCount > 0) return;
    const selection = selectSessionCards(cards, store.reviews, { maxCards: MAX_SESSION_CARDS, voluntary });
    setSessionCards(selection);
    sessionQuoteRef.current = selection.length;
    setAnsweredCount(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, voluntary, dueTick]);

  useEffect(() => {
    const bump = () => {
      if (document.visibilityState !== 'hidden') setDueTick(tick => tick + 1);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') bump();
    };
    const timer = window.setInterval(bump, 30_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const deckStats = useMemo(() => {
    const now = Date.now();
    let mastered = 0;
    let due = 0;
    let fresh = 0;
    let nextDueAt = Infinity;
    for (const card of cards) {
      const entry = store.reviews[card.key];
      if (!entry) fresh++;
      else if (entry.dueAt <= now) due++;
      else nextDueAt = Math.min(nextDueAt, entry.dueAt);
      if (isMastered(entry)) mastered++;
    }
    return { mastered, due, fresh, nextDueAt };
  }, [cards, store]);

  const currentCard = cards.find(card => card.key === currentKey) || null;
  const briefing = useMemo(() => (currentCard ? describeTrainingCard(currentCard, lang) : null), [currentCard, lang]);

  const activePlaybackLine = useMemo(() => {
    if (!currentCard || !briefing || !playbackTarget) return [];
    if (playbackTarget.kind === 'best') return briefing.bestLineUci;
    if (playbackTarget.kind === 'played') return briefing.playedRefutationUci;
    return attemptRefutationPv;
  }, [currentCard, briefing, playbackTarget, attemptRefutationPv]);

  const playbackFenStart = currentCard?.move.fenBefore || START_FEN;
  const playback = useLinePlayback(playbackFenStart, activePlaybackLine, 850);

  const activePlaybackSanMoves = useMemo(() => {
    if (!currentCard || !playback.active || activePlaybackLine.length === 0) return [];
    return principalVariationSan(currentCard.move.fenBefore, activePlaybackLine);
  }, [currentCard, playback.active, activePlaybackLine]);

  useEffect(() => {
    if (!playbackTarget) return;
    if (playbackTarget.token === lastStartedTokenRef.current) return;
    lastStartedTokenRef.current = playbackTarget.token;
    if (activePlaybackLine.length > 0) {
      playback.start();
    }
  }, [playbackTarget, activePlaybackLine, playback.start]);

  useEffect(() => {
    if (!currentCard) return;
    const moveIndex = currentCard.game.moves.findIndex(gameMove => gameMove.ply === currentCard.move.ply);
    const previousMove = moveIndex > 0 ? currentCard.game.moves[moveIndex - 1] : undefined;
    let timer: number | undefined;

    attemptGenRef.current += 1;

    setLastAttempt(null);
    setLastAttemptUci(null);
    setAttemptRefutationPv([]);
    setViewingRefutation(false);
    setOpponentReplyMove(null);
    setContextMove(null);
    setChecking(false);
    setFailedAttempts(0);
    setConceptHintVisible(false);
    setJudgementReason(null);
    setPlaybackTarget(null);
    helpedRef.current = false;
    setBoardFen(previousMove?.fenBefore || currentCard.move.fenBefore);

    if (previousMove) {
      setIntroLock(true);
      timer = window.setTimeout(() => {
        setBoardFen(currentCard.move.fenBefore);
        setContextMove({ from: previousMove.from, to: previousMove.to });
        setIntroLock(false);
      }, 750);
    } else {
      setIntroLock(false);
    }

    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, currentCard?.key]);

  useEffect(() => {
    if (!currentCard || replayNonce === 0) return;
    const moveIndex = currentCard.game.moves.findIndex(gameMove => gameMove.ply === currentCard.move.ply);
    const previousMove = moveIndex > 0 ? currentCard.game.moves[moveIndex - 1] : undefined;
    if (!previousMove) return;

    playback.reset();
    setPlaybackTarget(null);
    setViewingRefutation(false);
    setOpponentReplyMove(null);
    setContextMove(null);
    setBoardFen(previousMove.fenBefore);
    setIntroLock(true);
    const timer = window.setTimeout(() => {
      setBoardFen(currentCard.move.fenBefore);
      setContextMove({ from: previousMove.from, to: previousMove.to });
      setIntroLock(false);
    }, 650);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayNonce]);

  useEffect(() => {
    const availableKeys = sessionCards.map(card => card.key);
    setQueue(oldQueue => {
      const validQueue = oldQueue.filter(key => availableKeys.includes(key) && key !== currentKey);
      const missing = availableKeys.filter(key => key !== currentKey && !validQueue.includes(key));
      return [...validQueue, ...missing];
    });
    if (!currentKey || !availableKeys.includes(currentKey)) {
      if (!solvedHoldRef.current) setCurrentKey(null);
    }
  }, [sessionCards, currentKey]);

  useEffect(() => {
    if (!currentKey && queue.length > 0) {
      setCurrentKey(queue[0]);
      setQueue(oldQueue => oldQueue.slice(1));
      setFeedback(null);
      setFailedAttempts(0);
      setJudgementReason(null);
      setConceptHintVisible(false);
      setRevealed(false);
      setHintVisible(false);
      setLastAttempt(null);
      setLastAttemptUci(null);
      setAttemptRefutationPv([]);
      setViewingRefutation(false);
      setOpponentReplyMove(null);
      setPlaybackTarget(null);
    }
  }, [currentKey, queue]);

  useEffect(() => {
    return () => {
      if (advanceTimerRef.current !== undefined) window.clearTimeout(advanceTimerRef.current);
      attemptGenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const next = loadReviews(targetPlayer);
    const legacy = readLegacySolvedKeys(SOLVED_STORAGE_KEY);
    if (legacy.length > 0) {
      migrateLegacySolved(next, legacy);
      if (saveReviews(targetPlayer, next)) {
        try {
          localStorage.removeItem(SOLVED_STORAGE_KEY);
        } catch {
          // Non-critical
        }
      }
    }
    setStore(next);
  }, [targetPlayer]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let idMap: Record<string, string> = {};
      try {
        idMap = (await window.electronAPI?.db.getReviewIdMap()) || {};
      } catch {
        return;
      }
      if (cancelled || Object.keys(idMap).length === 0) return;
      const next = loadReviews(targetPlayer);
      if (migrateGameIdKeys(next, idMap) > 0) {
        saveReviews(targetPlayer, next);
        setStore(next);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [targetPlayer]);

  const recordReview = (key: string, outcome: ReviewOutcome) => {
    const next = loadReviews(targetPlayer);
    applyReview(next, key, outcome);
    saveReviews(targetPlayer, next);
    setStore(next);
  };

  const clearAdvanceTimer = () => {
    if (advanceTimerRef.current !== undefined) {
      window.clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = undefined;
    }
  };

  const showAutoRefutation = (
    fenAfterUserMove: string,
    replyUciRaw: string | undefined,
    replySan: string | undefined,
  ) => {
    const replyUci = (replyUciRaw || '').trim().toLowerCase();
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(replyUci)) {
      setViewingRefutation(false);
      setOpponentReplyMove(null);
      setBoardFen(currentCard?.move.fenBefore || START_FEN);
      return;
    }
    try {
      const checkReply = new Chess(fenAfterUserMove);
      const playedReply = checkReply.move({
        from: replyUci.slice(0, 2) as Square,
        to: replyUci.slice(2, 4) as Square,
        promotion: (replyUci[4] || undefined) as never,
      });
      if (!playedReply) throw new Error('illegal reply');
      setBoardFen(fenAfterUserMove);
      setViewingRefutation(true);
      setOpponentReplyMove({
        from: playedReply.from,
        to: playedReply.to,
        uci: replyUci,
        san: playedReply.san || replySan,
      });
    } catch {
      setViewingRefutation(false);
      setOpponentReplyMove(null);
      setBoardFen(currentCard?.move.fenBefore || START_FEN);
    }
  };

  const startSecondAttempt = () => {
    if (!currentCard) return;
    playback.reset();
    setPlaybackTarget(null);
    setViewingRefutation(false);
    setOpponentReplyMove(null);
    setBoardFen(currentCard.move.fenBefore);
  };

  const advance = (requeue: boolean) => {
    if (!currentCard) return;
    playback.reset();
    setPlaybackTarget(null);
    solvedHoldRef.current = false;
    helpedRef.current = false;
    if (!requeue) {
      setSessionCards(prev => prev.filter(card => card.key !== currentCard.key));
      setAnsweredCount(count => count + 1);
    }
    clearAdvanceTimer();
    attemptGenRef.current += 1;
    setCurrentKey(null);
    setFeedback(null);
    setFailedAttempts(0);
    setJudgementReason(null);
    setConceptHintVisible(false);
    setRevealed(false);
    setHintVisible(false);
    setLastAttempt(null);
    setLastAttemptUci(null);
    setAttemptRefutationPv([]);
    setViewingRefutation(false);
    setOpponentReplyMove(null);
  };

  const skipCard = () => {
    if (!currentCard || queue.length === 0) return;
    advance(true);
  };

  const ignoreCard = () => {
    if (!currentCard || !briefing) return;
    playback.reset();
    setPlaybackTarget(null);
    clearAdvanceTimer();
    solvedHoldRef.current = false;
    helpedRef.current = false;
    attemptGenRef.current += 1;
    const removedKey = currentCard.key;
    const label = `${tr('Zug', 'Move')} ${currentCard.move.moveNumber} (${briefing.playedSan})`;
    setSessionCards(prev => prev.filter(card => card.key !== removedKey));
    sessionQuoteRef.current = Math.max(0, sessionQuoteRef.current - 1);
    setCurrentKey(null);
    setFeedback(null);
    setFailedAttempts(0);
    setJudgementReason(null);
    setConceptHintVisible(false);
    setRevealed(false);
    setHintVisible(false);
    setLastAttempt(null);
    setLastAttemptUci(null);
    setAttemptRefutationPv([]);
    setViewingRefutation(false);
    setOpponentReplyMove(null);
    setUndoIgnored({ key: removedKey, label });
    onIgnoreCard(removedKey);
  };

  const handleUndoIgnore = () => {
    if (!undoIgnored) return;
    pendingRestoreKeyRef.current = undoIgnored.key;
    onUnignoreCard(undoIgnored.key);
  };

  const togglePlayback = (kind: PlaybackKind) => {
    clearAdvanceTimer();
    setViewingRefutation(false);
    setOpponentReplyMove(null);
    if (currentCard) setBoardFen(currentCard.move.fenBefore);
    if (playback.active && playbackTarget?.kind === kind) {
      playback.reset();
      setPlaybackTarget(null);
      return;
    }
    playback.reset();
    playbackTokenRef.current += 1;
    setPlaybackTarget({ kind, token: playbackTokenRef.current });
  };

  const isMobileEngine = Boolean(window.electronAPI?.isMobile);

  const evaluateAfter = (fen: string) => {
    const evaluate = window.electronAPI?.engine?.evaluateFen;
    if (!evaluate) return Promise.resolve(null);
    const targetDepth = judgeTargetDepth(currentCard!.move.evalBefore);
    return isMobileEngine
      ? evaluate(fen, targetDepth, undefined, undefined, { maxTimeMs: 1000 })
      : evaluate(fen, targetDepth);
  };

  const applyJudgement = (judgement: TrainingJudgement, playedUci: string) => {
    if (!currentCard) return;
    setChecking(false);
    if (judgement.verdict.kind === 'uncertain') {
      setViewingRefutation(false);
      setOpponentReplyMove(null);
      setBoardFen(currentCard.move.fenBefore);
      setFeedback('uncertain');
      setJudgementReason(judgement.verdict.reason);
      return;
    }
    if (judgement.verdict.kind === 'solid') {
      setViewingRefutation(false);
      setOpponentReplyMove(null);
      setBoardFen(currentCard.move.fenBefore);
      setFeedback('solid');
      setJudgementReason(judgement.verdict.reason);
      return;
    }
    if (judgement.verdict.kind === 'best' || judgement.verdict.kind === 'accepted') {
      setViewingRefutation(false);
      setOpponentReplyMove(null);
      if (judgement.fenAfter) setBoardFen(judgement.fenAfter);
      const outcome: ReviewOutcome = helpedRef.current || failedAttempts > 0 ? 'help' : 'correct';
      recordReview(currentCard.key, outcome);
      helpedRef.current = false;
      setFeedback('correct');
      const reason =
        failedAttempts > 0
          ? judgement.verdict.kind === 'accepted'
            ? tr(`Im 2. Versuch gelöst! ${judgement.verdict.reason}`, `Solved on 2nd attempt! ${judgement.verdict.reason}`)
            : tr('Im 2. Versuch gelöst!', 'Solved on 2nd attempt!')
          : judgement.verdict.kind === 'accepted'
            ? judgement.verdict.reason
            : null;
      setJudgementReason(reason);
      sounds.playSuccess();
      if (autoAdvance) {
        solvedHoldRef.current = true;
        clearAdvanceTimer();
        advanceTimerRef.current = window.setTimeout(() => {
          advanceTimerRef.current = undefined;
          advance(false);
        }, 1800);
      }
      return;
    }

    // Falscher Versuch: 1. Versuch gibt gezieltes Feedback + Gegnerdrohung per Pfeil + 2. Chance!
    const refutationLine = judgement.refutationPv?.length ? [playedUci, ...judgement.refutationPv] : [];
    setAttemptRefutationPv(refutationLine);
    sounds.playBlunder();
    if (failedAttempts === 0) {
      setFailedAttempts(1);
      setFeedback('retry');
      setJudgementReason(judgement.verdict.reason);
      showAutoRefutation(
        judgement.fenAfter || currentCard.move.fenBefore,
        judgement.refutationPv?.[0],
        judgement.refutationSan,
      );
      return;
    }

    recordReview(currentCard.key, 'wrong');
    helpedRef.current = false;
    setFeedback('wrong');
    setRevealed(true);
    setJudgementReason(judgement.verdict.reason);
    showAutoRefutation(
      judgement.fenAfter || currentCard.move.fenBefore,
      judgement.refutationPv?.[0],
      judgement.refutationSan,
    );
  };

  const handleMove = (move: { from: string; to: string; promotion?: string }) => {
    const canTry = feedback === null || feedback === 'solid' || (feedback === 'retry' && !viewingRefutation);
    if (!currentCard || !briefing || !canTry || checking || introLock || playback.active) return;

    const playedUci = (move.from + move.to + (move.promotion || '')).toLowerCase();
    setLastAttempt({ from: move.from, to: move.to });
    setLastAttemptUci(playedUci);
    let afterUserFen = currentCard.move.fenBefore;
    try {
      const pre = new Chess(currentCard.move.fenBefore);
      const played = pre.move({
        from: move.from as Square,
        to: move.to as Square,
        promotion: (move.promotion || undefined) as never,
      });
      if (played) afterUserFen = pre.fen();
    } catch {
      afterUserFen = currentCard.move.fenBefore;
    }
    setBoardFen(afterUserFen);
    const gen = attemptGenRef.current;

    // Falls im 1. Versuch genau der eigene alte Partiezug gespielt wird: Konterpfeil zeigen + 2. Chance!
    if (failedAttempts === 0 && playedUci === currentCard.move.uci.toLowerCase()) {
      setFailedAttempts(1);
      setFeedback('retry');
      setAttemptRefutationPv(briefing.playedRefutationUci);
      setJudgementReason(
        tr(
          `Das war dein Partiezug (${briefing.playedSan}). Der Pfeil zeigt den stärksten Gegenzug — probiere eine andere Idee.`,
          `That was your game move (${briefing.playedSan}). The arrow shows the strongest refutation — try another idea.`,
        ),
      );
      sounds.playBlunder();
      showAutoRefutation(afterUserFen, briefing.playedRefutationUci[1], undefined);
      return;
    }

    setChecking(true);
    judgeTrainingAttempt(
      currentCard.move.fenBefore,
      playedUci,
      currentCard.move.evalBefore.bestMoveUci,
      currentCard.move.evalBefore,
      {
        evaluateAfter,
        preserveMaterialOpportunity: currentCard.move.missedOpportunity?.kind === 'material',
        minReliableDepth: isMobileEngine ? 12 : undefined,
      },
    )
      .then(judgement => {
        if (attemptGenRef.current !== gen) return;
        applyJudgement(judgement, playedUci);
      })
      .catch(() => {
        if (attemptGenRef.current !== gen) return;
        setChecking(false);
        setBoardFen(currentCard.move.fenBefore);
      });
  };

  const handleRevealSolution = () => {
    if (!currentCard) return;
    if (feedback === 'correct' || feedback === 'wrong' || feedback === 'revealed') return;
    playback.reset();
    setPlaybackTarget(null);
    clearAdvanceTimer();
    setViewingRefutation(false);
    setOpponentReplyMove(null);
    setBoardFen(currentCard.move.fenBefore);
    setChecking(false);
    setRevealed(true);
    helpedRef.current = true;
    recordReview(currentCard.key, failedAttempts > 0 ? 'wrong' : 'help');
    setFeedback('revealed');
    setJudgementReason(null);
  };

  const resetDeckProgress = () => {
    setStore(prev => {
      const next: ReviewStore = { version: 1, reviews: { ...prev.reviews } };
      for (const card of cards) delete next.reviews[card.key];
      saveReviews(targetPlayer, next);
      return next;
    });
    setVoluntary(false);
    setCurrentKey(null);
    setAnsweredCount(0);
    setDueTick(tick => tick + 1);
  };

  if (cards.length === 0) {
    if (effectiveFocusMode === 'clear' && allModeCardsCount > 0) {
      return (
        <div className="training-deck-empty">
          <Target size={52} color="#81b64c" />
          <h2>{tr('Keine klaren Fehler in diesem Filter', 'No clear mistakes in this filter')}</h2>
          <p>
            {tr(
              `Im Modus „Klare Fehler“ wurden vorentschiedene oder bereits verlorene Stellungen ausgeblendet. Im Gesamtdeck gibt es ${allModeCardsCount} passende Karten.`,
              `"Clear Mistakes" mode hides already lost and decided positions. ${allModeCardsCount} matching cards are available in the full deck.`,
            )}
          </p>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="btn-primary" onClick={onSwitchToAllFocus}>
              {tr(`Alle Fehler anzeigen (${allModeCardsCount})`, `Show all mistakes (${allModeCardsCount})`)}
            </button>
            <button type="button" className="btn-secondary" onClick={onOpenFilters}>
              <SlidersHorizontal size={15} /> {tr('Filter anpassen', 'Adjust filters')}
            </button>
          </div>
        </div>
      );
    }
    if (!hasSelection || hasAvailableCards) {
      return (
        <div className="training-deck-empty">
          <Target size={52} color="#81b64c" />
          <h2>
            {!hasSelection
              ? tr('Wähle mindestens eine Fehlerart', 'Select at least one error category')
              : ignoredInScopeCount > 0 && allModeCardsCount === 0
                ? tr('Alle passenden Karten ausgeblendet', 'All matching cards are hidden')
                : tr('Keine Karten für diese Filter', 'No cards match these filters')}
          </h2>
          <p>
            {!hasSelection
              ? tr('Öffne die Filtereinstellungen oben, um deine Trainingsrunde zusammenzustellen.', 'Open the filter settings above to build your training session.')
              : ignoredInScopeCount > 0 && allModeCardsCount === 0
                ? tr(`Du hast ${ignoredInScopeCount} Karte${ignoredInScopeCount === 1 ? '' : 'n'} in dieser Auswahl ignoriert.`, `You hid ${ignoredInScopeCount} card${ignoredInScopeCount === 1 ? '' : 's'} in this selection.`)
                : tr('Passe Motiv, Spielphase oder Fehlerarten im Filter-Menü an.', 'Adjust motif, game phase, or move categories in the filter menu.')}
          </p>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
            {ignoredInScopeCount > 0 && allModeCardsCount === 0 && (
              <button type="button" className="btn-primary" onClick={onRestoreAllIgnored}>
                <Eye size={15} /> {tr(`Ignorierte wiederherstellen (${ignoredInScopeCount})`, `Restore hidden (${ignoredInScopeCount})`)}
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={onResetSubFilters}>
              {tr('Motiv/Phase zurücksetzen', 'Reset motif/phase')}
            </button>
            <button type="button" className="btn-secondary" onClick={onOpenFilters}>
              <SlidersHorizontal size={15} /> {tr('Filter öffnen', 'Open filters')}
            </button>
          </div>
        </div>
      );
    }
    if (motifFilter || openingFilter) {
      const filterText = [motifFilter ? (isEn ? (IDEA_LABELS_EN[motifFilter] || MISSED_IDEA_LABELS[motifFilter]) : MISSED_IDEA_LABELS[motifFilter]) : null, openingFilter].filter(Boolean).join(' · ');
      return (
        <div className="training-deck-empty">
          <Target size={52} color="#81b64c" />
          <h2>{tr('Keine Karten für diesen Filter', 'No cards for this filter')}</h2>
          <p>{tr(`Für ${filterText || 'den gewählten Filter'} existiert keine eigene Trainingskarte.`, `No training cards found for ${filterText || 'the selected filter'}.`)}</p>
          <button className="btn-secondary" onClick={onClearFilter} style={{ marginTop: '10px' }}>
            <X size={14} />
            <span>{tr('Filter entfernen', 'Clear filter')}</span>
          </button>
        </div>
      );
    }
    return (
      <div className="training-deck-empty">
        <Target size={52} color="#81b64c" />
        <h2>{tr('Noch keine Trainingskarten', 'No training cards yet')}</h2>
        <p>
          {tr(
            'Importiere und analysiere eigene Partien mit Ungenauigkeiten, Fehlern oder Patzern, damit hier dein persönliches Fehlerdeck entsteht.',
            'Import and analyze your games containing inaccuracies, mistakes, or blunders to populate your spaced-repetition deck.',
          )}
        </p>
      </div>
    );
  }

  if (!currentCard && sessionCards.length === 0 && sessionQuoteRef.current > 0) {
    return (
      <div className="training-deck-empty">
        <CheckCircle2 size={52} color="#81b64c" />
        <h2>{tr('Sitzung abgeschlossen', 'Session Complete')}</h2>
        <p>
          {tr(
            `${answeredCount} von ${sessionQuoteRef.current} Karten in dieser Sitzung bearbeitet. Weitere Übung startest du bewusst.`,
            `Completed ${answeredCount} of ${sessionQuoteRef.current} cards in this session. Start another round whenever you are ready.`,
          )}
        </p>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button
            className="btn-secondary"
            onClick={() => {
              setAnsweredCount(0);
              setVoluntary(true);
              setDueTick(tick => tick + 1);
            }}
          >
            <Play size={16} />
            {tr('Nochmal üben', 'Practice again')}
          </button>
        </div>
      </div>
    );
  }

  if (!currentCard || !briefing) {
    const nextDueText = Number.isFinite(deckStats.nextDueAt)
      ? new Date(deckStats.nextDueAt).toLocaleDateString(isEn ? 'en-US' : 'de-DE', { day: '2-digit', month: '2-digit' })
      : null;
    return (
      <div className="training-deck-empty">
        <CheckCircle2 size={52} color="#81b64c" />
        <h2>{tr('Nichts fällig', 'Nothing due')}</h2>
        <p>
          {tr(
            `${cards.length} Situationen im ausgewählten Deck — ${deckStats.mastered} gemeistert.${nextDueText ? ` Nächste Wiederholung: ${nextDueText}.` : ' Alle Karten im 30-Tage-Rhythmus.'}`,
            `${cards.length} situations in selected deck — ${deckStats.mastered} mastered.${nextDueText ? ` Next review: ${nextDueText}.` : ' All cards on 30-day intervals.'}`,
          )}
        </p>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button
            className="btn-secondary"
            onClick={() => {
              setAnsweredCount(0);
              setVoluntary(true);
              setDueTick(tick => tick + 1);
            }}
          >
            <Play size={16} />
            {tr('Trotzdem üben', 'Practice anyway')}
          </button>
          <button className="btn-secondary" onClick={resetDeckProgress}>
            <RotateCcw size={16} />
            {tr('Karten zurücksetzen', 'Reset deck')}
          </button>
        </div>
      </div>
    );
  }

  const move = currentCard.move;
  const bestMoveFrom = move.evalBefore.bestMoveUci.substring(0, 2);
  const moveIndex = currentCard.game.moves.findIndex(gameMove => gameMove.ply === move.ply);
  const previousMove = moveIndex > 0 ? currentCard.game.moves[moveIndex - 1] : null;
  const isSettled = feedback === 'correct' || feedback === 'wrong' || feedback === 'revealed';
  const canMoveOnBoard =
    (feedback === null || feedback === 'solid' || (feedback === 'retry' && !viewingRefutation)) &&
    !checking &&
    !introLock &&
    !playback.active;

  const displayFen = playback.active ? playback.fen : boardFen;
  const displayLastMove = playback.active
    ? playback.lastMove
    : (checking || viewingRefutation) && lastAttempt
      ? lastAttempt
      : feedback === 'correct' && lastAttempt
        ? { ...lastAttempt, quality: 'best' as const }
        : contextMove;

  const refutationThreatArrows =
    !playback.active && viewingRefutation && opponentReplyMove
      ? [{ from: opponentReplyMove.from, to: opponentReplyMove.to }]
      : [];

  const bestArrow =
    !playback.active &&
    !viewingRefutation &&
    !checking &&
    (feedback === 'wrong' || feedback === 'revealed' || revealed)
      ? { from: bestMoveFrom, to: move.evalBefore.bestMoveUci.substring(2, 4) }
      : null;

  const captures =
    playback.active && activePlaybackLine.length > 0
      ? capturedMaterialAfterLine(currentCard.game.moves, moveIndex, move.fenBefore, activePlaybackLine.slice(0, playback.ply))
      : (checking || viewingRefutation) && lastAttemptUci
        ? capturedMaterialAfterLine(currentCard.game.moves, moveIndex, move.fenBefore, [lastAttemptUci])
        : previousMove && displayFen === previousMove.fenBefore
          ? capturedMaterial(currentCard.game.moves, moveIndex - 1)
          : feedback === 'correct' && lastAttemptUci && displayFen !== move.fenBefore
            ? capturedMaterialAfterLine(currentCard.game.moves, moveIndex, move.fenBefore, [lastAttemptUci])
            : capturedMaterial(currentCard.game.moves, moveIndex);

  const sessionTotal = Math.max(sessionQuoteRef.current, answeredCount + sessionCards.length, 1);
  const sessionDone = Math.min(sessionTotal, answeredCount + (feedback === 'correct' ? 1 : 0));
  const sessionPercent = Math.round((sessionDone / sessionTotal) * 100);

  const topColor = move.color === 'b' ? 'w' : 'b';
  const bottomColor = move.color;
  const opponentName = move.color === 'w' ? currentCard.game.black : currentCard.game.white;
  const playerLabel = move.color === 'w' ? currentCard.game.white : currentCard.game.black;
  const turnColor: 'w' | 'b' = playback.active
    ? (displayFen.split(' ')[1] === 'b' ? 'b' : 'w')
    : move.color;
  const turnText = turnToMoveLabel(turnColor);
  const qualityCat = moveCategory(move);
  const qualityOpt = TRAINING_QUALITY_OPTIONS.find(option => option.quality === qualityCat);
  const qualitySingular = isEn
    ? (qualityOpt ? QUALITY_LABELS_EN[qualityOpt.quality].singular : 'Mistake')
    : (qualityOpt?.singular || 'Fehler');

  const headline = checking
    ? tr('Engine prüft deinen Zug …', 'Engine is evaluating your move…')
    : feedback === 'correct'
      ? tr('Gelöst!', 'Solved!')
      : feedback === 'solid'
        ? tr('Solider Zug — geht noch stärker!', 'Solid move — can you find an even stronger one?')
        : feedback === 'wrong'
          ? viewingRefutation && opponentReplyMove?.san
            ? tr(`Gegner droht: ${opponentReplyMove.san} (besser: ${briefing.bestSan})`, `Opponent threatens: ${opponentReplyMove.san} (better: ${briefing.bestSan})`)
            : tr(`Besser war ${briefing.bestSan}`, `${briefing.bestSan} was better`)
          : feedback === 'revealed'
            ? tr(`Lösung: ${briefing.bestSan}`, `Solution: ${briefing.bestSan}`)
            : feedback === 'uncertain'
              ? tr('Prüfung nicht eindeutig', 'Evaluation inconclusive')
              : feedback === 'retry'
                ? viewingRefutation && opponentReplyMove?.san
                  ? tr(`Gegner droht: ${opponentReplyMove.san}`, `Opponent threatens: ${opponentReplyMove.san}`)
                  : `${tr('Noch 1 Versuch —', '1 more try —')} ${briefing.prompt}`
                : briefing.prompt;

  const isRefutationRetry = feedback === 'retry' && viewingRefutation;
  const showSolvingButtons = !isSettled && feedback !== 'uncertain' && !isRefutationRetry;

  const canPlayDifferentAttempt =
    feedback === 'wrong' &&
    attemptRefutationPv.length > 1 &&
    lastAttemptUci !== move.uci.toLowerCase();

  const pvStripNode =
    playback.active && activePlaybackSanMoves.length > 0 ? (
      <div className="training-pv-strip" aria-label={tr('Variante', 'Variation')}>
        {activePlaybackSanMoves.map((san, idx) => (
          <span key={`${san}-${idx}`} className={idx + 1 === playback.ply ? 'is-current' : ''}>
            {san}
          </span>
        ))}
      </div>
    ) : null;

  return (
    <>
      {undoIgnored && (
        <div className="training-undo-bar">
          <span>{undoIgnored.label} {tr('ausgeblendet.', 'hidden.')}</span>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button type="button" className="btn-secondary btn-sm" onClick={handleUndoIgnore}>
              {tr('Rückgängig', 'Undo')}
            </button>
            <button
              type="button"
              className="btn-icon"
              aria-label={tr('Hinweis schließen', 'Dismiss')}
              onClick={() => setUndoIgnored(null)}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      <div className={`training-deck-layout ${isSettled ? 'is-settled' : ''} ${feedback !== null ? 'has-feedback' : ''} ${playback.active ? 'is-playing' : ''}`}>
        <div className="training-deck-board-column">
          <div className="board-player-row training-deck-player-top">
            <div className="board-player-label">
              <strong>{opponentName}</strong>
              <span>{currentCard.game.openingName || currentCard.game.eco || tr('Stellung', 'Position')}</span>
            </div>
            <CapturedPieces
              color={topColor}
              pieces={topColor === 'w' ? captures.byWhite : captures.byBlack}
              lead={topColor === 'w' ? captures.whiteLead : captures.blackLead}
            />
          </div>

          <Chessboard
            fen={displayFen}
            isFlipped={move.color === 'b'}
            onMove={handleMove}
            interactive={canMoveOnBoard}
            hintSquare={!playback.active && !viewingRefutation && !checking && hintVisible ? bestMoveFrom : null}
            bestMoveArrow={bestArrow}
            threatArrows={refutationThreatArrows}
            lastMove={displayLastMove}
          />

          <div className="board-player-row training-deck-player-bottom">
            <div className="board-player-label">
              <strong>{playerLabel}</strong>
              <span className={`turn-indicator-pill is-compact ${move.color === 'w' ? 'is-white' : 'is-black'}`}>
                <i className="turn-indicator-swatch" aria-hidden="true" />
                {sideMovesLabel(move.color)}
              </span>
            </div>
            <CapturedPieces
              color={bottomColor}
              pieces={bottomColor === 'w' ? captures.byWhite : captures.byBlack}
              lead={bottomColor === 'w' ? captures.whiteLead : captures.blackLead}
            />
          </div>
        </div>

        <aside className="training-deck-panel">
          <div className="training-deck-progress-block">
            <div className="training-deck-status-row">
              <div className="training-deck-count">
                {tr('Runde', 'Round')} {sessionDone}/{sessionTotal}
                <span className="training-deck-count-sub"> · {deckStats.mastered}/{cards.length} {tr('gemeistert', 'mastered')}</span>
              </div>
              <div className="training-deck-badges">
                <span className={`training-stance-pill tone-${briefing.stanceTone}`}>{briefing.stanceLabel}</span>
                <span className={`training-mission-badge is-${briefing.mission}`}>{briefing.missionBadge}</span>
              </div>
            </div>
            <div
              className="training-deck-progress-track"
              role="progressbar"
              aria-label={tr('Sitzungsfortschritt', 'Session progress')}
              aria-valuenow={sessionDone}
              aria-valuemin={0}
              aria-valuemax={sessionTotal}
            >
              <div className="training-deck-progress-fill" style={{ width: `${sessionPercent}%` }} />
            </div>
          </div>

          <div className="training-deck-meta">
            <div className="training-deck-context-row">
              <span className="training-deck-context-text">
                {tr('Zug', 'Move')} {move.moveNumber} · {briefing.phaseLabel}
                {briefing.previousMove && (
                  <>
                    {' '}
                    · {tr('Gegner:', 'Opponent:')} <strong>{briefing.previousMove.san}</strong>
                  </>
                )}
              </span>
              <div className="training-deck-card-tools">
                {briefing.previousMove && (
                  <button
                    type="button"
                    className="training-icon-pill"
                    title={tr('Letzten Gegnerzug nochmal animieren', 'Replay opponent last move')}
                    aria-label={tr('Letzten Gegnerzug nochmal animieren', 'Replay opponent last move')}
                    onClick={() => setReplayNonce(n => n + 1)}
                    disabled={checking}
                  >
                    <RotateCcw size={12} />
                  </button>
                )}
                {!isSettled && (
                  <>
                    <button
                      type="button"
                      className="training-icon-pill"
                      title={tr('Karte später in dieser Sitzung nochmal zeigen', 'Show card again later in this session')}
                      aria-label={tr('Karte später zeigen', 'Skip card for later')}
                      onClick={skipCard}
                      disabled={queue.length === 0 || checking}
                    >
                      <SkipForward size={12} />
                    </button>
                    <button
                      type="button"
                      className="training-icon-pill"
                      title={tr('Karte dauerhaft ausblenden', 'Hide card permanently')}
                      aria-label={tr('Karte ignorieren', 'Ignore card')}
                      onClick={ignoreCard}
                      disabled={checking}
                    >
                      <EyeOff size={12} />
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="training-deck-headline-row">
              <span className={`turn-indicator-pill ${turnColor === 'w' ? 'is-white' : 'is-black'}`}>
                <i className="turn-indicator-swatch" aria-hidden="true" />
                {turnText}
              </span>
              <strong>{headline}</strong>
            </div>
            <span className="training-deck-played-sub">
              {tr('In der Partie:', 'Played in game:')} {briefing.playedSan} ({qualitySingular})
            </span>
          </div>

          {conceptHintVisible && !viewingRefutation && (feedback === null || feedback === 'solid' || feedback === 'retry') && (
            <div className="training-hint-box">
              <Lightbulb size={15} />
              <span>{briefing.conceptHint}</span>
            </div>
          )}

          {feedback === 'solid' && (
            <div className="training-feedback info">
              <Info size={17} />
              <div className="training-feedback-body">
                <span>{judgementReason}</span>
              </div>
            </div>
          )}

          {feedback === 'retry' && (
            <div className="training-feedback warn">
              <AlertCircle size={17} />
              <div className="training-feedback-body">
                <span>{judgementReason || tr('Noch nicht optimal. Probiere eine andere Fortsetzung.', 'Not optimal yet. Try a different continuation.')}</span>
                {pvStripNode}
                {attemptRefutationPv.length > 1 && (
                  <button
                    type="button"
                    className="training-inline-link"
                    onClick={() => togglePlayback('attempt')}
                  >
                    {playback.active && playbackTarget?.kind === 'attempt' ? (
                      <>
                        <RotateCcw size={12} /> {tr('Zurück zur Aufgabe', 'Back to puzzle')}
                      </>
                    ) : (
                      <>
                        <Play size={12} /> {tr('Gegenzug abspielen', 'Play refutation')}
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          )}

          {feedback === 'correct' && (
            <div className="training-feedback success">
              <CheckCircle2 size={17} />
              <div className="training-feedback-body">
                <span>
                  {judgementReason || tr('Richtig.', 'Correct.')}{' '}
                  {storageProblem
                    ? tr('Lernstand noch nicht gespeichert.', 'Progress not yet saved.')
                    : `${tr('Nächste Wiederholung:', 'Next review:')} ${formatDueIn(store.reviews[currentCard.key])}.`}
                </span>
                {pvStripNode}
                {briefing.postMoveSummary && <p className="training-explain-text">{briefing.postMoveSummary}</p>}
              </div>
            </div>
          )}

          {feedback === 'wrong' && (
            <div className="training-feedback failure">
              <AlertCircle size={17} />
              <div className="training-feedback-body">
                <span>{judgementReason || tr('Nicht optimal. Die Karte bleibt im Stapel und kommt später wieder.', 'Not optimal. This card stays in your queue for review.')}</span>
                {pvStripNode}
                {briefing.postMoveSummary && <p className="training-explain-text">{briefing.postMoveSummary}</p>}
              </div>
            </div>
          )}

          {feedback === 'revealed' && (
            <div className="training-feedback info">
              <Info size={17} />
              <div className="training-feedback-body">
                <span>{tr('Die Karte bleibt zur Wiederholung im Stapel.', 'Card kept in deck for future review.')}</span>
                {pvStripNode}
                {briefing.postMoveSummary && <p className="training-explain-text">{briefing.postMoveSummary}</p>}
              </div>
            </div>
          )}

          {feedback === 'uncertain' && (
            <div className="training-feedback uncertain">
              <AlertCircle size={17} />
              <div className="training-feedback-body">
                <span>{judgementReason || tr('Engine-Bewertung gerade nicht verfügbar.', 'Engine evaluation temporarily unavailable.')} {tr('Der Versuch wird nicht gewertet.', 'This attempt was not scored.')}</span>
              </div>
            </div>
          )}

          <div
            className={`training-deck-actions ${
              isRefutationRetry ? 'is-refutation-retry' : showSolvingButtons ? 'is-solving' : ''
            }`}
          >
            {isRefutationRetry && (
              <>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={startSecondAttempt}
                  disabled={checking}
                >
                  <RotateCcw size={14} />
                  <span>{tr('2. Versuch', '2nd Try')}</span>
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleRevealSolution}
                  disabled={checking}
                >
                  <Eye size={14} />
                  <span>{tr('Lösung', 'Solution')}</span>
                </button>
              </>
            )}

            {showSolvingButtons && (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setConceptHintVisible(true)}
                  disabled={conceptHintVisible || checking}
                  title={tr('Gibt einen strategischen Denkanstoß ohne Intervall-Verlust', 'Gives a strategic clue without interval penalty')}
                >
                  <Lightbulb size={14} />
                  <span>{tr('Tipp', 'Hint')}</span>
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    helpedRef.current = true;
                    setHintVisible(true);
                  }}
                  disabled={hintVisible || checking}
                  title={tr('Markiert die richtige Figur auf dem Brett', 'Highlights the piece to move on the board')}
                >
                  <Target size={14} />
                  <span>{tr('Figur', 'Piece')}</span>
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleRevealSolution}
                  disabled={checking}
                >
                  <Eye size={14} />
                  <span>{tr('Lösung', 'Solution')}</span>
                </button>
              </>
            )}

            {feedback === 'uncertain' && (
              <>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => {
                    setFeedback(null);
                    setJudgementReason(null);
                  }}
                >
                  <RotateCcw size={14} />
                  <span>{tr('Erneut versuchen', 'Try again')}</span>
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={skipCard}
                  disabled={queue.length === 0}
                >
                  <SkipForward size={14} />
                  <span>{tr('Später', 'Later')}</span>
                </button>
              </>
            )}

            {isSettled && (
              <>
                <div className="training-deck-post-tools">
                  {briefing.bestLineUci.length > 0 && (
                    <button
                      type="button"
                      className={`btn-secondary btn-sm ${playbackTarget?.kind === 'best' && playback.active ? 'active' : ''}`}
                      onClick={() => togglePlayback('best')}
                    >
                      {playbackTarget?.kind === 'best' && playback.playing ? (
                        <StopSquare size={13} />
                      ) : playbackTarget?.kind === 'best' && playback.finished ? (
                        <RotateCcw size={13} />
                      ) : (
                        <Play size={13} />
                      )}
                      <span>{tr('Bestzug', 'Best line')}</span>
                    </button>
                  )}

                  {briefing.playedRefutationUci.length > 1 && (
                    <button
                      type="button"
                      className={`btn-secondary btn-sm ${playbackTarget?.kind === 'played' && playback.active ? 'active' : ''}`}
                      onClick={() => togglePlayback('played')}
                    >
                      {playbackTarget?.kind === 'played' && playback.playing ? (
                        <StopSquare size={13} />
                      ) : playbackTarget?.kind === 'played' && playback.finished ? (
                        <RotateCcw size={13} />
                      ) : (
                        <Play size={13} />
                      )}
                      <span>{tr('Partiezug', 'Game line')}</span>
                    </button>
                  )}

                  {canPlayDifferentAttempt && (
                    <button
                      type="button"
                      className={`btn-secondary btn-sm ${playbackTarget?.kind === 'attempt' && playback.active ? 'active' : ''}`}
                      onClick={() => togglePlayback('attempt')}
                    >
                      {playbackTarget?.kind === 'attempt' && playback.playing ? <StopSquare size={13} /> : <Play size={13} />}
                      <span>{tr('Versuch', 'Attempt')}</span>
                    </button>
                  )}

                  {onOpenGameAt && (
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() => {
                        clearAdvanceTimer();
                        playback.reset();
                        onOpenGameAt(currentCard.game.id, move.ply);
                      }}
                    >
                      <ExternalLink size={13} />
                      <span>{tr('Partie', 'Game')}</span>
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  className="btn-primary training-deck-next-btn"
                  onClick={() => advance(feedback !== 'correct')}
                >
                  {tr('Nächste Karte', 'Next Card')}
                </button>
              </>
            )}
          </div>
        </aside>
      </div>
    </>
  );
};
