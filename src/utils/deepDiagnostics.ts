import { Chess } from 'chess.js';
import type {
  AnalyzedGame,
  ConversionResilienceStats,
  CoreMoveQuality,
  DeepDiagnostics,
  EngineEvalResult,
  FormComparison,
  MissedIdea,
  MoveAnalysis,
  MoveQuality,
  MoveQualityDistribution,
  MoveZoneBucket,
  MoveZoneId,
  OpponentStrengthBucket,
  OpponentStrengthCategory,
  PlayerIdentity,
  PressureProfile,
  TrainingRecommendation,
  TurningPointMove,
} from '../types/chess';
import { calculateMoveAccuracy, moveCategory } from './analysis';
import { isReliableGame, isReliableGameMove } from './evaluationReliability';
import { playedAt } from './gameTime';
import { MISSED_IDEA_LABELS, moveIdea, resolvePlayerColor } from './moveInsights';
import { gamePhase } from './performanceStatistics';
import { normalizePlayerName } from './profile';

const START_PIECE_PLACEMENT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR ';
const ERROR_CATEGORIES = new Set<MoveQuality>(['inaccuracy', 'mistake', 'blunder', 'miss']);
const CORE_QUALITIES: readonly CoreMoveQuality[] = [
  'brilliant',
  'best',
  'excellent',
  'good',
  'inaccuracy',
  'mistake',
  'blunder',
  'miss',
];

const ZONE_DEFS: ReadonlyArray<{ zone: MoveZoneId; label: string; min: number; max: number }> = [
  { zone: '1-10', label: 'Züge 1–10', min: 1, max: 10 },
  { zone: '11-20', label: 'Züge 11–20', min: 11, max: 20 },
  { zone: '21-30', label: 'Züge 21–30', min: 21, max: 30 },
  { zone: '31-40', label: 'Züge 31–40', min: 31, max: 40 },
  { zone: '41+', label: 'Züge 41+', min: 41, max: Number.POSITIVE_INFINITY },
];

const OPPONENT_BUCKETS: ReadonlyArray<{ category: OpponentStrengthCategory; label: string }> = [
  { category: 'stronger', label: 'Stärkere Gegner (> +50 Elo)' },
  { category: 'equal', label: 'Ähnliche Stärke (±50 Elo)' },
  { category: 'weaker', label: 'Schwächere Gegner (< −50 Elo)' },
];

const round1 = (value: number): number => Math.round(value * 10) / 10;
const finiteOr = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const per100 = (count: number, total: number): number => (total > 0 ? round1((count / total) * 100) : 0);
const isValidAccuracy = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

function parseValidElo(raw: string | undefined): number | null {
  const trimmed = (raw || '').trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const num = Number(trimmed);
  return num > 0 && num <= 10000 ? num : null;
}

function inferPrimaryIdentity(games: AnalyzedGame[]): string | null {
  if (games.length < 2) return null;
  const counts = new Map<string, { raw: string; count: number }>();
  for (const game of games) {
    const names = [game.white, game.black].map((name) => ({ raw: name, norm: normalizePlayerName(name || '') }));
    const seenInGame = new Set<string>();
    for (const entry of names) {
      if (!entry.norm || seenInGame.has(entry.norm)) continue;
      seenInGame.add(entry.norm);
      const prev = counts.get(entry.norm);
      counts.set(entry.norm, { raw: prev?.raw || entry.raw, count: (prev?.count || 0) + 1 });
    }
  }
  const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
  if (ranked.length >= 2 && ranked[0].count === ranked[1].count) return null;
  return ranked[0]?.raw || null;
}

function resolveColorForIdentity(game: AnalyzedGame, identity: PlayerIdentity | undefined, inferred: string | null): 'w' | 'b' | null {
  if (typeof identity === 'string') {
    return identity.trim() ? resolvePlayerColor(game.white, game.black, identity, game.site) : null;
  }
  if (Array.isArray(identity)) {
    const candidates = [...new Set(identity.map((name) => name.trim()).filter(Boolean))];
    if (!candidates.length) return null;
    let matchedWhite = false;
    let matchedBlack = false;
    for (const candidate of candidates) {
      const color = resolvePlayerColor(game.white, game.black, candidate, game.site);
      if (color === 'w') matchedWhite = true;
      else if (color === 'b') matchedBlack = true;
    }
    if (matchedWhite && matchedBlack) return null;
    return matchedWhite ? 'w' : matchedBlack ? 'b' : null;
  }
  return inferred ? resolvePlayerColor(game.white, game.black, inferred, game.site) : null;
}

function userEvalPawns(evalResult: EngineEvalResult, userColor: 'w' | 'b'): number {
  if (evalResult.mate !== undefined && Number.isFinite(evalResult.mate)) {
    if (evalResult.mate === 0) {
      const whiteWon = finiteOr(evalResult.scoreCp, 0) >= 0;
      return (userColor === 'w' ? whiteWon : !whiteWon) ? 100 : -100;
    }
    const whiteMate = evalResult.mate > 0;
    return (userColor === 'w' ? whiteMate : !whiteMate) ? 100 : -100;
  }
  const sign = userColor === 'w' ? 1 : -1;
  return (finiteOr(evalResult.scoreCp, 0) * sign) / 100;
}

function resolveOutcome(result: string | undefined, userColor: 'w' | 'b'): 'win' | 'loss' | 'draw' | 'unfinished' {
  if (result === '1-0') return userColor === 'w' ? 'win' : 'loss';
  if (result === '0-1') return userColor === 'b' ? 'win' : 'loss';
  if (result === '1/2-1/2') return 'draw';
  return 'unfinished';
}

function mapQualityBucket(move: MoveAnalysis): CoreMoveQuality {
  const category = moveCategory(move);
  if ((CORE_QUALITIES as readonly string[]).includes(category)) {
    return category as CoreMoveQuality;
  }
  if (category === 'great') return 'best';
  const drop = finiteOr(move.winChanceDrop, 0);
  if (drop < 3) return 'excellent';
  if (drop < 7) return 'good';
  if (drop < 15) return 'inaccuracy';
  if (drop < 25) return 'mistake';
  return 'blunder';
}

function isInCheckBefore(game: AnalyzedGame, moveIndex: number, move: MoveAnalysis): boolean {
  const prev = moveIndex > 0 ? game.moves[moveIndex - 1] : undefined;
  if (prev && prev.fenAfter === move.fenBefore) {
    return Boolean(prev.isCheck || prev.san?.endsWith('+') || prev.san?.endsWith('#'));
  }
  if (move.fenBefore.startsWith(START_PIECE_PLACEMENT)) return false;
  try {
    return new Chess(move.fenBefore).inCheck();
  } catch {
    return false;
  }
}

function resolveBestMoveSan(move: MoveAnalysis): string {
  const direct = move.evalBefore.bestMoveSan?.trim();
  if (direct) return direct;
  const fromMissed = move.missedOpportunity?.bestSan?.trim();
  if (fromMissed) return fromMissed;
  const uci = move.evalBefore.bestMoveUci?.trim();
  if (uci && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
    try {
      const played = new Chess(move.fenBefore).move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4],
      });
      if (played?.san) return played.san;
    } catch {
      // Fall back to UCI when FEN/UCI mismatch occurs in synthetic fixtures.
    }
  }
  return uci || '—';
}

interface SampleMoveRef {
  gameId: string;
  ply: number;
  moveNumber: number;
  san: string;
  winChanceDrop: number;
  phase: 'opening' | 'middlegame' | 'endgame';
  motif?: MissedIdea;
}

function maybeUpdateWorst(current: SampleMoveRef | null, game: AnalyzedGame, move: MoveAnalysis): SampleMoveRef {
  const drop = finiteOr(move.winChanceDrop, 0);
  if (!current || drop > current.winChanceDrop) {
    return {
      gameId: game.id,
      ply: move.ply,
      moveNumber: move.moveNumber,
      san: move.san,
      winChanceDrop: drop,
      phase: gamePhase(move, 12),
      motif: moveIdea(move)?.idea,
    };
  }
  return current;
}

interface EligibleEntry {
  game: AnalyzedGame;
  userColor: 'w' | 'b';
  orderIndex: number;
  timestamp: string;
}

function summarizeFormSlice(entries: EligibleEntry[]): {
  games: number;
  completedGames: number;
  winRate: number;
  accuracy: number;
  errorsPer100: number;
} {
  let wins = 0;
  let completedGames = 0;
  let accSum = 0;
  let accCount = 0;
  let decisions = 0;
  let errors = 0;

  for (const { game, userColor } of entries) {
    const outcome = resolveOutcome(game.result, userColor);
    if (outcome !== 'unfinished') {
      completedGames++;
      if (outcome === 'win') wins++;
    }
    const acc = userColor === 'w' ? game.accuracyWhite : game.accuracyBlack;
    if (isValidAccuracy(acc)) {
      accSum += acc;
      accCount++;
    }
    for (const move of game.moves) {
      if (move.color !== userColor || move.isForced || !isReliableGameMove(game, move)) continue;
      decisions++;
      if (ERROR_CATEGORIES.has(moveCategory(move))) errors++;
    }
  }

  return {
    games: entries.length,
    completedGames,
    winRate: completedGames > 0 ? round1((wins / completedGames) * 100) : 0,
    accuracy: accCount > 0 ? round1(accSum / accCount) : 0,
    errorsPer100: per100(errors, decisions),
  };
}

interface RankedRecommendation extends TrainingRecommendation {
  score: number;
}

function buildRecommendations(params: {
  analyzedGames: number;
  totalErrors: number;
  moveZones: MoveZoneBucket[];
  zoneWorstError: Array<SampleMoveRef | null>;
  conversion: ConversionResilienceStats;
  turningPoints: TurningPointMove[];
  pressureProfile: PressureProfile;
  worstCheckError: SampleMoveRef | null;
  ideaCounts: Record<MissedIdea, number>;
  ideaTotal: number;
  ideaWorst: Partial<Record<MissedIdea, SampleMoveRef>>;
  opponentStrength: OpponentStrengthBucket[];
  formComparison: FormComparison;
}): TrainingRecommendation[] {
  const {
    analyzedGames,
    totalErrors,
    moveZones,
    zoneWorstError,
    conversion,
    turningPoints,
    pressureProfile,
    worstCheckError,
    ideaCounts,
    ideaTotal,
    ideaWorst,
    opponentStrength,
    formComparison,
  } = params;

  if (analyzedGames === 0 || totalErrors === 0) return [];

  const candidates: RankedRecommendation[] = [];

  // 1. Squandered winning positions / turning points
  if (conversion.winningGamesCompleted >= 2 && conversion.winningGamesSquandered > 0) {
    const squanderRate = conversion.winningGamesSquandered / conversion.winningGamesCompleted;
    const topTp = turningPoints[0];
    if (squanderRate >= 0.2 || turningPoints.length > 0) {
      const pct = Math.round(squanderRate * 100);
      const tpSuffix = topTp
        ? ` · teuerster Kipppunkt: ${topTp.moveNumber}. ${topTp.san} (−${Math.round(topTp.winChanceDrop)} %)`
        : '';
      candidates.push({
        id: 'conversion-squandered',
        priority: squanderRate >= 0.35 || conversion.squanderedLosses >= 2 ? 'high' : 'medium',
        title: 'Gewinnstellungen sauber verwerten',
        summary:
          'In klar gewonnenen Partien gibst du noch spürbar Punkte ab. Prüfe bei +2,0 oder höher zuerst gegnerische Gegenchancen, statt hastig Material zu jagen.',
        evidence: `${conversion.winningGamesSquandered} von ${conversion.winningGamesCompleted} Gewinnstellungen (${pct} %) nicht gewonnen (${conversion.squanderedLosses} verloren, ${conversion.squanderedDraws} Remis)${tpSuffix}.`,
        actionLabel: topTp ? 'Wendepunkt im Review öffnen' : 'Fehler gezielt trainieren',
        targetPhase: topTp ? (topTp.moveNumber <= 12 ? 'opening' : topTp.moveNumber >= 31 ? 'endgame' : 'middlegame') : 'middlegame',
        sampleGameId: topTp?.gameId,
        samplePly: topTp?.ply,
        score: 70 + squanderRate * 40 + conversion.squanderedLosses * 8,
      });
    }
  } else if (turningPoints.length > 0) {
    const topTp = turningPoints[0];
    candidates.push({
      id: 'turning-point-focus',
      priority: topTp.winChanceDrop >= 35 ? 'high' : 'medium',
      title: 'Kritische Wendepunkte abstellen',
      summary:
        'Einzelne schwere Kipppunkte aus vorteilhaften Stellungen kosten ganze Partien. Nutze vor forcierten Zügen einen kurzen Taktik-Check.',
      evidence: `${turningPoints.length} Wendepunkt${turningPoints.length === 1 ? '' : 'e'} mit ≥ 22 % Verlust ab ≥ 55 % Gewinnchance (Spitze: Zug ${topTp.moveNumber} ${topTp.san}, −${Math.round(topTp.winChanceDrop)} %).`,
      actionLabel: 'Wendepunkt im Review öffnen',
      targetPhase: topTp.moveNumber <= 12 ? 'opening' : topTp.moveNumber >= 31 ? 'endgame' : 'middlegame',
      sampleGameId: topTp.gameId,
      samplePly: topTp.ply,
      score: 62 + Math.min(30, topTp.winChanceDrop * 0.5),
    });
  }

  // 2. Peak error move zone
  const populatedZones = moveZones
    .map((bucket, idx) => ({ bucket, idx }))
    .filter(({ bucket }) => bucket.decisions > 0 && bucket.errors > 0);
  const reliableZones = populatedZones.filter(({ bucket }) => bucket.decisions >= 8);
  const peakZoneEntry = (reliableZones.length > 0 ? reliableZones : populatedZones).sort(
    (a, b) => b.bucket.errorsPer100 - a.bucket.errorsPer100 || b.bucket.errors - a.bucket.errors,
  )[0];
  if (peakZoneEntry) {
    const { bucket, idx } = peakZoneEntry;
    const targetPhase: TrainingRecommendation['targetPhase'] =
      idx === 0 ? 'opening' : idx >= 3 ? 'endgame' : 'middlegame';
    const sample = zoneWorstError[idx];
    const phaseAdvice =
      targetPhase === 'opening'
        ? 'Wiederhole deine Hauptvarianten und prüfe Entwicklungszüge vor frühen Bauernvorstößen.'
        : targetPhase === 'endgame'
          ? 'Plane Königszüge, Freibauern und Turmendspiele bewusster — hier kippen Partien bei knapper Zeit.'
          : 'Im Übergang ins volle Mittelspiel lohnt ein kurzer Sicherheitscheck für ungedeckte Figuren und Drohungen.';
    candidates.push({
      id: `move-zone-${bucket.zone}`,
      priority: bucket.errorsPer100 >= 25 ? 'high' : bucket.errorsPer100 >= 14 ? 'medium' : 'low',
      title: `Schwerpunkt ${bucket.label}`,
      summary: phaseAdvice,
      evidence: `${bucket.errorsPer100} Fehler pro 100 Züge in ${bucket.label} (${bucket.errors} Fehler bei ${bucket.decisions} Entscheidungen, Ø ${bucket.avgAccuracy ?? '—'} % Genauigkeit).`,
      actionLabel: sample ? 'Schlüsselfehler ansehen' : 'Phase überprüfen',
      targetPhase,
      targetMotif: sample?.motif,
      sampleGameId: sample?.gameId,
      samplePly: sample?.ply,
      score: 55 + Math.min(35, bucket.errorsPer100 * 0.9) + Math.min(15, bucket.blunders * 3),
    });
  }

  // 3. Top overlooked tactical motif
  if (ideaTotal > 0) {
    const sortedIdeas = (Object.entries(ideaCounts) as Array<[MissedIdea, number]>)
      .filter(([idea, count]) => count > 0 && idea !== 'quiet')
      .sort((a, b) => b[1] - a[1]);
    const [topIdea, topCount] = sortedIdeas[0] || [];
    if (topIdea && topCount && (topCount >= 2 || totalErrors <= 5)) {
      const sample = ideaWorst[topIdea];
      const share = Math.round((topCount / ideaTotal) * 100);
      candidates.push({
        id: `motif-${topIdea}`,
        priority: topCount >= 4 || share >= 35 ? 'high' : 'medium',
        title: `Taktik-Motiv: ${MISSED_IDEA_LABELS[topIdea]}`,
        summary: `Dein häufigstes konkretes Taktikdefizit betrifft ${MISSED_IDEA_LABELS[topIdea].toLowerCase()}. Trainiere gezielt diese Fehlerkarten im Deck.`,
        evidence: `${topCount}x ${MISSED_IDEA_LABELS[topIdea].toLowerCase()} übersehen (${share} % aller klassifizierten Fehlerideen).`,
        actionLabel: 'Motiv gezielt üben',
        targetMotif: topIdea,
        targetPhase: sample?.phase,
        sampleGameId: sample?.gameId,
        samplePly: sample?.ply,
        score: 58 + Math.min(30, topCount * 4 + share * 0.3),
      });
    }
  }

  // 4. Check pressure vulnerability
  if (
    pressureProfile.checkDecisions >= 4 &&
    pressureProfile.normalDecisions >= 10 &&
    pressureProfile.checkErrorsPer100 > pressureProfile.normalErrorsPer100 + 3
  ) {
    const gap = round1(pressureProfile.checkErrorsPer100 - pressureProfile.normalErrorsPer100);
    candidates.push({
      id: 'pressure-checks',
      priority: gap >= 12 ? 'high' : 'medium',
      title: 'Sicherheit bei gegnerischem Schach erhöhen',
      summary:
        'Unter direktem Schachgebot steigt deine Fehlerquote deutlich. Vergleiche vor der Antwort konsequent: schlagen, dazwischenziehen oder König ziehen.',
      evidence: `Im Schach ${pressureProfile.checkErrorsPer100} Fehler/100 Züge (${pressureProfile.checkDecisions} Züge, ${pressureProfile.checkAvgAccuracy ?? '—'} %) vs. ${pressureProfile.normalErrorsPer100} ohne Schach.`,
      actionLabel: worstCheckError ? 'Schach-Fehler öffnen' : 'Taktik trainieren',
      targetPhase: worstCheckError?.phase,
      targetMotif: worstCheckError?.motif,
      sampleGameId: worstCheckError?.gameId,
      samplePly: worstCheckError?.ply,
      score: 52 + Math.min(35, gap * 1.4),
    });
  }

  // 5. Recent form dip
  if (formComparison.overallGames >= 12 && formComparison.accuracyDelta <= -3.5) {
    candidates.push({
      id: 'form-dip',
      priority: formComparison.accuracyDelta <= -7 ? 'high' : 'medium',
      title: 'Aktuelle Formkurve stabilisieren',
      summary:
        'Deine letzten 10 Partien liegen spürbar unter deinem Gesamtschnitt. Eine kurze Pause von schnellen Partien und gezieltes Review helfen beim Reset.',
      evidence: `Letzte ${formComparison.recentGames} Partien: ${formComparison.recentAccuracy} % Genauigkeit (${formComparison.accuracyDelta} %-Punkte vs. ${formComparison.overallAccuracy} % Gesamt-Ø).`,
      actionLabel: turningPoints[0] ? 'Letzten Kipppunkt prüfen' : 'Fehlerkarten öffnen',
      sampleGameId: turningPoints[0]?.gameId,
      samplePly: turningPoints[0]?.ply,
      score: 50 + Math.min(30, Math.abs(formComparison.accuracyDelta) * 3),
    });
  }

  // 6. Stronger vs weaker Elo performance gap
  const stronger = opponentStrength.find((b) => b.category === 'stronger');
  const equal = opponentStrength.find((b) => b.category === 'equal');
  if (stronger && equal && stronger.games >= 3 && equal.games >= 3 && stronger.errorsPer100 >= equal.errorsPer100 + 6) {
    candidates.push({
      id: 'elo-stronger-pressure',
      priority: 'medium',
      title: 'Stabilität gegen stärkere Gegner',
      summary:
        'Gegen Gegner mit > +50 Elo unterlaufen dir deutlich mehr Ungenauigkeiten und Fehler. Setze auf solide Strukturen statt riskanter Verwicklungen.',
      evidence: `Gegen Stärkere: ${stronger.errorsPer100} Fehler/100 Züge (${stronger.games} Partien) vs. ${equal.errorsPer100} gegen gleichstarke Gegner.`,
      actionLabel: 'Wendepunkte prüfen',
      sampleGameId: turningPoints[0]?.gameId,
      samplePly: turningPoints[0]?.ply,
      score: 48 + Math.min(25, stronger.errorsPer100 - equal.errorsPer100),
    });
  }

  // Sort by impact score and return at most 3 distinct recommendations.
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 3).map(({ score: _score, ...rec }) => rec);
}

export function buildDeepDiagnostics(games: AnalyzedGame[], playerNames?: PlayerIdentity): DeepDiagnostics {
  const safeGames = Array.isArray(games) ? games.filter(isReliableGame) : [];
  const inferred = playerNames === undefined ? inferPrimaryIdentity(safeGames) : null;

  const eligible: EligibleEntry[] = [];
  for (let i = 0; i < safeGames.length; i++) {
    const game = safeGames[i];
    const userColor = resolveColorForIdentity(game, playerNames, inferred);
    if (!userColor) continue;
    eligible.push({
      game,
      userColor,
      orderIndex: i,
      timestamp: playedAt(game) || game.createdAt || '',
    });
  }

  const zoneAccSums = [0, 0, 0, 0, 0];
  const zoneBuckets: MoveZoneBucket[] = ZONE_DEFS.map((def) => ({
    zone: def.zone,
    label: def.label,
    decisions: 0,
    errors: 0,
    inaccuracies: 0,
    mistakes: 0,
    blunders: 0,
    misses: 0,
    errorsPer100: 0,
    avgAccuracy: null,
  }));
  const zoneWorstError: Array<SampleMoveRef | null> = [null, null, null, null, null];

  const qualityCounts: Record<CoreMoveQuality, number> = {
    brilliant: 0,
    best: 0,
    excellent: 0,
    good: 0,
    inaccuracy: 0,
    mistake: 0,
    blunder: 0,
    miss: 0,
  };

  let totalDecisions = 0;
  let totalErrors = 0;

  let checkDecisions = 0;
  let checkErrors = 0;
  let checkAccSum = 0;
  let normalDecisions = 0;
  let normalErrors = 0;
  let normalAccSum = 0;
  let sharpDecisions = 0;
  let sharpErrors = 0;
  let sharpAccSum = 0;
  let quietDecisions = 0;
  let quietErrors = 0;
  let quietAccSum = 0;
  let worstCheckError: SampleMoveRef | null = null;

  let winningGamesReached = 0;
  let winningGamesConverted = 0;
  let squanderedDraws = 0;
  let squanderedLosses = 0;
  let defensiveGamesFaced = 0;
  let defensiveGamesSaved = 0;
  let defensiveGamesLost = 0;

  const turningPointCandidates: Array<{ game: AnalyzedGame; userColor: 'w' | 'b'; move: MoveAnalysis; wcBefore: number; wcAfter: number; wcDrop: number }> = [];

  const eloAcc = OPPONENT_BUCKETS.map((def) => ({
    category: def.category,
    label: def.label,
    games: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    accSum: 0,
    accCount: 0,
    decisions: 0,
    errors: 0,
  }));
  let opponentStrengthUnknownGames = 0;

  const ideaCounts: Record<MissedIdea, number> = { mate: 0, capture: 0, fork: 0, check: 0, quiet: 0 };
  let ideaTotal = 0;
  const ideaWorst: Partial<Record<MissedIdea, SampleMoveRef>> = {};

  for (const { game, userColor } of eligible) {
    const outcome = resolveOutcome(game.result, userColor);
    let reachedWinning = false;
    let facedDefensive = false;

    const userElo = parseValidElo(userColor === 'w' ? game.whiteElo : game.blackElo);
    const oppElo = parseValidElo(userColor === 'w' ? game.blackElo : game.whiteElo);
    let eloBucketIndex = -1;
    if (userElo !== null && oppElo !== null) {
      const diff = oppElo - userElo;
      eloBucketIndex = diff > 50 ? 0 : diff < -50 ? 2 : 1;
      const bucket = eloAcc[eloBucketIndex];
      bucket.games++;
      if (outcome === 'win') bucket.wins++;
      else if (outcome === 'loss') bucket.losses++;
      else if (outcome === 'draw') bucket.draws++;
      const gameAcc = userColor === 'w' ? game.accuracyWhite : game.accuracyBlack;
      if (isValidAccuracy(gameAcc)) {
        bucket.accSum += gameAcc;
        bucket.accCount++;
      }
    } else {
      opponentStrengthUnknownGames++;
    }

    for (let moveIndex = 0; moveIndex < game.moves.length; moveIndex++) {
      const move = game.moves[moveIndex];
      if (move.color !== userColor || !isReliableGameMove(game, move)) continue;

      const wcBefore = finiteOr(move.winChanceBefore, 50);
      const wcAfter = finiteOr(move.winChanceAfter, wcBefore);
      const wcDrop = Math.max(0, finiteOr(move.winChanceDrop, 0));
      const evalPawnsBefore = userEvalPawns(move.evalBefore, userColor);

      if (wcBefore >= 75 || evalPawnsBefore >= 2.0) reachedWinning = true;
      if (wcBefore <= 25 || evalPawnsBefore <= -2.0) facedDefensive = true;

      if (move.isForced) continue;

      totalDecisions++;
      const category = moveCategory(move);
      const coreQuality = mapQualityBucket(move);
      qualityCounts[coreQuality]++;
      const isErr = ERROR_CATEGORIES.has(category);
      if (isErr) totalErrors++;

      const moveAcc = calculateMoveAccuracy(wcDrop);

      // Move zone
      let zoneIdx = ZONE_DEFS.findIndex((def) => move.moveNumber >= def.min && move.moveNumber <= def.max);
      if (zoneIdx < 0) zoneIdx = 0;
      const z = zoneBuckets[zoneIdx];
      z.decisions++;
      zoneAccSums[zoneIdx] += moveAcc;
      if (isErr) {
        z.errors++;
        if (category === 'inaccuracy') z.inaccuracies++;
        else if (category === 'mistake') z.mistakes++;
        else if (category === 'blunder') z.blunders++;
        else if (category === 'miss') z.misses++;
        zoneWorstError[zoneIdx] = maybeUpdateWorst(zoneWorstError[zoneIdx], game, move);
      }

      // Pressure profile: checks vs non-checks, and sharp tension vs decided
      if (isInCheckBefore(game, moveIndex, move)) {
        checkDecisions++;
        checkAccSum += moveAcc;
        if (isErr) {
          checkErrors++;
          worstCheckError = maybeUpdateWorst(worstCheckError, game, move);
        }
      } else {
        normalDecisions++;
        normalAccSum += moveAcc;
        if (isErr) normalErrors++;
      }

      const isSharp = move.evalBefore.mate === undefined && Math.abs(evalPawnsBefore) <= 3.0;
      if (isSharp) {
        sharpDecisions++;
        sharpAccSum += moveAcc;
        if (isErr) sharpErrors++;
      } else {
        quietDecisions++;
        quietAccSum += moveAcc;
        if (isErr) quietErrors++;
      }

      // Elo bucket move density
      if (eloBucketIndex >= 0) {
        eloAcc[eloBucketIndex].decisions++;
        if (isErr) eloAcc[eloBucketIndex].errors++;
      }

      // Turning points
      if (wcBefore >= 55 && wcDrop >= 22) {
        turningPointCandidates.push({ game, userColor, move, wcBefore, wcAfter, wcDrop });
      }

      // Tactical ideas on mistake/blunder/miss (aligned with db.ts)
      if (category === 'mistake' || category === 'blunder' || category === 'miss') {
        const idea = moveIdea(move);
        if (idea) {
          ideaTotal++;
          ideaCounts[idea.idea]++;
          ideaWorst[idea.idea] = maybeUpdateWorst(ideaWorst[idea.idea] || null, game, move);
        }
      }
    }

    if (reachedWinning) {
      winningGamesReached++;
      if (outcome === 'win') winningGamesConverted++;
      else if (outcome === 'draw') squanderedDraws++;
      else if (outcome === 'loss') squanderedLosses++;
    }
    if (facedDefensive) {
      defensiveGamesFaced++;
      if (outcome === 'draw' || outcome === 'win') defensiveGamesSaved++;
      else if (outcome === 'loss') defensiveGamesLost++;
    }
  }

  for (let i = 0; i < zoneBuckets.length; i++) {
    const b = zoneBuckets[i];
    b.errorsPer100 = per100(b.errors, b.decisions);
    b.avgAccuracy = b.decisions > 0 ? round1(zoneAccSums[i] / b.decisions) : null;
  }

  const winningGamesSquandered = squanderedDraws + squanderedLosses;
  const winningGamesCompleted = winningGamesConverted + winningGamesSquandered;
  const defensiveGamesCompleted = defensiveGamesSaved + defensiveGamesLost;
  const conversion: ConversionResilienceStats = {
    winningGamesReached,
    winningGamesCompleted,
    winningGamesConverted,
    winningGamesSquandered,
    squanderedWins: winningGamesSquandered,
    squanderedDraws,
    squanderedLosses,
    conversionRate: winningGamesCompleted > 0 ? round1((winningGamesConverted / winningGamesCompleted) * 100) : null,
    defensiveGamesFaced,
    defensiveGamesCompleted,
    defensiveGamesSaved,
    defensiveGamesLost,
    resilienceRate: defensiveGamesCompleted > 0 ? round1((defensiveGamesSaved / defensiveGamesCompleted) * 100) : null,
  };

  turningPointCandidates.sort(
    (a, b) =>
      b.wcDrop - a.wcDrop ||
      b.wcBefore - a.wcBefore ||
      a.game.id.localeCompare(b.game.id) ||
      a.move.ply - b.move.ply,
  );
  const turningPoints: TurningPointMove[] = turningPointCandidates.slice(0, 8).map((item) => ({
    gameId: item.game.id,
    opponent: item.userColor === 'w' ? item.game.black : item.game.white,
    userColor: item.userColor,
    date: item.game.date || playedAt(item.game)?.slice(0, 10) || '',
    result: item.game.result || '*',
    ply: item.move.ply,
    moveNumber: item.move.moveNumber,
    san: item.move.san,
    bestMoveSan: resolveBestMoveSan(item.move),
    classification: moveCategory(item.move),
    winChanceBefore: round1(item.wcBefore),
    winChanceAfter: round1(item.wcAfter),
    winChanceDrop: round1(item.wcDrop),
  }));

  const qualityPer100 = {} as Record<CoreMoveQuality, number>;
  for (const key of CORE_QUALITIES) {
    qualityPer100[key] = per100(qualityCounts[key], totalDecisions);
  }
  const moveQuality: MoveQualityDistribution = {
    totalDecisions,
    counts: qualityCounts,
    per100: qualityPer100,
  };

  const pressureProfile: PressureProfile = {
    checkDecisions,
    checkErrors,
    checkErrorsPer100: per100(checkErrors, checkDecisions),
    checkAvgAccuracy: checkDecisions > 0 ? round1(checkAccSum / checkDecisions) : null,
    normalDecisions,
    normalErrors,
    normalErrorsPer100: per100(normalErrors, normalDecisions),
    normalAvgAccuracy: normalDecisions > 0 ? round1(normalAccSum / normalDecisions) : null,
    sharpDecisions,
    sharpErrors,
    sharpErrorsPer100: per100(sharpErrors, sharpDecisions),
    sharpAvgAccuracy: sharpDecisions > 0 ? round1(sharpAccSum / sharpDecisions) : null,
    quietDecisions,
    quietErrors,
    quietErrorsPer100: per100(quietErrors, quietDecisions),
    quietAvgAccuracy: quietDecisions > 0 ? round1(quietAccSum / quietDecisions) : null,
  };

  const opponentStrength: OpponentStrengthBucket[] = eloAcc.map((b) => {
    const completed = b.wins + b.losses + b.draws;
    return {
      category: b.category,
      label: b.label,
      games: b.games,
      wins: b.wins,
      losses: b.losses,
      draws: b.draws,
      winRate: completed > 0 ? round1((b.wins / completed) * 100) : null,
      avgAccuracy: b.accCount > 0 ? round1(b.accSum / b.accCount) : null,
      errorsPer100: per100(b.errors, b.decisions),
      decisions: b.decisions,
      errors: b.errors,
    };
  });

  const chronological = [...eligible].sort(
    (a, b) =>
      a.timestamp.localeCompare(b.timestamp) ||
      (a.game.createdAt || '').localeCompare(b.game.createdAt || '') ||
      a.orderIndex - b.orderIndex,
  );
  const recentSlice = chronological.slice(-10);
  const overallSummary = summarizeFormSlice(chronological);
  const recentSummary = summarizeFormSlice(recentSlice);
  const formComparison: FormComparison = {
    recentGames: recentSummary.games,
    overallGames: overallSummary.games,
    recentCompletedGames: recentSummary.completedGames,
    overallCompletedGames: overallSummary.completedGames,
    recentWinRate: recentSummary.winRate,
    recentAccuracy: recentSummary.accuracy,
    recentErrorsPer100: recentSummary.errorsPer100,
    overallWinRate: overallSummary.winRate,
    overallAccuracy: overallSummary.accuracy,
    overallErrorsPer100: overallSummary.errorsPer100,
    accuracyDelta: round1(recentSummary.accuracy - overallSummary.accuracy),
    errorsPer100Delta: round1(recentSummary.errorsPer100 - overallSummary.errorsPer100),
  };

  const recommendations = buildRecommendations({
    analyzedGames: eligible.length,
    totalErrors,
    moveZones: zoneBuckets,
    zoneWorstError,
    conversion,
    turningPoints,
    pressureProfile,
    worstCheckError,
    ideaCounts,
    ideaTotal,
    ideaWorst,
    opponentStrength,
    formComparison,
  });

  return {
    analyzedGames: eligible.length,
    totalDecisions,
    totalErrors,
    moveZones: zoneBuckets,
    conversion,
    turningPoints,
    moveQuality,
    pressureProfile,
    opponentStrength,
    opponentStrengthUnknownGames,
    formComparison,
    recommendations,
  };
}
