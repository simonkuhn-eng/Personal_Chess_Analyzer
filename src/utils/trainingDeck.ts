import { Chess, type Move, type Square } from 'chess.js';
import { readLearningItem, writeLearningItem } from './learningStorage';
import type { AppLanguage, EngineEvalResult, GameAnalysis, MissedIdea, MoveAnalysis, OpeningFocus } from '../types/chess';
import { matchesOpeningFocus, normalizeOpeningWindow } from './openingPhase';
import { findEvidencedLostPiece, isEndgamePosition, moveIdea, resolvePlayerColor } from './moveInsights';
import { profileNamespace } from './profile';
import { isReliableGame, isReliableGameMove } from './evaluationReliability';
import { annotateMissedOpportunities } from './missedOpportunities';
import { formatEval, getPlayerWinChance, moveCategory } from './analysis';
import { lineEvidence } from './lineEvidence';
import { threatenedPieceArrows } from './boardPresentation';
import { reviewExplanation } from './reviewExplanation';
import { tacticalReasons, whyLine } from './whyEvidence';
import type { StatisticsFilter } from '../types/statistics';
import { matchesStatisticsFilter } from './statisticsFilter';

export const TRAINING_QUALITY_OPTIONS = [
  { quality: 'blunder', label: 'Patzer', singular: 'Patzer' },
  { quality: 'mistake', label: 'Gröbere Fehler', singular: 'Gröberer Fehler' },
  { quality: 'inaccuracy', label: 'Leichte Fehler', singular: 'Ungenauigkeit' },
  { quality: 'miss', label: 'Verpasste Chancen', singular: 'Verpasste Chance' },
] as const;

export type TrainingQuality = typeof TRAINING_QUALITY_OPTIONS[number]['quality'];
const DEFAULT_QUALITIES: TrainingQuality[] = ['blunder', 'mistake', 'miss'];

export type TrainingFocusMode = 'clear' | 'all';
export type TrainingPhase = 'opening' | 'middlegame' | 'endgame';
export type TrainingPhaseFilter = 'all' | TrainingPhase;
export type TrainingMission = 'mate' | 'tactic' | 'defense' | 'positional';
export type TrainingMissionFilter = 'all' | TrainingMission;

export interface TrainingDeckPrefs {
  focusMode: TrainingFocusMode;
  phase: TrainingPhaseFilter;
  mission: TrainingMissionFilter;
  autoAdvance: boolean;
}

export const DEFAULT_TRAINING_PREFS: TrainingDeckPrefs = {
  focusMode: 'clear',
  phase: 'all',
  mission: 'all',
  autoAdvance: false,
};

export const TRAINING_MISSION_LABELS: Record<TrainingMissionFilter, string> = {
  all: 'Alle Motive',
  mate: 'Matt',
  tactic: 'Taktik',
  defense: 'Abwehr',
  positional: 'Stellung',
};

export const TRAINING_PHASE_LABELS: Record<TrainingPhaseFilter, string> = {
  all: 'Alle Phasen',
  opening: 'Eröffnung',
  middlegame: 'Mittelspiel',
  endgame: 'Endspiel',
};

export interface TrainingCard {
  key: string;
  game: GameAnalysis;
  move: MoveAnalysis;
}

export interface TrainingCardBriefing {
  mission: TrainingMission;
  missionBadge: string;
  prompt: string;
  stanceLabel: string;
  stanceTone: 'winning' | 'even' | 'pressure';
  phase: TrainingPhase;
  phaseLabel: string;
  conceptHint: string;
  postMoveSummary: string | null;
  playedSan: string;
  bestSan: string;
  previousMove: { san: string; moveNumber: number; color: 'w' | 'b'; from: string; to: string; fenBefore: string } | null;
  bestLineUci: string[];
  playedRefutationUci: string[];
  isClear: boolean;
  priorityTier: 1 | 2 | 3;
}

const PIECE_ACCUSATIVE_DE: Record<string, string> = {
  p: 'einen Bauern',
  n: 'einen Springer',
  b: 'einen Läufer',
  r: 'einen Turm',
  q: 'die Dame',
  k: 'den König',
};

const PIECE_NAME_EN: Record<string, string> = {
  p: 'a pawn',
  n: 'a knight',
  b: 'a bishop',
  r: 'a rook',
  q: 'your queen',
  k: 'your king',
};

const PHASE_NAMES: Record<TrainingPhase, string> = {
  opening: 'Eröffnung',
  middlegame: 'Mittelspiel',
  endgame: 'Endspiel',
};

const PHASE_NAMES_EN: Record<TrainingPhase, string> = {
  opening: 'Opening',
  middlegame: 'Middlegame',
  endgame: 'Endgame',
};

const REASON_MOTIF_PRIORITY = ['T22', 'T04', 'T07', 'T05', 'T09', 'T14', 'T16', 'T08', 'T15', 'T13', 'T23', 'T02', 'T03', 'T01'];

const briefingCacheDe = new WeakMap<GameAnalysis, Map<number, TrainingCardBriefing>>();
const briefingCacheEn = new WeakMap<GameAnalysis, Map<number, TrainingCardBriefing>>();

function isTrainingQuality(quality: unknown): quality is TrainingQuality {
  return TRAINING_QUALITY_OPTIONS.some(option => option.quality === quality);
}

export function matchesTrainingQuality(move: MoveAnalysis, quality: TrainingQuality): boolean {
  return moveCategory(move) === quality;
}

function qualitiesStorageKey(player: string): string {
  return `personal-chess-analyzer-training-qualities-v1:${profileNamespace(player)}`;
}

function prefsStorageKey(player: string): string {
  return `personal-chess-analyzer-training-prefs-v1:${profileNamespace(player)}`;
}

function ignoredStorageKey(player: string): string {
  return `personal-chess-analyzer-training-ignored-v1:${profileNamespace(player)}`;
}

export function loadTrainingQualities(player: string): TrainingQuality[] {
  try {
    const raw = readLearningItem(qualitiesStorageKey(player));
    if (raw === null) return [...DEFAULT_QUALITIES];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_QUALITIES];
    const valid = [...new Set(parsed.filter(isTrainingQuality))];
    return parsed.length > 0 && valid.length === 0 ? [...DEFAULT_QUALITIES] : valid;
  } catch {
    return [...DEFAULT_QUALITIES];
  }
}

export function saveTrainingQualities(player: string, qualities: TrainingQuality[]): void {
  try {
    writeLearningItem(qualitiesStorageKey(player), JSON.stringify(qualities));
  } catch {
    // Die Auswahl bleibt bei nicht verfügbarem Speicher für die aktuelle Ansicht aktiv.
  }
}

export function loadTrainingPrefs(player: string): TrainingDeckPrefs {
  try {
    const raw = readLearningItem(prefsStorageKey(player));
    if (!raw) return { ...DEFAULT_TRAINING_PREFS };
    const parsed = JSON.parse(raw) as Partial<TrainingDeckPrefs> | null;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_TRAINING_PREFS };
    const focusMode: TrainingFocusMode = parsed.focusMode === 'all' ? 'all' : 'clear';
    const phase: TrainingPhaseFilter =
      parsed.phase === 'opening' || parsed.phase === 'middlegame' || parsed.phase === 'endgame' ? parsed.phase : 'all';
    const mission: TrainingMissionFilter =
      parsed.mission === 'mate' || parsed.mission === 'tactic' || parsed.mission === 'defense' || parsed.mission === 'positional'
        ? parsed.mission
        : 'all';
    const autoAdvance = parsed.autoAdvance === true;
    return { focusMode, phase, mission, autoAdvance };
  } catch {
    return { ...DEFAULT_TRAINING_PREFS };
  }
}

export function saveTrainingPrefs(player: string, prefs: TrainingDeckPrefs): void {
  try {
    writeLearningItem(prefsStorageKey(player), JSON.stringify(prefs));
  } catch {
    // Präferenzen bleiben in dieser Sitzung aktiv.
  }
}

export function loadIgnoredTrainingCards(player: string): string[] {
  try {
    const raw = readLearningItem(ignoredStorageKey(player));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))];
  } catch {
    return [];
  }
}

export function saveIgnoredTrainingCards(player: string, keys: readonly string[]): void {
  try {
    const clean = [...new Set(keys.filter(key => typeof key === 'string' && key.trim().length > 0))];
    writeLearningItem(ignoredStorageKey(player), JSON.stringify(clean));
  } catch {
    // Ausblendung bleibt in dieser Sitzung aktiv.
  }
}

function hasOwnMate(evalResult: EngineEvalResult | undefined, color: 'w' | 'b'): boolean {
  if (!evalResult || evalResult.mate === undefined || evalResult.mate === 0) return false;
  return (evalResult.mate > 0 && color === 'w') || (evalResult.mate < 0 && color === 'b');
}

function tryPlayUci(fen: string, uci: string): Move | null {
  if (!uci || uci.length < 4) return null;
  try {
    const chess = new Chess(fen);
    return chess.move({
      from: uci.slice(0, 2) as Square,
      to: uci.slice(2, 4) as Square,
      promotion: (uci[4] || undefined) as never,
    });
  } catch {
    return null;
  }
}

function legalSequence(fen: string, rawLine: readonly string[], maxPlies = 6): string[] {
  const result: string[] = [];
  if (!rawLine.length) return result;
  try {
    const chess = new Chess(fen);
    for (const step of rawLine.slice(0, maxPlies)) {
      const clean = (step || '').trim().toLowerCase();
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(clean)) break;
      const move = chess.move({
        from: clean.slice(0, 2) as Square,
        to: clean.slice(2, 4) as Square,
        promotion: (clean[4] || undefined) as never,
      });
      if (!move) break;
      result.push(clean);
    }
  } catch {
    return [];
  }
  return result;
}

function computeTrainingCardBriefing(card: TrainingCard, lang: AppLanguage = 'de'): TrainingCardBriefing {
  const isEn = lang === 'en';
  const { game, move } = card;
  const moveIndex = game.moves.findIndex(item => item.ply === move.ply);
  const prevRaw = moveIndex > 0 ? game.moves[moveIndex - 1] : undefined;
  const previousMove = prevRaw
    ? {
        san: prevRaw.san,
        moveNumber: prevRaw.moveNumber,
        color: prevRaw.color,
        from: prevRaw.from,
        to: prevRaw.to,
        fenBefore: prevRaw.fenBefore,
      }
    : null;

  const playedSan = tryPlayUci(move.fenBefore, move.uci)?.san || move.san;
  const bestUci = (move.evalBefore.bestMoveUci || '').trim().toLowerCase();
  const bestMoveObj = tryPlayUci(move.fenBefore, bestUci);
  const bestSan = bestMoveObj?.san || move.evalBefore.bestMoveSan || bestUci;

  const rawBest = move.evalBefore.pv?.length
    ? move.evalBefore.pv[0]?.trim().toLowerCase() === bestUci
      ? move.evalBefore.pv
      : [bestUci, ...move.evalBefore.pv]
    : [bestUci];
  const bestLineUci = legalSequence(move.fenBefore, rawBest, 6);
  const playedRefutationUci = legalSequence(move.fenBefore, [move.uci, ...(move.evalAfter.pv || [])], 6);

  const phase: TrainingPhase = isEndgamePosition(move.fenBefore)
    ? 'endgame'
    : move.moveNumber <= 12
      ? 'opening'
      : 'middlegame';
  const phaseLabel = isEn ? PHASE_NAMES_EN[phase] : PHASE_NAMES[phase];

  const ownMateBefore = hasOwnMate(move.evalBefore, move.color);
  const beforeWin = getPlayerWinChance(move.evalBefore, move.color);
  const afterWin = getPlayerWinChance(move.evalAfter, move.color);
  const beforeCp = move.color === 'w' ? move.evalBefore.scoreCp : -move.evalBefore.scoreCp;

  let stanceLabel: string;
  let stanceTone: TrainingCardBriefing['stanceTone'];
  if (ownMateBefore) {
    stanceLabel = isEn ? 'Winning Position' : 'Gewinnstellung';
    stanceTone = 'winning';
  } else if (beforeWin >= 72) {
    stanceLabel = isEn ? 'Winning Edge' : 'Du stehst auf Gewinn';
    stanceTone = 'winning';
  } else if (beforeWin >= 58) {
    stanceLabel = isEn ? 'Slight Advantage' : 'Leichter Vorteil';
    stanceTone = 'winning';
  } else if (beforeWin >= 42) {
    stanceLabel = isEn ? 'Equal' : 'Ausgeglichen';
    stanceTone = 'even';
  } else if (beforeWin >= 25) {
    stanceLabel = isEn ? 'Under Pressure' : 'Unter Druck';
    stanceTone = 'pressure';
  } else {
    stanceLabel = isEn ? 'Tough Defense' : 'Schwierige Verteidigung';
    stanceTone = 'pressure';
  }

  let inCheckBefore = false;
  try {
    inCheckBefore = new Chess(move.fenBefore).inCheck();
  } catch {
    inCheckBefore = false;
  }

  const replyEvidence = move.evalAfter.pv?.length
    ? lineEvidence(move.fenBefore, [move.uci, ...move.evalAfter.pv.slice(0, 12)], move.color)
    : null;
  const enemyMateAfterPlayed =
    (move.evalAfter.mate !== undefined && move.evalAfter.mate !== 0 && !hasOwnMate(move.evalAfter, move.color)) ||
    Boolean(replyEvidence?.board.isCheckmate() && replyEvidence.board.turn() === move.color);
  const lostPieceAfterPlayed = findEvidencedLostPiece(move.fenAfter, move.evalAfter.pv, move.color, {
    fenBefore: move.fenBefore,
    uci: move.uci,
  });
  const materialLossAfterPlayed = replyEvidence?.settled && replyEvidence.gain <= -1 ? -replyEvidence.gain : 0;
  const threatsBefore = threatenedPieceArrows(move.fenBefore);
  const idea = moveIdea(move);

  let mission: TrainingMission;
  let missionBadge: string;
  let prompt: string;

  if (move.missedOpportunity?.kind === 'mate' || ownMateBefore || idea?.idea === 'mate') {
    mission = 'mate';
    missionBadge = isEn ? 'Mate Chance' : 'Mattchance';
    const mateDist = move.evalBefore.mate ? Math.abs(move.evalBefore.mate) : 0;
    prompt =
      mateDist > 0 && mateDist <= 5
        ? isEn
          ? `Find mate in ${mateDist}`
          : `Matt in ${mateDist} finden`
        : isEn
          ? 'Find the mating sequence'
          : 'Mattfolge finden';
  } else if (move.missedOpportunity?.kind === 'material') {
    mission = 'tactic';
    missionBadge = isEn ? 'Win Material' : 'Materialgewinn';
    prompt = isEn ? 'Find the material-winning move' : 'Materialgewinn finden';
  } else if (
    enemyMateAfterPlayed ||
    lostPieceAfterPlayed !== null ||
    materialLossAfterPlayed >= 2 ||
    inCheckBefore ||
    (beforeCp < 250 && threatsBefore.length > 0 && move.winChanceDrop >= 15)
  ) {
    mission = 'defense';
    missionBadge = isEn ? 'Defense' : 'Abwehr';
    if (enemyMateAfterPlayed) prompt = isEn ? 'Parry the mating threat' : 'Mattdrohung abwehren';
    else if (inCheckBefore) prompt = isEn ? 'Handle the check cleanly' : 'Schach sauber abwehren';
    else if (lostPieceAfterPlayed) prompt = isEn ? 'Defend threat & keep material' : 'Drohung abwehren & Material sichern';
    else prompt = isEn ? 'Defend opponent threat' : 'Gegnerische Drohung abwehren';
  } else if (idea?.idea === 'fork' || idea?.idea === 'capture' || idea?.idea === 'check') {
    mission = 'tactic';
    if (idea.idea === 'fork') {
      missionBadge = isEn ? 'Double Attack' : 'Doppelangriff';
      prompt = isEn ? 'Seize the tactical chance' : 'Taktische Chance nutzen';
    } else if (idea.idea === 'capture') {
      missionBadge = isEn ? 'Capture' : 'Schlagzug';
      prompt = isEn ? 'Find the strong capture' : 'Starken Schlagzug finden';
    } else {
      missionBadge = isEn ? 'Tactics' : 'Taktik';
      prompt = isEn ? 'Find the active check' : 'Aktives Schach finden';
    }
  } else {
    mission = 'positional';
    missionBadge = isEn ? 'Plan & Position' : 'Plan & Stellung';
    prompt =
      beforeWin >= 62
        ? isEn
          ? 'Press your advantage cleanly'
          : 'Vorteil sauber ausbauen'
        : beforeWin <= 38
          ? isEn
            ? 'Hold the position solidly'
            : 'Stellung zäh verteidigen'
          : isEn
            ? 'Find the strongest plan'
            : 'Sauberen Plan finden';
  }

  let conceptHint: string;
  if (bestSan.startsWith('O-O')) {
    conceptHint = isEn
      ? 'Put king safety first and get your king out of the center.'
      : 'Denke zuerst an deine Königssicherheit und bringe den König in Sicherheit.';
  } else if (mission === 'mate') {
    conceptHint =
      bestMoveObj && (bestMoveObj.san.includes('+') || bestMoveObj.san.includes('#'))
        ? isEn
          ? 'The enemy king is boxed in — look for a forcing check that starts a mating attack.'
          : 'Der gegnerische König steht sehr eng — suche ein konkretes Schach, das ein erzwungenes Matt einleitet.'
        : isEn
          ? 'Take away the enemy king’s escape squares first and bring another attacker in.'
          : 'Schneide dem feindlichen König zuerst die Fluchtfelder ab und ziehe eine weitere Angriffsfigur heran.';
  } else if (mission === 'defense') {
    if (enemyMateAfterPlayed) {
      conceptHint = isEn
        ? 'Your king is in immediate danger! Check opponent mating threats first and cover the key squares.'
        : 'Dein König ist akut gefährdet! Prüfe zuerst gegnerische Mattdrohungen und decke die kritischen Felder.';
    } else if (lostPieceAfterPlayed) {
      conceptHint = isEn
        ? `Watch out: an inaccuracy loses ${PIECE_NAME_EN[lostPieceAfterPlayed] || 'material'}. Protect it or create an active counter-threat.`
        : `Vorsicht: Bei einer Ungenauigkeit drohst du ${PIECE_ACCUSATIVE_DE[lostPieceAfterPlayed] || 'einen Stein'} zu verlieren. Suche zuerst Schutz oder eine aktive Gegendrohung.`;
    } else if (inCheckBefore) {
      conceptHint = isEn
        ? 'You are in check — carefully compare moving the king, blocking, or capturing.'
        : 'Du stehst im Schach — prüfe in Ruhe, ob Ausweichen, Dazwischenstellen oder Schlagen die Stellung zusammenhält.';
    } else {
      conceptHint = isEn
        ? 'Your opponent prepared a concrete threat. Find the move that covers the target square or weak piece.'
        : 'Der Gegner hat eine konkrete Drohung vorbereitet. Finde den Zug, der das bedrohte Feld oder die schwache Figur absichert.';
    }
  } else if (mission === 'tactic') {
    if (idea?.idea === 'fork') {
      conceptHint = isEn
        ? 'Look for a double attack or fork — multiple enemy targets are poorly placed.'
        : 'Suche nach einem Doppelangriff oder einer Gabel — mehrere gegnerische Ziele stehen ungünstig.';
    } else if (move.missedOpportunity?.kind === 'material' || idea?.idea === 'capture') {
      conceptHint = isEn
        ? 'Material is hanging or a tactical sequence wins a piece. Check captures and undefended pieces.'
        : 'Es hängt Material oder eine taktische Abwicklung gewinnt einen Stein. Prüfe Schlagzüge und ungedeckte gegnerische Figuren.';
    } else if (idea?.idea === 'check') {
      conceptHint = isEn
        ? 'An intermediate or active check shifts the initiative in your favor.'
        : 'Ein Zwischenschach oder aktives Schach ändert die Initiative zu deinen Gunsten.';
    } else {
      conceptHint = isEn
        ? 'Look for undefended pieces, pins, or tactical weaknesses in your opponent’s camp.'
        : 'Achte auf ungedeckte Figuren, Fesselungen oder taktische Schwachpunkte im gegnerischen Lager.';
    }
  } else if (bestMoveObj?.captured) {
    conceptHint = isEn
      ? 'A targeted trade improves your pawn structure or shuts down your opponent’s counterplay.'
      : 'Ein gezielter Abtausch verbessert deine Struktur oder nimmt dem Gegner aktives Gegenspiel.';
  } else if (bestMoveObj?.piece === 'p') {
    conceptHint = isEn
      ? 'Pawn structure matters most here — look for a pawn break, space gain, or key square control.'
      : 'Die Bauernstruktur gibt hier den Ton an — prüfe einen Bauernhebel, Raumgewinn oder die Kontrolle über wichtige Felder.';
  } else {
    conceptHint = isEn
      ? 'No flashy tactic needed: improve your worst piece or coordinate your forces better.'
      : 'Keine reine Taktik nötig: Verbessere deine am wenigsten aktive Figur oder koordiniere deine Figuren besser.';
  }

  let postMoveSummary = isEn ? null : reviewExplanation(move);
  if (!isEn && !postMoveSummary && bestLineUci.length > 0) {
    try {
      const reasons = tacticalReasons(
        move.fenBefore,
        whyLine(move.fenBefore, [], bestLineUci, move.evalBefore, 'best', 'Bestzug', true),
      );
      reasons.sort((a, b) => {
        const ia = REASON_MOTIF_PRIORITY.indexOf(a.motif);
        const ib = REASON_MOTIF_PRIORITY.indexOf(b.motif);
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
      });
      if (reasons[0]) {
        postMoveSummary = `${reasons[0].title}: ${reasons[0].text}`;
      }
    } catch {
      postMoveSummary = null;
    }
  }
  if (!postMoveSummary) {
    postMoveSummary = isEn
      ? `Best move ${bestSan} evaluates at ${formatEval(move.evalBefore.scoreCp, move.evalBefore.mate)} (after ${playedSan}: ${formatEval(move.evalAfter.scoreCp, move.evalAfter.mate)}).`
      : `Bestzug ${bestSan} hält ${formatEval(move.evalBefore.scoreCp, move.evalBefore.mate)} (nach ${playedSan}: ${formatEval(move.evalAfter.scoreCp, move.evalAfter.mate)}).`;
  }

  const category = moveCategory(move);
  let isClear: boolean;
  if (!move.missedOpportunity && !ownMateBefore && beforeWin < 15) {
    isClear = false;
  } else if (!move.missedOpportunity && afterWin > 88) {
    isClear = false;
  } else {
    isClear =
      Boolean(move.missedOpportunity) ||
      category === 'blunder' ||
      mission === 'mate' ||
      mission === 'tactic' ||
      mission === 'defense' ||
      move.winChanceDrop >= 18;
  }

  const priorityTier: 1 | 2 | 3 =
    mission === 'mate' || Boolean(move.missedOpportunity)
      ? 1
      : mission === 'tactic' || mission === 'defense'
        ? 2
        : 3;

  return {
    mission,
    missionBadge,
    prompt,
    stanceLabel,
    stanceTone,
    phase,
    phaseLabel,
    conceptHint,
    postMoveSummary,
    playedSan,
    bestSan,
    previousMove,
    bestLineUci,
    playedRefutationUci,
    isClear,
    priorityTier,
  };
}

export function describeTrainingCard(card: TrainingCard, lang: AppLanguage = 'de'): TrainingCardBriefing {
  const briefingCache = lang === 'en' ? briefingCacheEn : briefingCacheDe;
  let byPly = briefingCache.get(card.game);
  if (!byPly) {
    byPly = new Map<number, TrainingCardBriefing>();
    briefingCache.set(card.game, byPly);
  }
  const cached = byPly.get(card.move.ply);
  if (cached) return cached;
  const computed = computeTrainingCardBriefing(card, lang);
  byPly.set(card.move.ply, computed);
  return computed;
}

export function shuffleCards<T>(items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function filterTrainingCardsByOptions(
  cards: readonly TrainingCard[],
  options: {
    qualities: readonly TrainingQuality[];
    ignoredKeys?: ReadonlySet<string>;
    focusMode?: TrainingFocusMode;
    phase?: TrainingPhaseFilter;
    mission?: TrainingMissionFilter;
  },
): TrainingCard[] {
  return cards.filter(card => {
    if (options.ignoredKeys?.has(card.key)) return false;
    if (!options.qualities.some(quality => matchesTrainingQuality(card.move, quality))) return false;
    const focusMode = options.focusMode ?? 'all';
    const phase = options.phase ?? 'all';
    const mission = options.mission ?? 'all';
    if (focusMode === 'all' && phase === 'all' && mission === 'all') return true;
    const briefing = describeTrainingCard(card);
    if (focusMode === 'clear' && !briefing.isClear) return false;
    if (phase !== 'all' && briefing.phase !== phase) return false;
    if (mission !== 'all' && briefing.mission !== mission) return false;
    return true;
  });
}

export function selectSessionCards(
  cards: readonly TrainingCard[],
  reviews: Record<string, { dueAt: number } | undefined>,
  options: { maxCards: number; voluntary?: boolean; nowMs?: number },
): TrainingCard[] {
  const maxCards = Math.max(0, options.maxCards);
  if (maxCards === 0 || cards.length === 0) return [];
  const now = options.nowMs ?? Date.now();

  const sortByTierShuffled = (list: readonly TrainingCard[]) => {
    const tier1: TrainingCard[] = [];
    const tier2: TrainingCard[] = [];
    const tier3: TrainingCard[] = [];
    for (const card of list) {
      const tier = describeTrainingCard(card).priorityTier;
      if (tier === 1) tier1.push(card);
      else if (tier === 2) tier2.push(card);
      else tier3.push(card);
    }
    return [...shuffleCards(tier1), ...shuffleCards(tier2), ...shuffleCards(tier3)];
  };

  if (options.voluntary) {
    return sortByTierShuffled(cards).slice(0, maxCards);
  }

  const due: TrainingCard[] = [];
  const fresh: TrainingCard[] = [];
  for (const card of cards) {
    const entry = reviews[card.key];
    if (!entry) fresh.push(card);
    else if (entry.dueAt <= now) due.push(card);
  }
  due.sort((a, b) => (reviews[a.key]?.dueAt || 0) - (reviews[b.key]?.dueAt || 0));
  return [...due, ...sortByTierShuffled(fresh)].slice(0, maxCards);
}

/** Alle lösbaren eigenen Fehler; Schwere-Auswahl und Wiederholungsplan folgen separat. */
export function buildTrainingCards(
  games: GameAnalysis[],
  targetPlayer: string,
  filters: {
    motif?: MissedIdea | null;
    opening?: string | null;
    openingFocus?: OpeningFocus | null;
    openingWindowMoves?: number;
    statisticsFilter?: StatisticsFilter | null;
  } = {},
): TrainingCard[] {
  return games.flatMap((game): TrainingCard[] => {
    if (filters.statisticsFilter && (!isReliableGame(game) || !matchesStatisticsFilter(game, filters.statisticsFilter))) return [];
    game = annotateMissedOpportunities(game);
    const playerColor = resolvePlayerColor(game.white, game.black, targetPlayer, game.site);
    if (!playerColor || (filters.opening && (game.openingName || game.eco) !== filters.opening)) return [];
    if (filters.openingFocus && (!isReliableGame(game) || !matchesOpeningFocus(game, playerColor, filters.openingFocus, filters.openingWindowMoves))) return [];
    return game.moves
      .filter(move => !filters.openingFocus || move.moveNumber <= normalizeOpeningWindow(filters.openingWindowMoves))
      .filter(move => move.color === playerColor && isTrainingQuality(moveCategory(move)))
      .filter(move => !move.isForced)
      .filter(move => isReliableGameMove(game, move))
      .filter(move => (move.evalBefore.bestMoveUci || '').length >= 4)
      .filter(move => {
        if (!filters.motif) return true;
        const idea = moveIdea(move);
        return idea?.idea === filters.motif;
      })
      .map(move => ({ key: `${game.id}:${move.ply}`, game, move }));
  });
}

export function filterTrainingCards(cards: TrainingCard[], qualities: readonly TrainingQuality[]): TrainingCard[] {
  return cards.filter(card => qualities.some(quality => matchesTrainingQuality(card.move, quality)));
}
