import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles,
  ArrowLeft,
  Send,
  RefreshCcw,
  Square as StopIcon,
  Play,
  Cpu,
  AlertCircle,
  MessageSquare,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  RotateCcw,
  LocateFixed,
} from 'lucide-react';
import type { GameAnalysis, MoveAnalysis } from '../types/chess';
import type {
  AiCoachEffort,
  AiCoachModelFamily,
  AiCoachStatus,
  AiCoachToolLogEntry,
} from '../types/aiCoach';
import { formatEval, moveCategory, reviewBadgeQuality } from '../utils/analysis';
import { resolvePlayerColor } from '../utils/moveInsights';
import { principalVariationSan } from '../utils/reviewPresentation';
import { isReliableGameMove } from '../utils/evaluationReliability';
import { QualityBadge } from './QualityBadge';
import { qualityAppearance } from '../utils/moveQuality';
import { colorLabel, useI18n } from '../utils/i18n';

interface AiCoachPanelProps {
  game: GameAnalysis;
  currentPly: number;
  anchorPly: number;
  currentFen: string;
  targetPlayer: string;
  autoStartToken: number;
  onBackToMainReview: () => void;
  onSelectPly: (ply: number) => void;
  onReanchorToPly: (ply: number) => void;
  onFlipBoard: () => void;
  onExplore: (anchorPly: number, line: string[], label: string, autoplay?: boolean) => void;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  modelId?: string;
  durationSeconds?: number;
  toolCalls?: AiCoachToolLogEntry[];
}

const MODEL_STORAGE_KEY = 'pca-ai-coach-model';
const HYDROGEN_EFFORT_STORAGE_KEY = 'pca-ai-coach-effort-hydrogen';
const NEON_EFFORT_STORAGE_KEY = 'pca-ai-coach-effort-neon';

function readStoredModelFamily(): AiCoachModelFamily {
  try {
    return localStorage.getItem(MODEL_STORAGE_KEY) === 'neon' ? 'neon' : 'hydrogen';
  } catch {
    return 'hydrogen';
  }
}

function readStoredHydrogenEffort(): 'high' | 'xhigh' {
  try {
    return localStorage.getItem(HYDROGEN_EFFORT_STORAGE_KEY) === 'xhigh' ? 'xhigh' : 'high';
  } catch {
    return 'high';
  }
}

function readStoredNeonEffort(): AiCoachEffort {
  try {
    const raw = localStorage.getItem(NEON_EFFORT_STORAGE_KEY);
    return raw === 'low' || raw === 'high' || raw === 'xhigh' ? raw : 'medium';
  } catch {
    return 'medium';
  }
}

function formatModelDisplay(modelId?: string): string {
  if (!modelId) return 'Antigravity KI';
  const effortSuffix = modelId.endsWith('-xhigh')
    ? ' (Extra High)'
    : modelId.endsWith('-high')
      ? ' (High)'
      : modelId.endsWith('-medium')
        ? ' (Medium)'
        : modelId.endsWith('-low')
          ? ' (Low)'
          : '';
  if (modelId.startsWith('gemini-4-neon')) return `Gemini 4 Neon${effortSuffix}`;
  if (modelId.startsWith('gemini-4-hydrogen')) return `Gemini 4 Hydrogen${effortSuffix}`;
  return modelId;
}

function formatPlyLabel(game: GameAnalysis, ply: number): string {
  if (ply <= 0) return 'Ausgangsstellung';
  const m = game.moves[ply - 1];
  if (!m) return `Zug ${ply}`;
  return `${m.moveNumber}.${m.color === 'b' ? '..' : ''} ${m.san}`;
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const tokens: React.ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let keyIdx = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      tokens.push(<strong key={`b-${keyIdx++}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`') && token.endsWith('`')) {
      tokens.push(<code key={`c-${keyIdx++}`}>{token.slice(1, -1)}</code>);
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex));
  }
  return tokens;
}

const SafeCoachMarkdown: React.FC<{ content: string }> = ({ content }) => {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let listItems: string[] = [];
  let listOrdered = false;
  let keyCounter = 0;

  const flushList = () => {
    if (listItems.length === 0) return;
    if (listOrdered) {
      blocks.push(
        <ol key={`ol-${keyCounter++}`}>
          {listItems.map((item, idx) => (
            <li key={idx}>{renderInlineMarkdown(item)}</li>
          ))}
        </ol>,
      );
    } else {
      blocks.push(
        <ul key={`ul-${keyCounter++}`}>
          {listItems.map((item, idx) => (
            <li key={idx}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>,
      );
    }
    listItems = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushList();
      continue;
    }

    if (trimmed.startsWith('### ') || trimmed.startsWith('## ') || trimmed.startsWith('# ')) {
      flushList();
      const headingText = trimmed.replace(/^#{1,3}\s+/, '');
      blocks.push(<h4 key={`h-${keyCounter++}`}>{renderInlineMarkdown(headingText)}</h4>);
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*•]\s+(.+)$/);
    if (bulletMatch) {
      if (listItems.length > 0 && listOrdered) flushList();
      listOrdered = false;
      listItems.push(bulletMatch[1]);
      continue;
    }

    const orderedMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (orderedMatch) {
      if (listItems.length > 0 && !listOrdered) flushList();
      listOrdered = true;
      listItems.push(orderedMatch[1]);
      continue;
    }

    flushList();
    blocks.push(<p key={`p-${keyCounter++}`}>{renderInlineMarkdown(trimmed)}</p>);
  }

  flushList();
  return <div className="ai-coach-markdown">{blocks}</div>;
};

export const AiCoachPanel: React.FC<AiCoachPanelProps> = ({
  game,
  currentPly,
  anchorPly,
  currentFen,
  targetPlayer,
  autoStartToken,
  onBackToMainReview,
  onSelectPly,
  onReanchorToPly,
  onFlipBoard,
  onExplore,
}) => {
  const { lang, tr } = useI18n();
  const [modelFamily, setModelFamily] = useState<AiCoachModelFamily>(readStoredModelFamily);
  const [hydrogenEffort, setHydrogenEffort] = useState<'high' | 'xhigh'>(readStoredHydrogenEffort);
  const [neonEffort, setNeonEffort] = useState<AiCoachEffort>(readStoredNeonEffort);
  const [status, setStatus] = useState<AiCoachStatus | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [liveStatus, setLiveStatus] = useState('');
  const [liveTools, setLiveTools] = useState<AiCoachToolLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [initialQuestion, setInitialQuestion] = useState('');
  const [followUpInput, setFollowUpInput] = useState('');

  const activeRequestIdRef = useRef<string | null>(null);
  const lastAutoTokenRef = useRef<number>(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const effectiveEffort: AiCoachEffort = modelFamily === 'hydrogen' ? hydrogenEffort : neonEffort;
  const anchorMove: MoveAnalysis | undefined = anchorPly > 0 ? game.moves[anchorPly - 1] : undefined;
  const isPositionOnly = !anchorMove;
  const hasDrifted = currentPly !== anchorPly;

  const playerColor = useMemo(
    () => resolvePlayerColor(game.white, game.black, targetPlayer, game.site),
    [game.white, game.black, targetPlayer, game.site],
  );

  useEffect(() => {
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, modelFamily);
    } catch {
      // Ignore storage failures
    }
  }, [modelFamily]);

  useEffect(() => {
    try {
      localStorage.setItem(HYDROGEN_EFFORT_STORAGE_KEY, hydrogenEffort);
    } catch {
      // Ignore storage failures
    }
  }, [hydrogenEffort]);

  useEffect(() => {
    try {
      localStorage.setItem(NEON_EFFORT_STORAGE_KEY, neonEffort);
    } catch {
      // Ignore storage failures
    }
  }, [neonEffort]);

  useEffect(() => {
    const api = window.electronAPI?.aiCoach;
    if (!api) return;
    let cancelled = false;
    void api.getStatus().then((res) => {
      if (!cancelled) setStatus(res);
    }).catch(() => {
      if (!cancelled) {
        setStatus({
          available: false,
          cliPath: '',
          error: 'Status der Antigravity CLI konnte nicht geprüft werden.',
          models: [],
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const api = window.electronAPI?.aiCoach;
    if (!api) return;
    const unsubscribe = api.onEvent((evt) => {
      if (!activeRequestIdRef.current || evt.requestId !== activeRequestIdRef.current) return;

      if (evt.type === 'status') {
        setLiveStatus(evt.message);
      } else if (evt.type === 'tool_start') {
        setLiveTools((prev) => [
          ...prev,
          { toolName: evt.toolName, summary: evt.summary, status: 'running' },
        ]);
      } else if (evt.type === 'tool_done') {
        setLiveTools((prev) => {
          const idx = prev.findIndex((item) => item.toolName === evt.toolName && item.status === 'running');
          const updated: AiCoachToolLogEntry = {
            toolName: evt.toolName,
            summary: evt.summary,
            durationSec: evt.durationSec,
            status: evt.error ? 'error' : 'done',
            error: evt.error,
          };
          if (idx >= 0) {
            const copy = [...prev];
            copy[idx] = updated;
            return copy;
          }
          return [...prev, updated];
        });
      } else if (evt.type === 'delta') {
        setStreamingText((prev) => prev + evt.text);
      } else if (evt.type === 'done') {
        activeRequestIdRef.current = null;
        setRunning(false);
        setStreamingText('');
        setLiveStatus('');
        setConversationId(evt.conversationId);
        setMessages((prev) => [
          ...prev,
          {
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            role: 'assistant',
            text: evt.response,
            modelId: evt.modelId,
            durationSeconds: evt.durationSeconds,
            toolCalls: evt.toolCalls,
          },
        ]);
      } else if (evt.type === 'error') {
        activeRequestIdRef.current = null;
        setRunning(false);
        setStreamingText('');
        setLiveStatus('');
        if (!evt.cancelled) {
          setError(evt.message);
        }
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, streamingText, liveTools]);

  const cancelCurrentRequest = () => {
    const reqId = activeRequestIdRef.current;
    if (reqId) {
      activeRequestIdRef.current = null;
      void window.electronAPI?.aiCoach?.cancel(reqId).catch(() => {});
    }
    setRunning(false);
    setStreamingText('');
    setLiveStatus('');
  };

  useEffect(() => {
    return () => {
      if (activeRequestIdRef.current) {
        void window.electronAPI?.aiCoach?.cancel(activeRequestIdRef.current).catch(() => {});
        activeRequestIdRef.current = null;
      }
    };
  }, []);

  const triggerExplain = (opts?: { question?: string; isFollowUp?: boolean; resetChat?: boolean }) => {
    const api = window.electronAPI?.aiCoach;
    if (!api) {
      setError('KI-Zugerklärung steht nur in der Desktop-App zur Verfügung.');
      return;
    }

    cancelCurrentRequest();

    const useConversationId = opts?.isFollowUp ? conversationId : undefined;
    const questionText = opts?.question?.trim() || undefined;

    if (opts?.resetChat || !useConversationId) {
      setMessages(
        questionText
          ? [{ id: `u-${Date.now()}`, role: 'user', text: questionText }]
          : [],
      );
      setConversationId(undefined);
    } else if (questionText) {
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: 'user', text: questionText }]);
    }

    const reqId = `coach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeRequestIdRef.current = reqId;
    setError(null);
    setStreamingText('');
    setLiveTools([]);
    setLiveStatus(
      `${modelFamily === 'neon' ? 'Gemini 4 Neon' : 'Gemini 4 Hydrogen (${effectiveEffort})'} ${tr('wird vorbereitet …', 'preparing …')}`.replace(
        '(${effectiveEffort})',
        effectiveEffort === 'xhigh' ? 'Extra High' : effectiveEffort === 'high' ? 'High' : '',
      ),
    );
    setRunning(true);

    const anchorStartFen = game.moves[0]?.fenBefore || currentFen;
    const bestLineSan =
      anchorMove && anchorMove.evalBefore.pv.length > 0
        ? principalVariationSan(anchorMove.fenBefore, anchorMove.evalBefore.pv).slice(0, 6)
        : undefined;
    const afterLineSan =
      anchorMove && anchorMove.evalAfter.pv.length > 0
        ? principalVariationSan(anchorMove.fenAfter, anchorMove.evalAfter.pv).slice(0, 6)
        : undefined;
    const gameContextMovesSan = game.moves
      .slice(Math.max(0, anchorPly - 10), Math.max(0, anchorPly))
      .map((m) => `${m.moveNumber}.${m.color === 'b' ? '..' : ''}${m.san}`);

    void api
      .explain({
        requestId: reqId,
        modelFamily,
        effort: effectiveEffort,
        fenBefore: anchorMove ? anchorMove.fenBefore : anchorStartFen,
        fenAfter: anchorMove ? anchorMove.fenAfter : anchorStartFen,
        moveNumber: anchorMove ? anchorMove.moveNumber : 1,
        color: anchorMove ? anchorMove.color : (anchorStartFen.split(' ')[1] === 'b' ? 'b' : 'w'),
        playedSan: anchorMove ? anchorMove.san : '',
        playedUci: anchorMove ? anchorMove.uci : '',
        quality: anchorMove ? reviewBadgeQuality(anchorMove) : undefined,
        bestMoveSan: anchorMove?.evalBefore.bestMoveSan || (bestLineSan?.[0] || undefined),
        bestMoveUci: anchorMove?.evalBefore.bestMoveUci || undefined,
        evalBeforeText: anchorMove ? formatEval(anchorMove.evalBefore.scoreCp, anchorMove.evalBefore.mate) : undefined,
        evalAfterText: anchorMove ? formatEval(anchorMove.evalAfter.scoreCp, anchorMove.evalAfter.mate) : undefined,
        bestLineSan,
        afterLineSan,
        winChanceDrop: anchorMove?.winChanceDrop,
        openingName: game.openingName || game.eco,
        playerColor,
        gameContextMovesSan,
        question: questionText,
        conversationId: useConversationId,
        isPositionOnly,
        language: lang,
      })
      .then((res) => {
        if (!res.ok && res.error && activeRequestIdRef.current === reqId) {
          activeRequestIdRef.current = null;
          setRunning(false);
          setError(res.error);
        }
      })
      .catch((err) => {
        if (activeRequestIdRef.current === reqId) {
          activeRequestIdRef.current = null;
          setRunning(false);
          setError(err instanceof Error ? err.message : 'KI-Erklärung fehlgeschlagen.');
        }
      });
  };

  // ONLY reset when the explained anchor move (anchorPly), game, or explicit start token changes.
  // Navigating currentPly with arrow keys or nav buttons preserves the entire chat!
  useEffect(() => {
    cancelCurrentRequest();
    setMessages([]);
    setConversationId(undefined);
    setLiveTools([]);
    setError(null);
    setInitialQuestion('');
    setFollowUpInput('');

    if (autoStartToken > lastAutoTokenRef.current) {
      lastAutoTokenRef.current = autoStartToken;
      triggerExplain({ resetChat: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id, anchorPly, autoStartToken]);

  const handleFollowUpSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = followUpInput.trim();
    if (!q || running) return;
    setFollowUpInput('');
    triggerExplain({ question: q, isFollowUp: true });
  };

  const handleQuickChip = (text: string) => {
    if (running) return;
    triggerExplain({ question: text, isFollowUp: Boolean(conversationId) });
  };

  const canCompareMoves =
    Boolean(anchorMove) &&
    anchorMove!.evalBefore.pv.length > 0 &&
    Boolean(anchorMove!.evalBefore.bestMoveUci) &&
    anchorMove!.evalBefore.bestMoveUci !== anchorMove!.uci;

  const moveQuality =
    anchorMove && isReliableGameMove(game, anchorMove) ? reviewBadgeQuality(anchorMove) : null;
  const bestMoveDisplaySan =
    anchorMove?.evalBefore.bestMoveSan ||
    (anchorMove && anchorMove.evalBefore.pv.length > 0
      ? principalVariationSan(anchorMove.fenBefore, anchorMove.evalBefore.pv)[0]
      : undefined);

  const hasAssistantAnswer = messages.some((m) => m.role === 'assistant');
  const anchorLabel = anchorPly <= 0 ? tr('Ausgangsstellung', 'Starting position') : formatPlyLabel(game, anchorPly);
  const currentBoardLabel = currentPly <= 0 ? tr('Ausgangsstellung', 'Starting position') : formatPlyLabel(game, currentPly);

  return (
    <section className="ai-coach-panel" aria-label={tr('KI-Zugerklärung', 'AI Move Explanation')}>
      {/* Dedicated Top Bar to Return to Main Analysis */}
      <div className="ai-coach-back-bar">
        <button
          type="button"
          className="btn-secondary btn-sm ai-coach-back-btn"
          onClick={() => {
            cancelCurrentRequest();
            onBackToMainReview();
          }}
        >
          <ArrowLeft size={14} />
          <span>{tr('Zurück zur Hauptanalyse', 'Back to Main Review')}</span>
        </button>
        <span className="ai-coach-page-tag">{tr('KI-Erklärungsmodus', 'AI EXPLANATION MODE')}</span>
      </div>

      <header className="ai-coach-header">
        <div className="ai-coach-header-title">
          <div className="ai-coach-title-row">
            <Sparkles size={17} color="#81b64c" aria-hidden="true" />
            <h2>{tr('KI-Zugerklärung', 'AI Move Explanation')}</h2>
            <span className="ai-coach-move-badge">{anchorLabel}</span>
            {moveQuality && (
              <span className="ai-coach-quality-tag">
                <QualityBadge quality={moveQuality} />
                <span>{qualityAppearance(moveQuality).label}</span>
              </span>
            )}
          </div>
          <p className="ai-coach-subtitle">
            {anchorMove
              ? `${tr('Erklärter Zug · Sicht', 'Explained move · Perspective')}: ${colorLabel(anchorMove.color, lang)}${
                  moveCategory(anchorMove) !== 'best' && anchorMove.winChanceDrop >= 2
                    ? ` · −${anchorMove.winChanceDrop.toFixed(1)}% ${tr('Gewinnchance', 'win chance')}`
                    : ''
                }`
              : `${game.openingName || game.eco || tr('Stellung vor dem 1. Zug', 'Position before move 1')}`}
          </p>
        </div>
      </header>

      {/* Model & Effort selector (Subscription via Antigravity CLI) */}
      <div className="ai-coach-model-bar">
        <div className="ai-coach-segmented" role="group" aria-label={tr('KI-Modell wählen', 'Choose AI model')}>
          <button
            type="button"
            className={`ai-coach-model-btn ${modelFamily === 'hydrogen' ? 'active' : ''}`}
            disabled={running}
            onClick={() => setModelFamily('hydrogen')}
            title={tr('Gemini 4 Hydrogen (immer mit High/Extra-High Thinking) über dein Antigravity-Abo', 'Gemini 4 Hydrogen (High/Extra-High Thinking) via Antigravity')}
          >
            <strong>Hydrogen</strong>
            <span>High</span>
          </button>
          <button
            type="button"
            className={`ai-coach-model-btn ${modelFamily === 'neon' ? 'active' : ''}`}
            disabled={running}
            onClick={() => setModelFamily('neon')}
            title={tr('Gemini 4 Neon über dein Antigravity-Abo', 'Gemini 4 Neon via Antigravity')}
          >
            <strong>Neon</strong>
            <span>{tr('Flexibel', 'Flexible')}</span>
          </button>
        </div>

        <label className="ai-coach-effort-wrap">
          <span>Thinking</span>
          {modelFamily === 'hydrogen' ? (
            <select
              aria-label={tr('Denktiefe wählen', 'Select thinking effort')}
              value={hydrogenEffort}
              disabled={running}
              onChange={(e) => setHydrogenEffort(e.target.value === 'xhigh' ? 'xhigh' : 'high')}
            >
              <option value="high">{tr('High (Standard)', 'High (Default)')}</option>
              <option value="xhigh">Extra High</option>
            </select>
          ) : (
            <select
              aria-label={tr('Denktiefe wählen', 'Select thinking effort')}
              value={neonEffort}
              disabled={running}
              onChange={(e) => setNeonEffort(e.target.value as AiCoachEffort)}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Extra High</option>
            </select>
          )}
        </label>
      </div>

      {/* Board Navigation Bar inside AI Explanation Page */}
      <div className="ai-coach-nav-bar" aria-label={tr('Brett-Navigation', 'Board navigation')}>
        <div className="ai-coach-nav-btns">
          <button
            type="button"
            className="btn-icon"
            onClick={() => onSelectPly(0)}
            disabled={currentPly === 0}
            title={tr('Zum Anfang', 'Go to start')}
            aria-label={tr('Zum Anfang', 'Go to start')}
          >
            <ChevronsLeft size={16} />
          </button>
          <button
            type="button"
            className="btn-icon"
            onClick={() => onSelectPly(Math.max(0, currentPly - 1))}
            disabled={currentPly === 0}
            title={tr('Vorheriger Zug (Pfeil Links)', 'Previous move (Left Arrow)')}
            aria-label={tr('Vorheriger Zug', 'Previous move')}
          >
            <ChevronLeft size={16} />
          </button>
          <span className="ai-coach-nav-pos" title={tr('Aktuelle Brettstellung (Pfeiltasten Links/Rechts nutzbar)', 'Current board position (Left/Right arrow keys work)')}>
            {currentPly === 0 ? 'Start' : `${currentBoardLabel}`} ({currentPly}/{game.moves.length})
          </span>
          <button
            type="button"
            className="btn-icon"
            onClick={() => onSelectPly(Math.min(game.moves.length, currentPly + 1))}
            disabled={currentPly >= game.moves.length}
            title={tr('Nächster Zug (Pfeil Rechts)', 'Next move (Right Arrow)')}
            aria-label={tr('Nächster Zug', 'Next move')}
          >
            <ChevronRight size={16} />
          </button>
          <button
            type="button"
            className="btn-icon"
            onClick={() => onSelectPly(game.moves.length)}
            disabled={currentPly >= game.moves.length}
            title={tr('Zum Ende', 'Go to end')}
            aria-label={tr('Zum Ende', 'Go to end')}
          >
            <ChevronsRight size={16} />
          </button>
        </div>
        <button
          type="button"
          className="btn-icon"
          onClick={onFlipBoard}
          title={tr('Brett drehen (F)', 'Flip board (F)')}
          aria-label={tr('Brett drehen', 'Flip board')}
        >
          <RotateCcw size={15} />
        </button>
      </div>

      {/* Position Drift Banner (when user stepped forward/backward to compare positions) */}
      {hasDrifted && (
        <div className="ai-coach-drift-bar" role="status">
          <span>
            {tr('Brett zeigt', 'Board shows')} <strong>{currentBoardLabel}</strong> · {tr('Chat bleibt bei', 'Chat stays on')} <strong>{anchorLabel}</strong>
          </span>
          <div className="ai-coach-drift-actions">
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => onSelectPly(anchorPly)}
              title={tr(`Brett zurück zu ${anchorLabel} springen`, `Jump board back to ${anchorLabel}`)}
            >
              <LocateFixed size={12} />
              <span>{tr('Zu', 'Jump to')} {anchorLabel}</span>
            </button>
            <button
              type="button"
              className="btn-primary btn-sm"
              onClick={() => onReanchorToPly(currentPly)}
              title={tr(`Stattdessen ${currentBoardLabel} von der KI erklären lassen`, `Ask AI to explain ${currentBoardLabel} instead`)}
            >
              <Sparkles size={12} />
              <span>{tr('Diesen Zug erklären', 'Explain this move')}</span>
            </button>
          </div>
        </div>
      )}

      {/* Quick move comparison actions on the board */}
      {anchorMove && (anchorMove.evalAfter.pv.length > 0 || canCompareMoves) && (
        <div className="ai-coach-context-strip">
          <div className="ai-coach-context-evals">
            <span>
              {tr('Nach', 'After')} <strong>{anchorMove.san}</strong>:{' '}
              {formatEval(anchorMove.evalAfter.scoreCp, anchorMove.evalAfter.mate)}
            </span>
            {canCompareMoves && bestMoveDisplaySan && (
              <span>
                {tr('Besser:', 'Better:')} <strong>{bestMoveDisplaySan}</strong> (
                {formatEval(anchorMove.evalBefore.scoreCp, anchorMove.evalBefore.mate)})
              </span>
            )}
          </div>
          <div className="ai-coach-context-btns">
            {anchorMove.evalAfter.pv.length > 0 && (
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() =>
                  onExplore(
                    anchorPly - 1,
                    [anchorMove.uci, ...anchorMove.evalAfter.pv],
                    tr('Partiezug + Antwort', 'Game move + reply'),
                    true,
                  )
                }
              >
                <Play size={12} />
                <span>{tr('Antwort zeigen', 'Show reply')}</span>
              </button>
            )}
            {canCompareMoves && (
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() =>
                  onExplore(anchorPly - 1, anchorMove.evalBefore.pv, tr('Enginealternative', 'Engine alternative'), true)
                }
              >
                <Play size={12} />
                <span>{tr('Alternative', 'Alternative')}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main Chat / Explanation Body */}
      <div className="ai-coach-body" ref={scrollRef}>
        {status && !status.available && (
          <div className="ai-coach-error" role="alert">
            <AlertCircle size={16} />
            <div>
              <strong>{tr('Antigravity CLI nicht verfügbar', 'Antigravity CLI unavailable')}</strong>
              <p>{status.error || tr('Bitte Antigravity CLI (agy) installieren und einmal anmelden.', 'Please install Antigravity CLI (agy) and sign in once.')}</p>
            </div>
          </div>
        )}

        {messages.length === 0 && !running && !error && (
          <div className="ai-coach-empty-card">
            <p>
              {tr(
                `Lass dir ${anchorMove ? `Zug ${anchorMove.san}` : 'diese Stellung'} mit verständlichen Schach-Faustregeln erklären (z. B. Bauernstruktur, Figurenaktivität, Spannung halten). Du kannst währenddessen jederzeit per Pfeiltasten am Brett vor- und zurückgehen.`,
                `Get ${anchorMove ? `move ${anchorMove.san}` : 'this position'} explained using practical rules of thumb (pawn structure, piece activity, keeping tension). You can step forward and backward on the board anytime without losing this chat.`,
              )}
            </p>
            <input
              type="text"
              className="ai-coach-question-input"
              placeholder={tr('Optionale Frage (z. B. Warum nicht lieber zurückziehen?)', 'Optional question (e.g. Why retreat instead of trading?)')}
              value={initialQuestion}
              onChange={(e) => setInitialQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  triggerExplain({ question: initialQuestion, resetChat: true });
                }
              }}
            />
            <button
              type="button"
              className="btn-primary ai-coach-start-btn"
              disabled={status !== null && !status.available}
              onClick={() => triggerExplain({ question: initialQuestion, resetChat: true })}
            >
              <Sparkles size={15} />
              <span>{anchorMove ? tr('Diesen Zug erklären', 'Explain this move') : tr('Stellung erklären', 'Explain position')}</span>
            </button>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`ai-coach-msg is-${msg.role}`}>
            {msg.role === 'user' ? (
              <div className="ai-coach-user-bubble">
                <MessageSquare size={13} />
                <span>{msg.text}</span>
              </div>
            ) : (
              <div className="ai-coach-assistant-card">
                {msg.toolCalls && msg.toolCalls.length > 0 && (
                  <div className="ai-coach-tool-list">
                    {msg.toolCalls.map((tool, idx) => (
                      <span
                        key={`${tool.toolName}-${idx}`}
                        className={`ai-coach-tool-badge is-${tool.status}`}
                        title={tool.error || tool.summary}
                      >
                        <Cpu size={11} />
                        <span>{tool.summary}</span>
                        {typeof tool.durationSec === 'number' && (
                          <small>({tool.durationSec}s)</small>
                        )}
                      </span>
                    ))}
                  </div>
                )}
                <SafeCoachMarkdown content={msg.text} />
                <div className="ai-coach-msg-meta">
                  <span>
                    {formatModelDisplay(msg.modelId)}
                    {typeof msg.durationSeconds === 'number' ? ` · ${msg.durationSeconds}s` : ''}
                  </span>
                </div>
              </div>
            )}
          </div>
        ))}

        {running && (
          <div className="ai-coach-streaming-card" role="status">
            <div className="ai-coach-loading-row">
              <span className="spin-dot" />
              <span>{liveStatus || tr('KI denkt nach …', 'AI thinking …')}</span>
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={cancelCurrentRequest}
                style={{ marginLeft: 'auto' }}
              >
                <StopIcon size={12} />
                <span>{tr('Abbrechen', 'Cancel')}</span>
              </button>
            </div>
            {liveTools.length > 0 && (
              <div className="ai-coach-tool-list">
                {liveTools.map((tool, idx) => (
                  <span key={`${tool.toolName}-${idx}`} className={`ai-coach-tool-badge is-${tool.status}`}>
                    <Cpu size={11} />
                    <span>{tool.summary}</span>
                    {typeof tool.durationSec === 'number' && <small>({tool.durationSec}s)</small>}
                  </span>
                ))}
              </div>
            )}
            {streamingText && <SafeCoachMarkdown content={streamingText} />}
          </div>
        )}

        {error && (
          <div className="ai-coach-error" role="alert">
            <AlertCircle size={16} />
            <div style={{ flex: 1 }}>
              <p>{error}</p>
              <button
                type="button"
                className="btn-secondary btn-sm"
                style={{ marginTop: '8px' }}
                onClick={() => triggerExplain({ resetChat: !conversationId })}
              >
                <RefreshCcw size={13} />
                <span>{tr('Erneut versuchen', 'Try again')}</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Follow-up Bar */}
      {(hasAssistantAnswer || conversationId) && !running && (
        <footer className="ai-coach-footer">
          <div className="ai-coach-chips">
            <button
              type="button"
              className="ai-coach-chip"
              onClick={() =>
                handleQuickChip(
                  tr(
                    'Welche konkrete Merkregel nehme ich daraus mit?',
                    'What concrete rule of thumb should I remember from this?',
                  ),
                )
              }
            >
              {tr('Merkregel', 'Rule of thumb')}
            </button>
            <button
              type="button"
              className="ai-coach-chip"
              onClick={() =>
                handleQuickChip(
                  bestMoveDisplaySan
                    ? tr(
                        `Was ist die Hauptidee hinter ${bestMoveDisplaySan} in 2 Zügen?`,
                        `What is the main idea behind ${bestMoveDisplaySan} in 2 moves?`,
                      )
                    : tr(
                        'Was wäre der beste Plan in den nächsten 2–3 Zügen?',
                        'What is the cleanest 2–3 move plan here?',
                      ),
                )
              }
            >
              {tr('Hauptidee', 'Main idea')}
            </button>
            <button
              type="button"
              className="ai-coach-chip"
              onClick={() => triggerExplain({ resetChat: true })}
              title={tr(`Mit ${modelFamily === 'neon' ? 'Neon' : 'Hydrogen'} neu generieren`, `Re-run with ${modelFamily === 'neon' ? 'Neon' : 'Hydrogen'}`)}
            >
              <RefreshCcw size={11} />
              <span>{tr('Neu erklären', 'Re-explain')}</span>
            </button>
          </div>
          <form className="ai-coach-followup" onSubmit={handleFollowUpSubmit}>
            <input
              type="text"
              placeholder={tr('Nachfragen (z. B. Warum schadet der Doppelbauer?)', 'Ask a follow-up (e.g. Why is the doubled pawn weak?)')}
              value={followUpInput}
              onChange={(e) => setFollowUpInput(e.target.value)}
            />
            <button
              type="submit"
              className="btn-primary btn-sm"
              disabled={!followUpInput.trim()}
              title={tr('Nachfrage senden', 'Send question')}
            >
              <Send size={14} />
            </button>
          </form>
        </footer>
      )}
    </section>
  );
};
