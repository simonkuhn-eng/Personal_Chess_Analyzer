import type { AppSettings, ArchiveItem, EngineEvalResult, GameAnalysis, PlayerStats } from './chess';

export interface TopMoveResult {
  uci: string;
  scoreCp: number;
  mate?: number;
  pv: string[];
}

export interface MultiPvResponse {
  moves: TopMoveResult[];
  bestMoveUci: string;
  scoreCp: number;
  mate?: number;
  pv: string[];
  depth: number;
  actualDepth?: number;
  bound?: 'exact' | 'lower' | 'upper';
  status?: 'complete' | 'partial' | 'unavailable';
}

export interface ChessComGameSummary {
  pgn: string;
  url?: string;
  timeClass?: string;
  timeControl?: string;
  endTime?: number;
  white: string;
  black: string;
  result: string;
  date?: string;
}

export interface ElectronAPI {
  isMobile?: boolean;
  engine: {
    getStatus: () => Promise<{ installed: boolean; path: string; engineName: string; ready: boolean }>;
    openEngineFolder: () => Promise<boolean>;
    setPath: (customPath: string) => Promise<boolean>;
    evaluateFen: (fen: string, depth?: number, historyUci?: string[], currentFen?: string, options?: import('./chess').EngineSearchOptions) => Promise<EngineEvalResult>;
    cancelRequest?: (requestId: string) => Promise<void>;
    evaluateFenMultiPv: (fen: string, depth?: number, multiPv?: number, historyUci?: string[], currentFen?: string, options?: import('./chess').EngineSearchOptions) => Promise<MultiPvResponse>;
    selectStockfishFile: () => Promise<string | null>;
  };
  db: {
    saveGame: (game: GameAnalysis) => Promise<GameAnalysis>;
    getGames: (playerName?: string) => Promise<ArchiveItem[]>;
    getGame: (id: string) => Promise<GameAnalysis | null>;
    deleteGame: (id: string) => Promise<boolean>;
    getPlayerStats: (playerName: string, filter?: import('./statistics').StatisticsFilter) => Promise<PlayerStats>;
    cancelPlayerStats?: () => Promise<void>;
    getStableGameIds: () => Promise<string[]>;
    getReviewIdMap: () => Promise<Record<string, string>>;
  };
  chesscom: {
    fetchGames: (username: string, year: number, month: number) => Promise<ChessComGameSummary[]>;
    fetchUserProfile: (username: string) => Promise<{ exists: boolean; name?: string }>;
    fetchLatestGame: (username: string) => Promise<ChessComGameSummary | null>;
    // T16: persistierte Pipeline
    listJobs: () => Promise<PipelineDataInfo>;
    createJob: (username: string, daysWindow: number) => Promise<{ job: PipelineJobInfo; created: boolean }>;
    claimNextJob: () => Promise<PipelineJobInfo | null>;
    markJob: (id: string, patch: { savedDelta?: number; failedDelta?: number; cursorSet?: number; status?: 'queued' | 'analyzing' | 'saved' | 'failed' | 'cancelled'; lastError?: string }) => Promise<PipelineJobInfo | null>;
    cancelJob: (id: string) => Promise<PipelineJobInfo | null>;
  };
  lichess: {
    // Phase 6: persistierte Lichess-Pipeline (Spiegel, eigene lichess_jobs.json)
    listJobs: () => Promise<PipelineDataInfo>;
    createJob: (username: string, daysWindow: number) => Promise<{ job: PipelineJobInfo; created: boolean }>;
    claimNextJob: () => Promise<PipelineJobInfo | null>;
    markJob: (id: string, patch: { savedDelta?: number; failedDelta?: number; cursorSet?: number; status?: 'queued' | 'analyzing' | 'saved' | 'failed' | 'cancelled'; lastError?: string }) => Promise<PipelineJobInfo | null>;
    cancelJob: (id: string) => Promise<PipelineJobInfo | null>;
  };
  data: {
    getPath: () => Promise<string>;
    openFolder: () => Promise<void>;
    createBackup: (learningStorage: Record<string, string>) => Promise<{ path: string; files: number }>;
    exportData: (learningStorage: Record<string, string>) => Promise<string | null>;
    inspectData: () => Promise<import('./data').DataBundle | null>;
    restoreData: (bundle: import('./data').DataBundle) => Promise<boolean>;
  };
  settings: {
    get: () => Promise<AppSettings | null>;
    save: (settings: Partial<AppSettings>) => Promise<AppSettings>;
  };
  aiCoach?: {
    getStatus: () => Promise<import('./aiCoach').AiCoachStatus>;
    explain: (request: import('./aiCoach').AiCoachExplainRequest) => Promise<{ ok: boolean; error?: string }>;
    cancel: (requestId: string) => Promise<void>;
    onEvent: (listener: (event: import('./aiCoach').AiCoachStreamEvent) => void) => () => void;
  };
  lanSync?: {
    getStatus: () => Promise<LanSyncStatus>;
    startServer: () => Promise<LanSyncStatus>;
    stopServer: () => Promise<LanSyncStatus>;
    prepareAdbSync?: () => Promise<{ ok: boolean; deviceSerial?: string; port: number; message: string }>;
    syncWithPeer: (
      hostOrIp: string,
      learningStorage: Record<string, string>
    ) => Promise<{
      summary: import('../utils/lanSyncMerge').SyncSummary;
      mergedLearningStorage: Record<string, string>;
    }>;
    onApplied?: (
      listener: (payload: {
        learningStorage: Record<string, string>;
        summary: import('../utils/lanSyncMerge').SyncSummary;
      }) => void
    ) => () => void;
  };
}

export interface LanSyncStatus {
  running: boolean;
  port: number;
  ips: string[];
  deviceName: string;
  lastSync?: import('../utils/lanSyncMerge').SyncSummary | null;
}

export interface PipelineJobInfo {
  id: string;
  username: string;
  status: 'queued' | 'analyzing' | 'saved' | 'failed' | 'cancelled';
  games: { sourceId: string; pgn: string; playedAt?: string }[];
  cursor: number;
  savedCount: number;
  failedCount: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PipelineDataInfo {
  version: 1;
  knownIds: string[];
  lastSync?: { username: string; at: number; savedCount: number; failedCount: number; newCount: number };
  jobs: PipelineJobInfo[];
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
