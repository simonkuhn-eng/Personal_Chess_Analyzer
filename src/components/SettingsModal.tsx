import React, { useEffect, useState } from 'react';
import { AppSettings, ReviewScheduleConfig } from '../types/chess';
import { loadReviews, recalculateDueAts, saveReviews, scheduleIntervalsMs } from '../utils/reviews';
import { X, FolderOpen, FileCode, CheckCircle, AlertTriangle, Save, CloudDownload, HardDrive, User, Cpu, SlidersHorizontal, Globe } from 'lucide-react';
import { snapshotLearningStorage, replaceLearningStorage } from '../utils/learningStorage';
import { LanSyncPanel } from './LanSyncPanel';
import { useI18n } from '../utils/i18n';

type SettingsSectionTab = 'profile' | 'engine' | 'training' | 'data';

const SETTINGS_TABS: Array<{ id: SettingsSectionTab; labelDe: string; labelEn: string; Icon: React.ComponentType<{ size?: number }> }> = [
  { id: 'profile', labelDe: 'Profil & Sync', labelEn: 'Profile & Sync', Icon: User },
  { id: 'engine', labelDe: 'Analyse & Engine', labelEn: 'Analysis & Engine', Icon: Cpu },
  { id: 'training', labelDe: 'Brett & Training', labelEn: 'Board & Training', Icon: SlidersHorizontal },
  { id: 'data', labelDe: 'Daten & Backup', labelEn: 'Data & Backup', Icon: HardDrive },
];

interface SettingsModalProps {
  settings: AppSettings;
  engineStatus: { installed: boolean; path: string; engineName: string; ready?: boolean };
  onClose: () => void;
  onSave: (newSettings: Partial<AppSettings>) => void | Promise<void>;
  onOpenEngineFolder: () => void;
  onSelectStockfishFile: () => Promise<string | null>;
}

/** Phase 6: klarer Abschnitts-Wrapper — per Tastatur bedienbar (natives HTML). */
const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section aria-label={title}>
    <h3 style={{ fontSize: '0.78rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#7d7b74', margin: '0 0 10px', fontWeight: 700 }}>
      {title}
    </h3>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>{children}</div>
  </section>
);

const fieldLabelStyle: React.CSSProperties = { display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#ffffff', marginBottom: '6px' };
const inputStyle: React.CSSProperties = {
  width: '100%',
  backgroundColor: '#161512',
  border: '1px solid #2e2b24',
  borderRadius: '8px',
  padding: '10px 14px',
  color: '#ffffff',
  fontSize: '0.9rem',
};
const hintStyle: React.CSSProperties = { fontSize: '0.78rem', color: '#a8a6a0', marginTop: '4px', display: 'block', lineHeight: 1.4 };

interface SyncInfo {
  username: string;
  at: number;
  savedCount: number;
  failedCount: number;
  newCount: number;
}

const accountCardStyle: React.CSSProperties = { background: '#24231e', border: '1px solid #2e2b24', borderRadius: '10px', padding: '14px' };

/** Phase 6: getrenntes Konto je Plattform (Brief-Punkt 3) — Eingabe + Sync-Status. */
const AccountSyncBlock: React.FC<{
  platformLabel: string;
  username: string;
  onUsernameChange: (value: string) => void;
  placeholder: string;
  lastSync: SyncInfo | null;
  busy: boolean;
  message: string | null;
  onSync: () => void;
}> = ({ platformLabel, username, onUsernameChange, placeholder, lastSync, busy, message, onSync }) => {
  const { tr, lang } = useI18n();
  return (
    <div style={accountCardStyle}>
      <label style={fieldLabelStyle}>{platformLabel}-{tr('Benutzername', 'Username')}</label>
      <input
        type="text"
        value={username}
        onChange={(e) => onUsernameChange(e.target.value)}
        placeholder={placeholder}
        style={inputStyle}
      />
      <div style={{ fontSize: '0.78rem', color: '#a8a6a0', marginTop: '8px', marginBottom: '10px', lineHeight: '1.4' }}>
        {lastSync
          ? `${tr('Letzter erfolgreicher Sync', 'Last successful sync')}: ${new Date(lastSync.at).toLocaleString(lang === 'en' ? 'en-US' : 'de-DE')} — ${lastSync.newCount} ${tr('neu gespeichert', 'saved')}, ${lastSync.failedCount} ${tr('fehlgeschlagen', 'failed')} (${lastSync.username}).`
          : tr('Noch kein Sync durchgeführt. Neue Partien werden als Hintergrund-Job analysiert.', 'No sync yet. New games are analyzed as a background job.')}
      </div>
      <button className="btn-secondary" onClick={onSync} disabled={busy || !username.trim()} style={{ width: '100%' }}>
        <CloudDownload size={16} />
        <span>{busy ? tr('Startet …', 'Starting …') : lastSync ? tr('Erneut synchronisieren', 'Sync again') : tr('Jetzt synchronisieren', 'Sync now')}</span>
      </button>
      {message && <div style={hintStyle}>{message}</div>}
    </div>
  );
};

export const SettingsModal: React.FC<SettingsModalProps> = ({
  settings,
  engineStatus,
  onClose,
  onSave,
  onOpenEngineFolder,
  onSelectStockfishFile,
}) => {
  const { tr } = useI18n();
  const [languageDraft, setLanguageDraft] = useState<'de' | 'en'>(settings.language === 'en' ? 'en' : 'de');
  useEffect(() => {
    setLanguageDraft(settings.language === 'en' ? 'en' : 'de');
  }, [settings.language]);
  // Phase 6: Änderungen zunächst lokal im Formular halten, dann gesammelt persistieren.
  const [playerName, setPlayerName] = useState(settings.playerName);
  // Phase 6: getrennte Plattform-Konten (Brief-Punkt 3) — keine Auto-Migration
  // aus dem Spielerprofil, weil die Quelle nicht eindeutig ermittelbar ist.
  const [chessComUsername, setChessComUsername] = useState(settings.chessComUsername);
  const [lichessUsername, setLichessUsername] = useState(settings.lichessUsername);
  // Phase 6 W3: Wiederholungsabstände (Brief-Punkt 6) — Draft + explizite
  // Neuberechnung; Preset-Wechsel ändert bestehende dueAt-Werte NICHT.
  const [scheduleDraft, setScheduleDraft] = useState<ReviewScheduleConfig>(settings.trainingSchedule);
  const [customDaysInput, setCustomDaysInput] = useState<string>(() =>
    settings.trainingSchedule.mode === 'custom' ? (settings.trainingSchedule.intervalsDays ?? []).join(', ') : ''
  );
  const [recalcMsg, setRecalcMsg] = useState<string | null>(null);
  const [recalcBusy, setRecalcBusy] = useState(false);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const formatIntervalMs = (ms: number): string =>
    ms < 24 * 60 * 60 * 1000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / (24 * 60 * 60 * 1000))} d`;
  const [depth, setDepth] = useState(settings.engineDepth);
  const [openingWindow, setOpeningWindow] = useState(settings.openingWindowMoves || 12);
  const [threads, setThreads] = useState(settings.engineThreads);
  const [hashMb, setHashMb] = useState(settings.engineHashMb);
  const [soundEnabled, setSoundEnabled] = useState(settings.soundEnabled);
  const [bestArrows, setBestArrows] = useState(settings.showBestMoveArrows);
  const [threatArrows, setThreatArrows] = useState(settings.showThreatArrows);
  const [autoSyncOnStartup, setAutoSyncOnStartup] = useState(settings.autoSyncOnStartup);
  const [autoAnalyzeNewGames, setAutoAnalyzeNewGames] = useState(settings.autoAnalyzeNewGames);
  useEffect(() => {
    setAutoSyncOnStartup(settings.autoSyncOnStartup);
    setAutoAnalyzeNewGames(settings.autoAnalyzeNewGames);
  }, [settings.autoSyncOnStartup, settings.autoAnalyzeNewGames]);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeSection, setActiveSection] = useState<SettingsSectionTab>('profile');
  const [dataPath, setDataPath] = useState<string | null>(null);

  // T16: Pipeline-Status je Plattform — letzter erfolgreicher Sync
  const [lastSyncBy, setLastSyncBy] = useState<{ chesscom: SyncInfo | null; lichess: SyncInfo | null }>({ chesscom: null, lichess: null });
  const [syncBusyBy, setSyncBusyBy] = useState<'chesscom' | 'lichess' | null>(null);
  const [syncMsgBy, setSyncMsgBy] = useState<{ chesscom: string | null; lichess: string | null }>({ chesscom: null, lichess: null });
  useEffect(() => {
    const api = window.electronAPI;
    api?.chesscom?.listJobs().then((data) => setLastSyncBy((prev) => ({ ...prev, chesscom: data.lastSync || null }))).catch(() => undefined);
    api?.lichess?.listJobs().then((data) => setLastSyncBy((prev) => ({ ...prev, lichess: data.lastSync || null }))).catch(() => undefined);
    api?.data?.getPath().then(setDataPath).catch(() => undefined);
  }, []);
  // T21: Escape schließt den Dialog (konsistent mit dem X-Button)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const handleSync = async (platform: 'chesscom' | 'lichess') => {
    const api = window.electronAPI;
    if (!api || syncBusyBy) return;
    const username = (platform === 'chesscom' ? chessComUsername : lichessUsername).trim();
    if (!username) return;
    setSyncBusyBy(platform);
    setSyncMsgBy((s) => ({ ...s, [platform]: null }));
    try {
      await onSave({ playerName: playerName.trim() || 'Mein Profil', chessComUsername: chessComUsername.trim(), lichessUsername: lichessUsername.trim() });
      if (platform === 'chesscom') {
        // T17: Profil-Check zuerst — 404 des Archivs ≠ „Nutzer existiert nicht“
        const profile = await api.chesscom.fetchUserProfile(username);
        if (!profile.exists) throw new Error(`chess.com-Account "${username}" wurde nicht gefunden.`);
        await api.chesscom.createJob(username, 30);
      } else {
        // Lichess: Discovery meldet 404 für unbekannte Accounts selbst.
        await api.lichess.createJob(username, 30);
      }
      window.dispatchEvent(new Event('pca-pipeline-kick'));
      setSyncMsgBy((s) => ({ ...s, [platform]: 'Hintergrund-Sync gestartet — neue Partien erscheinen automatisch im Archiv.' }));
    } catch (err) {
      setSyncMsgBy((s) => ({ ...s, [platform]: `Fehler: ${err instanceof Error ? err.message : String(err)}` }));
    } finally {
      setSyncBusyBy(null);
    }
  };

  // ── Phase 6 W3: Training (Brief-Punkt 6) ──
  // Eigene Intervall-Tage parsen: nur vollständige gültige Listen (≥2 Stufen)
  // schalten auf custom um, sonst bleibt der gewählte Preset aktiv.
  const handleCustomDaysChange = (value: string) => {
    setCustomDaysInput(value);
    const days = value
      .split(',')
      .map((part) => parseFloat(part.trim()))
      .filter((n) => Number.isFinite(n) && n >= 10 / 1440 && n <= 365)
      .slice(0, 8);
    if (days.length >= 2) {
      setScheduleDraft({ mode: 'custom', preset: scheduleDraft.preset, intervalsDays: days });
    } else if (scheduleDraft.mode === 'custom') {
      setScheduleDraft({ mode: 'preset', preset: scheduleDraft.preset });
    }
  };

  // Explizite Neuberechnung: lastReviewedAt + aktive Stufe — als bewusste
  // Aktion (nicht beim bloßen Preset-Wechsel), damit Fälligkeiten nicht
  // heimlich springen. R08-Kontrakt: fehlgeschlagenes Speichern → echte
  // Fehlermeldung, Store bleibt unverändert.
  const handleRecalculate = () => {
    if (recalcBusy) return;
    setRecalcBusy(true);
    setRecalcMsg(null);
    try {
      const name = settings.playerName;
      const store = loadReviews(name);
      const changed = recalculateDueAts(store, scheduleDraft, Date.now());
      if (!saveReviews(name, store)) {
        throw new Error('Speichern fehlgeschlagen (Speicher voll?) — Fälligkeiten unverändert.');
      }
      setRecalcMsg(changed > 0 ? `Fälligkeiten neu berechnet (${changed} Karten).` : 'Fälligkeiten waren bereits passend.');
    } catch (err) {
      setRecalcMsg(err instanceof Error ? err.message : 'Neuberechnung fehlgeschlagen.');
    } finally {
      setRecalcBusy(false);
    }
  };

  // Backup (Brief-Punkt 7): Kopie aller JSON-Datendateien in backups/<Zeitstempel>/
  // im Datenordner, einschliesslich Lernspeicher und portablem Restore-Paket.
  const handleBackup = async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    setBackupMsg(null);
    try {
      const api = window.electronAPI;
      if (!api?.data.createBackup) throw new Error('Backup nicht verfügbar (Electron-API fehlt).');
      const res = await api.data.createBackup(snapshotLearningStorage());
      setBackupMsg(`Backup erstellt: ${res.files} Datei(en) in ${res.path}`);
    } catch (err) {
      setBackupMsg(err instanceof Error ? err.message : 'Backup fehlgeschlagen.');
    } finally {
      setBackupBusy(false);
    }
  };

  const handleExport = async () => {
    setBackupBusy(true); setBackupMsg(null);
    try {
      const path = await window.electronAPI?.data.exportData(snapshotLearningStorage());
      if (path) setBackupMsg(`Vollständiges Backup exportiert: ${path}`);
    } catch (error) { setBackupMsg(error instanceof Error ? error.message : 'Export fehlgeschlagen.'); }
    finally { setBackupBusy(false); }
  };

  const handleRestore = async () => {
    const api = window.electronAPI;
    if (!api || backupBusy) return;
    setBackupBusy(true); setBackupMsg(null);
    let previous: Record<string, string> | undefined;
    try {
      const bundle = await api.data.inspectData();
      if (!bundle) return;
      if (!window.confirm(`Backup vom ${new Date(bundle.createdAt).toLocaleString('de-DE')}: ${bundle.games.length} Partien, Profil ${bundle.settings.playerName}, ${Object.keys(bundle.learningStorage).length} Lerneinträge.\n\nAktuelles Archiv, Einstellungen und Lernstände durch dieses Backup ersetzen? Eine Sicherung des aktuellen Zustands wird vorher erstellt.`)) return;
      window.dispatchEvent(new Event('pca-pause-pipelines'));
      await new Promise(resolve => window.setTimeout(resolve, 0));
      previous = snapshotLearningStorage();
      await api.data.createBackup(previous);
      replaceLearningStorage(bundle.learningStorage);
      await api.data.restoreData(bundle);
      window.location.reload();
    } catch (error) {
      if (previous) { try { replaceLearningStorage(previous); } catch { /* Recoverable from the full safety backup. */ } }
      setBackupMsg(error instanceof Error ? error.message : 'Wiederherstellung fehlgeschlagen.');
    } finally { setBackupBusy(false); window.dispatchEvent(new Event('pca-resume-pipelines')); }
  };

  /**
   * T05: Erfolg wird erst gemeldet, wenn die Persistenz ERFOLGREICH war —
   * ein abgelehntes Save (Schreibfehler, gesperrte Datei) zeigt jetzt einen
   * echten Fehler statt der alten Schein-Bestätigung.
   */
  const handleLanguageChange = async (nextLang: 'de' | 'en') => {
    setLanguageDraft(nextLang);
    setSaveError(null);
    try {
      await onSave({ language: nextLang });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : tr('Sprache konnte nicht gespeichert werden.', 'Could not save language setting.'));
    }
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({
        language: languageDraft,
        playerName: playerName.trim() || (languageDraft === 'en' ? 'My Profile' : 'Mein Profil'),
        chessComUsername: chessComUsername.trim(),
        lichessUsername: lichessUsername.trim(),
        trainingSchedule: scheduleDraft,
        engineDepth: depth,
        openingWindowMoves: openingWindow,
        engineThreads: threads,
        engineHashMb: hashMb,
        soundEnabled,
        showBestMoveArrows: bestArrows,
        showThreatArrows: threatArrows,
        autoSyncOnStartup,
        autoAnalyzeNewGames,
      });
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : tr('Einstellungen konnten nicht gespeichert werden.', 'Settings could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  const handleOpenDataFolder = async () => {
    const api = window.electronAPI;
    if (!api?.data?.openFolder) return;
    try {
      await api.data.openFolder();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Datenordner konnte nicht geöffnet werden.');
    }
  };

  return (
    <div className="modal-backdrop">
      <div role="dialog" aria-modal="true" aria-label={tr('Einstellungen', 'Settings')} className="modal-content settings-modal">
        <div className="modal-header">
          <h2 className="modal-title">{tr('Einstellungen', 'Settings')}</h2>
          <button className="btn-icon" onClick={onClose} aria-label={tr('Schließen', 'Close')}>
            <X size={18} />
          </button>
        </div>

        {/* Gegliederte Unterbereiche für Desktop & Mobile */}
        <div className="settings-tabs" role="tablist" aria-label={tr('Einstellungsbereiche', 'Settings sections')}>
          {SETTINGS_TABS.map(({ id, labelDe, labelEn, Icon }) => {
            const selected = activeSection === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={selected}
                className={`settings-tab-btn ${selected ? 'active' : ''}`}
                onClick={() => setActiveSection(id)}
              >
                <Icon size={15} />
                <span>{tr(labelDe, labelEn)}</span>
              </button>
            );
          })}
        </div>

        <div className="settings-modal-body" role="tabpanel">
          {activeSection === 'profile' && (
            <Section title={tr('Konten & Synchronisierung', 'Accounts & Synchronization')}>
              <div style={accountCardStyle}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, fontSize: '0.88rem', color: '#ffffff' }}>
                      <Globe size={15} color="#81b64c" />
                      <span>{tr('Sprache / Language', 'Language / Sprache')}</span>
                    </div>
                    <span style={{ display: 'block', fontSize: '0.76rem', color: '#a8a6a0', marginTop: '2px' }}>
                      {tr('Oberfläche sofort zwischen Deutsch und Englisch umschalten.', 'Switch the interface live between English and German.')}
                    </span>
                  </div>
                  <div style={{ display: 'inline-flex', background: '#161512', padding: '3px', borderRadius: '8px', border: '1px solid #2e2b24', gap: '4px' }} role="group" aria-label={tr('Sprache wählen', 'Select language')}>
                    <button
                      type="button"
                      className={languageDraft === 'de' ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
                      style={{ minWidth: '82px', justifyContent: 'center' }}
                      onClick={() => void handleLanguageChange('de')}
                    >
                      Deutsch
                    </button>
                    <button
                      type="button"
                      className={languageDraft === 'en' ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
                      style={{ minWidth: '82px', justifyContent: 'center' }}
                      onClick={() => void handleLanguageChange('en')}
                    >
                      English
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <label style={fieldLabelStyle}>{tr('Dein Spielername (lokales Profil)', 'Your Player Name (Local Profile)')}</label>
                <input
                  type="text"
                  value={playerName}
                  onChange={(e) => setPlayerName(e.target.value)}
                  placeholder={tr('Dein Anzeigename oder PGN-Spielername', 'Your display name or PGN player name')}
                  style={inputStyle}
                />
                <span style={hintStyle}>
                  {tr(
                    'Beide Plattformkonten gehören zu diesem Profil, auch mit unterschiedlichen Namen. Für manuelle PGNs wird zusätzlich dieser Spielername erkannt. Umbenennen erhält den Lernstand.',
                    'Both platform accounts belong to this profile, even with different usernames. Manual PGNs also match this player name. Renaming preserves your study history.',
                  )}
                </span>
              </div>

              <AccountSyncBlock
                platformLabel="chess.com"
                username={chessComUsername}
                onUsernameChange={setChessComUsername}
                placeholder={tr('z. B. hikaru', 'e.g. hikaru')}
                lastSync={lastSyncBy.chesscom}
                busy={syncBusyBy === 'chesscom'}
                message={syncMsgBy.chesscom}
                onSync={() => void handleSync('chesscom')}
              />
              <AccountSyncBlock
                platformLabel="Lichess"
                username={lichessUsername}
                onUsernameChange={setLichessUsername}
                placeholder={tr('z. B. drnykterstein', 'e.g. drnykterstein')}
                lastSync={lastSyncBy.lichess}
                busy={syncBusyBy === 'lichess'}
                message={syncMsgBy.lichess}
                onSync={() => void handleSync('lichess')}
              />
              <div style={{ ...accountCardStyle, display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', cursor: 'pointer' }}>
                  <span>
                    <span style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', color: '#ffffff' }}>
                      {tr('Beim App-Start automatisch nach neuen Partien suchen', 'Automatically check for new games on startup')}
                    </span>
                    <span style={{ display: 'block', fontSize: '0.78rem', color: '#a8a6a0', marginTop: '2px' }}>
                      {tr('Prüft beim Programmstart einmalig alle hinterlegten Plattformkonten auf neue Partien.', 'Checks all configured platform accounts once when the app starts.')}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={autoSyncOnStartup}
                    onChange={(e) => setAutoSyncOnStartup(e.target.checked)}
                    style={{ width: '18px', height: '18px', accentColor: '#81b64c', cursor: 'pointer', flexShrink: 0 }}
                  />
                </label>

                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', cursor: 'pointer' }}>
                  <span>
                    <span style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', color: '#ffffff' }}>
                      {tr('Neu gefundene Partien automatisch analysieren', 'Automatically analyze newly discovered games')}
                    </span>
                    <span style={{ display: 'block', fontSize: '0.78rem', color: '#a8a6a0', marginTop: '2px' }}>
                      {tr('Startet für beim Auto-Sync neu geladene Partien direkt die Stockfish-Analyse.', 'Starts Stockfish analysis immediately for games fetched during auto-sync.')}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={autoAnalyzeNewGames}
                    onChange={(e) => setAutoAnalyzeNewGames(e.target.checked)}
                    style={{ width: '18px', height: '18px', accentColor: '#81b64c', cursor: 'pointer', flexShrink: 0 }}
                  />
                </label>
              </div>
              <LanSyncPanel />
            </Section>
          )}

          {activeSection === 'engine' && (
            <Section title={tr('Analyse & Stockfish Engine', 'Analysis & Stockfish Engine')}>
              <div>
                <label style={fieldLabelStyle}>{tr('Standard-Analysetiefe', 'Default Analysis Depth')}</label>
                <select value={depth} onChange={(e) => setDepth(Number(e.target.value))} style={inputStyle}>
                  <option value={12}>{tr('Tiefe 12 (Sehr schnell)', 'Depth 12 (Very fast)')}</option>
                  <option value={14}>{tr('Tiefe 14 (Ausgewogen & genau - Empfohlen)', 'Depth 14 (Balanced & accurate - Recommended)')}</option>
                  <option value={18}>{tr('Tiefe 18 (Tiefgründige Meister-Analyse)', 'Depth 18 (Deep master-level analysis)')}</option>
                </select>
                <span style={hintStyle}>
                  {tr(
                    'Kosten pro Stufe: Tiefe 12 ≈ wenige Sekunden pro Zug, Tiefe 14 ≈ rund doppelt so lang (Empfehlung für Partieanalysen), Tiefe 18 ≈ deutlich mehr Rechenzeit — bei Hintergrund-Jobs entsprechend langsamer. Die Tiefe wird beim Job-Start festgehalten; ein späterer Wechsel ändert laufende Jobs nicht.',
                    'Time per level: Depth 12 takes a few seconds per game, Depth 14 is ~2x longer (recommended), Depth 18 takes noticeably longer for background jobs. Depth is fixed when a job starts.',
                  )}
                </span>
              </div>

              <div className="settings-two-col">
                <div style={{ flex: 1 }}>
                  <label style={fieldLabelStyle}>{tr('Engine-Threads', 'Engine Threads')}</label>
                  <select value={threads} onChange={(e) => setThreads(Number(e.target.value))} style={inputStyle}>
                    <option value={1}>{tr('1 Thread (Standard)', '1 Thread (Default)')}</option>
                    <option value={2}>2 Threads</option>
                    <option value={4}>4 Threads</option>
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={fieldLabelStyle}>Engine Hash (MB)</label>
                  <select value={hashMb} onChange={(e) => setHashMb(Number(e.target.value))} style={inputStyle}>
                    <option value={64}>64 MB</option>
                    <option value={128}>128 MB</option>
                    <option value={256}>256 MB</option>
                    <option value={512}>512 MB</option>
                  </select>
                </div>
              </div>

              <div style={{ background: '#24231e', border: '1px solid #2e2b24', borderRadius: '10px', padding: '14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.9rem', fontWeight: 700, color: '#ffffff' }}>Stockfish UCI Engine</span>
                  {engineStatus.installed ? (
                    <span style={{ color: '#81b64c', fontSize: '0.82rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <CheckCircle size={15} />
                      {engineStatus.engineName}
                      {engineStatus.ready ? tr(' aktiv', ' active') : tr(' bereit (startet bei Bedarf)', ' ready (starts on demand)')}
                    </span>
                  ) : (
                    <span style={{ color: '#e69d00', fontSize: '0.82rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <AlertTriangle size={15} />
                      {tr('Nicht gefunden (Fallback aktiv)', 'Not found (fallback active)')}
                    </span>
                  )}
                </div>

                <div style={{ fontSize: '0.82rem', color: '#a8a6a0', marginBottom: '12px', lineHeight: '1.4', wordBreak: 'break-all' }}>
                  {tr('Pfad:', 'Path:')} <code style={{ color: '#ffffff', background: '#161512', padding: '2px 6px', borderRadius: '4px' }}>{engineStatus.path}</code>
                </div>

                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  <button className="btn-secondary" onClick={onOpenEngineFolder} style={{ flex: 1, minWidth: '160px' }}>
                    <FolderOpen size={16} />
                    <span>{tr('Engine-Ordner öffnen', 'Open engine folder')}</span>
                  </button>
                  <button className="btn-secondary" onClick={onSelectStockfishFile} style={{ flex: 1, minWidth: '160px' }}>
                    <FileCode size={16} />
                    <span>{tr('stockfish.exe auswählen...', 'Select stockfish.exe...')}</span>
                  </button>
                </div>

                <div style={{ marginTop: '10px', fontSize: '0.78rem', color: '#7d7b74' }}>
                  {tr(
                    'Desktop: Windows x86-64-avx2 von stockfishchess.org als engine/stockfish.exe. Auf Android läuft Stockfish 10 WebAssembly direkt lokal im Hintergrund.',
                    'Desktop: Download Windows x86-64-avx2 from stockfishchess.org as engine/stockfish.exe. On Android, Stockfish 10 WebAssembly runs locally in the background.',
                  )}
                </div>
              </div>
              <span style={hintStyle}>
                {tr(
                  'Eine automatische Reanalyse läuft nur auf ausdrückliche Aktion — gespeicherte Partien werden nie im Hintergrund überschrieben.',
                  'Re-analysis only runs when explicitly requested — saved games are never silently overwritten in the background.',
                )}
              </span>
            </Section>
          )}

          {activeSection === 'training' && (
            <>
              <Section title={tr('Brett & Darstellung', 'Board & Display')}>
                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', cursor: 'pointer' }}>
                  <span>
                    <span style={{ display: 'block', fontWeight: 600, fontSize: '0.9rem', color: '#ffffff' }}>{tr('Beste Züge (grüne Pfeile)', 'Best moves (green arrows)')}</span>
                    <span style={{ display: 'block', fontSize: '0.78rem', color: '#a8a6a0', marginTop: '2px' }}>
                      {tr('Grün zeigt im Partie-Review die beste Möglichkeit für den zuletzt gespielten Zug.', 'Green highlights the engine best move for the position before the last played move.')}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={bestArrows}
                    onChange={(e) => setBestArrows(e.target.checked)}
                    style={{ width: '18px', height: '18px', accentColor: '#81b64c', cursor: 'pointer', flexShrink: 0 }}
                  />
                </label>

                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', cursor: 'pointer' }}>
                  <span>
                    <span style={{ display: 'block', fontWeight: 600, fontSize: '0.9rem', color: '#ffffff' }}>{tr('Angriffshinweise (orange Pfeile)', 'Threat hints (orange arrows)')}</span>
                    <span style={{ display: 'block', fontSize: '0.78rem', color: '#a8a6a0', marginTop: '2px' }}>
                      {tr(
                        'Markiert Angriffe auf König oder wertvolle Figuren der am Zug befindlichen Seite — kein Garant für Materialverlust. Zugfehler erscheinen als Badge, nicht als oranger Pfeil.',
                        'Highlights attacks on the king or high-value pieces of the side to move. Move errors appear as quality badges.',
                      )}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={threatArrows}
                    onChange={(e) => setThreatArrows(e.target.checked)}
                    style={{ width: '18px', height: '18px', accentColor: '#e69d00', cursor: 'pointer', flexShrink: 0 }}
                  />
                </label>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#ffffff' }}>{tr('Schach-Sounds', 'Board Sounds')}</div>
                    <div style={{ fontSize: '0.78rem', color: '#a8a6a0' }}>{tr('Zug-, Schlag- und Blunder-Töne abspielen', 'Play move, capture, and blunder sounds')}</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={soundEnabled}
                    onChange={(e) => setSoundEnabled(e.target.checked)}
                    style={{ width: '18px', height: '18px', accentColor: '#81b64c', cursor: 'pointer' }}
                  />
                </div>
              </Section>

              <Section title={tr('Training & Wiederholung', 'Training & Spaced Repetition')}>
                <label style={fieldLabelStyle}>{tr('Eröffnungsqualität auswerten bis Zug', 'Evaluate opening quality up to move')}
                  <select aria-label={tr('Eröffnungsphase bis Zug', 'Opening phase move window')} style={inputStyle} value={openingWindow} onChange={event => setOpeningWindow(Number(event.target.value))}>
                    {[8, 10, 12, 15, 20].map(value => <option key={value} value={value}>{value}</option>)}
                  </select>
                  <span style={hintStyle}>{tr('Nur eigene Entscheidungen in diesem Zugfenster zählen für Eröffnungsgenauigkeit und Eröffnungsfehler. Spätere Partiefehler bleiben getrennt.', 'Only your own decisions inside this move window count toward opening accuracy and opening errors.')}</span>
                </label>
                <div>
                  <span style={fieldLabelStyle}>{tr('Wiederholungsabstände (Preset)', 'Review intervals (Preset)')}</span>
                  <select
                    value={scheduleDraft.preset}
                    onChange={(e) => {
                      const preset = e.target.value as ReviewScheduleConfig['preset'];
                      setScheduleDraft({ mode: 'preset', preset });
                      setCustomDaysInput('');
                    }}
                    style={inputStyle}
                  >
                    <option value="frequent">{tr('Häufig — 10 min · 1 · 2 · 4 · 7 · 14 Tage', 'Frequent — 10 min · 1 · 2 · 4 · 7 · 14 days')}</option>
                    <option value="normal">{tr('Normal — 10 min · 1 · 3 · 7 · 14 · 30 Tage (Standard)', 'Normal — 10 min · 1 · 3 · 7 · 14 · 30 days (Default)')}</option>
                    <option value="relaxed">{tr('Entspannt — 10 min · 2 · 5 · 10 · 21 · 45 Tage', 'Relaxed — 10 min · 2 · 5 · 10 · 21 · 45 days')}</option>
                  </select>
                  <span style={hintStyle}>
                    {tr('Aktive Leiter:', 'Active schedule:')} {scheduleIntervalsMs(scheduleDraft).map(formatIntervalMs).join(' · ')}
                  </span>
                </div>
                <div>
                  <span style={fieldLabelStyle}>{tr('Eigene Intervalle (Tage, kommagetrennt)', 'Custom intervals (days, comma-separated)')}</span>
                  <input
                    type="text"
                    value={customDaysInput}
                    onChange={(e) => handleCustomDaysChange(e.target.value)}
                    placeholder={tr('z. B. 1, 3, 7, 14, 30', 'e.g. 1, 3, 7, 14, 30')}
                    style={inputStyle}
                  />
                  <span style={hintStyle}>
                    {tr('Mindestens 2 Stufen; kürzeste 10 min, längste 365 Tage; max. 8 Stufen. Leer = Preset.', 'At least 2 steps; min 10 min, max 365 days, up to 8 steps. Leave empty for preset.')}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.8rem', color: '#a8a6a0', lineHeight: 1.5, flex: '1 1 220px' }}>
                    {tr(
                      'Preset-Wechsel ändert bestehende Fälligkeiten nicht — „Neu berechnen“ wendet die angezeigte Leiter an (jede Karte bleibt in ihrer Stufe, nur dueAt wandert).',
                      'Changing presets keeps existing due dates intact — "Recalculate" applies the current ladder to existing cards.',
                    )}
                  </span>
                  <button className="btn-secondary" onClick={handleRecalculate} disabled={recalcBusy} style={{ flexShrink: 0 }}>
                    <Save size={16} />
                    <span>{recalcBusy ? tr('Berechne …', 'Calculating …') : tr('Neu berechnen', 'Recalculate')}</span>
                  </button>
                </div>
                {recalcMsg && <div style={hintStyle}>{recalcMsg}</div>}
              </Section>
            </>
          )}

          {activeSection === 'data' && (
            <Section title={tr('Daten & Datenschutz', 'Data & Privacy')}>
              <div className="settings-data-card">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#ffffff' }}>{tr('Datenpfad', 'Data Path')}</div>
                  <div style={{ fontSize: '0.78rem', color: '#a8a6a0', wordBreak: 'break-all', lineHeight: 1.4, marginTop: '4px' }}>
                    {dataPath || tr('Datenpfad wird geladen …', 'Loading data path …')}
                  </div>
                </div>
                <div className="settings-data-actions">
                  <button className="btn-secondary" onClick={handleOpenDataFolder}>
                    <HardDrive size={16} />
                    <span>{tr('Ordner öffnen', 'Open folder')}</span>
                  </button>
                  <button className="btn-secondary" onClick={() => void handleBackup()} disabled={backupBusy}>
                    <Save size={16} />
                    <span>{backupBusy ? tr('Erstellt Backup …', 'Creating backup …') : tr('Backup erstellen', 'Create backup')}</span>
                  </button>
                  <button className="btn-secondary" onClick={() => void handleExport()} disabled={backupBusy}>{tr('Vollständig exportieren', 'Export full backup')}</button>
                  <button className="btn-secondary" onClick={() => void handleRestore()} disabled={backupBusy}>{tr('Backup wiederherstellen', 'Restore backup')}</button>
                </div>
              </div>
              <span style={hintStyle}>
                {tr(
                  'Alle Daten liegen lokal auf diesem Gerät (Partien, Lernfortschritte, Einstellungen). Kein Passwort und keine Zugangsdaten werden gespeichert, geloggt oder exportiert. „Vollständig exportieren“ enthält Partien, Profil, Einstellungen, Kartenhistorie und Eröffnungsfortschritt in einer portablen JSON-Datei mit Prüfsumme.',
                  'All data stays locally on your device (games, study history, settings). No passwords or credentials are stored, logged, or exported. Full export writes games, profile, settings, and study progress into a checksummed portable JSON bundle.',
                )}
              </span>
              {backupMsg && <div style={hintStyle}>{backupMsg}</div>}
            </Section>
          )}
        </div>

        {/* Sticky Footer Save Action */}
        <div className="settings-modal-footer">
          {saveError ? (
            <span style={{ color: '#e06c5a', fontSize: '0.86rem', fontWeight: 600 }}>
              {saveError}
            </span>
          ) : savedSuccess ? (
            <span style={{ color: '#81b64c', fontSize: '0.86rem', fontWeight: 600 }}>
              {tr('Einstellungen erfolgreich gespeichert!', 'Settings saved!')}
            </span>
          ) : <span />}

          <button className="btn-primary" onClick={handleSave} disabled={saving} style={{ padding: '10px 24px' }}>
            <Save size={16} />
            <span>{saving ? tr('Speichert…', 'Saving…') : tr('Speichern', 'Save')}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
