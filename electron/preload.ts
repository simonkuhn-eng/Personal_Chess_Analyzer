import { contextBridge, ipcRenderer } from 'electron';
import { GameAnalysis, AppSettings } from '../src/types/chess';
import type { AiCoachExplainRequest, AiCoachStreamEvent } from '../src/types/aiCoach';

export const electronAPI = {
  engine: {
    getStatus: () => ipcRenderer.invoke('engine:get-status'),
    openEngineFolder: () => ipcRenderer.invoke('engine:open-engine-folder'),
    setPath: (customPath: string) => ipcRenderer.invoke('engine:set-path', customPath),
    evaluateFen: (fen: string, depth?: number, historyUci?: string[], currentFen?: string, options?: import('../src/types/chess').EngineSearchOptions) => ipcRenderer.invoke('engine:evaluate-fen', fen, depth, historyUci, currentFen, options),
    cancelRequest: (requestId: string) => ipcRenderer.invoke('engine:cancel-request', requestId),
    evaluateFenMultiPv: (fen: string, depth?: number, multiPv?: number, historyUci?: string[], currentFen?: string, options?: import('../src/types/chess').EngineSearchOptions) => ipcRenderer.invoke('engine:evaluate-fen-multipv', fen, depth, multiPv, historyUci, currentFen, options),
    selectStockfishFile: () => ipcRenderer.invoke('engine:select-file'),
  },
  db: {
    saveGame: (game: GameAnalysis) => ipcRenderer.invoke('db:save-game', game),
    getGames: (playerName?: string) => ipcRenderer.invoke('db:get-games', playerName),
    getGame: (id: string) => ipcRenderer.invoke('db:get-game', id),
    deleteGame: (id: string) => ipcRenderer.invoke('db:delete-game', id),
    getPlayerStats: (playerName: string, filter?: import('../src/types/statistics').StatisticsFilter) => ipcRenderer.invoke('db:get-player-stats', playerName, filter),
    getStableGameIds: () => ipcRenderer.invoke('db:get-stable-game-ids'),
    getReviewIdMap: () => ipcRenderer.invoke('db:get-review-id-map'),
  },
  chesscom: {
    fetchGames: (username: string, year: number, month: number) =>
      ipcRenderer.invoke('chesscom:fetch-games', username, year, month),
    fetchUserProfile: (username: string) => ipcRenderer.invoke('chesscom:fetch-profile', username),
    fetchLatestGame: (username: string) => ipcRenderer.invoke('chesscom:fetch-latest-game', username),
    // T16: persistierte Pipeline
    listJobs: () => ipcRenderer.invoke('chesscom:jobs:list'),
    createJob: (username: string, daysWindow: number) => ipcRenderer.invoke('chesscom:jobs:create', username, daysWindow),
    claimNextJob: () => ipcRenderer.invoke('chesscom:jobs:claim'),
    markJob: (id: string, patch: { savedDelta?: number; failedDelta?: number; cursorSet?: number; status?: 'queued' | 'analyzing' | 'saved' | 'failed' | 'cancelled'; lastError?: string }) =>
      ipcRenderer.invoke('chesscom:jobs:mark', id, patch),
    cancelJob: (id: string) => ipcRenderer.invoke('chesscom:jobs:cancel', id),
  },
  lichess: {
    // Phase 6: persistierte Lichess-Pipeline (Spiegel, eigene lichess_jobs.json)
    listJobs: () => ipcRenderer.invoke('lichess:jobs:list'),
    createJob: (username: string, daysWindow: number) => ipcRenderer.invoke('lichess:jobs:create', username, daysWindow),
    claimNextJob: () => ipcRenderer.invoke('lichess:jobs:claim'),
    markJob: (id: string, patch: { savedDelta?: number; failedDelta?: number; cursorSet?: number; status?: 'queued' | 'analyzing' | 'saved' | 'failed' | 'cancelled'; lastError?: string }) =>
      ipcRenderer.invoke('lichess:jobs:mark', id, patch),
    cancelJob: (id: string) => ipcRenderer.invoke('lichess:jobs:cancel', id),
  },
  data: {
    getPath: () => ipcRenderer.invoke('app:get-data-path'),
    openFolder: () => ipcRenderer.invoke('app:open-data-folder'),
    createBackup: (learningStorage: Record<string, string>) => ipcRenderer.invoke('app:create-backup', learningStorage),
    exportData: (learningStorage: Record<string, string>) => ipcRenderer.invoke('app:export-data', learningStorage),
    inspectData: () => ipcRenderer.invoke('app:inspect-data'),
    restoreData: (bundle: unknown) => ipcRenderer.invoke('app:restore-data', bundle),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (settings: Partial<AppSettings>) => ipcRenderer.invoke('settings:save', settings),
  },
  aiCoach: {
    getStatus: () => ipcRenderer.invoke('ai-coach:get-status'),
    explain: (request: AiCoachExplainRequest) => ipcRenderer.invoke('ai-coach:explain', request),
    cancel: (requestId: string) => ipcRenderer.invoke('ai-coach:cancel', requestId),
    onEvent: (listener: (event: AiCoachStreamEvent) => void) => {
      const handler = (_: unknown, event: AiCoachStreamEvent) => listener(event);
      ipcRenderer.on('ai-coach:event', handler);
      return () => {
        ipcRenderer.removeListener('ai-coach:event', handler);
      };
    },
  },
  lanSync: {
    getStatus: () => ipcRenderer.invoke('lan-sync:get-status'),
    startServer: () => ipcRenderer.invoke('lan-sync:start'),
    stopServer: () => ipcRenderer.invoke('lan-sync:stop'),
    prepareAdbSync: () => ipcRenderer.invoke('lan-sync:prepare-adb'),
    syncWithPeer: (hostOrIp: string, learningStorage: Record<string, string>) =>
      ipcRenderer.invoke('lan-sync:sync-peer', hostOrIp, learningStorage),
    onApplied: (
      listener: (payload: {
        learningStorage: Record<string, string>;
        summary: import('../src/utils/lanSyncMerge').SyncSummary;
      }) => void
    ) => {
      const handler = (
        _: unknown,
        payload: {
          learningStorage: Record<string, string>;
          summary: import('../src/utils/lanSyncMerge').SyncSummary;
        }
      ) => listener(payload);
      ipcRenderer.on('lan-sync:applied', handler);
      return () => {
        ipcRenderer.removeListener('lan-sync:applied', handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
