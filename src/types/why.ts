import type { EngineEvalResult } from './chess';

export type WhyLevel = 'board_fact' | 'searched_line' | 'branch_checked' | 'positional_observation';
export interface WhyReason {
  motif: string;
  title: string;
  text: string;
  level: WhyLevel;
  lineId: string;
  decisivePly: number;
  squares: string[];
}
export interface WhyLine {
  id: string;
  uci: string;
  san: string;
  label: string;
  kind: 'best' | 'played' | 'alternative' | 'reply';
  moves: string[];
  evaluation: EngineEvalResult | null;
  reliable: boolean;
  materialGain: number;
  settled: boolean;
  terminal: 'win' | 'loss' | 'draw' | null;
  endFen: string;
}
export interface WhyChoice { uci: string; san: string; label: string }
export interface WhyResult {
  version: number;
  anchorFen: string;
  color: 'w' | 'b';
  best: WhyLine;
  alternatives: WhyLine[];
  replies: WhyLine[];
  reasons: WhyReason[];
  summary: string;
  notes: string[];
  choices: WhyChoice[];
  replyChoices: WhyChoice[];
  forced: boolean;
  depth: number;
  limited: boolean;
}
