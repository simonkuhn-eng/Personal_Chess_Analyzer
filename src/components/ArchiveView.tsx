import React, { useEffect, useRef, useState } from 'react';
import { ArchiveItem } from '../types/chess';
import { resolvePlayerColor } from '../utils/moveInsights';
import { Search, FolderKanban, Trash2, ChevronRight, Trophy, Plus, CloudDownload } from 'lucide-react';
import { QualityBadge } from './QualityBadge';
import { needsBrilliantScan, scanBrilliantMoves } from '../utils/brilliantMoves';
import { useI18n } from '../utils/i18n';

interface ArchiveViewProps {
  games: ArchiveItem[];
  onOpenGame: (id: string, ply?: number) => void;
  onDeleteGame: (id: string) => void;
  onNewImport: () => void;
  onChessComImport: () => void;
  targetPlayer: string;
  engineDepth: number;
  onArchiveUpdated: () => void;
}

export const ArchiveView: React.FC<ArchiveViewProps> = ({
  games,
  onOpenGame,
  onDeleteGame,
  onNewImport,
  onChessComImport,
  targetPlayer,
  engineDepth,
  onArchiveUpdated,
}) => {
  const { tr } = useI18n();
  const [searchTerm, setSearchTerm] = useState('');
  const [filterResult, setFilterResult] = useState<'all' | 'win' | 'loss' | 'draw'>('all');
  const [onlyBrilliant, setOnlyBrilliant] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState('');
  const scanEpoch = useRef(0);
  useEffect(() => {
    setScanning(false);
    setScanMessage('');
    return () => { scanEpoch.current++; };
  }, [targetPlayer]);
  const ownBrilliants = (game: ArchiveItem) => {
    const color = resolvePlayerColor(game.white, game.black, targetPlayer, game.site);
    return color ? (game.brilliantMoves || []).filter(move => move.color === color) : [];
  };
  const unchecked = games.filter(game => resolvePlayerColor(game.white, game.black, targetPlayer, game.site) && needsBrilliantScan(game, engineDepth));
  const totalBrilliant = games.reduce((sum, game) => sum + ownBrilliants(game).length, 0);
  const scanArchive = async () => {
    const api = window.electronAPI;
    if (!api) { setScanMessage(tr('Für die Prüfung ist die Desktop-App mit Stockfish erforderlich.', 'Scanning requires the desktop app with Stockfish.')); return; }
    const epoch = ++scanEpoch.current;
    setScanning(true);
    let saved = 0;
    try {
      for (const [index, item] of unchecked.entries()) {
        if (epoch !== scanEpoch.current) return;
        setScanMessage(tr(`Prüfe Partie ${index + 1} von ${unchecked.length} …`, `Scanning game ${index + 1} of ${unchecked.length}…`));
        const game = await api.db.getGame(item.id);
        if (!game) continue;
        const checked = await scanBrilliantMoves(game, api.engine, engineDepth, () => epoch !== scanEpoch.current,
          (current, total) => { if (epoch === scanEpoch.current) setScanMessage(tr(`Partie ${index + 1} von ${unchecked.length} · Figurenopfer ${current} von ${total}`, `Game ${index + 1} of ${unchecked.length} · Sacrifice ${current} of ${total}`)); });
        if (epoch !== scanEpoch.current) return;
        const latest = await api.db.getGame(item.id);
        if (epoch !== scanEpoch.current) return;
        // Don't recreate a deleted game or replace a concurrently reanalysed game.
        if (!latest || latest.pgn !== game.pgn || JSON.stringify(latest.moves) !== JSON.stringify(game.moves)) continue;
        await api.db.saveGame(checked);
        saved++;
      }
      if (epoch === scanEpoch.current) setScanMessage(tr(`${saved} Partien geprüft. Unvollständige Prüfungen können erneut gestartet werden.`, `${saved} games scanned. Incomplete scans can be resumed anytime.`));
    } catch (error) {
      if (epoch === scanEpoch.current) setScanMessage(tr(`Prüfung gestoppt: ${error instanceof Error ? error.message : String(error)} (${saved} Partien gespeichert).`, `Scan stopped: ${error instanceof Error ? error.message : String(error)} (${saved} games saved).`));
    } finally {
      if (epoch === scanEpoch.current) { setScanning(false); onArchiveUpdated(); }
    }
  };

  const filteredGames = games.filter((g) => {
    if (onlyBrilliant && ownBrilliants(g).length === 0) return false;
    const term = searchTerm.toLowerCase();
    const matchesSearch =
      g.white.toLowerCase().includes(term) ||
      g.black.toLowerCase().includes(term) ||
      (g.openingName && g.openingName.toLowerCase().includes(term)) ||
      (g.eco && g.eco.toLowerCase().includes(term));

    if (!matchesSearch) return false;

    if (filterResult === 'all') return true;
    // T13: exakter Resolver — Substring-Match würde 'SpielerA' mit
    // 'SpielerA2' verwechseln; ohne eigenen Spieler keine Farbannahme.
    const userColor = resolvePlayerColor(g.white, g.black, targetPlayer, g.site);

    if (filterResult === 'win') {
      return (g.result === '1-0' && userColor === 'w') || (g.result === '0-1' && userColor === 'b');
    }
    if (filterResult === 'loss') {
      return (g.result === '0-1' && userColor === 'w') || (g.result === '1-0' && userColor === 'b');
    }
    if (filterResult === 'draw') {
      return g.result === '1/2-1/2';
    }
    return true;
  });

  return (
    <div className="archive-view" style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Top Controls */}
      <div
        className="archive-top-controls"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '16px',
          gap: '16px',
          flexWrap: 'wrap',
        }}
      >
        {/* Search */}
        <div className="archive-search-box" style={{ position: 'relative', flex: 1, maxWidth: '400px' }}>
          <Search
            size={18}
            color="#a8a6a0"
            style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }}
          />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={tr('Nach Gegner, Eröffnung oder ECO suchen...', 'Search opponent, opening, or ECO...')}
            style={{
              width: '100%',
              backgroundColor: '#1c1b18',
              border: '1px solid #2e2b24',
              borderRadius: '8px',
              padding: '10px 14px 10px 38px',
              color: '#ffffff',
              fontSize: '0.88rem',
            }}
          />
        </div>

        {/* Filter Pills */}
        <div className="archive-filter-pills" style={{ display: 'flex', gap: '8px' }}>
          {(['all', 'win', 'loss', 'draw'] as const).map((mode) => (
            <button
              key={mode}
              className={`nav-btn ${filterResult === mode ? 'active' : ''}`}
              onClick={() => setFilterResult(mode)}
              style={{ padding: '6px 14px', fontSize: '0.82rem' }}
            >
              {mode === 'all' && tr('Alle Partien', 'All Games')}
              {mode === 'win' && tr('Siege', 'Wins')}
              {mode === 'loss' && tr('Niederlagen', 'Losses')}
              {mode === 'draw' && tr('Remis', 'Draws')}
            </button>
          ))}
        </div>

        <div className="archive-actions-row" style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button className="btn-secondary" disabled={scanning} onClick={onChessComImport} style={{ padding: '8px 16px' }} title={tr('Alle neuen Partien des Monats von chess.com laden', 'Fetch all new games for this month from Chess.com')}>
            <CloudDownload size={16} />
            <span>{tr('Neue chess.com-Partien', 'Fetch Chess.com')}</span>
          </button>

          <button className="btn-primary" disabled={scanning} onClick={onNewImport} style={{ padding: '8px 16px' }}>
            <Plus size={16} />
            <span>{tr('Partien laden', 'Import PGN')}</span>
          </button>
        </div>
      </div>

      <div className="archive-highlights-bar">
        <label className="archive-brilliant-filter"><input type="checkbox" checked={onlyBrilliant} onChange={event => setOnlyBrilliant(event.target.checked)} /><QualityBadge quality="brilliant" /> {tr('Nur eigene brillante Partien', 'Only my brilliant games')} <span>({totalBrilliant} {tr('Züge', 'moves')})</span></label>
        <span className="archive-brilliant-description" title={tr('Lokale, konservative Bewertung: sehr guter Zug mit Figurenopfer und bestätigter Kompensation; kein bereits klar gewinnender Zug ohne Opfer. Keine exakte Nachbildung der Chess.com-Klassifizierung.', 'Local conservative detector: strong piece sacrifice with verified compensation (excludes already winning non-sacrifices).')}>{tr('Sehr gutes Figurenopfer mit Kompensation', 'Sound piece sacrifice with compensation')}</span>
        {scanning ? <button className="btn-secondary" onClick={() => { scanEpoch.current++; setScanning(false); setScanMessage(tr('Prüfung abgebrochen. Bereits gespeicherte Ergebnisse bleiben erhalten.', 'Scan cancelled. Saved results were kept.')); onArchiveUpdated(); }}>{tr('Abbrechen', 'Cancel')}</button> :
          <button className="btn-secondary" disabled={!unchecked.length} onClick={() => void scanArchive()} title={tr('Prüft vorhandene Analysen auf brillante Züge; nur mögliche Figurenopfer benötigen zusätzliche Engine-Suchen.', 'Scans analyzed games for brilliant sacrifices using targeted engine verification.')}>{tr('Brillanz prüfen', 'Scan brilliancies')}{unchecked.length ? ` (${unchecked.length})` : ''}</button>}
      </div>
      {scanMessage && <p className="archive-scan-status" role="status">{scanMessage}</p>}

      {/* Games Table */}
      <div
        className="archive-table-container"
        style={{
          flex: 1,
          backgroundColor: '#1c1b18',
          border: '1px solid #2e2b24',
          borderRadius: '12px',
          overflowY: 'auto',
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.3)',
        }}
      >
        {filteredGames.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: '#a8a6a0' }}>
            <FolderKanban size={48} color="#7d7b74" style={{ margin: '0 auto 16px' }} />
            <h3 style={{ color: '#ffffff', marginBottom: '8px' }}>
              {onlyBrilliant
                ? tr('Keine brillanten Züge in dieser Auswahl', 'No brilliant moves in this selection')
                : games.length
                  ? tr('Keine passenden Partien', 'No matching games')
                  : tr('Keine gespeicherten Partien gefunden', 'No saved games found')}
            </h3>
            <p style={{ fontSize: '0.9rem', marginBottom: '16px' }}>
              {onlyBrilliant
                ? tr('Vorhandene Partien mit „Brillanz prüfen“ untersuchen. Nicht geprüfte Partien sind mit „–“ gekennzeichnet.', 'Run "Scan brilliancies" on existing games. Unchecked games show "–".')
                : games.length
                  ? tr('Passe die Suche oder die Ergebnisfilter an.', 'Adjust your search query or result filters.')
                  : tr('Importiere ein PGN, um Partien automatisch in deiner persönlichen Datenbank abzuspeichern.', 'Import a PGN to analyze and store games in your local database.')}
            </p>
            {!games.length && <button className="btn-primary" onClick={onNewImport} style={{ margin: '0 auto' }}>
              {tr('Erste Partie analysieren', 'Analyze first game')}
            </button>}
          </div>
        ) : (
          <table className="archive-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.88rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #2b2922', color: '#a8a6a0', fontSize: '0.76rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                <th style={{ padding: '10px 12px' }}>{tr('Datum', 'Date')}</th>
                <th style={{ padding: '10px 12px' }}>{tr('Partie', 'Game')}</th>
                <th style={{ padding: '10px 12px' }}>{tr('Eröffnung', 'Opening')}</th>
                <th style={{ padding: '10px 12px' }}>{tr('Ergebnis', 'Result')}</th>
                <th style={{ padding: '10px 12px' }}>{tr('Genauigkeit', 'Accuracy')}</th>
                <th style={{ padding: '10px 12px' }}>{tr('Eigene Patzer', 'Blunders')}</th>
                <th style={{ padding: '10px 12px' }}>{tr('Eigene brillante Züge', 'Brilliancies')}</th>
                <th style={{ padding: '10px 12px', textAlign: 'right' }}>{tr('Aktionen', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredGames.map((game) => {
                // T13: exakter Resolver; bei fremden Partien (Spieler nicht
                // beteiligt) ehrlich "–" statt der falschen Farb-Accuracy.
                const userColor = resolvePlayerColor(game.white, game.black, targetPlayer, game.site);
                const brilliants = ownBrilliants(game);
                const playerAcc = userColor === 'w' ? game.accuracyWhite : game.accuracyBlack;
                const isDraw = game.result === '1/2-1/2';
                const isWin = !isDraw && ((game.result === '1-0' && userColor === 'w') || (game.result === '0-1' && userColor === 'b'));

                return (
                  <tr
                    key={game.id}
                    style={{
                      borderBottom: '1px solid #24231e',
                      cursor: 'pointer',
                      transition: 'background 0.15s ease',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = '#24231e')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    onClick={() => onOpenGame(game.id)}
                  >
                    <td data-label={tr('Datum', 'Date')} style={{ padding: '9px 12px', color: '#a8a6a0', fontSize: '0.8rem' }}>
                      {game.date}
                      {game.analysisPartial && <small className="analysis-warning">{tr('Analyse unvollständig', 'Partial analysis')}</small>}
                    </td>

                    <td data-label={tr('Partie', 'Game')} style={{ padding: '9px 12px' }}>
                      <div style={{ fontWeight: 600, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                        <span>{game.white}</span>
                        <span style={{ color: '#7d7b74' }}>vs</span>
                        <span>{game.black}</span>
                      </div>
                    </td>

                    <td data-label={tr('Eröffnung', 'Opening')} style={{ padding: '9px 12px', color: '#cbc9c4' }}>
                      <div style={{ fontWeight: 600 }}>{game.openingName}</div>
                      <div style={{ fontSize: '0.75rem', color: '#81b64c' }}>{game.eco}</div>
                    </td>

                    <td data-label={tr('Ergebnis', 'Result')} style={{ padding: '9px 12px' }}>
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          padding: '2px 7px',
                          borderRadius: '6px',
                          fontSize: '0.78rem',
                          fontWeight: 700,
                          backgroundColor: isDraw ? 'rgba(213, 164, 80, 0.15)' : isWin ? 'rgba(129, 182, 76, 0.15)' : 'rgba(202, 52, 49, 0.15)',
                          color: isDraw ? '#d5a450' : isWin ? '#81b64c' : '#ff7b78',
                        }}
                      >
                        {isWin && <Trophy size={12} />}
                        {game.result}
                      </span>
                    </td>

                    <td data-label={tr('Genauigkeit', 'Accuracy')} style={{ padding: '9px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontWeight: 800, color: '#81b64c' }}>{userColor && !game.analysisPartial ? `${playerAcc}%` : '–'}</span>
                        <div className="archive-acc-bar" style={{ width: '50px', height: '4px', background: '#2e2b24', borderRadius: '2px', overflow: 'hidden' }}>
                          <div style={{ height: '100%', background: '#81b64c', width: `${userColor && !game.analysisPartial ? playerAcc : 0}%` }} />
                        </div>
                      </div>
                    </td>

                    <td data-label={tr('Patzer', 'Blunders')} style={{ padding: '9px 12px' }}>
                      <span style={{ color: game.blunderCount > 0 ? '#ca3431' : '#81b64c', fontWeight: 700 }}>
                        {userColor && !game.analysisPartial ? game.blunderCount : '–'}
                      </span>
                    </td>

                    <td data-label={tr('Brillant', 'Brilliant')} className="archive-brilliant-cell" onClick={event => event.stopPropagation()}>
                      {brilliants.length ? <div className="archive-brilliant-links"><span className="archive-brilliant-count"><QualityBadge quality="brilliant" />{brilliants.length}</span>{brilliants.map(move => <button type="button" className="archive-brilliant-move" key={move.ply} onClick={() => onOpenGame(game.id, move.ply)} title={tr(`Brillanten Zug ${move.moveNumber}${move.color === 'b' ? '…' : '.'} ${move.san} öffnen`, `Open brilliant move ${move.moveNumber}${move.color === 'b' ? '…' : '.'} ${move.san}`)}>{move.moveNumber}{move.color === 'b' ? '…' : '.'} {move.san}</button>)}</div> : <span title={userColor && needsBrilliantScan(game, engineDepth) ? tr('Noch nicht vollständig auf brillante Züge geprüft', 'Not yet fully scanned for brilliant moves') : undefined}>{userColor && !needsBrilliantScan(game, engineDepth) ? '0' : '–'}</span>}
                    </td>

                    <td data-label={tr('Aktionen', 'Actions')} className="archive-actions-cell" style={{ padding: '9px 12px', textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '6px' }} onClick={(e) => e.stopPropagation()}>
                        <button
                          className="btn-icon archive-open-btn"
                          onClick={() => onOpenGame(game.id)}
                          title={tr('Partie öffnen', 'Open game')}
                        >
                          <ChevronRight size={16} />
                        </button>
                        <button
                          className="btn-icon archive-delete-btn"
                          onClick={() => {
                            if (window.confirm(tr(`Partie ${game.white} vs. ${game.black} wirklich löschen?`, `Delete game ${game.white} vs. ${game.black}?`))) {
                              onDeleteGame(game.id);
                            }
                          }}
                          title={tr('Löschen', 'Delete')}
                          disabled={scanning}
                        >
                          <Trash2 size={16} color="#ff7b78" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
