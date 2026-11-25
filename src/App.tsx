import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { Chess } from 'chess.js';
import { configureProfile, migrateProfileStorage } from './utils/profile';
import { isReliableGame, isReliableEvaluation, isReliableGameMove } from './utils/evaluationReliability';
import { appendVariation, variationPosition, type ReviewVariation } from './utils/reviewVariation';
import { ReviewVariationPanel } from './components/ReviewVariationPanel';
import { StorageStatus } from './components/StorageStatus';
import { GameAnalysis, AppSettings, PlayerStats, ArchiveItem, MissedIdea, OpeningFocus, APP_SETTINGS_DEFAULTS } from './types/chess';
import type { StatisticsFilter } from './types/statistics';
import { DEFAULT_STATISTICS_FILTER } from './utils/statisticsFilter';
import { resolvePlayerColor } from './utils/moveInsights';
import { replaceLearningStorage } from './utils/learningStorage';
import { setReviewSchedule } from './utils/reviews';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Chessboard } from './components/Chessboard';
import { CapturedPieces } from './components/CapturedPieces';
import { EvalBar } from './components/EvalBar';
import { EvalChart } from './components/EvalChart';
import { ReviewPanel } from './components/ReviewPanel';
import { TopMovesPanel } from './components/TopMovesPanel';
import { sounds } from './utils/sound';
import { reviewBadgeQuality, terminalEval } from './utils/analysis';
import { colorLabel, LanguageProvider, trStatic, turnToMoveLabel } from './utils/i18n';
import type { AiCoachMovePreview } from './utils/coachMoveLinks';
import { legalReviewTopMoves, matchingLiveReview, reviewBestArrow, reviewMoveBestArrow, reviewPosition, type LiveReviewEvaluation } from './utils/reviewPresentation';
import { capturedMaterial, capturedMaterialAfterLine, threatenedPieceArrows } from './utils/boardPresentation';
import {
  Sparkles,
  FolderKanban,
  Brain,
  Plus,
  Settings as SettingsIcon,
  Layers,
  BookOpen,
  Loader2,
} from 'lucide-react';

const DEFAULT_SETTINGS: AppSettings = APP_SETTINGS_DEFAULTS;
const LAST_OPENED_GAME_KEY = 'pca-last-opened-game-id';

function readLastOpenedGameId(): string | null {
  try {
    return localStorage.getItem(LAST_OPENED_GAME_KEY);
  } catch {
    return null;
  }
}

function persistLastOpenedGameId(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_OPENED_GAME_KEY, id);
    else localStorage.removeItem(LAST_OPENED_GAME_KEY);
  } catch {
    // Ignore restricted storage environments
  }
}

const PgnImportModal = lazy(() => import('./components/PgnImportModal').then(module => ({ default: module.PgnImportModal })));
const ChessComImportModal = lazy(() => import('./components/ChessComImportModal').then(module => ({ default: module.ChessComImportModal })));
const TrainingModal = lazy(() => import('./components/TrainingModal').then(module => ({ default: module.TrainingModal })));
const TrainingDeckView = lazy(() => import('./components/TrainingDeckView').then(module => ({ default: module.TrainingDeckView })));
const OpeningTrainerView = lazy(() => import('./components/OpeningTrainerView').then(module => ({ default: module.OpeningTrainerView })));
const ArchiveView = lazy(() => import('./components/ArchiveView').then(module => ({ default: module.ArchiveView })));
const AnalyticsDashboard = lazy(() => import('./components/AnalyticsDashboard').then(module => ({ default: module.AnalyticsDashboard })));
const StatisticsFilters = lazy(() => import('./components/PerformanceStatistics').then(module => ({ default: module.StatisticsFilters })));
const SettingsModal = lazy(() => import('./components/SettingsModal').then(module => ({ default: module.SettingsModal })));
const AiCoachPanel = lazy(() => import('./components/AiCoachPanel').then(module => ({ default: module.AiCoachPanel })));
const LoadingView: React.FC<{ children?: React.ReactNode }> = ({ children = 'Ansicht wird geladen …' }) => (
  <div role="status" className="loading-view">
    <Loader2 size={28} className="loading-view-spinner" aria-hidden="true" />
    <span>{children}</span>
  </div>
);

/** Phase 6: markJob-Signatur — identisch für chess.com- und Lichess-Pipeline. */
type PipelineMark = (
  id: string,
  patch: { savedDelta?: number; failedDelta?: number; cursorSet?: number; status?: 'queued' | 'analyzing' | 'saved' | 'failed' | 'cancelled'; lastError?: string },
) => Promise<unknown>;

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'review' | 'archive' | 'analytics' | 'training' | 'openings'>('review');
  const [currentGame, setCurrentGame] = useState<GameAnalysis | null>(null);
  const [currentPly, setCurrentPly] = useState<number>(0);
  const [isFlipped, setIsFlipped] = useState<boolean>(false);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [liveReview, setLiveReview] = useState<LiveReviewEvaluation | null>(null);
  const [topMovesPending, setTopMovesPending] = useState(false);
  const [variation, setVariation] = useState<ReviewVariation | null>(null);
  const [variationPlaying, setVariationPlaying] = useState(false);
  const [pipelinesPaused, setPipelinesPaused] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [isCompactViewport, setIsCompactViewport] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 768px)').matches
      : false
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 768px)');
    const update = () => setIsCompactViewport(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  const refreshGeneration = useRef(0);
  const statsLoadedKey = useRef('');
  const reviewEvaluationCache = useRef(new Map<string, LiveReviewEvaluation>());

  // Modals
  const [isImportOpen, setIsImportOpen] = useState<boolean>(false);
  const [reanalyzePgn, setReanalyzePgn] = useState<string | undefined>(undefined);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isTrainingOpen, setIsTrainingOpen] = useState<boolean>(false);
  const [isChessComOpen, setIsChessComOpen] = useState<boolean>(false);
  const [isAiCoachOpen, setIsAiCoachOpen] = useState<boolean>(false);
  const [aiCoachAnchorPly, setAiCoachAnchorPly] = useState<number>(0);
  const [aiCoachStartToken, setAiCoachStartToken] = useState<number>(0);
  const [aiCoachPreview, setAiCoachPreview] = useState<AiCoachMovePreview | null>(null);

  // Stored state
  const [gamesList, setGamesList] = useState<ArchiveItem[]>([]);
  const [trainingGames, setTrainingGames] = useState<GameAnalysis[]>([]);
  const [playerStats, setPlayerStats] = useState<PlayerStats | null>(null);
  const [statisticsFilter, setStatisticsFilter] = useState<StatisticsFilter>(DEFAULT_STATISTICS_FILTER);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [engineStatus, setEngineStatus] = useState<{ installed: boolean; path: string; engineName: string; ready?: boolean }>({
    installed: false,
    path: 'engine/stockfish.exe',
    engineName: 'Stockfish',
    ready: false,
  });

  const getElectron = () => {
    return window.electronAPI;
  };

  // Wurde die neueste Partie schon einmal automatisch geladen? (verhindert Reload-Schleifen)
  const autoLoadedRef = useRef(false);

  // Refresh DB and stats
  // Phase 6: Auto-Sync beim Start (Brief-Punkt 4) — einmalig nach dem ersten
  // Settings-Load; autoAnalyzeNewGames=false → keine analysierenden Jobs (nur
  // manuell), autoSyncOnStartup=false (Default) → gar nichts. knownIds-Dedup
  // verhindert Doppel-Partien, der Driver verarbeitet seriell (kein Sturm).
  const autoSyncStartedRef = useRef(false);
  const startAutoSyncIfConfigured = (appSettings: AppSettings): void => {
    if (!appSettings.autoSyncOnStartup || !appSettings.autoAnalyzeNewGames) return;
    const api = getElectron();
    const tasks: Promise<unknown>[] = [];
    const chessCom = appSettings.chessComUsername.trim();
    const lichessName = appSettings.lichessUsername.trim();
    if (chessCom && api?.chesscom.createJob) tasks.push(api.chesscom.createJob(chessCom, 30));
    if (lichessName && api?.lichess.createJob) tasks.push(api.lichess.createJob(lichessName, 30));
    if (!tasks.length) return;
    void Promise.allSettled(tasks).then(() => window.dispatchEvent(new Event('pca-pipeline-kick')));
  };

  // Phase 6: aktive Review-Leiter an die reviews-Utils binden — dieselbe
  // Konfiguration für alle Trainingsformate (Brief-Punkt 6).
  useEffect(() => {
    setReviewSchedule(settings.trainingSchedule);
  }, [settings.trainingSchedule]);

  const refreshData = useCallback(async () => {
    const api = getElectron();
    const generation = ++refreshGeneration.current;
    if (api) {
      try {
        const [appSettings, status] = await Promise.all([api.settings.get(), api.engine.getStatus()]);
        if (generation !== refreshGeneration.current) return;
        if (appSettings) {
          configureProfile(appSettings);
          try { migrateProfileStorage(appSettings); setProfileError(null); }
          catch { setProfileError('Vorhandener Lernstand konnte noch nicht ins stabile Profil übernommen werden. Bitte Speicher prüfen und Einstellungen erneut speichern. Die alten Einträge bleiben erhalten.'); }
          setSettings(appSettings);
          sounds.enabled = appSettings.soundEnabled ?? true;
          // Phase 6: Auto-Sync einmalig nach dem ersten Settings-Load
          if (!autoSyncStartedRef.current) {
            autoSyncStartedRef.current = true;
            startAutoSyncIfConfigured(appSettings);
          }
        }

        const playerName = appSettings?.playerName || APP_SETTINGS_DEFAULTS.playerName;
        if (status) {
          setEngineStatus(status);
        }
        const games = await api.db.getGames();
        if (generation !== refreshGeneration.current) return;
        setGamesList(games || []);
        setPlayerStats(null);
        setDataVersion(value => value + 1);
        setLoadError(null);

        // Auto-load the last opened/analyzed game (falling back to latest) once on startup
        if (!autoLoadedRef.current && games && games.length > 0) {
          autoLoadedRef.current = true;
          const savedLastId = readLastOpenedGameId();
          const preferredId = savedLastId && games.some((g) => g.id === savedLastId) ? savedLastId : games[0].id;
          const latest = await api.db.getGame(preferredId);
          if (generation !== refreshGeneration.current) return;
          if (latest) {
            setCurrentGame(latest);
            setCurrentPly(0);
            setIsFlipped(resolvePlayerColor(latest.white, latest.black, playerName, latest.site) === 'b');
          }
        }
      } catch (err) {
        console.error('Failed to load initial data:', err);
        if (generation === refreshGeneration.current) setLoadError('Das Archiv konnte nicht geladen werden.');
      }
    }
    if (generation === refreshGeneration.current) setInitialLoading(false);
  }, []);

  useEffect(() => {
    refreshData();
  }, [refreshData]);

  useEffect(() => {
    const api = getElectron();
    const onLanSyncApplied = () => {
      void refreshData();
    };
    window.addEventListener('pca-lan-sync-applied', onLanSyncApplied);
    const unsubscribeIpc = api?.lanSync?.onApplied?.((payload) => {
      try {
        replaceLearningStorage(payload.learningStorage);
      } catch (err) {
        console.error('Failed to persist LAN sync learning storage:', err);
      }
      window.dispatchEvent(new CustomEvent('pca-lan-sync-applied', { detail: payload.summary }));
    });
    return () => {
      window.removeEventListener('pca-lan-sync-applied', onLanSyncApplied);
      unsubscribeIpc?.();
    };
  }, [refreshData]);

  // Diagnostics are only needed when their tab is open; leaving cancels active calculation.
  useEffect(() => {
    const api = getElectron();
    if (activeTab !== 'analytics' || initialLoading || !api) return;
    const key = `${dataVersion}:${settings.playerName}:${settings.openingWindowMoves}:${JSON.stringify(statisticsFilter)}`;
    if (statsLoadedKey.current === key) { setStatsLoading(false); return; }
    let cancelled = false;
    setStatsLoading(true);
    setStatsError(null);
    const timer = window.setTimeout(() => {
      api.db.getPlayerStats(settings.playerName, statisticsFilter).then(stats => {
        if (!cancelled) { setPlayerStats(stats); statsLoadedKey.current = key; }
      }).catch((err: unknown) => {
        if (!cancelled && !(err instanceof DOMException && err.name === 'AbortError')) {
          setStatsError('Die Fehler-Diagnostik konnte nicht geladen werden. Öffne den Tab erneut, um es noch einmal zu versuchen.');
        }
      }).finally(() => { if (!cancelled) setStatsLoading(false); });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      setStatsLoading(false);
      void api.db.cancelPlayerStats?.().catch(() => {});
    };
  }, [activeTab, dataVersion, settings.playerName, settings.openingWindowMoves, statisticsFilter, initialLoading]);

  useEffect(() => {
    if (!currentGame) return;
    const color = resolvePlayerColor(currentGame.white, currentGame.black, settings.playerName, currentGame.site);
    if (color) setIsFlipped(color === 'b');
  }, [currentGame, settings]);

  const selectGamePly = (ply: number) => {
    setVariation(null);
    setVariationPlaying(false);
    setIsPlaying(false);
    setAiCoachPreview(null);
    setCurrentPly(ply);
  };
  const activeVariation = variation && variation.gameId === currentGame?.id && variation.anchorPly === currentPly ? variation : null;
  const exploreLine = (anchorPly: number, line: string[], label: string, autoplay = false, cursor = 1) => {
    if (!currentGame) return;
    const start = reviewPosition(currentGame, anchorPly);
    const valid = variationPosition(start.fen, line);
    if (!valid.steps.length) return;
    setIsPlaying(false); setCurrentPly(start.ply);
    setVariation({ gameId: currentGame.id, anchorPly: start.ply, returnPly: activeVariation?.returnPly ?? currentPly, line: valid.steps.map(step => step.uci), cursor: Math.min(cursor, valid.steps.length), label });
    setVariationPlaying(autoplay);
  };

  useEffect(() => {
    if (activeTab !== 'review' || isSettingsOpen || isImportOpen || isChessComOpen || isTrainingOpen) { setVariationPlaying(false); return; }
    if (!variationPlaying || !activeVariation) return;
    if (activeVariation.cursor >= activeVariation.line.length) { setVariationPlaying(false); return; }
    const timer = window.setTimeout(() => setVariation(previous => previous ? { ...previous, cursor: previous.cursor + 1 } : null), 1100);
    return () => window.clearTimeout(timer);
  }, [variationPlaying, activeVariation?.gameId, activeVariation?.anchorPly, activeVariation?.cursor, activeTab, isSettingsOpen, isImportOpen, isChessComOpen, isTrainingOpen]);

  useEffect(() => {
    if (activeTab !== 'training') return;
    const api = getElectron();
    if (!api) return;
    Promise.all((gamesList || []).map((game) => api.db.getGame(game.id)))
      .then((games: Array<GameAnalysis | null>) => setTrainingGames(games.filter((game): game is GameAnalysis => Boolean(game))))
      .catch(() => setTrainingGames([]));
  }, [activeTab, gamesList]);

  // Autoplay moves loop
  useEffect(() => {
    if (!isPlaying || !currentGame) return;

    const interval = setInterval(() => {
      setCurrentPly((prev) => {
        if (prev >= currentGame.moves.length) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, 1200);

    return () => clearInterval(interval);
  }, [isPlaying, currentGame]);

  // T20/T21: Autoplay stoppen bei Tab-/Modalwechsel — läuft sonst hinter
  // anderem Kontext weiter und erzeugt weitere Engine-Suchen.
  useEffect(() => {
    if (activeTab !== 'review' || isImportOpen || isChessComOpen || isSettingsOpen || isTrainingOpen) {
      if (isPlaying) setIsPlaying(false);
    }
    if (activeTab !== 'review' || !currentGame) {
      setIsAiCoachOpen(false);
      setAiCoachPreview(null);
    }
  }, [activeTab, currentGame, isImportOpen, isChessComOpen, isSettingsOpen, isTrainingOpen, isPlaying]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // T21: Shortcuts nur im richtigen Kontext — alle Modals blockieren,
      // fokussierte Eingabefelder/Selects ausnehmen, Space nicht mit
      // Button-Aktion kollidieren lassen.
      if (isImportOpen || isChessComOpen || isSettingsOpen || isTrainingOpen) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (target?.tagName === 'BUTTON' && e.key === ' ') return;
      if (activeTab !== 'review' || !currentGame) return;

      if (activeVariation && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(e.key)) {
        e.preventDefault();
        if (e.key === ' ') setVariationPlaying(playing => !playing);
        else {
          setVariationPlaying(false);
          setVariation(previous => previous ? { ...previous, cursor: e.key === 'Home' || e.key === 'ArrowUp' ? 0 : e.key === 'End' || e.key === 'ArrowDown' ? previous.line.length : Math.max(0, Math.min(previous.line.length, previous.cursor + (e.key === 'ArrowLeft' ? -1 : 1))) } : null);
        }
        return;
      }

      if (e.key === 'ArrowLeft') {
        setCurrentPly((p) => Math.max(0, p - 1));
      } else if (e.key === 'ArrowRight') {
        setCurrentPly((p) => Math.min(currentGame.moves.length, p + 1));
      } else if (e.key === 'ArrowUp' || e.key === 'Home') {
        setCurrentPly(0);
      } else if (e.key === 'ArrowDown' || e.key === 'End') {
        setCurrentPly(currentGame.moves.length);
      } else if (e.key === ' ') {
        e.preventDefault();
        setIsPlaying((p) => !p);
      } else if (e.key.toLowerCase() === 'f') {
        setIsFlipped((f) => !f);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTab, currentGame, activeVariation, isImportOpen, isChessComOpen, isSettingsOpen, isTrainingOpen]);

  // Android hardware back button handler: close overlays/variations/tabs cleanly before exiting
  useEffect(() => {
    const win = window as unknown as { __pcaHandleBack?: () => boolean };
    win.__pcaHandleBack = () => {
      if (isSettingsOpen) { setIsSettingsOpen(false); return true; }
      if (isImportOpen) { setIsImportOpen(false); setReanalyzePgn(undefined); return true; }
      if (isChessComOpen) { setIsChessComOpen(false); return true; }
      if (isTrainingOpen) { setIsTrainingOpen(false); return true; }
      if (activeTab === 'review' && variation) {
        setVariationPlaying(false);
        setVariation(null);
        return true;
      }
      if (activeTab !== 'review') {
        setActiveTab('review');
        return true;
      }
      return false;
    };
    return () => {
      delete win.__pcaHandleBack;
    };
  }, [activeTab, isSettingsOpen, isImportOpen, isChessComOpen, isTrainingOpen, variation]);

  // T20: Refresh bündeln — Batch-Import triggert nicht pro Partie ein volles Re-Read
  const refreshTimerRef = useRef<number | null>(null);
  const refreshSoon = () => {
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void refreshData();
    }, 700);
  };

  // Handle Game completion from PgnImportModal
  // R11: asynchroner Vertrag — der Save-Erfolg wird abgewartet, BEVOR Dialog
  // und Status umgestellt werden; bei Save-Fehlern wird geworfen, damit der
  // Importdialog den Fehler sichtbar macht, keinen Erfolg zählt und der
  // Archivstand unverändert bleibt (erneuter Save bleibt möglich).
  const handleAnalysisComplete = async (analyzedGame: GameAnalysis, closeAfter = true) => {
    // Save to local database — kanonisches Ergebnis nutzen: bei Reanalyse
    // ersetzt die neue Analyse den bestehenden Eintrag (stabile ID, T06);
    // das zurückgegebene Objekt enthält den konsolidierten createdAt-Zeitpunkt.
    const api = getElectron();
    let savedGame = analyzedGame;
    if (api) {
      savedGame = await api.db.saveGame(analyzedGame); // Fehler propagieren (R11)
      refreshSoon();
    }
    setCurrentGame(savedGame);
    persistLastOpenedGameId(savedGame.id);
    setVariation(null);
    setCurrentPly(0);
    if (closeAfter) {
      setIsImportOpen(false);
      setReanalyzePgn(undefined);
    }
    setActiveTab('review');

    // Automatically orient board to user's perspective
    // Phase 6: exakte Namenszuordnung (resolvePlayerColor) statt Substring —
    // fremde Partien mit ähnlichen Namen werden nicht falsch zugewiesen.
    setIsFlipped(resolvePlayerColor(analyzedGame.white, analyzedGame.black, settings.playerName.trim(), analyzedGame.site) === 'b');
  };

  // T16 + Phase 6: Pipeline-Driver — persistierte Jobs (chess.com UND Lichess,
  // je eigene jobs.json, geteilte Status-Maschine) seriell abarbeiten:
  // claim → je Partie Analyse + Save + markJob → 'saved'. Abbruch (Settings-
  // Wechsel/Unmount) requeued 'analyzing' (Guard in markJob) → Fortsetzung
  // beim nächsten Driver-Lauf bzw. App-Neustart (resumeStaleJobs). Ein
  // Analysefehler markiert 'failed', OHNE bereits gespeicherte Partien zu
  // verlieren (Cursor bleibt für den Retry in den Einstellungen).
  const [pipelineTick, setPipelineTick] = useState(0);
  // Phase 6: aktiver Job je Driver-Lauf — die mark-Referenz wird mitgespeichert,
  // damit der Cleanup-Requeue auf der RICHTIGEN Plattform landet (chess.com/Lichess).
  const refreshDataRef = useRef(refreshData);
  useEffect(() => {
    refreshDataRef.current = refreshData;
  });

  useEffect(() => {
    const kick = () => setPipelineTick((tick) => tick + 1);
    const pause = () => setPipelinesPaused(true);
    const resume = () => setPipelinesPaused(false);
    window.addEventListener('pca-pipeline-kick', kick);
    window.addEventListener('pca-pause-pipelines', pause);
    window.addEventListener('pca-resume-pipelines', resume);
    return () => { window.removeEventListener('pca-pipeline-kick', kick); window.removeEventListener('pca-pause-pipelines', pause); window.removeEventListener('pca-resume-pipelines', resume); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let activeJob: { id: string; mark: PipelineMark } | null = null;
    const drive = async () => {
      const api = getElectron();
      if (!api || pipelinesPaused || initialLoading || loadError) return;
      // Phase 6: beide Plattformen bedienen sich derselben Status-Maschine —
      // jeder claim/mark-Aufruf arbeitet auf seiner eigenen jobs.json (kein
      // geteilter Zustand). claimNextJob liefert null, wenn keine queued-Jobs
      // existieren → Plattform übersprungen, Weiter zur nächsten.
      const pipelineApis = [api.chesscom, api.lichess].filter((p) => !!p?.claimNextJob && !!p.markJob);
      for (const pipelineApi of pipelineApis) {
        for (;;) {
          if (cancelled) return;
          let job: Awaited<ReturnType<typeof pipelineApi.claimNextJob>> = null;
          try {
            job = await pipelineApi.claimNextJob();
          } catch {
            break; // IPC-Fehler — diese Plattform stilllegen, nächstes Event
          }
          if (!job) break;
          if (cancelled) { await pipelineApi.markJob(job.id, { status: 'queued' }).catch(() => undefined); return; }
          activeJob = { id: job.id, mark: pipelineApi.markJob as PipelineMark };
          try {
            const existingIds = new Set(await api.db.getStableGameIds());
            const { parsePgnMetadata } = await import('./utils/pgn');
            for (let index = job.cursor; index < job.games.length; index++) {
              if (cancelled) return; // Cleanup requeued den Job
              const entry = job.games[index];
              const stableId = parsePgnMetadata(entry.pgn).id;
              if (existingIds.has(stableId)) {
                const existing = await api.db.getGame(stableId);
                if (cancelled) return;
                if (existing && isReliableGame(existing)) {
                  await pipelineApi.markJob(job.id, { cursorSet: index + 1 });
                  continue;
                }
              }
              const { analyzePgnGame } = await import('./utils/analyzeGame');
              if (cancelled) return;
              const analysis = await analyzePgnGame(entry.pgn, settings.engineDepth, undefined, () => cancelled);
              if (cancelled) return;
              if (entry.playedAt) analysis.playedAt = entry.playedAt;
              await api.db.saveGame(analysis);
              await pipelineApi.markJob(job.id, { savedDelta: 1, cursorSet: index + 1 });
            }
            await pipelineApi.markJob(job.id, { status: 'saved' });
            void refreshDataRef.current();
          } catch (err) {
            if (cancelled) return;
            void pipelineApi
              .markJob(job.id, { status: 'failed', lastError: err instanceof Error ? err.message : String(err) })
              .catch(() => undefined);
            break; // kein Endlos-Retry — Retry-Aktion in den Einstellungen
          } finally {
            activeJob = null;
          }
        }
      }
    };
    void drive();
    return () => {
      cancelled = true;
      const active = activeJob;
      if (active) {
        // Requeue nur aus 'analyzing' erlaubt (markJob-Guard) — fertige/failed Jobs unberührt.
        void active.mark(active.id, { status: 'queued' })?.catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineTick, settings.engineDepth, pipelinesPaused, initialLoading, loadError]);

  const handleReanalyze = () => {
    if (!currentGame) return;
    setReanalyzePgn(currentGame.pgn);
    setIsImportOpen(true);
  };

  // T18: Diagnostik → gefiltertes Training (Motiv/Eröffnung)
  const [trainingFilter, setTrainingFilter] = useState<{ motif?: MissedIdea; openingFocus?: OpeningFocus; openingWindowMoves?: number; statisticsFilter?: StatisticsFilter } | null>(null);
  const [openingTrainingFocus, setOpeningTrainingFocus] = useState<OpeningFocus | null>(null);
  const handleTrainMotif = (idea: MissedIdea) => {
    setTrainingFilter({ motif: idea, statisticsFilter });
    setActiveTab('training');
  };
  const handleTrainOpeningErrors = (focus: OpeningFocus, windowMoves: number) => {
    setTrainingFilter({ openingFocus: focus, openingWindowMoves: windowMoves, statisticsFilter });
    setActiveTab('training');
  };
  const handleTrainOpeningResponses = (focus: OpeningFocus) => {
    setOpeningTrainingFocus(focus);
    setActiveTab('openings');
  };
  const handleOpeningWindowChange = async (openingWindowMoves: number) => {
    const api = getElectron();
    if (!api) throw Error('Einstellungen sind nur in der Desktop-App verfügbar.');
    const updated = await api.settings.save({ openingWindowMoves });
    configureProfile(updated);
    setSettings(updated);
    setPlayerStats(null);
  };

  // Open game from archive (T18: startPly — Diagnose öffnet die Position VOR dem Fehler)
  const handleOpenGame = async (id: string, startPly = 0) => {
    const api = getElectron();
    if (api) {
      const fullGame = await api.db.getGame(id);
      if (fullGame) {
        setCurrentGame(fullGame);
        persistLastOpenedGameId(fullGame.id);
        setVariation(null); setVariationPlaying(false); setIsPlaying(false);
        setCurrentPly(startPly);
        setIsFlipped(resolvePlayerColor(fullGame.white, fullGame.black, settings.playerName.trim(), fullGame.site) === 'b');
        setActiveTab('review');
      }
    }
  };

  // Delete game from archive
  const handleDeleteGame = async (id: string) => {
    const api = getElectron();
    if (api) {
      await api.db.deleteGame(id);
      if (currentGame?.id === id) {
        setCurrentGame(null);
        persistLastOpenedGameId(null);
      }
      refreshData();
    }
  };

  // Settings Save
  const handleSaveSettings = async (newSettings: Partial<AppSettings>) => {
    const api = getElectron();
    if (api) {
      const updated = await api.settings.save(newSettings);
      configureProfile(updated);
      migrateProfileStorage(updated);
      setSettings(updated);
      sounds.enabled = updated.soundEnabled ?? true;
      refreshData();
    }
  };

  // Current position on board
  const position = reviewPosition(currentGame, currentPly);
  const branchPosition = activeVariation ? variationPosition(position.fen, activeVariation.line, activeVariation.cursor) : null;
  const currentFen = branchPosition?.fen || position.fen;
  const reviewHistory = [...(currentGame?.moves.slice(0, position.ply).map(move => move.uci) || []), ...(activeVariation?.line.slice(0, branchPosition?.cursor || 0) || [])];
  const engineContext = `${currentGame?.id}|${reviewHistory.join(',')}`;

  useEffect(() => { reviewEvaluationCache.current.clear(); }, [currentGame, settings.stockfishPath]);

  useEffect(() => {
    const api = getElectron();
    if (!api || !currentGame || activeTab !== 'review' || isSettingsOpen || isImportOpen || isChessComOpen || isTrainingOpen) {
      setLiveReview(null);
      setTopMovesPending(false);
      return;
    }

    // T20: 50 schnelle Zugwechsel → keine 50 nutzlosen Suchen: Anfrage erst
    // 250ms nach dem letzten Positionswechsel stellen (Coalescing), veraltete
    // Antworten verwerfen (cancelled).
    let cancelled = false;
    const requestId = 'review-' + crypto.randomUUID();
    setLiveReview(null);
    setTopMovesPending(true);
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      api.engine.evaluateFenMultiPv(currentGame.moves[0]?.fenBefore || currentFen, settings.engineDepth, 3,
        reviewHistory, currentFen, { requestId })
        .then(result => {
          if (!cancelled) {
            const value = { ...result, moves: result.moves || [], gameId: currentGame.id, fen: currentFen, requestedDepth: settings.engineDepth, contextKey: engineContext };
            reviewEvaluationCache.current.set(`${settings.engineDepth}:${engineContext}`, value);
            if (reviewEvaluationCache.current.size > 120) reviewEvaluationCache.current.delete(reviewEvaluationCache.current.keys().next().value!);
            setLiveReview(value);
          }
        })
        .catch(() => {
          if (!cancelled) setLiveReview(null);
        })
        .finally(() => {
          if (!cancelled) setTopMovesPending(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      void api.engine.cancelRequest?.(requestId).catch(() => {});
    };
  }, [currentFen, currentGame, engineContext, settings.engineDepth, activeTab, isSettingsOpen, isImportOpen, isChessComOpen, isTrainingOpen]);

  const currentMove = position.move;
  const currentLive = matchingLiveReview(liveReview, currentGame?.id, currentFen, settings.engineDepth, engineContext);
  const topMoves = legalReviewTopMoves(currentFen, currentLive);
  // Gate by position synchronously: no old list during the 250ms debounce window.
  const topMovesLoading = topMovesPending || Boolean(liveReview && !currentLive && liveReview.fen !== currentFen);

  const lastMoveHighlight = branchPosition ? branchPosition.lastMove : currentMove
    ? {
        from: currentMove.from,
        to: currentMove.to,
        quality: !!currentGame && isReliableGameMove(currentGame, currentMove) ? reviewBadgeQuality(currentMove) : undefined,
        engineQuality: currentMove.quality,
      }
    : null;

  const currentPositionEval = currentLive || (branchPosition ? terminalEval(branchPosition.board) : position.evaluation);
  // The green arrow reviews the move that just appeared with its quality badge.
  // Current-position searches still drive the bar/Top 3, never this comparison.
  const branchBefore = activeVariation && branchPosition && branchPosition.cursor > 0
    ? variationPosition(position.fen, activeVariation.line, branchPosition.cursor - 1) : null;
  const beforeContext = `${currentGame?.id}|${reviewHistory.slice(0, -1).join(',')}`;
  const branchBeforeLive = branchBefore ? matchingLiveReview(reviewEvaluationCache.current.get(`${settings.engineDepth}:${beforeContext}`) || null,
    currentGame?.id, branchBefore.fen, settings.engineDepth, beforeContext) : null;
  const branchBeforeSaved = branchPosition?.cursor === 1 ? position.evaluation : undefined;
  const bestMoveArrow = currentGame && settings.showBestMoveArrows !== false
    ? branchBefore ? reviewBestArrow(branchBefore.fen,
      isReliableEvaluation(branchBeforeSaved) ? branchBeforeSaved : undefined,
      branchBeforeLive && isReliableEvaluation(branchBeforeLive) ? branchBeforeLive : null)
      : reviewMoveBestArrow(currentMove)
    : null;
  const reviewedStep = branchPosition?.lastMove;
  const reviewedColor = reviewedStep?.color || currentMove?.color;
  const bestArrowLabel = `Engine-Bestzug zu ${reviewedStep?.number || currentMove?.moveNumber}${reviewedColor === 'b' ? '...' : '.'} ${reviewedStep?.san || currentMove?.san} · ${reviewedColor === 'b' ? 'Schwarz' : 'Weiß'}`;
  const threatArrows = currentGame && settings.showThreatArrows !== false
    ? threatenedPieceArrows(currentFen)
    : [];
  const captures = currentGame ? activeVariation ? capturedMaterialAfterLine(currentGame.moves, currentPly, position.fen, activeVariation.line.slice(0, branchPosition?.cursor || 0)) : capturedMaterial(currentGame.moves, currentPly) : null;
  const currentScoreCp = currentPositionEval?.scoreCp || 0;
  const currentMate = currentPositionEval?.mate;
  const lang = settings.language === 'en' ? 'en' : 'de';
  const tr = (de: string, en: string) => trStatic(de, en, lang);
  const canUseAiCoach =
    typeof window !== 'undefined' &&
    Boolean(window.electronAPI?.aiCoach) &&
    !window.electronAPI?.isMobile &&
    !isCompactViewport;

  return (
    <LanguageProvider language={lang}>
    <div className="app-container">
      {/* Top Navigation */}
      <header className="top-nav">
        <div className="brand-section">
          <div className="brand-title">
            <img src="./app-icon.png" alt="" className="brand-logo-img" width={26} height={26} />
            <span>Chess Analyzer</span>
          </div>
          <span className="brand-badge">{settings.playerName}</span>
        </div>

        {/* Navigation Tabs */}
        <nav className="nav-links">
          <button
            className={`nav-btn ${activeTab === 'review' ? 'active' : ''}`}
            onClick={() => setActiveTab('review')}
          >
            <Sparkles size={16} />
            <span>{tr('Partie Review', 'Game Review')}</span>
          </button>
          <button
            className={`nav-btn ${activeTab === 'archive' ? 'active' : ''}`}
            onClick={() => setActiveTab('archive')}
          >
            <FolderKanban size={16} />
            <span>{tr('Archiv', 'Archive')} ({gamesList.length})</span>
          </button>
          <button
            className={`nav-btn ${activeTab === 'analytics' ? 'active' : ''}`}
            onClick={() => setActiveTab('analytics')}
          >
            <Brain size={16} />
            <span>{tr('Fehler-Diagnostik', 'Diagnostics')}</span>
          </button>
          <button
            className={`nav-btn ${activeTab === 'training' ? 'active' : ''}`}
            onClick={() => setActiveTab('training')}
          >
            <Layers size={16} />
            <span>{tr('Fehlerkarten', 'Mistake Cards')}</span>
          </button>
          <button
            className={`nav-btn ${activeTab === 'openings' ? 'active' : ''}`}
            onClick={() => setActiveTab('openings')}
          >
            <BookOpen size={16} />
            <span>{tr('Eröffnungen', 'Openings')}</span>
          </button>
        </nav>

        {/* Right Tools */}
        <div className="nav-right">
          {/* Stockfish Status Pill */}
          <div className="engine-status-pill" title={`${tr('Stockfish UCI Pfad', 'Stockfish UCI Path')}: ${engineStatus.path}`}>
            {/* T01: installed (Binary vorhanden) und ready (Prozess handshake ok) getrennt */}
            <span className={`engine-status-dot ${engineStatus.ready ? 'ready' : engineStatus.installed ? 'warning' : 'error'}`} />
            <span>
              {engineStatus.ready
                ? engineStatus.engineName
                : engineStatus.installed
                  ? `${engineStatus.engineName} (${tr('startet bei Bedarf', 'starts on demand')})`
                  : tr('Keine Engine installiert', 'No engine installed')}
            </span>
          </div>

          {(activeTab === 'review' || activeTab === 'archive') && (
            <button className="btn-primary" onClick={() => setIsImportOpen(true)} style={{ padding: '7px 14px' }}>
              <Plus size={16} />
              <span>{tr('Neue Partie laden', 'Load New Game')}</span>
            </button>
          )}

          <button className="btn-icon" onClick={() => setIsSettingsOpen(true)} title={tr('Einstellungen', 'Settings')}>
            <SettingsIcon size={18} />
          </button>
        </div>
      </header>
      <StorageStatus />
      {profileError && <div className="storage-status" role="alert">{profileError}</div>}

      {/* Main Content Workspace */}
      <main className="workspace" data-active-tab={activeTab}>
        <ErrorBoundary key={activeTab}>
        <Suspense fallback={<LoadingView>{tr('Ansicht wird geladen …', 'Loading view …')}</LoadingView>}>
        {activeTab === 'review' && (
          !currentGame && initialLoading ? <LoadingView>{tr('Archiv wird geladen …', 'Loading archive …')}</LoadingView> : !currentGame && loadError ? <div role="alert"><p>{loadError}</p><button className="btn-secondary" onClick={() => void refreshData()}>{tr('Erneut versuchen', 'Try again')}</button></div> : currentGame ? (
            <div className="review-layout">
              {isCompactViewport && (
                <>
                  <div className="review-horizontal-eval">
                    <EvalBar
                      orientation="horizontal"
                      resetKey={currentGame.id}
                      scoreCp={currentScoreCp}
                      mate={currentMate}
                      isFlipped={isFlipped}
                      unavailable={!currentPositionEval}
                    />
                  </div>
                  <div className="review-mobile-eval-chart">
                    <EvalChart
                      moves={currentGame.moves}
                      currentPly={currentPly}
                      onSelectPly={selectGamePly}
                      compact
                    />
                  </div>
                </>
              )}
              {/* Left Board Column */}
              {(() => {
                const activeAiPreview = isAiCoachOpen && canUseAiCoach ? aiCoachPreview : null;
                const displayBoardFen = activeAiPreview ? activeAiPreview.fenAfter : currentFen;
                const displayTurnColor = displayBoardFen.split(' ')[1] === 'b' ? 'b' : 'w';
                return (
              <div className="board-column">
                <div className="board-stage">
                  <div className="board-player-row board-player-top">
                    <div className="board-player-label">
                      <strong>{isFlipped ? currentGame.white : currentGame.black}</strong>
                      {displayTurnColor === (isFlipped ? 'w' : 'b') ? (
                        <span className={`turn-indicator-pill is-compact ${isFlipped ? 'is-white' : 'is-black'}`}>
                          <i className="turn-indicator-swatch" aria-hidden="true" />
                          {turnToMoveLabel(isFlipped ? 'w' : 'b', lang)}
                        </span>
                      ) : (
                        <span>{colorLabel(isFlipped ? 'w' : 'b', lang)}</span>
                      )}
                    </div>
                    {captures && <CapturedPieces color={isFlipped ? 'w' : 'b'} pieces={isFlipped ? captures.byWhite : captures.byBlack} lead={isFlipped ? captures.whiteLead : captures.blackLead} />}
                  </div>
                  <div className="board-play-area">
                    {!isCompactViewport && (
                      <EvalBar
                        orientation="vertical"
                        resetKey={currentGame.id}
                        scoreCp={currentScoreCp}
                        mate={currentMate}
                        isFlipped={isFlipped}
                        unavailable={!currentPositionEval}
                      />
                    )}
                    <Chessboard
                      fen={displayBoardFen}
                      isFlipped={isFlipped}
                      lastMove={activeAiPreview ? { from: activeAiPreview.from, to: activeAiPreview.to } : lastMoveHighlight}
                      bestMoveArrow={activeAiPreview ? null : bestMoveArrow}
                      threatArrows={activeAiPreview ? [] : threatArrows}
                      previewArrow={activeAiPreview ? { from: activeAiPreview.from, to: activeAiPreview.to } : null}
                      interactive={true}
                      onMove={move => {
                        if (!currentGame) return;
                        setAiCoachPreview(null);
                        const base = activeVariation || { gameId: currentGame.id, anchorPly: position.ply, returnPly: currentPly, line: [], cursor: 0, label: tr('Eigene Variante', 'Custom line') };
                        const next = appendVariation(position.fen, base, move.from + move.to + (move.promotion || ''));
                        if (next) { setIsPlaying(false); setVariationPlaying(false); setVariation(next); }
                      }}
                    />
                  </div>
                  <div className="board-player-row board-player-bottom">
                    <div className="board-player-label">
                      <strong>{isFlipped ? currentGame.black : currentGame.white}</strong>
                      {displayTurnColor === (isFlipped ? 'b' : 'w') ? (
                        <span className={`turn-indicator-pill is-compact ${isFlipped ? 'is-black' : 'is-white'}`}>
                          <i className="turn-indicator-swatch" aria-hidden="true" />
                          {turnToMoveLabel(isFlipped ? 'b' : 'w', lang)}
                        </span>
                      ) : (
                        <span>{colorLabel(isFlipped ? 'b' : 'w', lang)}</span>
                      )}
                    </div>
                    {captures && <CapturedPieces color={isFlipped ? 'b' : 'w'} pieces={isFlipped ? captures.byBlack : captures.byWhite} lead={isFlipped ? captures.blackLead : captures.whiteLead} />}
                  </div>
                  {(activeAiPreview || bestMoveArrow || threatArrows.length > 0) && (
                    <div className="board-arrow-legend" aria-label={tr('Bedeutung der Pfeile', 'Arrow legend')}>
                      {activeAiPreview ? (
                        <span>
                          <i className="board-arrow-legend-preview" aria-hidden="true" />{' '}
                          {tr(
                            `Vorschau: ${activeAiPreview.label} (${activeAiPreview.from} → ${activeAiPreview.to})`,
                            `Preview: ${activeAiPreview.label} (${activeAiPreview.from} → ${activeAiPreview.to})`,
                          )}
                        </span>
                      ) : (
                        <>
                          {bestMoveArrow && <span title={tr('Beste Möglichkeit für den gerade gespielten Zug. Der Pfeil bezieht sich auf die Stellung vor diesem Zug.', 'Engine best move for the position before the played move.')}><i className="board-arrow-legend-green" aria-hidden="true" /> {`${tr('Engine-Bestzug zu', 'Engine best move for')} ${reviewedStep?.number || currentMove?.moveNumber}${reviewedColor === 'b' ? '...' : '.'} ${reviewedStep?.san || currentMove?.san} · ${colorLabel(reviewedColor === 'b' ? 'b' : 'w', lang)}`}</span>}
                          {threatArrows.length > 0 && <span title={tr('Legale mögliche Schläge des Gegners und Schachgebote; keine Behauptung einer erzwungenen Variante.', 'Legal opponent captures and checks; not necessarily forced.')}><i className="board-arrow-legend-orange" aria-hidden="true" /> {tr('Mögliche gegnerische Bedrohung', 'Possible opponent threat')}</span>}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
                );
              })()}

              <div className={`right-side-column ${isAiCoachOpen && canUseAiCoach ? 'is-ai-coach-mode' : ''}`}>
                <ReviewVariationPanel variation={activeVariation} anchorFen={position.fen}
                  onCursor={cursor => { setVariationPlaying(false); setVariation(previous => previous ? { ...previous, cursor } : null); }}
                  onReturn={() => { setVariationPlaying(false); if (activeVariation) setCurrentPly(activeVariation.returnPly ?? activeVariation.anchorPly); setVariation(null); }} playing={variationPlaying}
                  onTogglePlay={() => { if (activeVariation?.cursor === activeVariation?.line.length) setVariation(previous => previous ? { ...previous, cursor: 0 } : null); setVariationPlaying(playing => !playing); }} />
                {isAiCoachOpen && canUseAiCoach ? (
                  <AiCoachPanel
                    game={currentGame}
                    currentPly={currentPly}
                    anchorPly={aiCoachAnchorPly}
                    currentFen={currentFen}
                    targetPlayer={settings.playerName}
                    autoStartToken={aiCoachStartToken}
                    onBackToMainReview={() => {
                      setIsAiCoachOpen(false);
                      setAiCoachPreview(null);
                    }}
                    onSelectPly={selectGamePly}
                    onReanchorToPly={nextPly => {
                      setAiCoachPreview(null);
                      setAiCoachAnchorPly(nextPly);
                      setAiCoachStartToken(token => token + 1);
                    }}
                    onFlipBoard={() => setIsFlipped((f) => !f)}
                    onExplore={exploreLine}
                    onPreviewMove={setAiCoachPreview}
                  />
                ) : (
                  <>
                    {!isCompactViewport && (
                      <div className="review-tools-column review-tools-desktop">
                        <TopMovesPanel
                          fen={currentFen}
                          topMoves={topMoves}
                          isLoading={topMovesLoading}
                          depth={currentLive?.actualDepth ?? currentLive?.depth ?? 0}
                          provisional={!!currentPositionEval && !isReliableEvaluation(currentPositionEval)}
                          evaluationAvailable={!!currentPositionEval}
                          currentEvalCp={currentScoreCp}
                          currentEvalMate={currentMate}
                          onPlayLine={line => exploreLine(currentPly, [...(activeVariation?.line.slice(0, branchPosition?.cursor || 0) || []), ...line], 'Enginevariante', false, (branchPosition?.cursor || 0) + 1)}
                        />
                        {!activeVariation && <EvalChart
                          moves={currentGame.moves}
                          currentPly={currentPly}
                          onSelectPly={selectGamePly}
                        />}
                      </div>
                    )}
                    <ReviewPanel
                      game={currentGame}
                      targetPlayer={settings.playerName}
                      currentPly={currentPly}
                      onSelectPly={selectGamePly}
                      onExplore={exploreLine}
                      onFlipBoard={() => setIsFlipped((f) => !f)}
                      onStartTraining={() => setIsTrainingOpen(true)}
                      isPlaying={isPlaying}
                      onTogglePlay={() => { if (activeVariation) setCurrentPly(activeVariation.returnPly ?? activeVariation.anchorPly); setVariation(null); setVariationPlaying(false); setIsPlaying((p) => !p); }}
                      onReanalyze={handleReanalyze}
                      onAskAiCoach={canUseAiCoach ? () => {
                        setAiCoachAnchorPly(currentPly);
                        setIsAiCoachOpen(true);
                        setAiCoachStartToken(token => token + 1);
                      } : undefined}
                      onToggleAiCoach={canUseAiCoach ? () => {
                        if (isAiCoachOpen) {
                          setIsAiCoachOpen(false);
                        } else {
                          setAiCoachAnchorPly(currentPly);
                          setIsAiCoachOpen(true);
                          setAiCoachStartToken(token => token + 1);
                        }
                      } : undefined}
                      isAiCoachOpen={isAiCoachOpen}
                      isCompactLayout={isCompactViewport}
                      topMovesNode={
                        <TopMovesPanel
                          fen={currentFen}
                          topMoves={topMoves}
                          isLoading={topMovesLoading}
                          depth={currentLive?.actualDepth ?? currentLive?.depth ?? 0}
                          provisional={!!currentPositionEval && !isReliableEvaluation(currentPositionEval)}
                          evaluationAvailable={!!currentPositionEval}
                          currentEvalCp={currentScoreCp}
                          currentEvalMate={currentMate}
                          onPlayLine={line => exploreLine(currentPly, [...(activeVariation?.line.slice(0, branchPosition?.cursor || 0) || []), ...line], 'Enginevariante', false, (branchPosition?.cursor || 0) + 1)}
                        />
                      }
                      evalChartNode={
                        !activeVariation ? (
                          <EvalChart
                            moves={currentGame.moves}
                            currentPly={currentPly}
                            onSelectPly={selectGamePly}
                          />
                        ) : null
                      }
                    />
                  </>
                )}
              </div>
            </div>
          ) : (
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#a8a6a0',
              }}
            >
              <img src="./app-icon.png" alt="" width={72} height={72} style={{ marginBottom: '16px', borderRadius: '16px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }} />
              <h2 style={{ color: '#ffffff', marginBottom: '8px' }}>{tr('Willkommen beim Personal Chess Analyzer', 'Welcome to Personal Chess Analyzer')}</h2>
              <p style={{ maxWidth: '440px', textAlign: 'center', lineHeight: '1.5', marginBottom: '20px' }}>
                {tr(
                  'Hinterlege deine Chess.com- und Lichess-Namen in den Einstellungen. So erkennt die App deine Züge und erstellt passende Fehlerkarten. Du kannst auch direkt eine PGN importieren.',
                  'Add your Chess.com or Lichess usernames in Settings so the app recognizes your moves and creates mistake cards automatically, or import a PGN directly.',
                )}
              </p>
              <button className="btn-secondary" onClick={() => setIsSettingsOpen(true)} style={{ marginBottom: '12px' }}>{tr('Konten und Engine einrichten', 'Set up accounts and engine')}</button>
              {!engineStatus.installed && <p style={{ maxWidth: '440px', textAlign: 'center', marginBottom: '12px' }}>{tr('Stockfish fehlt. Wähle in den Einstellungen die Engine-Datei, bevor du analysierst.', 'Stockfish is missing. Select your engine executable in Settings before analyzing.')}</p>}
              <button className="btn-primary" onClick={() => setIsImportOpen(true)} style={{ padding: '12px 24px' }}>
                <Plus size={18} />
                <span>{tr('Erste Partie importieren', 'Import first game')}</span>
              </button>
            </div>
          )
        )}

        {activeTab === 'archive' && (
          <ArchiveView
            games={gamesList}
            onOpenGame={handleOpenGame}
            onDeleteGame={handleDeleteGame}
            onNewImport={() => setIsImportOpen(true)}
            onChessComImport={() => setIsChessComOpen(true)}
            targetPlayer={settings.playerName}
            engineDepth={settings.engineDepth}
            onArchiveUpdated={() => void refreshData()}
          />
        )}

        {activeTab === 'analytics' && <div className="analytics-page">
          <StatisticsFilters filter={statisticsFilter} busy={statsLoading} onChange={value => { setStatisticsFilter(value); setPlayerStats(null); }} />
          {statsLoading || initialLoading || (!playerStats && !statsError) ? <LoadingView>{tr('Fehler-Diagnostik wird berechnet …', 'Computing diagnostics …')}</LoadingView> : statsError ? <div role="alert">{statsError}</div> : (
          <AnalyticsDashboard
            stats={playerStats}
            targetPlayer={settings.playerName}
            onOpenGameAt={(gameId, ply) => void handleOpenGame(gameId, ply)}
            onTrainMotif={handleTrainMotif}
            onOpeningErrors={handleTrainOpeningErrors}
            onOpeningResponses={handleTrainOpeningResponses}
            onOpeningWindowChange={handleOpeningWindowChange}
          />
        )}</div>}

        {activeTab === 'training' && (
          <TrainingDeckView
            games={trainingGames}
            targetPlayer={settings.playerName}
            motifFilter={trainingFilter?.motif ?? null}
            openingFocus={trainingFilter?.openingFocus ?? null}
            openingWindowMoves={trainingFilter?.openingWindowMoves}
            statisticsFilter={trainingFilter?.statisticsFilter}
            onClearFilter={() => setTrainingFilter(null)}
            onOpenGameAt={(gameId, ply) => void handleOpenGame(gameId, ply)}
          />
        )}

        {activeTab === 'openings' && <OpeningTrainerView targetPlayer={settings.playerName} focus={openingTrainingFocus}
          depth={settings.engineDepth} onClearFocus={() => setOpeningTrainingFocus(null)} />}
        </Suspense>
        </ErrorBoundary>
      </main>

      {/* Modals */}
      <Suspense fallback={null}>
      {isImportOpen && (
        <PgnImportModal
          initialPgn={reanalyzePgn}
          onClose={() => { setIsImportOpen(false); setReanalyzePgn(undefined); }}
          onAnalysisComplete={handleAnalysisComplete}
          onOpenExistingGame={handleOpenGame}
          defaultPlayerName={settings.chessComUsername || settings.playerName}
          defaultDepth={settings.engineDepth}
        />
      )}

      {isTrainingOpen && currentGame && (
        <TrainingModal
          game={currentGame}
          targetPlayer={settings.playerName}
          onClose={() => setIsTrainingOpen(false)}
        />
      )}

      {isChessComOpen && (
        <ChessComImportModal
          playerName={settings.chessComUsername || settings.playerName}
          depth={settings.engineDepth}
          onClose={() => setIsChessComOpen(false)}
          onGamesSaved={(lastGame) => {
            if (lastGame) {
              setCurrentGame(lastGame);
              persistLastOpenedGameId(lastGame.id);
              setCurrentPly(0);
            }
            refreshData();
          }}
        />
      )}

      {isSettingsOpen && (
        <SettingsModal
          settings={settings}
          engineStatus={engineStatus}
          onClose={() => setIsSettingsOpen(false)}
          onSave={handleSaveSettings}
          onOpenEngineFolder={() => getElectron()?.engine.openEngineFolder()}
          onSelectStockfishFile={async () => {
            const chosen = (await getElectron()?.engine.selectStockfishFile()) ?? null;
            if (chosen) refreshData();
            return chosen;
          }}
        />
      )}
      </Suspense>
    </div>
    </LanguageProvider>
  );
};
