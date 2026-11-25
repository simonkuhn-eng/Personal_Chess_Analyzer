import type { BoardArrow } from './boardPresentation';

export type BoardArrowKind = 'best' | 'threat' | 'mistake' | 'preview';
export interface DisplayBoardArrow extends BoardArrow { kind: BoardArrowKind }
type Point = { x: number; y: number };
const valid = (arrow: BoardArrow | null | undefined): arrow is BoardArrow => Boolean(arrow && /^[a-h][1-8]$/.test(arrow.from) && /^[a-h][1-8]$/.test(arrow.to) && arrow.from !== arrow.to);

export function displayBoardArrows(best?: BoardArrow | null, threats: BoardArrow[] = [], mistake?: BoardArrow | null, preview?: BoardArrow | null): DisplayBoardArrow[] {
  const unique = new Map<string, DisplayBoardArrow>();
  // One semantic color per move; preview and best take precedence over lower layers.
  for (const [kind, list] of [['threat', threats], ['mistake', [mistake]], ['best', [best]], ['preview', [preview]]] as const) {
    for (const arrow of list) if (valid(arrow)) unique.set(arrow.from + arrow.to, { ...arrow, kind });
  }
  const order: BoardArrowKind[] = ['threat', 'mistake', 'best', 'preview'];
  return [...unique.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

export function boardSquareCenter(square: string, flipped = false): Point {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return { x: (flipped ? 7 - file : file) * 12.5 + 6.25, y: (flipped ? rank : 7 - rank) * 12.5 + 6.25 };
}

/** One filled silhouette avoids doubled opacity where a line meets its head. */
export function boardArrowGeometry(from: string, to: string, flipped = false) {
  if (!valid({ from, to })) return null;
  const start = boardSquareCenter(from, flipped);
  const tip = boardSquareCenter(to, flipped);
  const fileDistance = Math.abs(from.charCodeAt(0) - to.charCodeAt(0));
  const rankDistance = Math.abs(Number(from[1]) - Number(to[1]));
  const points = [start];
  if (fileDistance === 1 && rankDistance === 2) points.push({ x: start.x, y: tip.y });
  if (fileDistance === 2 && rankDistance === 1) points.push({ x: tip.x, y: start.y });
  points.push(tip);
  const directions = points.slice(1).map((point, i) => {
    const length = Math.hypot(point.x - points[i].x, point.y - points[i].y);
    return { x: (point.x - points[i].x) / length, y: (point.y - points[i].y) / length };
  });
  const normals = directions.map(direction => ({ x: -direction.y, y: direction.x }));
  const lastDirection = directions[directions.length - 1];
  const lastNormal = normals[normals.length - 1];
  const headBase = { x: tip.x - lastDirection.x * 4.9, y: tip.y - lastDirection.y * 4.9 };
  const side = (sign: number) => {
    const edge = [{ x: start.x + normals[0].x * 1.35 * sign, y: start.y + normals[0].y * 1.35 * sign }];
    for (let i = 1; i < points.length - 1; i++) {
      const previous = normals[i - 1];
      const next = normals[i];
      const scale = 1.35 * sign / (1 + previous.x * next.x + previous.y * next.y);
      edge.push({ x: points[i].x + (previous.x + next.x) * scale, y: points[i].y + (previous.y + next.y) * scale });
    }
    edge.push({ x: headBase.x + lastNormal.x * 1.35 * sign, y: headBase.y + lastNormal.y * 1.35 * sign });
    return edge;
  };
  const polygon = [...side(1), { x: headBase.x + lastNormal.x * 3.6, y: headBase.y + lastNormal.y * 3.6 }, tip,
    { x: headBase.x - lastNormal.x * 3.6, y: headBase.y - lastNormal.y * 3.6 }, ...side(-1).reverse()];
  return { path: polygon.map((point, i) => (i === 0 ? 'M' : 'L') + point.x.toFixed(3) + ',' + point.y.toFixed(3)).join(' ') + ' Z', points, tip, polygon };
}
