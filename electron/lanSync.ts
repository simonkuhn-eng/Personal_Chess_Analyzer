import http from 'node:http';
import os from 'node:os';
import zlib from 'node:zlib';
import type { AppSettings, GameAnalysis } from '../src/types/chess';
import {
  isValidSyncPayload,
  mergeSyncPayloads,
  type SyncPayload,
  type SyncSummary,
} from '../src/utils/lanSyncMerge';

export const DEFAULT_LAN_SYNC_PORT = 47821;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const PORT_RANGE_END = 47830;

export interface LanSyncStatus {
  running: boolean;
  port: number;
  ips: string[];
  deviceName: string;
  lastSync?: SyncSummary | null;
}

export interface LanSyncCallbacks {
  getLocalPayload: () => Promise<SyncPayload>;
  applyMergedPayload: (merged: SyncPayload, summary: SyncSummary) => Promise<void>;
}

let activeServer: http.Server | null = null;
let activePort = DEFAULT_LAN_SYNC_PORT;
let lastSyncSummary: SyncSummary | null = null;

function isPrivateHomeIpv4(ip: string): boolean {
  if (ip.startsWith('192.168.') || ip.startsWith('10.')) return true;
  if (ip.startsWith('172.')) {
    const second = Number(ip.split('.')[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

export function getLocalLanIps(): string[] {
  const ifaces = os.networkInterfaces();
  const candidates: Array<{ ip: string; score: number }> = [];

  for (const [name, entries] of Object.entries(ifaces)) {
    if (!entries) continue;
    const lowerName = name.toLowerCase();
    const isVirtual =
      lowerName.includes('vethernet') ||
      lowerName.includes('wsl') ||
      lowerName.includes('docker') ||
      lowerName.includes('vmware') ||
      lowerName.includes('virtualbox') ||
      lowerName.includes('hyper-v');

    for (const info of entries) {
      if (info.family !== 'IPv4' || info.internal || !info.address) continue;
      if (info.address.startsWith('169.254.')) continue; // link-local APIPA
      let score = isPrivateHomeIpv4(info.address) ? 10 : 1;
      if (lowerName.includes('wi-fi') || lowerName.includes('wlan') || lowerName.includes('ethernet')) {
        score += 5;
      }
      if (isVirtual) score -= 8;
      candidates.push({ ip: info.address, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.ip.localeCompare(b.ip));
  return [...new Set(candidates.map((c) => c.ip))];
}

export function getLanSyncStatus(): LanSyncStatus {
  return {
    running: activeServer !== null && activeServer.listening,
    port: activePort,
    ips: getLocalLanIps(),
    deviceName: os.hostname() || 'Windows PC',
    lastSync: lastSyncSummary,
  };
}

function isAllowedSyncOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // Native clients (Android HttpURLConnection) send no Origin header
  if (origin === 'null' || origin.startsWith('file://')) return true;
  if (origin === 'https://appassets.androidplatform.net') return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function setCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && isAllowedSyncOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Content-Encoding');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function sendJson(req: http.IncomingMessage, res: http.ServerResponse, statusCode: number, data: unknown): void {
  setCorsHeaders(req, res);
  const rawBuffer = Buffer.from(JSON.stringify(data), 'utf-8');
  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  if (rawBuffer.length > 1024 && /\bgzip\b/i.test(acceptEncoding)) {
    const gzBuffer = zlib.gzipSync(rawBuffer, { level: 6 });
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Vary': 'Accept-Encoding, Origin',
      'Content-Length': String(gzBuffer.length),
    });
    res.end(gzBuffer);
    return;
  }
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(rawBuffer.length),
  });
  res.end(rawBuffer);
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        reject(new Error('Sync-Nutzlast ist größer als 64 MB.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const rawBuf = Buffer.concat(chunks);
        const encoding = String(req.headers['content-encoding'] || '').toLowerCase();
        const plainBuf = encoding === 'gzip'
          ? zlib.gunzipSync(rawBuf, { maxOutputLength: MAX_BODY_BYTES * 2 })
          : rawBuf;
        const text = plainBuf.toString('utf-8');
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Ungültige JSON-Sync-Anfrage.'));
      }
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function listenOnAvailablePort(server: http.Server, startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = startPort;

    const tryPort = () => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && port < PORT_RANGE_END) {
          port += 1;
          tryPort();
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '0.0.0.0');
    };

    tryPort();
  });
}

export async function startLanSyncServer(callbacks: LanSyncCallbacks): Promise<LanSyncStatus> {
  if (activeServer && activeServer.listening) {
    return getLanSyncStatus();
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!isAllowedSyncOrigin(req.headers.origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Nicht autorisierte Origin für lokalen Sync.' }));
        return;
      }

      setCorsHeaders(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const urlPath = (req.url || '/').split('?')[0];

      if (req.method === 'GET' && urlPath === '/api/lan-sync/ping') {
        const local = await callbacks.getLocalPayload();
        sendJson(req, res, 200, {
          ok: true,
          app: 'personal-chess-analyzer',
          version: 1,
          deviceName: local.deviceName,
          playerName: local.settings.playerName,
          gamesCount: local.games.length,
        });
        return;
      }

      if (req.method === 'POST' && urlPath === '/api/lan-sync/sync') {
        const rawBody = await readJsonBody(req);
        if (!isValidSyncPayload(rawBody)) {
          sendJson(req, res, 400, { ok: false, error: 'Ungültiges Sync-Paketformat.' });
          return;
        }
        const localPayload = await callbacks.getLocalPayload();
        const { mergedPayload, summary } = mergeSyncPayloads(localPayload, rawBody);
        await callbacks.applyMergedPayload(mergedPayload, summary);
        lastSyncSummary = summary;
        sendJson(req, res, 200, { ok: true, mergedPayload, summary });
        return;
      }

      sendJson(req, res, 404, { ok: false, error: 'Endpunkt nicht gefunden.' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Interner Sync-Fehler.';
      sendJson(req, res, 500, { ok: false, error: message });
    }
  });

  const boundPort = await listenOnAvailablePort(server, DEFAULT_LAN_SYNC_PORT);
  activeServer = server;
  activePort = boundPort;
  return getLanSyncStatus();
}

export async function stopLanSyncServer(): Promise<LanSyncStatus> {
  const srv = activeServer;
  activeServer = null;
  if (srv) {
    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
      srv.closeAllConnections?.();
    });
  }
  return getLanSyncStatus();
}

export function normalizePeerEndpoint(hostOrIp: string): string {
  let cleaned = hostOrIp.trim();
  if (!cleaned) throw new Error('Bitte IP-Adresse oder Hostnamen des Zielgeräts eingeben.');
  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = `http://${cleaned}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error('Ungültige Adresse. Beispiel: 192.168.178.25');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Nur HTTP/HTTPS im lokalen Netzwerk wird unterstützt.');
  }
  const port = parsed.port || String(DEFAULT_LAN_SYNC_PORT);
  return `${parsed.protocol}//${parsed.hostname}:${port}`;
}

export function buildLocalSyncPayload(
  games: GameAnalysis[],
  settings: AppSettings,
  learningStorage: Record<string, string>,
): SyncPayload {
  return {
    format: 'personal-chess-analyzer-lan-sync',
    version: 1,
    sentAt: new Date().toISOString(),
    deviceName: os.hostname() || 'Windows PC',
    games,
    settings,
    learningStorage,
  };
}

export async function syncWithLanPeer(
  hostOrIp: string,
  localPayload: SyncPayload,
): Promise<{ mergedPayload: SyncPayload; summary: SyncSummary }> {
  const baseUrl = normalizePeerEndpoint(hostOrIp);
  const endpoint = `${baseUrl}/api/lan-sync/sync`;
  const targetUrl = new URL(endpoint);
  const body = JSON.stringify(localPayload);

  const responseText = await new Promise<string>((resolve, reject) => {
    const req = http.request(
      {
        hostname: targetUrl.hostname,
        port: Number(targetUrl.port) || DEFAULT_LAN_SYNC_PORT,
        path: targetUrl.pathname,
        method: 'POST',
        timeout: 20_000,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body, 'utf-8'),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            try {
              const errJson = JSON.parse(text) as { error?: string };
              reject(new Error(errJson.error || `Sync fehlgeschlagen (HTTP ${res.statusCode}).`));
            } catch {
              reject(new Error(`Sync fehlgeschlagen (HTTP ${res.statusCode}).`));
            }
            return;
          }
          resolve(text);
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Zeitüberschreitung beim Verbinden mit ${targetUrl.hostname}:${targetUrl.port}. Ist die App dort geöffnet?`));
    });
    req.on('error', (err) => {
      reject(new Error(`Verbindung zu ${targetUrl.hostname}:${targetUrl.port} fehlgeschlagen (${err.message}). Beide Geräte müssen im selben WLAN sein.`));
    });
    req.write(body, 'utf-8');
    req.end();
  });

  const parsed = JSON.parse(responseText) as { ok?: boolean; mergedPayload?: unknown; summary?: SyncSummary; error?: string };
  if (!parsed.ok || !isValidSyncPayload(parsed.mergedPayload) || !parsed.summary) {
    throw new Error(parsed.error || 'Unerwartete Antwort vom Zielgerät.');
  }

  lastSyncSummary = {
    ...parsed.summary,
    peerDeviceName: targetUrl.hostname,
  };

  return {
    mergedPayload: parsed.mergedPayload,
    summary: lastSyncSummary,
  };
}
