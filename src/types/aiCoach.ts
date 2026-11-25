export type AiCoachModelFamily = 'hydrogen' | 'neon';
export type AiCoachEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface AiCoachStatus {
  available: boolean;
  cliPath: string;
  error?: string;
  models: Array<{
    family: AiCoachModelFamily;
    label: string;
    subtitle: string;
  }>;
}

export interface AiCoachExplainRequest {
  requestId: string;
  modelFamily: AiCoachModelFamily;
  effort: AiCoachEffort;
  fenBefore: string;
  fenAfter: string;
  moveNumber: number;
  color: 'w' | 'b';
  playedSan: string;
  playedUci: string;
  quality?: string;
  bestMoveSan?: string;
  bestMoveUci?: string;
  evalBeforeText?: string;
  evalAfterText?: string;
  bestLineSan?: string[];
  afterLineSan?: string[];
  winChanceDrop?: number;
  openingName?: string;
  playerColor?: 'w' | 'b' | null;
  gameContextMovesSan?: string[];
  question?: string;
  conversationId?: string;
  isPositionOnly?: boolean;
  language?: 'de' | 'en';
}

export interface AiCoachToolLogEntry {
  toolName: string;
  summary: string;
  durationSec?: number;
  status: 'running' | 'done' | 'error';
  error?: string;
}

export type AiCoachStreamEvent =
  | { requestId: string; type: 'status'; message: string }
  | { requestId: string; type: 'tool_start'; toolName: string; summary: string }
  | { requestId: string; type: 'tool_done'; toolName: string; summary: string; durationSec?: number; error?: string }
  | { requestId: string; type: 'delta'; text: string }
  | {
      requestId: string;
      type: 'done';
      response: string;
      conversationId?: string;
      durationSeconds?: number;
      modelId: string;
      toolCalls: AiCoachToolLogEntry[];
    }
  | { requestId: string; type: 'error'; message: string; cancelled?: boolean };
