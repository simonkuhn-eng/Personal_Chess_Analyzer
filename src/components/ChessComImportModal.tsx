import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChessComGameSummary } from '../types/electron';
import { GameAnalysis } from '../types/chess';
import { extractMovesFromPgn, gameFingerprint, parsePgnMetadata } from '../utils/pgn';
import { analyzePgnGame, AnalysisCancelledError } from '../utils/analyzeGame';
import { CloudDownload, Loader2, RefreshCcw, X, CheckCircle2, XCircle, ChevronLeft, ChevronRight, Ban } from 'lucide-react';
import { useI18n } from '../utils/i18n';

interface ChessComImportModalProps {
  playerName: string;
  depth: number;
  onClose: () => void;
  /** Wird nach erfolgreichem Speichern aufgerufen (App aktualisiert Archiv/Review). */
  onGamesSaved: (lastGame: GameAnalysis | null) => void;
}

interface MonthEntry extends ChessComGameSummary {
  entryKey: string;
  fp: string;
  isNew: boolean;
  selected: boolean;
  analyzable: boolean;
  moveCount: number;
}

const MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONTH_NAMES_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Fingerprint-Logik lebt jetzt in utils/pgn.ts (gameFingerprint) —
// identische Formel wie electron/db.ts.

export const ChessComImportModal: React.FC<ChessComImportModalProps> = ({
  playerName,
  depth,
  onClose,
  onGamesSaved,
}) => {
  const { isEn, tr } = useI18n();
  const monthNames = isEn ? MONTH_NAMES_EN : MONTH_NAMES;
  const now = new Date();
  const [username, setUsername] = useState(playerName);
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1-12
  const [entries, setEntries] = useState<MonthEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'analyzing' | 'done'>('idle');
  const [gameProgress, setGameProgress] = useState({ current: 0, total: 0 });
  const [moveProgress, setMoveProgress] = useState({ current: 0, total: 0 });
  const [result, setResult] = useState<{ saved: number; failed: number; cancelled: boolean } | null>(null);

  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
  const isAnalyzing = phase === 'analyzing';
  // T17: veraltete Antworten (Async-Nachlauf nach Monatswechsel/Neu laden) verwerfen
  const loadSeqRef = useRef(0);
  // T17: Abbruch laufender Analysen
  const cancelRef = useRef(false);
  useEffect(() => { cancelRef.current = false; return () => { cancelRef.current = true; }; }, []);
  const [cancelRequested, setCancelRequested] = useState(false);
  // T16: persistierte Hintergrund-Pipeline — Discovery+Queue im Main-Prozess,
  // Analyse im App-Driver (überlebt Schließen des Modals und App-Neustart).
  const [pipelineBusy, setPipelineBusy] = useState(false);
  const [pipelineMsg, setPipelineMsg] = useState<string | null>(null);
  // T21: Escape schließt den Dialog (gleiches Verhalten wie der X-Button)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { cancelRef.current = true; onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const handleBackgroundSync = async () => {
    const api = window.electronAPI;
    if (!api?.chesscom.createJob || pipelineBusy || !username.trim()) return;
    setPipelineBusy(true);
    setPipelineMsg(null);
    try {
      const { job, created } = await api.chesscom.createJob(username.trim(), 30);
      setPipelineMsg(
        created
          ? tr(
              `Hintergrund-Job erstellt: ${job.games.length} neue Partie(n) werden im Hintergrund analysiert (setzt bei App-Neustart fort).`,
              `Background job created: ${job.games.length} new game(s) will be analyzed in the background (resumes across restarts).`,
            )
          : tr('Ein Hintergrund-Job für diesen Spieler läuft bereits.', 'A background job is already running for this player.'),
      );
      window.dispatchEvent(new Event('pca-pipeline-kick'));
    } catch (err) {
      setPipelineMsg(`${tr('Fehler:', 'Error:')} ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPipelineBusy(false);
    }
  };
  const requestCancel = () => {
    cancelRef.current = true;
    setCancelRequested(true);
  };

  const loadMonth = useCallback(async (name: string, y: number, m: number) => {
    const api = window.electronAPI;
    if (!api) {
      setErrorMsg(tr('Chess.com-Import ist nur in der Desktop-App verfügbar.', 'Chess.com import is only available in the desktop app.'));
      return;
    }
    const seq = ++loadSeqRef.current;
    setErrorMsg(null);
    setIsLoading(true);
    setEntries([]);
    setResult(null);
    setPhase('idle');
    try {
      const [games, stableIds] = await Promise.all([
        api.chesscom.fetchGames(name, y, m),
        api.db.getStableGameIds(),
      ]);
      const known = new Set(stableIds);

      const mapped: MonthEntry[] = [];
      const seenInBatch = new Set<string>();
      for (const game of games) {
        let uciMoves: string[] = [];
        let gameId = '';
        try {
          uciMoves = extractMovesFromPgn(game.pgn).map((mv) => mv.uci);
          // R07: Quellidentität = stabile Partie-ID aus den PGN-Metadaten
          gameId = parsePgnMetadata(game.pgn).id;
        } catch {
          uciMoves = [];
        }
        // R07: Identität statt schwachem Fingerabdruck — Zwillingspartien
        // (gleiche Züge, verschiedenes Datum) bleiben im Import; Duplikate im
        // selben Batch werden per ID erkannt. fp bleibt nur als Anzeige-Detail.
        const analyzable = uciMoves.length > 0;
        const isNew = analyzable && !!gameId && !known.has(gameId) && !seenInBatch.has(gameId);
        if (gameId) seenInBatch.add(gameId);
        const fp = gameFingerprint(game.white, game.black, uciMoves);
        const entryKey = `${gameId || fp}#${mapped.length}`;
        mapped.push({ ...game, entryKey, fp, isNew, selected: isNew, analyzable, moveCount: uciMoves.length });
      }
      if (seq !== loadSeqRef.current) return; // veraltete Antwort — Monat wurde gewechselt
      setEntries(mapped);
      if (mapped.length === 0) {
        // T17: 404/leeres Archiv vom "unbekannter Nutzer" unterscheiden
        const profile = await api.chesscom.fetchUserProfile(name);
        if (seq !== loadSeqRef.current) return;
        setErrorMsg(
          profile.exists
            ? tr(`Keine Partien von "${name}" im ${monthNames[m - 1]} ${y} gefunden.`, `No games for "${name}" found in ${monthNames[m - 1]} ${y}.`)
            : tr(`Chess.com-Benutzer "${name}" wurde nicht gefunden.`, `Chess.com user "${name}" was not found.`)
        );
      }
    } catch (err: unknown) {
      if (seq === loadSeqRef.current) {
        setErrorMsg((err as Error).message || tr('Chess.com-Partien konnten nicht geladen werden.', 'Could not fetch Chess.com games.'));
      }
    } finally {
      if (seq === loadSeqRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  // Automatisch beim Öffnen den aktuellen Monat laden
  useEffect(() => {
    loadMonth(playerName, now.getFullYear(), now.getMonth() + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const newCount = useMemo(() => entries.filter((e) => e.isNew).length, [entries]);
  const selectedCount = useMemo(() => entries.filter((e) => e.isNew && e.selected).length, [entries]);

  const shiftMonth = (delta: number) => {
    if (isAnalyzing || isLoading) return;
    let y = year;
    let m = month + delta;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    if (y > now.getFullYear() || (y === now.getFullYear() && m > now.getMonth() + 1)) return;
    setYear(y);
    setMonth(m);
    loadMonth(username, y, m);
  };

  const toggleEntry = (entryKey: string) => {
    if (isAnalyzing) return;
    setEntries((prev) => prev.map((e) => (e.entryKey === entryKey && e.isNew ? { ...e, selected: !e.selected } : e)));
  };

  const setAllSelected = (selected: boolean) => {
    if (isAnalyzing) return;
    setEntries((prev) => prev.map((e) => (e.isNew ? { ...e, selected } : e)));
  };

  const handleStart = async () => {
    const api = window.electronAPI;
    if (!api) return;
    const selected = entries.filter((e) => e.isNew && e.selected);
    if (selected.length === 0) return;

    setPhase('analyzing');
    setGameProgress({ current: 0, total: selected.length });
    setMoveProgress({ current: 0, total: 0 });
    setErrorMsg(null);
    cancelRef.current = false;
    setCancelRequested(false);

    let saved = 0;
    let failed = 0;
    let cancelled = false;
    let last: GameAnalysis | null = null;

    for (let gi = 0; gi < selected.length; gi++) {
      if (cancelRef.current) {
        cancelled = true;
        break;
      }
      setGameProgress({ current: gi + 1, total: selected.length });
      try {
        // T13: gespeicherte chess.com-Zeitklasse als [TimeClass]-Header
        // injizieren — classifyTimeControl hat timeClass-Vorrang, und die
        // Identity-Key-Bildung nutzt TimeControl (IDs bleiben unverändert).
        const entryPgn = selected[gi].timeClass
          ? `[TimeClass "${selected[gi].timeClass}"]\n${selected[gi].pgn}`
          : selected[gi].pgn;
        // T17: shouldCancel an die Analyse durchreichen (Zug-für-Zug-Abbruch)
        const analyzed = await analyzePgnGame(
          entryPgn,
          depth,
          (current, total) => setMoveProgress({ current, total }),
          () => cancelRef.current
        );
        // T17: Abbruch nochmals vor dem finalen Speichern prüfen
        if (cancelRef.current) {
          cancelled = true;
          break;
        }
        if (selected[gi].endTime) analyzed.playedAt = new Date(selected[gi].endTime! * 1000).toISOString();
        last = await api.db.saveGame(analyzed);
        saved++;
        // T17: gespeicherte Einträge sofort als "Archiv" markieren statt
        // weiter als "Neu" auswählbar zu bleiben.
        const savedKey = selected[gi].entryKey;
        setEntries((prev) => prev.map((e) => (e.entryKey === savedKey ? { ...e, isNew: false, selected: false } : e)));
      } catch (err: unknown) {
        if (err instanceof AnalysisCancelledError) {
          cancelled = true;
          break;
        }
        console.error('Chess.com-Import: Partie fehlgeschlagen', err);
        failed++;
      }
    }

    setResult({ saved, failed, cancelled });
    setPhase('done');
    if (saved > 0 && !cancelRef.current) {
      onGamesSaved(last);
    }
  };

  const formatEndTime = (entry: MonthEntry) => {
    if (entry.date) return entry.date;
    if (entry.endTime) return new Date(entry.endTime * 1000).toISOString().split('T')[0];
    return '—';
  };

  return (
    <div className="modal-backdrop">
      <div role="dialog" aria-modal="true" aria-label={tr('chess.com Partien importieren', 'Import Chess.com games')} className="modal-content" style={{ maxWidth: '640px' }}>
        {/* Header */}
        <div className="modal-header">
          <h2 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CloudDownload size={20} color="#81b64c" />
            <span>{tr('Neue chess.com-Partien laden', 'Fetch Chess.com Games')}</span>
          </h2>
          {!isAnalyzing && (
            <button className="btn-icon" onClick={() => { cancelRef.current = true; onClose(); }}>
              <X size={18} />
            </button>
          )}
        </div>

        {/* Username + Monat */}
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap' }}>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={isAnalyzing || isLoading}
            placeholder={tr('chess.com Benutzername', 'Chess.com username')}
            style={{
              flex: 1,
              minWidth: '180px',
              backgroundColor: '#161512',
              border: '1px solid #2e2b24',
              borderRadius: '8px',
              padding: '9px 12px',
              color: '#ffffff',
              fontSize: '0.88rem',
            }}
          />
          <button className="btn-icon" onClick={() => shiftMonth(-1)} disabled={isAnalyzing || isLoading} title={tr('Vorheriger Monat', 'Previous month')}>
            <ChevronLeft size={18} />
          </button>
          <span style={{ minWidth: '130px', textAlign: 'center', color: '#ffffff', fontWeight: 600, fontSize: '0.9rem' }}>
            {monthNames[month - 1]} {year}
          </span>
          <button className="btn-icon" onClick={() => shiftMonth(1)} disabled={isAnalyzing || isLoading || isCurrentMonth} title={tr('Nächster Monat', 'Next month')}>
            <ChevronRight size={18} />
          </button>
          <button
            className="btn-secondary"
            onClick={() => loadMonth(username, year, month)}
            disabled={isAnalyzing || isLoading || !username.trim()}
            style={{ fontSize: '0.8rem', padding: '7px 12px' }}
          >
            {isLoading ? <Loader2 size={14} className="spin" /> : <RefreshCcw size={14} />}
            <span>{tr('Neu laden', 'Reload')}</span>
          </button>
        </div>

        {errorMsg && (
          <div style={{ background: '#ca343122', border: '1px solid #ca3431', color: '#ff7b78', padding: '10px 14px', borderRadius: '8px', marginBottom: '14px', fontSize: '0.85rem' }}>
            {errorMsg}
          </div>
        )}

        {/* Partien-Liste */}
        {entries.length > 0 && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', fontSize: '0.85rem', color: '#a8a6a0' }}>
              <span>
                <strong style={{ color: '#ffffff' }}>{entries.length}</strong> {tr('Partien gefunden', 'games found')} ·{' '}
                <strong style={{ color: '#81b64c' }}>{newCount} {tr('neu', 'new')}</strong> · {entries.length - newCount} {tr('bereits im Archiv', 'already archived')}
                {entries.some((e) => !e.analyzable) && <> · {entries.filter((e) => !e.analyzable).length} {tr('nicht lesbar', 'unreadable')}</>}
              </span>
              {newCount > 0 && !isAnalyzing && (
                <span style={{ display: 'flex', gap: '8px' }}>
                  <button className="btn-secondary" onClick={() => setAllSelected(true)} style={{ fontSize: '0.72rem', padding: '3px 8px' }}>{tr('Alle auswählen', 'Select all')}</button>
                  <button className="btn-secondary" onClick={() => setAllSelected(false)} style={{ fontSize: '0.72rem', padding: '3px 8px' }}>{tr('Keine', 'None')}</button>
                </span>
              )}
            </div>

            <div style={{ maxHeight: '280px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px', paddingRight: '4px' }}>
              {entries.map((entry) => (
                <div
                  key={entry.entryKey}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '8px 12px',
                    borderRadius: '8px',
                    background: entry.isNew ? '#22241c' : '#1c1b18',
                    border: `1px solid ${entry.isNew ? '#4a7a2e' : '#24231e'}`,
                    opacity: entry.isNew ? 1 : 0.55,
                  }}
                >
                  {entry.isNew ? (
                    <input
                      type="checkbox"
                      checked={entry.selected}
                      onChange={() => toggleEntry(entry.entryKey)}
                      disabled={isAnalyzing}
                      style={{ accentColor: '#81b64c', width: '16px', height: '16px', cursor: 'pointer' }}
                    />
                  ) : (
                    <CheckCircle2 size={16} color="#7d7b74" />
                  )}
                  <span style={{ fontSize: '0.78rem', color: '#a8a6a0', minWidth: '78px' }}>{formatEndTime(entry)}</span>
                  <span style={{ flex: 1, fontSize: '0.85rem', color: '#ffffff', fontWeight: 600 }}>
                    {entry.white} <span style={{ color: '#7d7b74', fontWeight: 400 }}>vs</span> {entry.black}
                  </span>
                  {entry.timeClass && (
                    <span style={{ fontSize: '0.7rem', color: '#a8a6a0', background: '#24231e', padding: '2px 7px', borderRadius: '5px' }}>
                      {entry.timeClass}
                    </span>
                  )}
                  <span style={{ fontSize: '0.78rem', fontWeight: 700, color: entry.result === '1/2-1/2' ? '#d5a450' : '#cbc9c4', minWidth: '56px', textAlign: 'right' }}>
                    {entry.result}
                  </span>
                  <span style={{ fontSize: '0.7rem', fontWeight: 800, padding: '2px 8px', borderRadius: '5px', background: entry.isNew ? 'rgba(129, 182, 76, 0.18)' : 'rgba(110, 109, 107, 0.15)', color: entry.isNew ? '#96c860' : '#7d7b74' }}>
                    {entry.isNew ? tr('Neu', 'New') : !entry.analyzable ? tr('Nicht lesbar', 'Unreadable') : tr('Archiv', 'Archived')}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Fortschritt */}
        {isAnalyzing && (
          <div style={{ marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', color: '#81b64c', fontWeight: 600 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Loader2 size={14} className="spin" />
                {tr(`Partie ${gameProgress.current} von ${gameProgress.total}`, `Game ${gameProgress.current} of ${gameProgress.total}`)}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span>{tr(`Zug ${moveProgress.current} von ${moveProgress.total}`, `Move ${moveProgress.current} of ${moveProgress.total}`)}</span>
                <button
                  type="button"
                  className="btn-cancel"
                  onClick={requestCancel}
                  disabled={cancelRequested}
                  style={{ fontSize: '0.72rem', padding: '3px 10px' }}
                >
                  <Ban size={12} /> {cancelRequested ? tr('Abbrechen...', 'Cancelling...') : tr('Abbrechen', 'Cancel')}
                </button>
              </span>
            </div>
            <div style={{ width: '100%', height: '8px', background: '#24231e', borderRadius: '4px', overflow: 'hidden' }}>
              <div style={{ height: '100%', background: '#81b64c', width: `${((gameProgress.current - 1) / (gameProgress.total || 1)) * 100 + (moveProgress.current / (moveProgress.total || 1)) * (100 / (gameProgress.total || 1))}%`, transition: 'width 0.15s ease' }} />
            </div>
          </div>
        )}

        {/* Abschluss-Summary */}
        {phase === 'done' && result && (
          <div style={{ background: '#2d4a1e', border: '1px solid #4a7a2e', color: '#b5d48a', padding: '10px 14px', borderRadius: '8px', marginBottom: '14px', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckCircle2 size={16} />
            {result.cancelled
              ? tr(`Abgebrochen — ${result.saved} von ${result.saved + result.failed} Partie(n) gespeichert.`, `Cancelled — ${result.saved} of ${result.saved + result.failed} game(s) saved.`)
              : tr(`${result.saved} Partie${result.saved === 1 ? '' : 'n'} analysiert und gespeichert.`, `${result.saved} game${result.saved === 1 ? '' : 's'} analyzed and saved.`)}
            {result.failed > 0 && <span style={{ color: '#ff9c8a' }}>&nbsp;{result.failed} {tr('fehlgeschlagen.', 'failed.')}</span>}
          </div>
        )}

        {/* T16: Hintergrund-Pipeline */}
        <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
          <button
            className="btn-secondary"
            onClick={handleBackgroundSync}
            disabled={pipelineBusy || isAnalyzing || !username.trim()}
            style={{ flex: 1, padding: '10px' }}
          >
            <CloudDownload size={16} />
            <span>{pipelineBusy ? tr('Erstelle Hintergrund-Job …', 'Creating background job…') : tr('Neue Partien im Hintergrund synchronisieren', 'Sync new games in background')}</span>
          </button>
        </div>
        {pipelineMsg && <div style={{ color: '#a8a6a0', fontSize: '0.8rem', marginTop: '6px' }}>{pipelineMsg}</div>}

        {/* Actions */}
        <div style={{ display: 'flex', gap: '10px' }}>
          {phase === 'done' ? (
            <button className="btn-primary" onClick={() => { cancelRef.current = true; onClose(); }} style={{ flex: 1, padding: '12px' }}>
              <CheckCircle2 size={18} />
              <span>{tr('Schließen', 'Close')}</span>
            </button>
          ) : (
            <button
              className="btn-primary"
              disabled={isAnalyzing || isLoading || selectedCount === 0}
              onClick={handleStart}
              style={{ flex: 1, padding: '12px' }}
            >
              {isAnalyzing ? (
                <>
                  <Loader2 size={18} />
                  <span>{tr(`Analysiere (${gameProgress.current}/${gameProgress.total})...`, `Analyzing (${gameProgress.current}/${gameProgress.total})...`)}</span>
                </>
              ) : (
                <>
                  <CloudDownload size={18} />
                  <span>{tr(`${selectedCount} neue Partien analysieren & speichern (Tiefe ${depth})`, `Analyze & save ${selectedCount} new games (Depth ${depth})`)}</span>
                </>
              )}
            </button>
          )}
        </div>

        {selectedCount > 0 && phase === 'idle' && (
          <div style={{ marginTop: '10px', fontSize: '0.75rem', color: '#7d7b74', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <XCircle size={12} />
            {tr('Bereits archivierte Partien werden automatisch übersprungen. Die Analyse kann je nach Partienanzahl einige Minuten dauern.', 'Already archived games are skipped automatically. Analysis may take a few minutes depending on game count.')}
          </div>
        )}
      </div>
    </div>
  );
};
