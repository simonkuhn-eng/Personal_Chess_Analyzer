import type { ReviewStore } from './reviews';
import { isDue } from './reviews';
import { selectedOpeningLine, type OpeningSelection } from './openingCatalog';
import type { Deviation } from '../data/repertoire';

export interface OpeningPracticeTask {
  selection: OpeningSelection;
  lineId: string;
  reviewKey: string;
  deviation?: { atPly: number; uci: string };
  kind: 'due' | 'new';
  dueAt: number;
}

export interface OpeningPracticePlan {
  tasks: OpeningPracticeTask[];
  dueCount: number;
  newCount: number;
}

export function practiceDeviationCandidates(
  candidates: Deviation[],
  task: OpeningPracticeTask | undefined,
  lineId: string,
): Deviation[] {
  if (!task) return candidates;
  if (task.lineId !== lineId || !task.deviation) return [];
  const target = task.deviation;
  return candidates.filter(deviation =>
    deviation.atPly === target.atPly && deviation.uci === target.uci
  );
}

/** Fixed, spoiler-free session snapshot: due reviews first, then new tasks.
 * Round-robin over favorites prevents one course's many branches from taking
 * every slot. A course contributes one task per deviation; an ECO drill one.
 */
export function planOpeningPractice(
  selections: readonly OpeningSelection[],
  reviews: ReviewStore,
  nowMs = Date.now(),
  limit = 5,
): OpeningPracticePlan {
  const buckets: Array<{ due: OpeningPracticeTask[]; fresh: OpeningPracticeTask[] }> = [];
  let dueCount = 0;
  let newCount = 0;

  for (const selection of selections) {
    const line = selectedOpeningLine(selection);
    if (!line) continue;
    const targets = line.id.startsWith('eco:')
      ? [{ reviewKey: `opening:${line.id}` }]
      : line.deviations.map(deviation => ({
          reviewKey: `${line.id}:${deviation.atPly}:${deviation.uci}`,
          deviation: { atPly: deviation.atPly, uci: deviation.uci },
        }));
    const due: OpeningPracticeTask[] = [];
    const fresh: OpeningPracticeTask[] = [];
    for (const target of targets) {
      const review = reviews.reviews[target.reviewKey];
      if (review && !isDue(review, nowMs)) continue;
      const task: OpeningPracticeTask = {
        selection,
        lineId: line.id,
        ...target,
        kind: review ? 'due' : 'new',
        dueAt: review?.dueAt ?? nowMs,
      };
      if (review) { due.push(task); dueCount++; }
      else { fresh.push(task); newCount++; }
    }
    due.sort((a, b) => a.dueAt - b.dueAt);
    if (due.length || fresh.length) buckets.push({ due, fresh });
  }

  const tasks: OpeningPracticeTask[] = [];
  for (const category of ['due', 'fresh'] as const) {
    while (tasks.length < limit && buckets.some(bucket => bucket[category].length > 0)) {
      for (const bucket of buckets) {
        const next = bucket[category].shift();
        if (next) tasks.push(next);
        if (tasks.length >= limit) break;
      }
    }
  }
  return { tasks, dueCount, newCount };
}
