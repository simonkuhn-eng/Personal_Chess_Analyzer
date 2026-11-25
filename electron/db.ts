import { isReliableGame, isReliableGameMove } from '../src/utils/evaluationReliability';
import { playedAt, migrateGameTime } from '../src/utils/gameTime';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { GameAnalysis, PlayerStats, ArchiveItem } from '../src/types/chess';
import { archiveItem } from '../src/utils/archive';
import { annotateMissedOpportunities } from '../src/utils/missedOpportunities';
import { moveCategory } from '../src/utils/analysis';
import { buildOpeningPhaseStats, normalizeOpeningWindow } from '../src/utils/openingPhase';
import type { StatisticsFilter } from '../src/types/statistics';
import { matchesStatisticsFilter, normalizeStatisticsFilter } from '../src/utils/statisticsFilter';
import { buildPerformanceOverview, gamePhase } from '../src/utils/performanceStatistics';
import { buildDeepDiagnostics } from '../src/utils/deepDiagnostics';
import { classifyTimeControl } from '../src/utils/timeControl';
export { classifyTimeControl } from '../src/utils/timeControl';
import {
  moveIdea,
  classifyMatePattern,
  MISSED_IDEA_LABELS,
  resolvePlayerColor,
  findEvidencedLostPiece,
} from '../src/utils/moveInsights';
import { detectOpeningFromFens } from '../src/utils/openingBook';
import type { MissedIdea } from '../src/types/chess';
import { writeJsonFileAtomic } from './jsonStore';
import { isStableGameId, sameSourceIdentity, mergePreviousIds } from '../src/utils/pgn';
import { repairAlternatingPovAnalysis } from '../src/utils/repairAlternatingPov';

interface DbData {
  games: GameAnalysis[];
}

export class ChessDatabase {
  private filePath: string;
  private data: DbData = { games: [] };
  /**
   * R08: Nach fehlgeschlagener Recovery (kaputte DB konnte nicht als .broken
   * gesichert werden ODER Lesefehler ungeklärter Ursache) Schreibschutz —
   * Mutationen werden mit sichtbarem Fehler abgewiesen, damit das nächste
   * save() nicht das ungesicherte Original überschreibt.
   */
  private recoveryLock: string | null = null;

  constructor() {
    const userDataPath = app.getPath('userData');
    this.filePath = path.join(userDataPath, 'games_db.json');
    this.load();
  }

  private load() {
    if (!fs.existsSync(this.filePath)) {
      try {
        this.save();
      } catch (err) {
        console.error('Error creating database:', err);
      }
      return;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      console.error('Error reading database file:', err);
      // R08: ungeklärter Lesefehler → Schreibschutz, Original bleibt unangetastet
      this.recoveryLock = 'Datenbank konnte nicht gelesen werden — Schreibschutz aktiv. Bitte Datei prüfen (games_db.json).';
      this.data = { games: [] };
      return;
    }

    let parsed: DbData;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // T05: Beschädigte DB NIEMALS als leere Datenbank überschreiben.
      // Original wird unter eindeutigem Namen gesichert (Recovery möglich),
      // danach startet die App mit leerer DB — das nächste save() schreibt
      // eine NEUE Datei, das Original bleibt erhalten.
      const backupPath = `${this.filePath}.broken-${Date.now()}`;
      try {
        fs.renameSync(this.filePath, backupPath);
        console.error(
          `Datenbank war beschädigt — Original gesichert unter ${backupPath}. Neue leere Datenbank wird erstellt.`
        );
      } catch (backupErr) {
        console.error('Datenbank beschädigt und Backup fehlgeschlagen — es wird NICHT gespeichert:', backupErr);
        // R08: Ohne gesicherte Kopie NIEMALS die Originaldatei überschreiben
        this.recoveryLock = 'Datenbank beschädigt und Sicherung fehlgeschlagen — Schreibschutz aktiv, Original erhalten. Bitte games_db.json manuell sichern/untersuchen.';
      }
      this.data = { games: [] };
      return;
    }

    const games: GameAnalysis[] = Array.isArray(parsed?.games) ? parsed.games : [];
    // Dedup: stabile IDs gruppieren nach ID; Legacy-Einträge (Zufalls-IDs aus
    // der UUID-Ära) nur dann nach dem klassischen Fingerabdruck verschmelzen,
    // wenn die Quellmetadaten die Identität bestätigen (R07) — sonst werden
    // beide Partien erhalten statt zu verschmelzen (Zwillingspartien, die
    // identische Züge an verschiedenen Tagen gespielt haben).
    const uniqueGames: GameAnalysis[] = [];
    const indexByKey = new Map<string, number>();
    let mergedCount = 0;
    for (const game of games) {
      const stable = isStableGameId(game.id);
      const key = stable ? `id:${game.id}` : `fp:${this.gameFingerprint(game)}`;
      const existingIndex = indexByKey.get(key);
      if (existingIndex === undefined) {
        indexByKey.set(key, uniqueGames.length);
        uniqueGames.push(game);
        continue;
      }
      const existing = uniqueGames[existingIndex];
      const sameId = key.startsWith('id:');
      if (sameId || sameSourceIdentity(existing, game)) {
        // gleiche stabile ID oder bestätigte Quelle — letzter Stand gewinnt,
        // frühere IDs bleiben für die Lernschlüssel-Migration zugeordnet (R07)
        uniqueGames[existingIndex] = { ...game, previousIds: mergePreviousIds(existing, game) };
        mergedCount++;
      } else {
        // R07: Unklarheit oder Widerspruch — erhalten statt verschmelzen
        uniqueGames.push(game);
      }
    }
    const repairedGames = uniqueGames.map((game) => repairAlternatingPovAnalysis(game) ?? game);
    const repairedCount = repairedGames.filter((game, index) => game !== uniqueGames[index]).length;
    this.data = { games: repairedGames };
    if (repairedCount > 0) {
      // Original vor der einmaligen Korrektur unverändert sichern.
      const backupPath = `${this.filePath}.before-pov-repair-${Date.now()}`;
      try {
        fs.copyFileSync(this.filePath, backupPath, fs.constants.COPYFILE_EXCL);
        this.save();
        console.info(`${repairedCount} Partien mit falscher Bewertungsrichtung repariert; Backup: ${backupPath}`);
      } catch (err) {
        this.data = { games: uniqueGames };
        console.error('POV-Reparatur nicht gespeichert; Original bleibt erhalten:', err);
      }
    } else if (mergedCount > 0) {
      try {
        this.save();
      } catch (err) {
        console.error('Error saving deduplicated database:', err);
      }
    }
  }

  /**
   * Atomar schreiben (T05): Fehler werden NICHT verschluckt — der Aufrufer
   * (IPC-Handler) propagiert sie an die UI, die sonst fälschlich Erfolg meldet.
   */
  private save() {
    // R08: Recovery-Lock gilt für ALLE Schreibpfade (auch Dedup beim Load)
    if (this.recoveryLock) throw new Error(this.recoveryLock);
    writeJsonFileAtomic(this.filePath, this.data);
  }

  private gameFingerprint(game: GameAnalysis): string {
    const normalize = (value: string | undefined) => (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const moves = (game.moves || []).map((move) => move.uci).join(',');
    return [normalize(game.white), normalize(game.black), moves || normalize(game.pgn)].join('|');
  }

  /**
   * T06 replaceAnalysis-Semantik: Eine Partie mit identischer ID wird durch
   * die neue Analyse ERSETZT (Reanalyse aktualisiert, statt alte zu verwerfen).
   * Der RAM-Stand wird erst nach erfolgreichem Schreiben übernommen (T05).
   */
  saveGame(game: GameAnalysis): GameAnalysis {
    if (this.recoveryLock) throw new Error(this.recoveryLock);
    game = annotateMissedOpportunities(migrateGameTime(game));
    const candidateGames: GameAnalysis[] = [];
    let replacedGame: GameAnalysis | null = null;
    const existingIndex = this.data.games.findIndex((g) => g.id === game.id);
    if (existingIndex >= 0) {
      candidateGames.push(...this.data.games);
      // createdAt (Importzeitpunkt) bleibt bei Reanalyse stabil; frühere IDs
      // bleiben für die Lernschlüssel-Migration zugeordnet (R07)
      const prev = this.data.games[existingIndex];
      replacedGame = { ...game, createdAt: prev.createdAt || game.createdAt, playedAt: game.playedAt || prev.playedAt, previousIds: mergePreviousIds(prev, game) };
      candidateGames[existingIndex] = replacedGame;
    } else {
      const fingerprint = this.gameFingerprint(game);
      // Fingerprint-Fallback nur für Legacy-Einträge: zwei NEUE Partien mit
      // gleicher Zugfolge aber unterschiedlicher ID (unterschiedliches Datum)
      // dürfen sich nicht gegenseitig überschreiben (T06/F07). R07: Der schwache
      // Fingerabdruck allein genügt nicht — die Quellmetadaten müssen die
      // Identität bestätigen, sonst erhalten statt verschmelzen.
      const duplicateIndex = this.data.games.findIndex((g) => {
        if (isStableGameId(game.id) && isStableGameId(g.id)) return false;
        if (this.gameFingerprint(g) !== fingerprint) return false;
        return sameSourceIdentity(g, game);
      });
      if (duplicateIndex >= 0) {
        candidateGames.push(...this.data.games);
        const prev = this.data.games[duplicateIndex];
        replacedGame = { ...game, createdAt: prev.createdAt || game.createdAt, playedAt: game.playedAt || prev.playedAt, previousIds: mergePreviousIds(prev, game) };
        candidateGames[duplicateIndex] = replacedGame;
      } else {
        candidateGames.push(game, ...this.data.games); // most recent first
      }
    }

    const previous = this.data;
    this.data = { games: candidateGames };
    try {
      this.save();
    } catch (err) {
      this.data = previous; // Rollback: RAM bleibt konsistent mit der Platte
      throw err;
    }
    return replacedGame || game;
  }

  /**
   * T13: `targetPlayer` (optional) schränkt Fehler-/Patzerzähler auf die
   * EIGENEN Züge des Zielspielers ein — vorher zählten die Listen die Fehler
   * beider Spieler, während die Genauigkeit persönlich war. Ohne Parameter
   * bleibt das alte Verhalten (beide Seiten, z. B. für neutrale Exporte).
   */
  getGames(targetPlayer?: string): ArchiveItem[] {
    this.data.games = this.data.games.map(game => annotateMissedOpportunities(migrateGameTime(game)));
    return this.data.games.map(game => archiveItem(game, targetPlayer));
  }

  /** Keep native window events responsive while enriching a large archive. */
  async getGamesAsync(targetPlayer?: string): Promise<ArchiveItem[]> {
    const snapshot = this.data.games;
    const items: ArchiveItem[] = [];
    let sliceStart = performance.now();
    for (let i = 0; i < snapshot.length; i++) {
      const game = annotateMissedOpportunities(migrateGameTime(snapshot[i]));
      if (this.data.games === snapshot) snapshot[i] = game;
      items.push(archiveItem(game, targetPlayer));
      if (performance.now() - sliceStart >= 8) {
        await new Promise<void>(resolve => setImmediate(resolve));
        sliceStart = performance.now();
      }
    }
    return items;
  }

  getGame(id: string): GameAnalysis | null {
    const index = this.data.games.findIndex(g => g.id === id);
    if (index < 0) return null;
    const game = annotateMissedOpportunities(migrateGameTime(this.data.games[index]));
    this.data.games[index] = game;
    return game;
  }

  /** Fingerprints aller gespeicherten Partien (Dedup-Abgleich beim chess.com-Import). */
  /**
   * R07: Stabile IDs des Bestands — Import-Modals prüfen die Quellidentität
   * (Partie-ID statt des schwachen Legacy-Fingerabdrucks), damit Zwillings-
   * partien (gleiche Züge, verschiedenes Datum) nicht mehr vor dem Speichern
   * ausgesortiert werden.
   */
  getStableGameIds(): string[] {
    return this.data.games.map((g) => g.id).filter(isStableGameId);
  }

  /**
   * R07: Explizite ID-Zuordnung für die Lernschlüssel-Migration — jede
   * frühere ID (previousIds aus Reanalyse/Legacy-Migration) → aktuelle ID.
   * Ziel ist immer eine stabile ID.
   */
  getReviewIdMap(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const g of this.data.games) {
      if (!isStableGameId(g.id) || !g.previousIds) continue;
      for (const prevId of g.previousIds) {
        if (prevId && !map[prevId]) map[prevId] = g.id;
      }
    }
    return map;
  }

  deleteGame(id: string): boolean {
    if (this.recoveryLock) throw new Error(this.recoveryLock);
    const prevLen = this.data.games.length;
    if (!this.data.games.some((g) => g.id === id)) return false;
    const previous = this.data;
    this.data = { games: this.data.games.filter((g) => g.id !== id) };
    try {
      this.save();
    } catch (err) {
      this.data = previous;
      throw err;
    }
    return this.data.games.length === prevLen - 1;
  }

  exportGames(): GameAnalysis[] { return this.data.games; }

  replaceGames(games: GameAnalysis[]): void {
    const previous = this.data;
    this.data = { games: games.map(game => annotateMissedOpportunities(migrateGameTime(game))) };
    try { this.save(); } catch (error) { this.data = previous; throw error; }
  }

  getPlayerStats(targetPlayer: string = 'Mein Profil', openingWindowMoves = 12, requestedFilter?: Partial<StatisticsFilter>): PlayerStats {
    const filter = normalizeStatisticsFilter(requestedFilter), now = Date.now();
    // T13: Genauigkeit 0 ist ein ECHTER Wert (analysierte, katastrophal
    // gespielte Partie) — unbekannt ist nur, wer nie analysiert wurde.
    // Überall derselbe Nenner: nur analysierte Partien mit gültigem Wert.
    const isValidAccuracy = (v: number | undefined): v is number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
    const wasAnalyzed = isReliableGame;

    // T13: exakt normalisierter Spieler-Resolver (kein includes()) —
    // 'audit-user' matcht nicht 'audit-user-other', leerer Name matcht
    // niemanden, fremde Partien bekommen KEINE Farbannahme.
    const ownGames = this.data.games.filter(
      (g) => resolvePlayerColor(g.white, g.black, targetPlayer, g.site) !== null
    ).map(annotateMissedOpportunities);
    const playerGames = ownGames.filter(game => matchesStatisticsFilter(game, filter, now)).filter(isReliableGame);

    let winCount = 0;
    let lossCount = 0;
    let drawCount = 0;
    let totalAcc = 0;
    let countedAccGames = 0;
    const colorStats = {
      white: { games: 0, wins: 0, losses: 0, draws: 0, accSum: 0, accCount: 0 },
      black: { games: 0, wins: 0, losses: 0, draws: 0, accSum: 0, accCount: 0 },
    };

    let openingBlunders = 0;
    let middlegameBlunders = 0;
    let endgameBlunders = 0;

    let errorSeveritySum = 0;
    let errorSeverityCount = 0;
    let worstError: PlayerStats['worstError'] = null;
    const timeControlMap: Record<
      string,
      { games: number; wins: number; losses: number; draws: number; accSum: number; accCount: number }
    > = {};

    // T13: belegbare Figurenverluste statt bewegter Figur; Königszugfehler
    // ohne belegbaren Verlust werden ehrlich unter 'k' gezählt.
    const blunderedPieces: Record<string, number> = { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 };
    const ideaCounts: Record<MissedIdea, number> = { mate: 0, capture: 0, fork: 0, check: 0, quiet: 0 };
    let ideaTotal = 0;
    const ideaExamples: PlayerStats['overlookedIdeas']['examples'] = [];
    const matePatterns = { backRank: 0, smothered: 0, net: 0, total: 0 };
    const variationMap: Record<
      string,
      { games: number; blunders: number; accSum: number; accCount: number; openingPhaseBlunders: number }
    > = {};
    const openingMap: Record<
      string,
      { name: string; eco: string; games: number; wins: number; losses: number; draws: number; accSum: number; accCount: number; blunders: number; whiteGames: number; whiteWins: number; blackGames: number; blackWins: number }
    > = {};

    for (const game of playerGames) {
      // T13: exakter Resolver statt Farbannahme — fremde Partien sind gar
      // nicht erst in playerGames; hier nur defensiv.
      const userColor = resolvePlayerColor(game.white, game.black, targetPlayer, game.site);
      if (!userColor) continue;

      // T12: gemeinsame Eröffnungserkennung — längste passend erreichte
      // benannte Stellung aus dem Anker-Buch, identisch zu Import/Archiv.
      const bookHit = detectOpeningFromFens(game.moves.map((m) => m.fenAfter));
      const variationKey = bookHit?.name || game.openingName || 'Ohne Theorielinie';
      if (!variationMap[variationKey]) {
        variationMap[variationKey] = { games: 0, blunders: 0, accSum: 0, accCount: 0, openingPhaseBlunders: 0 };
      }
      variationMap[variationKey].games++;
      // T13: derselbe Genauigkeits-Nenner wie überall (analysiert + gültig, 0 zählt).
      const userAccInsights = userColor === 'w' ? game.accuracyWhite : game.accuracyBlack;
      if (wasAnalyzed(game) && isValidAccuracy(userAccInsights)) {
        variationMap[variationKey].accSum += userAccInsights;
        variationMap[variationKey].accCount++;
      }

      // Mattmuster: nur verlorene Partien, letzter Zug ist Matt des Gegners
      const userLost =
        (userColor === 'w' && game.result === '0-1') || (userColor === 'b' && game.result === '1-0');
      if (userLost && game.moves.length > 0) {
        const last = game.moves[game.moves.length - 1];
        if (last.isCheckmate && last.color !== userColor) {
          const pattern = classifyMatePattern(last.fenBefore, last.uci);
          if (pattern) {
            matePatterns[pattern]++;
            matePatterns.total++;
          }
        }
      }

      // Win / Loss / Draw
      if (game.result === '1-0') {
        if (userColor === 'w') winCount++;
        else lossCount++;
      } else if (game.result === '0-1') {
        if (userColor === 'b') winCount++;
        else lossCount++;
      } else if (game.result === '1/2-1/2') {
        drawCount++;
      }

      // T13: accuracy 0 ist ein echter Wert — nur NICHT analysierte Partien
      // bleiben außen (derselbe Nenner wie in allen Buckets).
      const userAcc = userColor === 'w' ? game.accuracyWhite : game.accuracyBlack;
      if (wasAnalyzed(game) && isValidAccuracy(userAcc)) {
        totalAcc += userAcc;
        countedAccGames++;
      }

      // Zeitkontrollen-Bucket (T13: gespeicherte timeClass hat Vorrang, Daily
      // und Unbekannt getrennt; '*' ist ungeklärt, KEIN Remis)
      const tcLabel = classifyTimeControl(game.timeControl, game.timeClass);
      if (!timeControlMap[tcLabel]) {
        timeControlMap[tcLabel] = { games: 0, wins: 0, losses: 0, draws: 0, accSum: 0, accCount: 0 };
      }
      const tcBucket = timeControlMap[tcLabel];
      tcBucket.games++;
      if (wasAnalyzed(game) && isValidAccuracy(userAcc)) {
        tcBucket.accSum += userAcc;
        tcBucket.accCount++;
      }
      if ((game.result === '1-0' && userColor === 'w') || (game.result === '0-1' && userColor === 'b')) {
        tcBucket.wins++;
      } else if ((game.result === '0-1' && userColor === 'w') || (game.result === '1-0' && userColor === 'b')) {
        tcBucket.losses++;
      } else if (game.result === '1/2-1/2') {
        tcBucket.draws++;
      }

      // Openings aggregation
      const opKey = game.openingName || game.eco || 'Standard';
      if (!openingMap[opKey]) {
        openingMap[opKey] = {
          name: game.openingName || 'Standard',
          eco: game.eco || '',
          games: 0,
          wins: 0,
          losses: 0,
          draws: 0,
          accSum: 0,
          accCount: 0,
          blunders: 0,
          whiteGames: 0,
          whiteWins: 0,
          blackGames: 0,
          blackWins: 0,
        };
      }
      openingMap[opKey].games++;
      if (wasAnalyzed(game) && isValidAccuracy(userAcc)) {
        openingMap[opKey].accSum += userAcc;
        openingMap[opKey].accCount++;
      }
      const colorBucket = userColor === 'w' ? colorStats.white : colorStats.black;
      colorBucket.games++;
      if (wasAnalyzed(game) && isValidAccuracy(userAcc)) {
        colorBucket.accSum += userAcc;
        colorBucket.accCount++;
      }
      if (userColor === 'w') openingMap[opKey].whiteGames++;
      else openingMap[opKey].blackGames++;
      if ((game.result === '1-0' && userColor === 'w') || (game.result === '0-1' && userColor === 'b')) {
        openingMap[opKey].wins++;
        colorBucket.wins++;
        if (userColor === 'w') openingMap[opKey].whiteWins++;
        else openingMap[opKey].blackWins++;
      } else if ((game.result === '0-1' && userColor === 'w') || (game.result === '1-0' && userColor === 'b')) {
        openingMap[opKey].losses++;
        colorBucket.losses++;
      } else if (game.result === '1/2-1/2') {
        openingMap[opKey].draws++;
        colorBucket.draws++;
      }

      // Moves & Blunder clustering
      for (const move of game.moves) {
        if (move.color !== userColor || move.isForced || !isReliableGameMove(game, move)) continue;

        const category = moveCategory(move);
        if (!['blunder', 'mistake', 'miss'].includes(category)) continue;
        const ideaResult = moveIdea(move);
        if (ideaResult) {
          ideaTotal++;
          ideaCounts[ideaResult.idea]++;
          ideaExamples.push({ san: move.san, bestSan: ideaResult.bestSan, moveNumber: move.moveNumber, idea: ideaResult.idea, heuristic: ideaResult.heuristic ?? false, winChanceDrop: move.winChanceDrop, date: game.date, openingName: game.openingName || game.eco, gameId: game.id, ply: move.ply });
        }

        if (category === 'blunder' || category === 'mistake') {
          // Use the same explicit opening window as the focused diagnosis.
          // After that, identify endgames by material rather than move number.
          const phase = gamePhase(move, normalizeOpeningWindow(openingWindowMoves));
          if (phase === 'opening') {
            openingBlunders++;
            variationMap[variationKey].openingPhaseBlunders++;
          } else if (phase === 'endgame') {
            endgameBlunders++;
          } else {
            middlegameBlunders++;
          }

          // T13: belegbarer Figurenverlust aus der Gegenantwort (evalAfter.pv
          // = beste Gegnerlinie) statt der bewegten Figur. Königszugfehler
          // ohne belegbaren Verlust landen ehrlich unter 'k'; positionelle
          // Fehler ohne belegbaren Verlust zählen KEINE Figur.
          const lostPiece =
            findEvidencedLostPiece(move.fenAfter, move.evalAfter?.pv, userColor, move) ??
            (move.piece === 'k' ? 'k' : null);
          if (lostPiece && blunderedPieces[lostPiece] !== undefined) {
            blunderedPieces[lostPiece]++;
          }

          openingMap[opKey].blunders++;
          variationMap[variationKey].blunders++;

          // "Was hätte der Bestzug gebracht?" - Idee klassifizieren (T14: PV
          // mitgeben → Matt in mehreren Zügen belegbar; heuristic-Flag mit-
          // speichern, wenn nur geometrische Gabel ohne Gewinnbeleg)
          // Fehlerschwere: Gewinnchancen-Verlust akkumulieren + schlimmsten Fehler tracken
          errorSeveritySum += move.winChanceDrop;
          errorSeverityCount++;
          if (!worstError || move.winChanceDrop > worstError.winChanceDrop) {
            worstError = {
              san: move.san,
              moveNumber: move.moveNumber,
              winChanceDrop: move.winChanceDrop,
              date: game.date,
              openingName: game.openingName || game.eco,
              color: userColor,
              // T18: Beleg-Verweis — Position vor dem Fehler = ply - 1
              gameId: game.id,
              ply: move.ply,
            };
          }
        }
      }
    }

    const avgAccuracy = countedAccGames > 0 ? Math.round((totalAcc / countedAccGames) * 10) / 10 : 0;

    const openingsStats = Object.values(openingMap)
      .map((op) => ({
        name: op.name,
        eco: op.eco,
        games: op.games,
        wins: op.wins,
        losses: op.losses,
        draws: op.draws,
        avgAccuracy: op.accCount > 0 ? Math.round((op.accSum / op.accCount) * 10) / 10 : 0,
        blunders: op.blunders,
        whiteGames: op.whiteGames,
        whiteWins: op.whiteWins,
        blackGames: op.blackGames,
        blackWins: op.blackWins,
      }))
      .sort((a, b) => b.games - a.games);

    // Genauigkeits-Verlauf (T13): analysierte Partien inkl. echter 0-Werte;
    // chronologisch über createdAt (UTC) mit Datum als Fallback — gleiche
    // Tage behalten deterministische Reihenfolge.
    const accuracyHistory = playerGames
      .filter(g => !!playedAt(g))
      .filter((g) => {
        const userColor = resolvePlayerColor(g.white, g.black, targetPlayer, g.site);
        if (!userColor) return false;
        const acc = userColor === 'w' ? g.accuracyWhite : g.accuracyBlack;
        return wasAnalyzed(g) && isValidAccuracy(acc);
      })
      .map((g) => {
        const userColor = resolvePlayerColor(g.white, g.black, targetPlayer, g.site) as 'w' | 'b';
        const win = (userColor === 'w' && g.result === '1-0') || (userColor === 'b' && g.result === '0-1');
        const draw = g.result === '1/2-1/2';
        return {
          date: g.date,
          createdAt: g.createdAt,
          playedAt: playedAt(g),
          accuracy: userColor === 'w' ? g.accuracyWhite : g.accuracyBlack,
          result: g.result,
          win,
          draw,
        };
      })
      .sort((a, b) => (a.playedAt || '').localeCompare(b.playedAt || '') || (a.createdAt || '').localeCompare(b.createdAt || ''));

    const timeControlStats = Object.entries(timeControlMap)
      .map(([label, s]) => {
        const completed = s.wins + s.losses + s.draws;
        return {
          label,
          games: s.games,
          wins: s.wins,
          losses: s.losses,
          draws: s.draws,
          avgAccuracy: s.accCount > 0 ? Math.round((s.accSum / s.accCount) * 10) / 10 : 0,
          winRate: completed > 0 ? Math.round((s.wins / completed) * 100) : 0,
        };
      })
      .sort((a, b) => b.games - a.games);

    const avgErrorSeverity =
      errorSeverityCount > 0 ? Math.round((errorSeveritySum / errorSeverityCount) * 10) / 10 : 0;

    // "Was hätte der Bestzug gebracht?" - Top-Beispiele nach Fehlerschwere
    const topIdeaExamples = ideaExamples
      .sort((a, b) => b.winChanceDrop - a.winChanceDrop)
      .slice(0, 5);

    // Varianten-Ranking (T13): RELATIV — Fehler je Partie statt absoluter
    // Zahl (viel gespielte Eröffnungen sind sonst systematisch "schlechter");
    // Fehler in der Eröffnungsphase getrennt ausgewiesen. Tie-Break: Fallzahl.
    const variationStats = Object.entries(variationMap)
      .map(([variation, s]) => ({
        variation,
        games: s.games,
        blunders: s.blunders,
        blundersPerGame: s.games > 0 ? Math.round((s.blunders / s.games) * 100) / 100 : 0,
        openingPhaseBlunders: s.openingPhaseBlunders,
        avgAccuracy: s.accCount > 0 ? Math.round((s.accSum / s.accCount) * 10) / 10 : 0,
      }))
      .filter((v) => v.blunders > 0)
      .sort((a, b) => b.blundersPerGame - a.blundersPerGame || b.games - a.games)
      .slice(0, 7);

    // Dynamic Coaching Insights
    const coachingInsights: string[] = [];
    const totalBlunders = openingBlunders + middlegameBlunders + endgameBlunders;

    // "Was hätte der Bestzug gebracht?" - häufigste übersehene Idee
    if (ideaTotal > 0) {
      const ideasSorted = Object.entries(ideaCounts).sort((a, b) => b[1] - a[1]);
      const [topIdea, topIdeaCount] = ideasSorted[0];
      if (topIdeaCount > 0) {
        const label = MISSED_IDEA_LABELS[topIdea as MissedIdea];
        coachingInsights.push(
          `🧩 **Übersehene Ideen (${label})**: In ${topIdeaCount} von ${ideaTotal} Fehlerfällen war die bessere Idee: ${label.toLowerCase()}. Nach jedem Gegner-Zug aktiv nach Motiven suchen: hängende Figuren, Mattmuster, Gabeln.`
        );
      }
    }

    if (totalBlunders > 0) {
      const midPct = Math.round((middlegameBlunders / totalBlunders) * 100);
      const openPct = Math.round((openingBlunders / totalBlunders) * 100);
      const endPct = Math.round((endgameBlunders / totalBlunders) * 100);

      if (midPct >= 50) {
        coachingInsights.push(
          `⚠️ **Mittelspiel-Fokus**: ${midPct}% deiner schwerwiegenden Fehler entstehen im Mittelspiel (nach der Eröffnungsphase, vor dem Endspiel). Achte besonders auf ungedeckte Figuren und gegnerische Taktikmotive nach dem Übergang aus der Eröffnung.`
        );
      } else if (openPct >= 35) {
        coachingInsights.push(
          `📖 **Eröffnungsphase**: ${openPct}% deiner gröberen Fehler und Patzer entstehen in den ersten ${normalizeOpeningWindow(openingWindowMoves)} Zügen. Prüfe unten die konkreten Aufbauten und deine frühen Entscheidungen.`
        );
      } else if (endPct >= 35) {
        coachingInsights.push(
          `👑 **Endspieltechnik**: ${endPct}% deiner Fehler treten im späten Endspiel auf. König-Aktivität und Bauernumwandlungen sind hier dein wichtigster Hebel.`
        );
      }

      // Most blundered piece
      const piecesSorted = Object.entries(blunderedPieces).sort((a, b) => b[1] - a[1]);
      if (piecesSorted[0] && piecesSorted[0][1] > 0) {
        const pieceNames: Record<string, string> = {
          q: 'Damen',
          r: 'Türme',
          b: 'Läufer',
          n: 'Springer',
          p: 'Bauern',
          k: 'König',
        };
        const pieceName = pieceNames[piecesSorted[0][0]] || 'Figuren';
        if (piecesSorted[0][0] === 'k') {
          coachingInsights.push(
            `♛ **Königssicherheit**: ${piecesSorted[0][1]}x endete ein Patzer in einem belegbar verlorenen Königsstellungsszenario (ohne direkten Figurenverlust). Prüfe vor Königszügen: "Ist mein Königsfeld gedeckt, welche Diagonalen und Reihen sind offen?"`
          );
        } else {
          coachingInsights.push(
            `♟️ **Taktische Verwundbarkeit (${pieceName})**: Am häufigsten belegbar verloren oder eingestellt: **${pieceName}** (${piecesSorted[0][1]}x). Halte vor jedem Zug kurz inne: "Steht mein(e) ${pieceName} sicher und gedeckt?".`
          );
        }
      }

      // Fehlerschwere-Insight: avg severity relative to mistake threshold (15%)
      if (avgErrorSeverity > 0) {
        if (avgErrorSeverity >= 22) {
          coachingInsights.push(
            `🌡️ **Fehler haben es in sich**: Deine Fehler kosten im Schnitt ${avgErrorSeverity.toFixed(1)}%-Punkte Gewinnchance - das ist nahe an Patzer-Niveau. Rechne vor jedem Zug kurz durch: "Welche Figuren hängen jetzt und nach meinem Zug?"`
          );
        } else {
          coachingInsights.push(
            `🌡️ **Fehlerschwere moderat**: Deine Fehler kosten im Schnitt ${avgErrorSeverity.toFixed(1)}%-Punkte Gewinnchance. Kleiner Hebel: Nach jedem Gegner-Zug 3 Sekunden "Was hat sich geändert?" checken.`
          );
        }
        if (worstError) {
          coachingInsights.push(
            `💥 **Teuerster Fehler**: ${worstError.san} (Zug ${worstError.moveNumber}${worstError.openingName ? `, ${worstError.openingName}` : ''}) kostete ${Math.round(worstError.winChanceDrop)}%-Punkte Gewinnchance.`
          );
        }
      }
    } else {
      coachingInsights.push(
        '🎯 Analysiere weitere Partien, um personalisierte Fehler-Cluster und taktische Schwerpunkte zu generieren.'
      );
    }

    const whiteCompleted = colorStats.white.wins + colorStats.white.losses + colorStats.white.draws;
    const blackCompleted = colorStats.black.wins + colorStats.black.losses + colorStats.black.draws;

    return {
      playerName: targetPlayer,
      performance: buildPerformanceOverview(ownGames, targetPlayer, filter, normalizeOpeningWindow(openingWindowMoves), now),
      deepDiagnostics: buildDeepDiagnostics(playerGames, targetPlayer),
      totalGames: playerGames.length,
      winCount,
      lossCount,
      drawCount,
      avgAccuracy,
      openingWindowMoves: normalizeOpeningWindow(openingWindowMoves),
      openingPhaseStats: buildOpeningPhaseStats(playerGames, targetPlayer, openingWindowMoves),
      colorPerformance: {
        white: {
          games: colorStats.white.games,
          wins: colorStats.white.wins,
          losses: colorStats.white.losses,
          draws: colorStats.white.draws,
          avgAccuracy: colorStats.white.accCount > 0 ? Math.round((colorStats.white.accSum / colorStats.white.accCount) * 10) / 10 : 0,
          winRate: whiteCompleted > 0 ? Math.round((colorStats.white.wins / whiteCompleted) * 100) : 0,
        },
        black: {
          games: colorStats.black.games,
          wins: colorStats.black.wins,
          losses: colorStats.black.losses,
          draws: colorStats.black.draws,
          avgAccuracy: colorStats.black.accCount > 0 ? Math.round((colorStats.black.accSum / colorStats.black.accCount) * 10) / 10 : 0,
          winRate: blackCompleted > 0 ? Math.round((colorStats.black.wins / blackCompleted) * 100) : 0,
        },
      },
      phaseDistribution: {
        openingBlunders,
        middlegameBlunders,
        endgameBlunders,
      },
      blunderedPieces: {
        p: blunderedPieces.p,
        n: blunderedPieces.n,
        b: blunderedPieces.b,
        r: blunderedPieces.r,
        q: blunderedPieces.q,
        k: blunderedPieces.k,
      },
      openingsStats,
      accuracyHistory,
      timeControlStats,
      avgErrorSeverity,
      worstError,
      coachingInsights,
      overlookedIdeas: {
        total: ideaTotal,
        counts: ideaCounts,
        examples: topIdeaExamples,
      },
      matePatterns,
      variationStats,
    };
  }
}
