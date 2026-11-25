export type MoveQuality = 
  | 'brilliant' 
  | 'great' 
  | 'best' 
  | 'excellent' 
  | 'good' 
  | 'book' 
  | 'inaccuracy' 
  | 'mistake' 
  | 'blunder' 
  | 'miss';

export interface QualitySummary {
  brilliant: number;
  great: number;
  best: number;
  excellent: number;
  good: number;
  book: number;
  inaccuracy: number;
  mistake: number;
  blunder: number;
  miss: number;
}

export type MissedIdea = 'mate' | 'capture' | 'fork' | 'check' | 'quiet';

export interface EngineEvalResult {
  scoreCp: number;      // Always from White's perspective (+ = White advantage)
  mate?: number;        // Mate in X (+ = White wins, - = Black wins)
  bestMoveUci: string;
  bestMoveSan?: string;
  pv: string[];
  depth: number;
  /** Tatsächlich erreichte Suchtiefe (kann bei Timeouts unter `depth` liegen). */
  actualDepth?: number;
  /** Score-Güte: 'lower'/'upper' bei vorzeitig abgebrochenen Suchen. */
  bound?: 'exact' | 'lower' | 'upper';
  /**
   * Herkunft des Ergebnisses (T03): 'complete' = bestmove erhalten,
   * 'partial' = abgebrochen mit Teildaten, 'unavailable' = keine Engine.
   * Fehlt das Feld (alte Datensätze), gilt 'complete'.
   */
  status?: 'complete' | 'partial' | 'unavailable';
}

/** Optional budgets for explicit, cancellable explanation searches. */
export interface EngineSearchOptions {
  requestId?: string;
  maxTimeMs?: number;
  deadlineAt?: number;
  searchMoves?: string[];
}

export interface MoveAnalysis {
  ply: number;
  moveNumber: number;
  color: 'w' | 'b';
  san: string;
  uci: string;
  from: string;
  to: string;
  piece: string;
  captured?: string;
  isCheck: boolean;
  isCheckmate: boolean;
  /** Exactly one legal move existed before this move; no decision to penalize. */
  isForced?: boolean;
  fenBefore: string;
  fenAfter: string;
  evalBefore: EngineEvalResult;
  evalAfter: EngineEvalResult;
  winChanceBefore: number;  // 0 - 100% from player's perspective
  winChanceAfter: number;   // 0 - 100% from player's perspective
  winChanceDrop: number;    // drop in win% caused by this move
  quality: MoveQuality;
  comment?: string;
  /** Eröffnungstheorie-Name dieser Stellung (getrennt von quality, T04). */
  openingAnnotation?: string;
  /** Nachweis der lokalen, konservativen Figurenopfer-Erkennung. */
  brilliantEvidence?: BrilliantEvidence;
  missedOpportunity?: MissedOpportunity;
}

export interface MissedOpportunity {
  version: number;
  kind: 'mate' | 'material';
  bestMoveUci: string;
  bestSan: string;
  bestLine: string[];
  materialGain?: number;
  description: string;
  depth: number;
}

export interface BrilliantEvidence {
  version: number;
  piece: string;
  square: string;
  materialInvestment: number;
  acceptingMoveUci: string;
  acceptedEval: EngineEvalResult;
  playedScoreCp: number;
  playedMate?: number;
  alternativeUci: string;
  alternativeScoreCp: number;
  alternativeMate?: number;
  depth: number;
}

export interface GameMetadata {
  id: string;
  createdAt: string;
  /** Actual play time; never the import time. */
  playedAt?: string;
  event?: string;
  site?: string;
  date?: string;
  white: string;
  black: string;
  result: string;
  whiteElo?: string;
  blackElo?: string;
  eco?: string;
  openingName?: string;
  timeControl?: string;
  /** T13: API-Zeitklasse (chess.com time_class) — Vorrang vor Ableitung aus TimeControl. */
  timeClass?: string;
}

export interface GameAnalysis extends GameMetadata {
  pgn: string;
  /** Version der Bewertungs-/POV-Pipeline; ältere Daten können repariert werden. */
  analysisVersion?: number;
  accuracyWhite: number;
  accuracyBlack: number;
  summaryWhite: QualitySummary;
  summaryBlack: QualitySummary;
  moves: MoveAnalysis[];
  /** T03: true, wenn mindestens ein Zug nur Teildaten (Timeout/Crash) hat. */
  analysisPartial?: boolean;
  /** R07: frühere IDs (Legacy-UUID oder alter Stand), die zu diesem Eintrag migriert wurden — Basis der Lernschlüssel-Migration. */
  previousIds?: string[];
  brilliantScan?: { version: number; depth: number; complete: boolean };
  missedOpportunityVersion?: number;
  forcedMoveVersion?: number;
  moveClassificationVersion?: number;
}

export interface OpeningFocus {
  id: string;
  name: string;
  eco?: string;
  color: 'w' | 'b';
  anchorFen: string;
  prefixUci: string[];
  positionLabel: string;
}

export interface OpeningPhaseStats extends OpeningFocus {
  games: number;
  gamesWithErrors: number;
  errors: number;
  inaccuracies: number;
  mistakes: number;
  blunders: number;
  misses: number;
  avgAccuracy: number | null;
  avgChanceLoss: number;
  decisions: number;
  examples: Array<{ gameId: string; ply: number; san: string; moveNumber: number; quality: MoveQuality; winChanceDrop: number }>;
}

export type AnalyzedGame = GameAnalysis;
export type PlayerIdentity = string | string[];
export type MoveZoneId = '1-10' | '11-20' | '21-30' | '31-40' | '41+';
export type CoreMoveQuality =
  | 'brilliant'
  | 'best'
  | 'excellent'
  | 'good'
  | 'inaccuracy'
  | 'mistake'
  | 'blunder'
  | 'miss';
export type OpponentStrengthCategory = 'stronger' | 'equal' | 'weaker';

export interface MoveZoneBucket {
  zone: MoveZoneId;
  label: string;
  decisions: number;
  errors: number;
  inaccuracies: number;
  mistakes: number;
  blunders: number;
  misses: number;
  errorsPer100: number;
  avgAccuracy: number | null;
}

export interface ConversionResilienceStats {
  winningGamesReached: number;
  winningGamesCompleted: number;
  winningGamesConverted: number;
  winningGamesSquandered: number;
  squanderedWins: number;
  squanderedDraws: number;
  squanderedLosses: number;
  conversionRate: number | null;
  defensiveGamesFaced: number;
  defensiveGamesCompleted: number;
  defensiveGamesSaved: number;
  defensiveGamesLost: number;
  resilienceRate: number | null;
}

export interface TurningPointMove {
  gameId: string;
  opponent: string;
  userColor: 'w' | 'b';
  date: string;
  result: string;
  ply: number;
  moveNumber: number;
  san: string;
  bestMoveSan: string;
  classification: MoveQuality;
  winChanceBefore: number;
  winChanceAfter: number;
  winChanceDrop: number;
}

export interface MoveQualityDistribution {
  totalDecisions: number;
  counts: Record<CoreMoveQuality, number>;
  per100: Record<CoreMoveQuality, number>;
}

export interface PressureProfile {
  checkDecisions: number;
  checkErrors: number;
  checkErrorsPer100: number;
  checkAvgAccuracy: number | null;
  normalDecisions: number;
  normalErrors: number;
  normalErrorsPer100: number;
  normalAvgAccuracy: number | null;
  sharpDecisions: number;
  sharpErrors: number;
  sharpErrorsPer100: number;
  sharpAvgAccuracy: number | null;
  quietDecisions: number;
  quietErrors: number;
  quietErrorsPer100: number;
  quietAvgAccuracy: number | null;
}

export interface OpponentStrengthBucket {
  category: OpponentStrengthCategory;
  label: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number | null;
  avgAccuracy: number | null;
  errorsPer100: number;
  decisions: number;
  errors: number;
}

export interface FormComparison {
  recentGames: number;
  overallGames: number;
  recentCompletedGames: number;
  overallCompletedGames: number;
  recentWinRate: number;
  recentAccuracy: number;
  recentErrorsPer100: number;
  overallWinRate: number;
  overallAccuracy: number;
  overallErrorsPer100: number;
  accuracyDelta: number;
  errorsPer100Delta: number;
}

export interface TrainingRecommendation {
  id: string;
  priority: 'high' | 'medium' | 'low';
  title: string;
  summary: string;
  evidence: string;
  actionLabel: string;
  targetPhase?: 'opening' | 'middlegame' | 'endgame';
  targetMotif?: MissedIdea;
  sampleGameId?: string;
  samplePly?: number;
}

export interface DeepDiagnostics {
  analyzedGames: number;
  totalDecisions: number;
  totalErrors: number;
  moveZones: MoveZoneBucket[];
  conversion: ConversionResilienceStats;
  turningPoints: TurningPointMove[];
  moveQuality: MoveQualityDistribution;
  pressureProfile: PressureProfile;
  opponentStrength: OpponentStrengthBucket[];
  opponentStrengthUnknownGames: number;
  formComparison: FormComparison;
  recommendations: TrainingRecommendation[];
}

export interface PlayerStats {
  performance?: import('./statistics').PerformanceOverview;
  deepDiagnostics?: DeepDiagnostics;
  playerName: string;
  totalGames: number;
  winCount: number;
  lossCount: number;
  drawCount: number;
  avgAccuracy: number;
  openingWindowMoves?: number;
  openingPhaseStats?: OpeningPhaseStats[];
  colorPerformance: {
    white: { games: number; wins: number; losses: number; draws: number; avgAccuracy: number; winRate: number };
    black: { games: number; wins: number; losses: number; draws: number; avgAccuracy: number; winRate: number };
  };
  phaseDistribution: {
    openingBlunders: number;
    middlegameBlunders: number;
    endgameBlunders: number;
  };
  blunderedPieces: {
    p: number;
    n: number;
    b: number;
    r: number;
    q: number;
    /** T13: Königszugfehler ohne belegbaren Figurenverlust (z. B. mattgefährdende Königsflucht). */
    k: number;
  };
  openingsStats: {
    name: string;
    eco: string;
    games: number;
    wins: number;
    losses: number;
    draws: number;
    avgAccuracy: number;
    blunders: number;
    whiteGames: number;
    whiteWins: number;
    blackGames: number;
    blackWins: number;
  }[];
  accuracyHistory: {
    date?: string;
    /** T13: UTC-Zeitstempel der Partie (end_time/Import) — sortiert gleiche Tage deterministisch. */
    createdAt?: string;
    playedAt?: string;
    accuracy: number;
    result: string;
    win: boolean;
    draw: boolean;
  }[];
  timeControlStats: {
    label: string;
    games: number;
    wins: number;
    losses: number;
    draws: number;
    avgAccuracy: number;
    winRate: number;
  }[];
  avgErrorSeverity: number;
  worstError: {
    san: string;
    moveNumber: number;
    winChanceDrop: number;
    date?: string;
    openingName?: string;
    color: 'w' | 'b';
    /** T18: Diagnose → Beleg: Partie + Position vor dem Fehler. */
    gameId?: string;
    ply?: number;
  } | null;
  coachingInsights: string[];
  /** „Was hätte der Bestzug gebracht?" - Klassifikation aller Fehlerzüge */
  overlookedIdeas: {
    total: number;
    counts: Record<MissedIdea, number>;
    examples: {
      san: string;
      bestSan: string;
      moveNumber: number;
      idea: MissedIdea;
      /** T14: true = Motiv nur geometrisch erkannt (UI hängt "(heuristisch)" an). */
      heuristic?: boolean;
      winChanceDrop: number;
      date?: string;
      openingName?: string;
      /** T18: Diagnose → Beleg: Partie + Position vor dem Fehler. */
      gameId?: string;
      ply?: number;
    }[];
  };
  /** Mattmuster aus verloren gegangenen Partien */
  matePatterns: {
    backRank: number;
    smothered: number;
    net: number;
    total: number;
  };
  /** Varianten (tiefster Buch-Name), gruppiert nach Fehlerbelastung */
  variationStats: {
    variation: string;
    games: number;
    blunders: number;
    /** T13: Fehler je Partie — relative Belastung statt absoluter Zahl. */
    blundersPerGame: number;
    /** Coarse errors inside the configured opening window; legacy whole-game grouping. */
    openingPhaseBlunders: number;
    avgAccuracy: number;
  }[];
}

export interface ArchiveItem extends GameMetadata {
  accuracyWhite: number;
  accuracyBlack: number;
  mistakeCount: number;
  blunderCount: number;
  brilliantCount?: number;
  brilliantMoves?: Array<Pick<MoveAnalysis, 'ply' | 'moveNumber' | 'san' | 'color'>>;
  brilliantScan?: GameAnalysis['brilliantScan'];
  analysisPartial?: boolean;
}

/** Wiederholungsabstände (Phase 6): Preset oder explizite Intervallliste in Tagen. */
export type AppLanguage = 'de' | 'en';

export interface ReviewScheduleConfig {
  mode: 'preset' | 'custom';
  preset: 'frequent' | 'normal' | 'relaxed';
  /** Nur mode 'custom': monoton steigende Intervalle (Tage), 1–8 Stufen. */
  intervalsDays?: number[];
}

export interface AppSettings {
  profileId: string;
  playerAliases: string[];
  accountAliases: { chessCom: string[]; lichess: string[] };
  playerName: string;
  /** Synchronisierung — getrennte Konten (leer = nicht konfiguriert). */
  chessComUsername: string;
  lichessUsername: string;
  /** Discovery-Job beim App-Start; Standard aus (Brief-Punkt 4). */
  autoSyncOnStartup: boolean;
  /** Auto-Sync legt analysierende Jobs an; aus → nur manueller Sync. */
  autoAnalyzeNewGames: boolean;
  stockfishPath: string;
  engineDepth: number;
  /** Explicit evaluation window, full move numbers, independent of book exit. */
  openingWindowMoves: number;
  /** UCI setoption — sicher geklemmt (1–4 Threads, 16–512 MB). */
  engineThreads: number;
  engineHashMb: number;
  soundEnabled: boolean;
  /** Review overlays. Old settings files receive defaults via normalizeAppSettings. */
  showBestMoveArrows: boolean;
  showThreatArrows: boolean;
  /** Wiederholungsabstände für alle Trainingsformate. */
  trainingSchedule: ReviewScheduleConfig;
  /** Version des Settings-Schemas; Normalisierung füllt fehlende/ungültige Felder. */
  settingsVersion: number;
  theme: 'chesscom-green' | 'chesscom-dark' | 'glass';
  language: AppLanguage;
}

/** Zentrale Defaults — electron/main.ts und Renderer nutzen dieselbe Quelle. */
export const APP_SETTINGS_DEFAULTS: AppSettings = {
  profileId: 'local-profile',
  playerAliases: [],
  accountAliases: { chessCom: [], lichess: [] },
  playerName: 'Mein Profil',
  chessComUsername: '',
  lichessUsername: '',
  autoSyncOnStartup: false,
  autoAnalyzeNewGames: true,
  stockfishPath: 'engine/stockfish.exe',
  engineDepth: 14,
  openingWindowMoves: 12,
  engineThreads: 1,
  engineHashMb: 64,
  soundEnabled: true,
  showBestMoveArrows: true,
  showThreatArrows: true,
  trainingSchedule: { mode: 'preset', preset: 'normal' },
  settingsVersion: 1,
  theme: 'chesscom-green',
  language: 'de',
};

const TRAINING_PRESETS = ['frequent', 'normal', 'relaxed'] as const;

/** Ungültige/grenzfällige Werte normalisieren (Brief-Punkt 7). */
export function normalizeTrainingSchedule(raw: unknown): ReviewScheduleConfig {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const preset = TRAINING_PRESETS.includes(p.preset as ReviewScheduleConfig['preset'])
    ? (p.preset as ReviewScheduleConfig['preset'])
    : 'normal';
  if (p.mode !== 'custom' || !Array.isArray(p.intervalsDays)) {
    return { mode: 'preset', preset };
  }
  const minDays = 10 * 60 / (24 * 60 * 60); // kürzeste Stufe = 10 Minuten
  const days = p.intervalsDays
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= minDays && v <= 365)
    .map((v) => Math.round(v * 1000) / 1000);
  const increasing: number[] = [];
  for (const d of days) {
    const last = increasing[increasing.length - 1];
    if (!increasing.length || d > last) increasing.push(d);
  }
  if (increasing.length === 0) return { mode: 'preset', preset };
  return { mode: 'custom', preset, intervalsDays: increasing.slice(0, 8) };
}

/** Alte settings.json lädt unverändert; fehlende Felder erhalten Defaults. */
export function normalizeAppSettings(parsed: unknown, stockfishPathFallback?: string): AppSettings {
  const p = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const names = (v: unknown): string[] => Array.isArray(v) ? [...new Set(v.filter((name): name is string => typeof name === 'string' && !!name.trim()).map(name => name.trim()))] : [];
  const aliases = (p.accountAliases && typeof p.accountAliases === 'object' ? p.accountAliases : {}) as Record<string, unknown>;
  const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN;
    return Number.isNaN(n) ? fallback : Math.max(lo, Math.min(hi, n));
  };
  return {
    profileId: /^[a-zA-Z0-9_-]{1,80}$/.test(str(p.profileId)) ? str(p.profileId) : APP_SETTINGS_DEFAULTS.profileId,
    playerAliases: Array.isArray(p.playerAliases) ? [...new Set(p.playerAliases.filter((name): name is string => typeof name === 'string' && !!name.trim()).map(name => name.trim()))] : [],
    accountAliases: { chessCom: names(aliases.chessCom), lichess: names(aliases.lichess) },
    playerName: str(p.playerName) || APP_SETTINGS_DEFAULTS.playerName,
    chessComUsername: str(p.chessComUsername),
    lichessUsername: str(p.lichessUsername),
    autoSyncOnStartup: bool(p.autoSyncOnStartup, APP_SETTINGS_DEFAULTS.autoSyncOnStartup),
    autoAnalyzeNewGames: bool(p.autoAnalyzeNewGames, APP_SETTINGS_DEFAULTS.autoAnalyzeNewGames),
    stockfishPath:
      (typeof p.stockfishPath === 'string' && p.stockfishPath.trim()) ||
      stockfishPathFallback ||
      APP_SETTINGS_DEFAULTS.stockfishPath,
    engineDepth: clampInt(p.engineDepth, 1, 30, APP_SETTINGS_DEFAULTS.engineDepth),
    openingWindowMoves: [8, 10, 12, 15, 20].includes(p.openingWindowMoves as number) ? p.openingWindowMoves as number : 12,
    engineThreads: clampInt(p.engineThreads, 1, 4, APP_SETTINGS_DEFAULTS.engineThreads),
    engineHashMb: clampInt(p.engineHashMb, 16, 512, APP_SETTINGS_DEFAULTS.engineHashMb),
    soundEnabled: bool(p.soundEnabled, APP_SETTINGS_DEFAULTS.soundEnabled),
    showBestMoveArrows: bool(p.showBestMoveArrows, true),
    showThreatArrows: bool(p.showThreatArrows, true),
    trainingSchedule: normalizeTrainingSchedule(p.trainingSchedule),
    settingsVersion: 1,
    theme:
      p.theme === 'chesscom-dark' || p.theme === 'glass' ? p.theme : APP_SETTINGS_DEFAULTS.theme,
    language: p.language === 'en' ? 'en' : 'de',
  };
}
