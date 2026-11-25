import React, { useCallback, useEffect, useState } from 'react';
import { Check, Copy, RefreshCw, Server, Smartphone, Usb, Wifi } from 'lucide-react';
import type { LanSyncStatus } from '../types/electron';
import type { SyncSummary } from '../utils/lanSyncMerge';
import { replaceLearningStorage, snapshotLearningStorage } from '../utils/learningStorage';
import { useI18n } from '../utils/i18n';

const PEER_IP_STORAGE_KEY = 'pca-lan-sync-peer-ip';

interface LanSyncPanelProps {
  compact?: boolean;
  onSyncComplete?: (summary: SyncSummary) => void;
}

const cardStyle: React.CSSProperties = {
  background: '#24231e',
  border: '1px solid #2e2b24',
  borderRadius: '10px',
  padding: '14px',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  backgroundColor: '#161512',
  border: '1px solid #2e2b24',
  borderRadius: '8px',
  padding: '10px 12px',
  color: '#ffffff',
  fontSize: '0.88rem',
};

export const LanSyncPanel: React.FC<LanSyncPanelProps> = ({ compact = false, onSyncComplete }) => {
  const { tr, lang } = useI18n();
  const [status, setStatus] = useState<LanSyncStatus | null>(null);
  const [peerIp, setPeerIp] = useState<string>(() => {
    try {
      return localStorage.getItem(PEER_IP_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });
  const [busy, setBusy] = useState(false);
  const [serverBusy, setServerBusy] = useState(false);
  const [adbBusy, setAdbBusy] = useState(false);
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const loadStatus = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.lanSync) return;
    try {
      const next = await api.lanSync.getStatus();
      setStatus(next);
    } catch {
      // Optional in environments without LAN sync
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    const onApplied = (ev: Event) => {
      const detail = (ev as CustomEvent<SyncSummary | undefined>).detail;
      if (detail) {
        setMessage({
          kind: 'success',
          text: tr(
            `Abgleich mit ${detail.peerDeviceName}: ${detail.totalReviewCards} Fehlerkarten (${detail.reviewCardsUpdated} aktualisiert), ${detail.totalGames} Partien (+${detail.gamesAdded} neu).`,
            `Synced with ${detail.peerDeviceName}: ${detail.totalReviewCards} mistake cards (${detail.reviewCardsUpdated} updated), ${detail.totalGames} games (+${detail.gamesAdded} new).`,
          ),
        });
      }
      void loadStatus();
    };
    window.addEventListener('pca-lan-sync-applied', onApplied);
    return () => window.removeEventListener('pca-lan-sync-applied', onApplied);
  }, [loadStatus, tr]);

  const handleToggleServer = async () => {
    const api = window.electronAPI;
    if (!api?.lanSync || serverBusy) return;
    setServerBusy(true);
    try {
      const next = status?.running ? await api.lanSync.stopServer() : await api.lanSync.startServer();
      setStatus(next);
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : tr('Heimnetz-Server konnte nicht umgeschaltet werden.', 'Could not toggle local network server.'),
      });
    } finally {
      setServerBusy(false);
    }
  };

  const handleCopy = async (addr: string) => {
    try {
      await navigator.clipboard.writeText(addr);
      setCopiedAddr(addr);
      window.setTimeout(() => setCopiedAddr((cur) => (cur === addr ? null : cur)), 1800);
    } catch {
      // Clipboard may be unavailable in restricted contexts
    }
  };

  const syncWithEndpoint = async (endpoint: string) => {
    const api = window.electronAPI;
    if (!api?.lanSync || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const { summary, mergedLearningStorage } = await api.lanSync.syncWithPeer(
        endpoint,
        snapshotLearningStorage(),
      );
      replaceLearningStorage(mergedLearningStorage);
      window.dispatchEvent(new CustomEvent('pca-lan-sync-applied', { detail: summary }));
      setMessage({
        kind: 'success',
        text: tr(
          `Erfolgreich mit ${summary.peerDeviceName} synchronisiert: ${summary.totalReviewCards} Fehlerkarten (${summary.reviewCardsUpdated} aktualisiert), ${summary.totalGames} Partien (+${summary.gamesAdded} neu).`,
          `Successfully synced with ${summary.peerDeviceName}: ${summary.totalReviewCards} mistake cards (${summary.reviewCardsUpdated} updated), ${summary.totalGames} games (+${summary.gamesAdded} new).`,
        ),
      });
      await loadStatus();
      onSyncComplete?.(summary);
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : tr('Synchronisierung fehlgeschlagen.', 'Synchronization failed.'),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSyncNow = async () => {
    const trimmed = peerIp.trim();
    if (!trimmed) {
      setMessage({
        kind: 'error',
        text: tr(
          'Bitte IP-Adresse des PCs im Heimnetz eingeben (z. B. 192.168.178.42).',
          'Please enter the PC local network IP address (e.g. 192.168.178.42).',
        ),
      });
      return;
    }
    try {
      localStorage.setItem(PEER_IP_STORAGE_KEY, trimmed);
    } catch {
      // Ignore storage quota warning here
    }
    await syncWithEndpoint(trimmed);
  };

  const handlePrepareAdb = async () => {
    const api = window.electronAPI;
    if (!api?.lanSync?.prepareAdbSync || adbBusy) return;
    setAdbBusy(true);
    setMessage(null);
    try {
      const res = await api.lanSync.prepareAdbSync();
      setMessage({ kind: res.ok ? 'success' : 'error', text: res.message });
      await loadStatus();
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : tr('ADB-Tunnel konnte nicht eingerichtet werden.', 'Could not set up ADB tunnel.'),
      });
    } finally {
      setAdbBusy(false);
    }
  };

  const handleAdbSyncFromPhone = async () => {
    const port = status?.port || 47821;
    await syncWithEndpoint(`127.0.0.1:${port}`);
  };

  const isDesktopHost = Boolean(status && (status.running || status.ips.length > 0));
  const primaryAddress = status?.ips[0] ? `${status.ips[0]}:${status.port}` : null;

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Wifi size={16} color="#81b64c" />
          <strong style={{ fontSize: compact ? '0.88rem' : '0.92rem', color: '#ffffff' }}>
            {tr('PC ↔ Handy Heimnetz-Sync (Fehlerkarten & Partien)', 'PC ↔ Phone LAN Sync (Mistake Cards & Games)')}
          </strong>
        </div>
        {isDesktopHost && status && (
          <span
            style={{
              fontSize: '0.75rem',
              fontWeight: 700,
              color: status.running ? '#81b64c' : '#a8a6a0',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
            }}
          >
            <Server size={13} />
            {status.running ? `${tr('Empfangsbereit', 'Listening')} (Port ${status.port})` : tr('Server pausiert', 'Server paused')}
          </span>
        )}
      </div>

      {isDesktopHost && status && (
        <div style={{ background: '#161512', border: '1px solid #2e2b24', borderRadius: '8px', padding: '10px 12px', marginBottom: '12px' }}>
          <div style={{ fontSize: '0.8rem', color: '#a8a6a0', lineHeight: 1.45, marginBottom: '8px' }}>
            {primaryAddress ? (
              <>
                {tr(
                  'Diese Adresse in der Android-App (im selben WLAN) eingeben, um gelöste Fehlerkarten, Repertoires und Partien abzugleichen:',
                  'Enter this address in the Android app (same Wi-Fi) to sync mistake cards, repertoires, and games:',
                )}
              </>
            ) : (
              tr('Keine lokale WLAN-/LAN-IP erkannt. Stelle sicher, dass der PC mit deinem Heimnetz verbunden ist.', 'No local Wi-Fi/LAN IP detected.')
            )}
          </div>
          {status.ips.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
              {status.ips.map((ip) => {
                const addr = `${ip}:${status.port}`;
                return (
                  <button
                    key={addr}
                    type="button"
                    className="btn-secondary"
                    onClick={() => void handleCopy(addr)}
                    style={{ padding: '5px 10px', fontSize: '0.82rem', fontFamily: 'monospace' }}
                    title={tr('Adresse kopieren', 'Copy address')}
                  >
                    {copiedAddr === addr ? <Check size={13} color="#81b64c" /> : <Copy size={13} />}
                    <span>{addr}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.75rem', color: '#7d7b74' }}>
              {tr('Bei erster Verbindung in der Windows-Firewall „Private Netzwerke zulassen“ bestätigen.', 'On first connection, allow "Private networks" in Windows Firewall.')}
            </span>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {window.electronAPI?.lanSync?.prepareAdbSync && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void handlePrepareAdb()}
                  disabled={adbBusy}
                  style={{ padding: '5px 10px', fontSize: '0.78rem' }}
                  title={tr('Richtet automatisch adb reverse für das per USB verbundene Android-Gerät ein', 'Automatically configures adb reverse for the USB-connected Android device')}
                >
                  <Usb size={13} />
                  <span>{adbBusy ? tr('Prüfe USB …', 'Checking USB…') : tr('USB-Tunnel (ADB) aktivieren', 'Enable USB tunnel (ADB)')}</span>
                </button>
              )}
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void handleToggleServer()}
                disabled={serverBusy}
                style={{ padding: '5px 10px', fontSize: '0.78rem' }}
              >
                {status.running ? tr('Server pausieren', 'Pause server') : tr('Server starten', 'Start server')}
              </button>
            </div>
          </div>
        </div>
      )}

      {!isDesktopHost && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px', padding: '10px 12px', background: '#161512', border: '1px solid #2e2b24', borderRadius: '8px' }}>
          <span style={{ fontSize: '0.78rem', color: '#a8a6a0', lineHeight: 1.4 }}>
            {tr('Wenn dein Handy per USB-Kabel am offenen PC hängt (USB-Debugging aktiv), reicht ein Tipp ohne WLAN-IP:', 'If your phone is connected via USB to the PC (USB debugging enabled), one tap syncs without a Wi-Fi IP:')}
          </span>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void handleAdbSyncFromPhone()}
            disabled={busy}
            style={{ padding: '9px 14px', justifyContent: 'center' }}
          >
            <Usb size={15} />
            <span>{busy ? tr('Synchronisiert …', 'Syncing…') : tr('Per USB (ADB) mit PC syncen', 'Sync via USB (ADB)')}</span>
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <label style={{ fontSize: '0.8rem', color: '#d0cec8', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Smartphone size={14} color="#e69d00" />
          <span>{isDesktopHost ? tr('Oder mit anderem PC im Heimnetz abgleichen:', 'Or sync with another PC on the local network:') : tr('PC-Adresse im Heim-WLAN:', 'PC IP address on local Wi-Fi:')}</span>
        </label>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <input
            type="text"
            value={peerIp}
            onChange={(e) => setPeerIp(e.target.value)}
            placeholder={tr('z. B. 192.168.178.42', 'e.g. 192.168.178.42')}
            aria-label={tr('PC-IP-Adresse im Heimnetz', 'PC IP address on local network')}
            style={{ ...inputStyle, flex: '1 1 180px' }}
          />
          <button
            type="button"
            className="btn-primary"
            onClick={() => void handleSyncNow()}
            disabled={busy || !peerIp.trim()}
            style={{ padding: '10px 16px', flexShrink: 0 }}
          >
            <RefreshCw size={15} className={busy ? 'te-spinner' : undefined} />
            <span>{busy ? tr('Synchronisiert …', 'Syncing…') : tr('Jetzt synchronisieren', 'Sync now')}</span>
          </button>
        </div>
      </div>

              {status?.lastSync && !message && (
        <div style={{ fontSize: '0.78rem', color: '#a8a6a0', marginTop: '8px', lineHeight: 1.4 }}>
          {tr('Letzter Heimnetz-Sync:', 'Last LAN sync:')} {new Date(status.lastSync.syncedAt).toLocaleString(lang === 'en' ? 'en-US' : 'de-DE')} · {status.lastSync.peerDeviceName} ({status.lastSync.totalReviewCards} {tr('Fehlerkarten', 'cards')}, {status.lastSync.totalGames} {tr('Partien', 'games')}).
        </div>
      )}

      {message && (
        <div
          role="status"
          style={{
            marginTop: '10px',
            padding: '8px 10px',
            borderRadius: '8px',
            fontSize: '0.8rem',
            lineHeight: 1.4,
            background: message.kind === 'success' ? 'rgba(129, 182, 76, 0.14)' : 'rgba(224, 108, 90, 0.14)',
            border: `1px solid ${message.kind === 'success' ? 'rgba(129, 182, 76, 0.45)' : 'rgba(224, 108, 90, 0.45)'}`,
            color: message.kind === 'success' ? '#cde8a8' : '#f4a89d',
          }}
        >
          {message.text}
        </div>
      )}
    </div>
  );
};
