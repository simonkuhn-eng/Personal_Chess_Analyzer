import React, { useEffect, useRef, useState } from 'react';
import { analyzePgnGame, AnalysisCancelledError } from '../utils/analyzeGame';
import { parsePgnMetadata } from '../utils/pgn';
import { isReliableGame } from '../utils/evaluationReliability';
import { GameAnalysis } from '../types/chess';
import { ChessComGameSummary } from '../types/electron';
import { X, Play, FileText, Loader2, CloudDownload, Ban } from 'lucide-react';
import { useI18n } from '../utils/i18n';

interface PgnImportModalProps {
  onClose: () => void;
  /** R11: asynchroner Vertrag — Save-Erfolg abwarten; Rejection → Dialog zeigt den Fehler sichtbar. */
  onAnalysisComplete: (game: GameAnalysis, closeAfter?: boolean) => Promise<void> | void;
  defaultPlayerName: string;
  defaultDepth?: number;
  initialPgn?: string;
  onOpenExistingGame?: (id: string) => Promise<void> | void;
}

// Fenster für den Chess.com-Schnellimport: letzte 30 Tage
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const PgnImportModal: React.FC<PgnImportModalProps> = ({
  onClose,
  onAnalysisComplete,
  defaultPlayerName,
  defaultDepth = 14,
  initialPgn,
  onOpenExistingGame,
}) => {
  const { tr } = useI18n();
  // T21: Escape schließt den Dialog (gleiches Verhalten wie der X-Button)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { cancelRef.current = true; onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const [pgnText, setPgnText] = useState(initialPgn || '');
  const [depth, setDepth] = useState<number>(defaultDepth);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [batch, setBatch] = useState<{ current: number; total: number } | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const cancelRef = useRef(false);
  useEffect(() => { cancelRef.current = false; return () => { cancelRef.current = true; }; }, []);

  const requestCancel = () => {
    cancelRef.current = true;
    setCancelRequested(true);
  };

  const resetCancel = () => {
    cancelRef.current = false;
    setCancelRequested(false);
  };

  const handleStartAnalysis = async () => {
    if (!pgnText.trim()) {
      setErrorMsg(tr('Bitte füge einen PGN-Text ein.', 'Please paste a PGN first.'));
      return;
    }

    setErrorMsg(null);
    setStatusMsg(null);
    resetCancel();
    setBatch(null);
    setIsAnalyzing(true);

    try {
      const game = await analyzePgnGame(
        pgnText,
        depth,
        (current, total) => setProgress({ current, total }),
        () => cancelRef.current,
      );
      setIsAnalyzing(false);
      // R11: Save-Erfolg abwarten — bei Save-Fehler zeigt der Dialog den
      // Fehler sichtbar (catch), der Dialog bleibt offen (erneuter Save möglich).
      if (!cancelRef.current) await onAnalysisComplete(game, true);
    } catch (err: unknown) {
      setIsAnalyzing(false);
      if (err instanceof AnalysisCancelledError) {
        setStatusMsg(tr('Analyse abgebrochen.', 'Analysis cancelled.'));
      } else {
        setErrorMsg((err as Error).message || tr('Fehler beim Analysieren des PGNs', 'Failed to analyze PGN'));
      }
    }
  };

  const handleChessComImport = async () => {
    const api = window.electronAPI;
    if (!api) {
      setErrorMsg(tr('Chess.com-Import ist nur in der Desktop-App verfügbar.', 'Chess.com import is only available in the desktop app.'));
      return;
    }

    setErrorMsg(null);
    setStatusMsg(null);
    resetCancel();
    setBatch(null);
    setIsFetching(true);

    try {
      // T17: Profil-Existenz prüfen — ein 404 des Monatsarchivs (unbekannter
      // Nutzer ODER leeres Archiv) darf nicht als "alles bereits geladen"
      // durchgehen.
      const profile = await api.chesscom.fetchUserProfile(defaultPlayerName);
      if (!profile.exists) {
        setIsFetching(false);
        setErrorMsg(tr(`Chess.com-Benutzer "${defaultPlayerName}" wurde nicht gefunden.`, `Chess.com user "${defaultPlayerName}" was not found.`));
        return;
      }
      if (cancelRef.current) return;

      // T17: ALLE vom 30-Tage-Fenster geschnittenen Monate serial laden —
      // am 1. März eines Nichtschaltjahres reichen 30 Tage bis Januar zurück.
      // Serial statt Promise.all: ein Fehler verwirft nicht beide Monate,
      // und chess.com drosselt parallele Requests (429 → Backoff im Main).
      const now = new Date();
      const windowStart = new Date(now.getTime() - THIRTY_DAYS_MS);
      const months: { y: number; m: number }[] = [];
      for (
        let iter = new Date(windowStart.getFullYear(), windowStart.getMonth(), 1);
        iter <= new Date(now.getFullYear(), now.getMonth(), 1);
        iter = new Date(iter.getFullYear(), iter.getMonth() + 1, 1)
      ) {
        months.push({ y: iter.getFullYear(), m: iter.getMonth() + 1 });
      }

      const monthGames: ChessComGameSummary[] = [];
      for (const { y, m } of months) {
        if (cancelRef.current) break;
        monthGames.push(...(await api.chesscom.fetchGames(defaultPlayerName, y, m)));
      }

      setIsFetching(false);
      if (cancelRef.current) return;

      // Nur Partien der letzten 30 Tage
      const cutoff = Date.now() - THIRTY_DAYS_MS;
      const recent = monthGames.filter((g) => !g.endTime || g.endTime * 1000 >= cutoff);

      // Duplikate entfernen: bereits gespeicherte + doppelte im selben Batch.
      // T17: Parsefehler werden gezählt und angezeigt statt still aussortiert.
      // R07: Quellidentität (stabile Partie-ID) statt des schwachen Legacy-
      // Fingerabdrucks — Zwillingspartien (gleiche Züge, verschiedenes Datum)
      // werden nicht mehr vor dem Speichern ausgesortiert.
      const existing = new Set(await api.db.getStableGameIds());
      const seenInBatch = new Set<string>();
      let unreadable = 0;
      const fresh = recent
        .filter((g) => {
          let gameId = '';
          try {
            // R07: Quellidentität = stabile Partie-ID aus den PGN-Metadaten
            gameId = parsePgnMetadata(g.pgn).id;
          } catch {
            unreadable++;
            gameId = '';
          }
          if (!gameId || existing.has(gameId) || seenInBatch.has(gameId)) return false;
          seenInBatch.add(gameId);
          return true;
        })
        .sort((a, b) => (a.endTime || 0) - (b.endTime || 0)); // älteste zuerst

      if (fresh.length === 0) {
        setStatusMsg(
          unreadable > 0
            ? tr(`Keine neuen Partien — ${unreadable} Partie(n) konnten nicht gelesen werden.`, `No new games — ${unreadable} game(s) could not be parsed.`)
            : tr('Keine neuen Partien in den letzten 30 Tagen — alles bereits geladen.', 'No new games in the last 30 days — everything is up to date.')
        );
        return;
      }
      if (cancelRef.current) return;

      // Sofort analysieren + speichern
      setIsAnalyzing(true);
      let saved = 0;
      let failed = 0;
      let cancelled = false;

      for (let i = 0; i < fresh.length; i++) {
        if (cancelRef.current) {
          cancelled = true;
          break;
        }
        setBatch({ current: i + 1, total: fresh.length });
        try {
          const analyzed = await analyzePgnGame(
            fresh[i].pgn,
            depth,
            (current, total) => setProgress({ current, total }),
            () => cancelRef.current,
          );
          // T17: Abbruch nochmals vor dem finalen Speichern prüfen —
          // ein zuletzt analysiertes Spiel nicht gegen den Willen speichern.
          if (cancelRef.current) {
            cancelled = true;
            break;
          }
          if (fresh[i].endTime) analyzed.playedAt = new Date(fresh[i].endTime! * 1000).toISOString();
          await onAnalysisComplete(analyzed, false);
          saved++;
        } catch (err: unknown) {
          if (err instanceof AnalysisCancelledError) {
            cancelled = true;
            break;
          }
          console.error('Chess.com-Import: Partie fehlgeschlagen', err);
          failed++;
        }
      }

      setIsAnalyzing(false);
      setBatch(null);

      const unreadNote = unreadable > 0 ? tr(`, ${unreadable} nicht lesbar`, `, ${unreadable} unreadable`) : '';
      if (cancelled) {
        setStatusMsg(tr(`Abgebrochen — ${saved} von ${fresh.length} Partien gespeichert${unreadNote}.`, `Cancelled — ${saved} of ${fresh.length} games saved${unreadNote}.`));
      } else if (failed > 0) {
        setStatusMsg(tr(`${saved} Partien gespeichert, ${failed} übersprungen (Fehler)${unreadNote}.`, `${saved} games saved, ${failed} skipped (error)${unreadNote}.`));
      } else {
        onClose();
      }
    } catch (err: unknown) {
      setIsFetching(false);
      setIsAnalyzing(false);
      setBatch(null);
      setErrorMsg((err as Error).message || tr('Chess.com-Partien konnten nicht geladen werden.', 'Could not fetch games from Chess.com.'));
    }
  };

  const handleLatestGame = async () => {
    const api = window.electronAPI;
    if (!api) { setErrorMsg(tr('Chess.com-Import ist nur in der Desktop-App verfügbar.', 'Chess.com import is only available in the desktop app.')); return; }
    setErrorMsg(null);
    setStatusMsg(null);
    resetCancel();
    setBatch(null);
    setProgress({ current: 0, total: 0 });
    setIsFetching(true);
    try {
      const latest = await api.chesscom.fetchLatestGame(defaultPlayerName);
      if (cancelRef.current) return;
      if (!latest) { setStatusMsg(tr('Keine abgeschlossene Standardpartie auf Chess.com gefunden.', 'No completed standard game found on Chess.com.')); return; }
      const pgn = latest.timeClass ? `[TimeClass "${latest.timeClass}"]\n${latest.pgn}` : latest.pgn;
      setPgnText(pgn);
      const existing = await api.db.getGame(parsePgnMetadata(pgn).id);
      if (cancelRef.current) return;
      if (existing && isReliableGame(existing) && onOpenExistingGame) {
        await onOpenExistingGame(existing.id);
        if (!cancelRef.current) onClose();
        return;
      }
      setIsFetching(false);
      setIsAnalyzing(true);
      const game = await analyzePgnGame(pgn, depth, (current, total) => setProgress({ current, total }), () => cancelRef.current);
      if (cancelRef.current) return;
      if (latest.endTime) game.playedAt = new Date(latest.endTime * 1000).toISOString();
      await onAnalysisComplete(game, true);
    } catch (error) {
      if (error instanceof AnalysisCancelledError) setStatusMsg(tr('Analyse abgebrochen.', 'Analysis cancelled.'));
      else if (!cancelRef.current) setErrorMsg(error instanceof Error ? error.message : tr('Die letzte Partie konnte nicht geladen werden.', 'Could not load the latest game.'));
    } finally {
      setIsFetching(false);
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div role="dialog" aria-modal="true" aria-label={initialPgn ? tr('PGN erneut analysieren', 'Re-analyze PGN') : tr('Partien laden', 'Load Games')} className="modal-content" style={{ maxWidth: '620px' }}>
        {/* Header */}
        <div className="modal-header">
          <h2 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <FileText size={20} color="#81b64c" />
            <span>{initialPgn ? tr('PGN erneut analysieren', 'Re-analyze PGN') : tr('Partien laden', 'Load Games')}</span>
          </h2>
          {!isAnalyzing && !isFetching && (
            <button className="btn-icon" onClick={() => { cancelRef.current = true; onClose(); }}>
              <X size={18} />
            </button>
          )}
        </div>

        {!initialPgn && <section style={{ border: '1px solid #2e2b24', borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <p style={{ fontSize: '0.85rem', color: '#a8a6a0', marginBottom: 10 }}>{tr('Von Chess.com laden', 'Fetch from Chess.com')} · {defaultPlayerName}</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn-secondary" disabled={isAnalyzing || isFetching || !defaultPlayerName.trim()} onClick={handleLatestGame}
              title={tr('Öffnet genau deine zuletzt abgeschlossene Standardpartie. Bereits vorhandene Analysen werden direkt geöffnet.', 'Opens your latest completed standard game directly.')}>
              <CloudDownload size={16} /> {tr('Nur letzte Partie laden', 'Load latest game')}
            </button>
            <button type="button" className="btn-secondary btn-sm" disabled={isAnalyzing || isFetching || !defaultPlayerName.trim()} onClick={handleChessComImport}>
              {isFetching ? <Loader2 size={14} className="spin" /> : <CloudDownload size={14} />}
              {isFetching ? tr('Lade …', 'Loading…') : tr('Neue Partien (30 Tage)', 'New games (30 days)')}
            </button>
          </div>
        </section>}

        {/* Text Area */}
        <div style={{ marginBottom: '14px' }}>
          <label style={{ display: 'block', fontSize: '0.85rem', color: '#a8a6a0', marginBottom: '6px' }}>
            {tr('Füge deinen PGN-Text von Chess.com oder Lichess hier ein:', 'Paste your PGN from Chess.com or Lichess:')}
          </label>
          <textarea
            value={pgnText}
            onChange={(e) => setPgnText(e.target.value)}
            disabled={isAnalyzing || isFetching}
            placeholder="[Event &quot;Live Chess&quot;]&#10;1. e4 e5 2. Nf3 Nc6..."
            style={{
              width: '100%',
              height: '180px',
              backgroundColor: '#161512',
              border: '1px solid #2e2b24',
              borderRadius: '8px',
              color: '#ffffff',
              padding: '12px',
              fontFamily: 'monospace',
              fontSize: '0.85rem',
              resize: 'vertical',
            }}
          />
        </div>

        {/* Depth & Quick Sample Options */}
        <div className="pgn-options-row">
          <div className="pgn-depth-group">
            <span>{tr('Tiefe:', 'Depth:')}</span>
            <select
              value={depth}
              onChange={(e) => setDepth(Number(e.target.value))}
              disabled={isAnalyzing || isFetching}
            >
              <option value={12}>{tr('Schnell (Tiefe 12)', 'Fast (Depth 12)')}</option>
              <option value={14}>{tr('Ausgewogen (Tiefe 14 - Empfohlen)', 'Balanced (Depth 14 - Recommended)')}</option>
              <option value={18}>{tr('Tiefgründig (Tiefe 18)', 'Deep (Depth 18)')}</option>
            </select>
          </div>

        </div>

        {statusMsg && (
          <div style={{ background: '#2d4a1e', border: '1px solid #4a7a2e', color: '#b5d48a', padding: '9px 12px', borderRadius: '8px', fontSize: '0.82rem', marginBottom: '14px' }}>
            {statusMsg}
          </div>
        )}

        {errorMsg && (
          <div style={{ background: '#ca343122', border: '1px solid #ca3431', color: '#ff7b78', padding: '10px 14px', borderRadius: '8px', marginBottom: '16px', fontSize: '0.85rem' }}>
            {errorMsg}
          </div>
        )}

        {/* Progress Bar when analyzing */}
        {isAnalyzing && (
          <div style={{ marginBottom: '18px' }}>
            <div className="pgn-progress-row">
              <span className="pgn-progress-label">
                <Loader2 size={14} className="spin" />
                {batch
                  ? tr(`Partie ${batch.current} von ${batch.total} · Zug ${progress.current}/${progress.total}`, `Game ${batch.current} of ${batch.total} · Move ${progress.current}/${progress.total}`)
                  : tr(`Stockfish analysiert Partie... Zug ${progress.current} von ${progress.total}`, `Stockfish analyzing game… Move ${progress.current} of ${progress.total}`)}
              </span>
              <button type="button" className="btn-cancel" onClick={requestCancel} disabled={cancelRequested}>
                <Ban size={14} /> {cancelRequested ? tr('Abbrechen...', 'Cancelling...') : tr('Abbrechen', 'Cancel')}
              </button>
            </div>
            <div style={{ width: '100%', height: '8px', background: '#24231e', borderRadius: '4px', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  background: '#81b64c',
                  width: `${(progress.current / (progress.total || 1)) * 100}%`,
                  transition: 'width 0.15s ease',
                }}
              />
            </div>
          </div>
        )}

        {/* Submit */}
        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            className="btn-primary"
            disabled={isAnalyzing || isFetching || !pgnText.trim()}
            onClick={handleStartAnalysis}
            style={{ flex: 1, padding: '12px' }}
          >
            {isAnalyzing ? (
              <>
                <Loader2 size={18} />
                <span>{tr(`Analysiere (${progress.current}/${progress.total})...`, `Analyzing (${progress.current}/${progress.total})...`)}</span>
              </>
            ) : (
              <>
                <Play size={18} />
                <span>{tr('Analyse starten', 'Start Analysis')}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
