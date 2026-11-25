import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { LineAssembler } from './uci';
import { describeMoveStructuralDiff } from './chessPositionFacts';
import type { AiCoachMcpServer } from './aiCoachMcp';
import type {
  AiCoachEffort,
  AiCoachExplainRequest,
  AiCoachModelFamily,
  AiCoachStatus,
  AiCoachStreamEvent,
  AiCoachToolLogEntry,
} from '../src/types/aiCoach';

const VALID_FAMILIES = new Set<AiCoachModelFamily>(['hydrogen', 'neon']);
const VALID_EFFORTS = new Set<AiCoachEffort>(['low', 'medium', 'high', 'xhigh']);
const UUID_RE = /^[a-f0-9-]{8,80}$/i;

export function resolveAgyModelId(family: AiCoachModelFamily, effort: AiCoachEffort): string {
  const safeFamily: AiCoachModelFamily = VALID_FAMILIES.has(family) ? family : 'hydrogen';
  if (safeFamily === 'hydrogen') {
    return effort === 'xhigh' ? 'gemini-4-hydrogen-xhigh' : 'gemini-4-hydrogen-high';
  }
  const safeEffort: AiCoachEffort = VALID_EFFORTS.has(effort) ? effort : 'medium';
  return `gemini-4-neon-${safeEffort}`;
}

export function resolveAgyExecutable(): string | null {
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe') : '',
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local', 'agy', 'bin', 'agy.exe') : '',
    process.platform !== 'win32' ? '/usr/local/bin/agy' : '',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Ignore permission/stat failures
    }
  }

  try {
    const lookupCmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const res = spawnSync(lookupCmd, ['agy'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    if (res.status === 0 && typeof res.stdout === 'string') {
      const firstLine = res.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && fs.existsSync(line));
      if (firstLine) return firstLine;
    }
  } catch {
    // Ignore lookup failure
  }

  return null;
}

function summarizeToolName(
  rawToolName: string,
  lang: 'de' | 'en' = 'de',
): { displayName: string; startSummary: string; doneSummary: string } {
  const normalized = rawToolName.replace(/^mcp_chess-engine_/, '');
  const en = lang === 'en';
  switch (normalized) {
    case 'compare_moves':
      return {
        displayName: 'compare_moves',
        startSummary: en ? 'Stockfish comparing candidate moves …' : 'Stockfish vergleicht Kandidatenzüge …',
        doneSummary: en ? 'Compared moves with Stockfish' : 'Züge mit Stockfish verglichen',
      };
    case 'evaluate_position':
      return {
        displayName: 'evaluate_position',
        startSummary: en ? 'Stockfish checking line …' : 'Stockfish prüft Variante …',
        doneSummary: en ? 'Position checked with Stockfish' : 'Stellung mit Stockfish geprüft',
      };
    case 'inspect_position':
      return {
        displayName: 'inspect_position',
        startSummary: en ? 'Inspecting pawn structure & piece activity …' : 'Bauernstruktur & Figurenstellung prüfen …',
        doneSummary: en ? 'Position facts checked' : 'Stellungsfakten geprüft',
      };
    default:
      return {
        displayName: normalized || 'tool',
        startSummary: en ? `Running tool ${normalized || 'tool'} …` : `Werkzeug ${normalized || 'tool'} läuft …`,
        doneSummary: en ? `Finished tool ${normalized || 'tool'}` : `Werkzeug ${normalized || 'tool'} abgeschlossen`,
      };
  }
}

function safeDiffLines(fenBefore: string, moveCandidate?: string): string[] {
  if (!fenBefore || !moveCandidate) return [];
  try {
    return describeMoveStructuralDiff(fenBefore, moveCandidate).observations;
  } catch {
    return [];
  }
}

export function buildCoachPrompt(req: AiCoachExplainRequest): string {
  const cleanQuestion = (req.question || '').trim().slice(0, 1000);
  const en = req.language === 'en';

  if (req.conversationId) {
    if (en) {
      return [
        'Answer the chess player’s follow-up question about the position we just discussed.',
        'Respond in clear, friendly, practical English suitable for an improving club/amateur player.',
        'Keep concrete variations short (max 1–3 moves) and connect the answer back to a practical rule of thumb.',
        'You may optionally call a chess-engine tool (compare_moves, evaluate_position, inspect_position) if a quick verification helps.',
        '',
        `Follow-up: ${cleanQuestion || 'Could you explain this idea even more simply with a rule of thumb?'}`,
      ].join('\n');
    }
    return [
      'Beantworte die folgende Nachfrage des Schachspielers zur gerade besprochenen Stellung.',
      'Antworte auf Deutsch in lockerer Du-Form, praktisch und verständlich für Hobbyspieler.',
      'Halte Varianten kurz (maximal 1–3 Züge) und leite nach Möglichkeit wieder eine konkrete Merkregel ab.',
      'Falls eine kurze Prüfung mit einem Tool (compare_moves, evaluate_position, inspect_position) hilft, kannst du sie optional nutzen – aber nur wenn nötig.',
      '',
      `Nachfrage: ${cleanQuestion || 'Kannst du das noch etwas einfacher anhand einer Schachregel erklären?'}`,
    ].join('\n');
  }

  const sideLabel = en
    ? (req.color === 'b' ? 'Black' : 'White')
    : (req.color === 'b' ? 'Schwarz' : 'Weiß');
  const playedLabel = req.isPositionOnly
    ? (en ? 'Starting position before the first move' : 'Ausgangsstellung vor dem ersten Zug')
    : `${req.moveNumber}.${req.color === 'b' ? '.. ' : ' '}${req.playedSan} (${sideLabel})`;

  const playedFacts = !req.isPositionOnly ? safeDiffLines(req.fenBefore, req.playedUci || req.playedSan) : [];
  const bestDiffers =
    !req.isPositionOnly &&
    req.bestMoveSan &&
    req.bestMoveUci &&
    req.bestMoveUci !== req.playedUci;
  const bestFacts = bestDiffers ? safeDiffLines(req.fenBefore, req.bestMoveUci || req.bestMoveSan) : [];

  if (en) {
    const enLines: string[] = [
      'You are a patient, practical chess coach helping an improving amateur/club player (around 800–1600 Elo).',
      'Explain the move in clear, encouraging English.',
      '',
      'IMPORTANT COACHING RULES:',
      '1. Focus on **transferable chess principles / rules of thumb** that help in future games (e.g., avoiding/creating doubled pawns, keeping tension instead of trading prematurely, piece activity, center control, development/tempo, king safety, open files, undefended pieces, basic tactical motifs).',
      '2. Keep concrete variations short (**1–3 moves**, max 4 plies) with easy-to-follow consequences. Never dump 20-move engine lines or "mate in 40".',
      '3. Refer clearly to pieces and squares using standard notation.',
      '4. You have `chess-engine` MCP tools (`compare_moves`, `evaluate_position`, `inspect_position`) available if checking concrete replies helps, **but calling them is optional** when the explanation is already clear from the position and facts.',
      '5. Use this clean Markdown structure:',
    ];
    if (req.isPositionOnly) {
      enLines.push(
        '### Quick Answer',
        '### Position Overview & Key Features',
        '### Practical Plan for the Side to Move',
        '### Rule of Thumb for Future Games',
      );
    } else {
      const moveHeading =
        req.quality && ['blunder', 'mistake', 'inaccuracy', 'miss'].includes(req.quality)
          ? `### Why ${req.playedSan} is problematic`
          : `### What ${req.playedSan} achieves here`;
      enLines.push('### Quick Answer', moveHeading);
      if (bestDiffers) enLines.push(`### Why ${req.bestMoveSan} is better`);
      enLines.push('### Rule of Thumb for Future Games');
    }

    enLines.push('', '---', 'GAME DATA:');
    if (req.openingName) enLines.push(`- Opening: ${req.openingName}`);
    if (req.playerColor) enLines.push(`- User perspective: ${req.playerColor === 'w' ? 'White' : 'Black'}`);
    enLines.push(`- Situation to explain: ${playedLabel}`);
    if (!req.isPositionOnly && req.quality) enLines.push(`- Engine quality label: ${req.quality}`);
    if (typeof req.winChanceDrop === 'number' && Number.isFinite(req.winChanceDrop) && req.winChanceDrop > 0) {
      enLines.push(`- Win-chance drop: ${req.winChanceDrop.toFixed(1)} percentage points`);
    }
    if (req.evalBeforeText) enLines.push(`- Evaluation before move: ${req.evalBeforeText}`);
    if (req.evalAfterText) enLines.push(`- Evaluation after move: ${req.evalAfterText}`);
    if (req.bestMoveSan && !req.isPositionOnly) {
      enLines.push(`- Engine best move: ${req.bestMoveSan}${req.bestMoveUci ? ` (${req.bestMoveUci})` : ''}`);
    }
    if (req.bestLineSan?.length) enLines.push(`- Short engine line: ${req.bestLineSan.slice(0, 6).join(' ')}`);
    if (req.afterLineSan?.length) enLines.push(`- Expected reply after played move: ${req.afterLineSan.slice(0, 6).join(' ')}`);
    if (req.gameContextMovesSan?.length) enLines.push(`- Recent game moves: ${req.gameContextMovesSan.slice(-10).join(' ')}`);
    enLines.push(`- FEN before move: ${req.fenBefore}`);
    if (!req.isPositionOnly) enLines.push(`- FEN after move: ${req.fenAfter}`);
    if (playedFacts.length > 0) {
      enLines.push('', `STRUCTURAL FACTS FOR ${req.playedSan} (German notes from analyzer):`);
      for (const fact of playedFacts) enLines.push(`- ${fact}`);
    }
    if (bestFacts.length > 0) {
      enLines.push('', `STRUCTURAL FACTS FOR ${req.bestMoveSan} (German notes from analyzer):`);
      for (const fact of bestFacts) enLines.push(`- ${fact}`);
    }
    if (cleanQuestion) enLines.push('', `PLAYER QUESTION: ${cleanQuestion}`);
    return enLines.join('\n');
  }

  const contextLines: string[] = [
    'Du bist ein geduldiger, praxisnaher Schachcoach für Hobbyspieler (ca. 800–1600 Elo).',
    'Erkläre den Zug auf Deutsch in freundlicher Du-Form.',
    '',
    'WICHTIGE COACH-REGELN:',
    '1. Erkläre vor allem mit **übertragbaren Schachprinzipien / Faustregeln**, die dem Spieler in Zukunft helfen (z. B. "Doppelbauern vermeiden/erzeugen", "Spannung halten statt unnötig abzutauschen", "aktive Figuren nicht gegen passive tauschen", "offene Linien für Türme", "Königssicherheit/Rochade", "Entwicklung vor Bauernraub", "ungedeckte Figuren schützen", "Zentrumskontrolle").',
    '2. Zeige höchstens **kurze, greifbare Ideen (1–3 Züge, max. 4 Halbzüge)** mit verständlichen Folgen. Keine 20-Züge-Computervarianten und kein "in 40 Zügen Matt".',
    '3. Nenne die wichtigsten Figuren und Felder konkret auf Deutsch (z. B. Dame, Turm, Läufer, Springer, Bauer) oder in sauberer Notation.',
    '4. Dir stehen MCP-Tools vom Server `chess-engine` zur Verfügung (`compare_moves`, `evaluate_position`, `inspect_position`), um bei Bedarf die konkrete Gegnerantwort oder Alternativen mit Stockfish zu prüfen. Der Aufruf ist **optional** — wenn die Erklärung schon aus Stellung & Fakten klar ist, antworte direkt; wenn eine konkrete Widerlegung/Alternative unklar ist, prüfe sie gezielt (1–2 Tool-Aufrufe reichen meist).',
    '5. Nutze genau diese übersichtliche Markdown-Struktur:',
  ];

  if (req.isPositionOnly) {
    contextLines.push(
      '### Kurzantwort',
      '### Stellungsüberblick & worauf es ankommt',
      '### Sinnvoller Plan für die Seite am Zug',
      '### Merkregel für zukünftige Partien',
    );
  } else {
    const moveSectionHeading =
      req.quality && ['blunder', 'mistake', 'inaccuracy', 'miss'].includes(req.quality)
        ? `### Warum ${req.playedSan} problematisch ist`
        : `### Was ${req.playedSan} in dieser Stellung bewirkt`;
    contextLines.push('### Kurzantwort', moveSectionHeading);
    if (bestDiffers) {
      contextLines.push(`### Warum ${req.bestMoveSan} besser ist`);
    }
    contextLines.push('### Merkregel für zukünftige Partien');
  }

  contextLines.push('', '---', 'PARTIEDATEN:');
  if (req.openingName) contextLines.push(`- Eröffnung: ${req.openingName}`);
  if (req.playerColor) {
    contextLines.push(`- Spielerfarbe des Nutzers: ${req.playerColor === 'w' ? 'Weiß' : 'Schwarz'}`);
  }
  contextLines.push(`- Zu erklärende Situation: ${playedLabel}`);
  if (!req.isPositionOnly && req.quality) {
    contextLines.push(`- Engine-Bewertungskategorie: ${req.quality}`);
  }
  if (typeof req.winChanceDrop === 'number' && Number.isFinite(req.winChanceDrop) && req.winChanceDrop > 0) {
    contextLines.push(`- Gewinnchancen-Verlust laut Engine: ${req.winChanceDrop.toFixed(1)} Prozentpunkte`);
  }
  if (req.evalBeforeText) contextLines.push(`- Bewertung davor: ${req.evalBeforeText}`);
  if (req.evalAfterText) contextLines.push(`- Bewertung danach: ${req.evalAfterText}`);
  if (req.bestMoveSan && !req.isPositionOnly) {
    contextLines.push(
      `- Engine-Empfehlung davor: ${req.bestMoveSan}${req.bestMoveUci ? ` (${req.bestMoveUci})` : ''}`,
    );
  }
  if (req.bestLineSan && req.bestLineSan.length > 0) {
    contextLines.push(`- Kurze Empfehlungslinie: ${req.bestLineSan.slice(0, 6).join(' ')}`);
  }
  if (req.afterLineSan && req.afterLineSan.length > 0) {
    contextLines.push(`- Erwartete Antwort nach gespieltem Zug: ${req.afterLineSan.slice(0, 6).join(' ')}`);
  }
  if (req.gameContextMovesSan && req.gameContextMovesSan.length > 0) {
    contextLines.push(`- Letzte Züge bis hierher: ${req.gameContextMovesSan.slice(-10).join(' ')}`);
  }

  contextLines.push(`- FEN vor dem Zug: ${req.fenBefore}`);
  if (!req.isPositionOnly) {
    contextLines.push(`- FEN nach dem Zug: ${req.fenAfter}`);
  }

  if (playedFacts.length > 0) {
    contextLines.push('', `VORBERECHNETE STELLUNGSFAKTEN ZU ${req.playedSan}:`);
    for (const fact of playedFacts) contextLines.push(`- ${fact}`);
  }
  if (bestFacts.length > 0) {
    contextLines.push('', `VORBERECHNETE STELLUNGSFAKTEN ZU ${req.bestMoveSan}:`);
    for (const fact of bestFacts) contextLines.push(`- ${fact}`);
  }

  if (cleanQuestion) {
    contextLines.push('', `SPEZIELLE FRAGE DES SPIELERS: ${cleanQuestion}`);
  }

  return contextLines.join('\n');
}

function writeFileAtomicSync(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, targetPath);
}

function translateCliError(rawMessage: string, lang: 'de' | 'en' = 'de'): string {
  const lower = rawMessage.toLowerCase();
  const en = lang === 'en';
  if (lower.includes('authentication required') || lower.includes('not authenticated') || lower.includes('login')) {
    return en
      ? 'Antigravity CLI is not signed in. Please run "agy" once in your terminal to sign in.'
      : 'Antigravity CLI ist nicht angemeldet. Bitte einmal „agy“ im Terminal öffnen und anmelden.';
  }
  if (lower.includes('quota') || lower.includes('rate limit') || lower.includes('exhausted')) {
    return en
      ? 'Model quota reached. Please switch models (Hydrogen/Neon) or try again shortly.'
      : 'Modell-Kontingent aktuell erschöpft. Bitte anderes Modell (Hydrogen/Neon) wählen oder später erneut versuchen.';
  }
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return en
      ? 'AI request timed out. Please try again.'
      : 'Zeitüberschreitung bei der KI-Antwort. Bitte erneut versuchen oder „Schnell“ wählen.';
  }
  return rawMessage;
}

export class AiCoachService {
  private readonly mcpServer: AiCoachMcpServer;
  private readonly getUserDataDir: () => string;
  private activeProcess: { requestId: string; proc: ChildProcess } | null = null;
  private cancelledIds = new Set<string>();

  constructor(mcpServer: AiCoachMcpServer, getUserDataDir: () => string) {
    this.mcpServer = mcpServer;
    this.getUserDataDir = getUserDataDir;
  }

  async getStatus(): Promise<AiCoachStatus> {
    const cliPath = resolveAgyExecutable();
    return {
      available: Boolean(cliPath),
      cliPath: cliPath || '',
      error: cliPath
        ? undefined
        : 'Antigravity CLI (agy.exe) wurde nicht gefunden. Bitte Antigravity CLI installieren/anmelden.',
      models: [
        {
          family: 'hydrogen',
          label: 'Gemini 4 Hydrogen',
          subtitle: 'Schnell & präzise',
        },
        {
          family: 'neon',
          label: 'Gemini 4 Neon',
          subtitle: 'Tiefere Analyse',
        },
      ],
    };
  }

  cancel(requestId: string): void {
    this.cancelledIds.add(requestId);
    if (this.cancelledIds.size > 100) {
      this.cancelledIds.delete(this.cancelledIds.values().next().value!);
    }
    if (this.activeProcess && this.activeProcess.requestId === requestId) {
      try {
        this.activeProcess.proc.kill();
      } catch {
        // Ignore
      }
      this.mcpServer.cancelAllActiveSearches();
    }
  }

  dispose(): void {
    if (this.activeProcess) {
      try {
        this.activeProcess.proc.kill();
      } catch {
        // Ignore
      }
      this.activeProcess = null;
    }
    this.mcpServer.cancelAllActiveSearches();
  }

  private prepareWorkspace(mcpUrl: string, mcpToken: string): { workspaceDir: string; settingsPath: string } {
    const workspaceDir = path.join(this.getUserDataDir(), 'ai-coach-workspace');
    const mcpConfigPath = path.join(workspaceDir, '.agents', 'mcp_config.json');
    const settingsPath = path.join(workspaceDir, 'session-settings.json');

    const mcpConfig = {
      mcpServers: {
        'chess-engine': {
          serverUrl: mcpUrl,
          headers: {
            Authorization: `Bearer ${mcpToken}`,
          },
          timeoutSeconds: 60,
          tools: {
            inspect_position: { eager: true },
            evaluate_position: { eager: true },
            compare_moves: { eager: true },
          },
        },
      },
    };
    writeFileAtomicSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    const settingsConfig = {
      trustedWorkspaces: [workspaceDir],
      toolPermission: 'request-review',
      permissions: {
        allow: ['mcp(chess-engine/*)'],
        deny: ['command(*)', 'write_file(*)', 'read_file(*)', 'read_url(*)', 'execute_url(*)'],
      },
    };
    writeFileAtomicSync(settingsPath, JSON.stringify(settingsConfig, null, 2));

    return { workspaceDir, settingsPath };
  }

  async explainMove(
    request: AiCoachExplainRequest,
    onEvent: (event: AiCoachStreamEvent) => void,
  ): Promise<{ ok: boolean; error?: string }> {
    const requestId = request.requestId;
    if (!requestId || this.cancelledIds.has(requestId)) {
      return { ok: false, error: 'Anfrage abgebrochen.' };
    }

    const cliPath = resolveAgyExecutable();
    if (!cliPath) {
      const msg = 'Antigravity CLI (agy.exe) wurde auf diesem System nicht gefunden.';
      onEvent({ requestId, type: 'error', message: msg });
      return { ok: false, error: msg };
    }

    // Abort previous active coach request if still running
    if (this.activeProcess) {
      this.cancel(this.activeProcess.requestId);
    }

    let workspaceDir: string;
    let settingsPath: string;
    try {
      const mcpInfo = await this.mcpServer.ensureStarted();
      const prepared = this.prepareWorkspace(mcpInfo.url, mcpInfo.token);
      workspaceDir = prepared.workspaceDir;
      settingsPath = prepared.settingsPath;
    } catch (err) {
      const msg = `Lokaler Schach-Tool-Server konnte nicht gestartet werden: ${err instanceof Error ? err.message : String(err)}`;
      onEvent({ requestId, type: 'error', message: msg });
      return { ok: false, error: msg };
    }

    if (this.cancelledIds.has(requestId)) {
      onEvent({ requestId, type: 'error', message: 'Analyse abgebrochen.', cancelled: true });
      return { ok: false, error: 'Analyse abgebrochen.' };
    }

    const modelId = resolveAgyModelId(request.modelFamily, request.effort);
    const prompt = buildCoachPrompt(request);

    const args = [
      '--model',
      modelId,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--disable-slash-commands',
      '--print-timeout',
      '120s',
      '--settings',
      settingsPath,
    ];
    if (request.conversationId && UUID_RE.test(request.conversationId)) {
      args.push('--conversation', request.conversationId);
    }

    const reqLang: 'de' | 'en' = request.language === 'en' ? 'en' : 'de';
    onEvent({
      requestId,
      type: 'status',
      message: `${request.modelFamily === 'neon' ? 'Gemini 4 Neon' : 'Gemini 4 Hydrogen'} ${reqLang === 'en' ? 'starting …' : 'wird gestartet …'}`,
    });

    return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      let settled = false;
      let sawTerminalResult = false;
      const assembler = new LineAssembler();
      const stderrChunks: string[] = [];
      const activeToolsByStep = new Map<number, AiCoachToolLogEntry>();
      const toolHistory: AiCoachToolLogEntry[] = [];
      let accumulatedText = '';

      const finish = (ok: boolean, errorMsg?: string) => {
        if (settled) return;
        settled = true;
        if (this.activeProcess?.requestId === requestId) {
          this.activeProcess = null;
        }
        resolve(ok ? { ok: true } : { ok: false, error: errorMsg });
      };

      let proc: ChildProcess;
      try {
        proc = spawn(cliPath, args, {
          cwd: workspaceDir,
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        const msg = `${reqLang === 'en' ? 'Failed to launch Antigravity CLI:' : 'Antigravity CLI konnte nicht gestartet werden:'} ${err instanceof Error ? err.message : String(err)}`;
        onEvent({ requestId, type: 'error', message: msg });
        finish(false, msg);
        return;
      }

      this.activeProcess = { requestId, proc };

      const handleStdoutLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) return;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          return;
        }

        const evtType = payload.event;
        if (evtType === 'init') {
          onEvent({ requestId, type: 'status', message: reqLang === 'en' ? 'AI analyzing position …' : 'KI analysiert Stellung …' });
          return;
        }

        if (evtType === 'step_update' && payload.step_update && typeof payload.step_update === 'object') {
          const su = payload.step_update as Record<string, unknown>;
          const stepType = su.step_type;
          const state = su.state;
          const stepIndex = typeof su.step_index === 'number' ? su.step_index : -1;

          if (stepType === 'tool') {
            const toolInfo =
              su.tool_info && typeof su.tool_info === 'object' ? (su.tool_info as Record<string, unknown>) : {};
            const rawName = String(su.tool_name || toolInfo.name || 'tool');
            const summaryInfo = summarizeToolName(rawName, reqLang);
            const toolErr =
              toolInfo.error && typeof toolInfo.error === 'object'
                ? String((toolInfo.error as Record<string, unknown>).message || 'Tool error')
                : undefined;
            const durationSec =
              typeof su.duration_seconds === 'number' ? Math.round(su.duration_seconds * 10) / 10 : undefined;

            if (state === 'ACTIVE') {
              const entry: AiCoachToolLogEntry = {
                toolName: summaryInfo.displayName,
                summary: summaryInfo.startSummary,
                status: 'running',
              };
              activeToolsByStep.set(stepIndex, entry);
              onEvent({
                requestId,
                type: 'tool_start',
                toolName: summaryInfo.displayName,
                summary: summaryInfo.startSummary,
              });
            } else if (state === 'DONE') {
              const entry: AiCoachToolLogEntry = {
                toolName: summaryInfo.displayName,
                summary: toolErr ? `${summaryInfo.displayName}: ${reqLang === 'en' ? 'Error' : 'Fehler'}` : summaryInfo.doneSummary,
                durationSec,
                status: toolErr ? 'error' : 'done',
                error: toolErr,
              };
              activeToolsByStep.delete(stepIndex);
              toolHistory.push(entry);
              onEvent({
                requestId,
                type: 'tool_done',
                toolName: entry.toolName,
                summary: entry.summary,
                durationSec,
                error: toolErr,
              });
            }
            return;
          }

          if (stepType === 'agent_response' && typeof su.text_delta === 'string' && su.text_delta.length > 0) {
            accumulatedText += su.text_delta;
            onEvent({
              requestId,
              type: 'delta',
              text: su.text_delta,
            });
          }
          return;
        }

        if (evtType === 'result' && payload.result && typeof payload.result === 'object') {
          sawTerminalResult = true;
          const res = payload.result as Record<string, unknown>;
          const status = String(res.status || '');
          const conversationId =
            typeof res.conversation_id === 'string' && res.conversation_id ? res.conversation_id : undefined;
          const durationSeconds =
            typeof res.duration_seconds === 'number' ? Math.round(res.duration_seconds * 10) / 10 : undefined;

          if (status === 'SUCCESS') {
            const finalResponse =
              typeof res.response === 'string' && res.response.trim().length > 0
                ? res.response.trim()
                : accumulatedText.trim();
            onEvent({
              requestId,
              type: 'done',
              response: finalResponse,
              conversationId,
              durationSeconds,
              modelId,
              toolCalls: toolHistory,
            });
            finish(true);
          } else {
            const rawErr =
              typeof res.error === 'string' && res.error
                ? res.error
                : `${reqLang === 'en' ? 'AI run ended with status:' : 'KI-Lauf beendet mit Status:'} ${status || 'UNKNOWN'}`;
            const friendly = translateCliError(rawErr, reqLang);
            onEvent({ requestId, type: 'error', message: friendly });
            finish(false, friendly);
          }
        }
      };

      proc.stdout?.setEncoding('utf8');
      proc.stdout?.on('data', (chunk: string) => {
        for (const line of assembler.push(chunk)) {
          handleStdoutLine(line);
        }
      });

      proc.stderr?.setEncoding('utf8');
      proc.stderr?.on('data', (chunk: string) => {
        stderrChunks.push(chunk);
      });

      proc.on('error', (err) => {
        if (this.cancelledIds.has(requestId)) {
          onEvent({ requestId, type: 'error', message: reqLang === 'en' ? 'Analysis cancelled.' : 'Analyse abgebrochen.', cancelled: true });
          finish(false, reqLang === 'en' ? 'Analysis cancelled.' : 'Analyse abgebrochen.');
          return;
        }
        const msg = translateCliError(err.message, reqLang);
        onEvent({ requestId, type: 'error', message: msg });
        finish(false, msg);
      });

      proc.on('close', (code) => {
        if (settled || sawTerminalResult) {
          finish(true);
          return;
        }
        if (this.cancelledIds.has(requestId)) {
          onEvent({ requestId, type: 'error', message: reqLang === 'en' ? 'Analysis cancelled.' : 'Analyse abgebrochen.', cancelled: true });
          finish(false, reqLang === 'en' ? 'Analysis cancelled.' : 'Analyse abgebrochen.');
          return;
        }
        const stderrText = stderrChunks.join('').trim();
        const fallbackErr = stderrText || `${reqLang === 'en' ? 'Antigravity CLI exited unexpectedly' : 'Antigravity CLI wurde unerwartet beendet'} (Code ${code ?? 'unknown'}).`;
        const friendly = translateCliError(fallbackErr, reqLang);
        onEvent({ requestId, type: 'error', message: friendly });
        finish(false, friendly);
      });

      try {
        const inputLine = JSON.stringify({
          event: 'user',
          message: { content: prompt },
        });
        proc.stdin?.write(`${inputLine}\n`);
        proc.stdin?.end();
      } catch (err) {
        const msg = `Prompt konnte nicht an agy gesendet werden: ${err instanceof Error ? err.message : String(err)}`;
        onEvent({ requestId, type: 'error', message: msg });
        finish(false, msg);
      }
    });
  }
}
