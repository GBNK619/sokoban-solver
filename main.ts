// Sokoban solver: push-optimal, room by room.
//
// Every level this competition draws is a one-wide hallway with 1-4 rooms
// off it; a box pushed out of a room's door can never come back, so each
// room is an independent problem and the level's push optimum is the sum of
// its rooms' optima. This program splits the level into rooms, solves each
// room push-optimally with A* over pushes (player-reachability BFS, minimum
// assignment heuristic, dead-square and frozen-block pruning, transposition
// table keyed on boxes + player region), and joins the rooms with hallway
// walks. Fully deterministic: budgets are counted in work (states expanded),
// never in wall-clock time; no clock is read, no randomness is used.
//
// Local run: MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Directions: [dx, dy, letter], in a fixed order so every tie breaks the same way. */
const DIRS = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
] as const;

/** Work budgets (states expanded), never the clock. Rooms are tiny; these are generous. */
const MAX_ROOM_EXPANSIONS = 500_000;
const MAX_LEVEL_EXPANSIONS = 2_000_000;
const MAX_GREEDY_PUSHES = 3000;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on goal, @ player). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The squares from which a box can still be pushed onto some goal: pull
 * backwards from the goals. A box needs the player on the far side to be
 * pulled, so a square is live only when the square beyond it is open floor.
 */
function liveSquares(lv: Level): Uint8Array {
  const { w, wall, goals } = lv;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood the player's reachable region from `from` around walls and boxes,
 * marking it in `seen` with `stamp`; returns its lowest square, which names
 * the region (two states with the same boxes and the same region are one).
 */
function regionLow(
  lv: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = lv;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    const q0 = p - w;
    const q1 = p + w;
    const q2 = p - 1;
    const q3 = p + 1;
    if (!wall[q0] && !occupied[q0] && seen[q0] !== stamp) { seen[q0] = stamp; stack[n++] = q0; }
    if (!wall[q1] && !occupied[q1] && seen[q1] !== stamp) { seen[q1] = stamp; stack[n++] = q1; }
    if (!wall[q2] && !occupied[q2] && seen[q2] !== stamp) { seen[q2] = stamp; stack[n++] = q2; }
    if (!wall[q3] && !occupied[q3] && seen[q3] !== stamp) { seen[q3] = stamp; stack[n++] = q3; }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes with a box off its goal. */
function frozenBlock(lv: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = lv;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** Walking distance from one goal over open floor (walls alone), -1 where unreachable. */
function distTable(lv: Level, goalCell: number): Int32Array {
  const { w, wall } = lv;
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [goalCell];
  dist[goalCell] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const q = p + dy * w + dx;
      if (!wall[q] && dist[q] < 0) {
        dist[q] = dist[p]! + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/**
 * Minimum-assignment heuristic: the cheapest way to match every box to a
 * distinct goal by walking distance. Each push moves one box one square, so
 * this is a lower bound on the pushes still needed (admissible), and it is
 * exact enough to keep the search small. Infinity when some box reaches no goal.
 */
function assignmentHeuristic(boxes: number[], dists: Int32Array[]): number {
  const n = boxes.length;
  let best = Infinity;
  const used = new Array<boolean>(n).fill(false);
  const assign = (i: number, sum: number): void => {
    if (sum >= best) return;
    if (i === n) {
      best = sum;
      return;
    }
    for (let g = 0; g < n; g++) {
      if (used[g]) continue;
      const d = dists[g]![boxes[i]!]!;
      if (d < 0) continue;
      used[g] = true;
      assign(i + 1, sum + d);
      used[g] = false;
    }
  };
  assign(0, 0);
  return best;
}

/** The shortest walk from `from` to `to` around walls and boxes (lower-case LURD), or null when unreachable. */
function walkTo(lv: Level, occupied: Uint8Array, from: number, to: number): string | null {
  const { w, wall } = lv;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * Push-optimal A* over one level (a room, or the whole board as a fallback):
 * {pushes, moves}, or null when the work budget runs out or no solution exists.
 * States are (boxes, player region); pushes are the only cost, so the first
 * solved state popped is push-optimal.
 */
function solvePushAStar(lv: Level, maxExpansions: number, stringKeys: boolean): { pushes: number; moves: string } | null {
  const { w, wall, goals } = lv;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(lv);
  const dists = goals.map((g) => distTable(lv, g));
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);
  if (lv.boxes.some((b) => !live[b])) return null;
  if (solved(lv.boxes)) return { pushes: 0, moves: '' };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const keyOf = (boxes: number[], low: number): number | string => {
    if (stringKeys) return `${low}|${boxes.join(',')}`;
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  // The states, in order found: boxes, the player's square after the push that made them, parent, the push.
  const sBoxes: number[][] = [lv.boxes.slice()];
  const sPlayer: number[] = [lv.player];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sTo: number[] = [-1];
  const sDir: number[] = [-1];
  const sG: number[] = [0];
  const best = new Map<number | string, number>();

  for (const b of lv.boxes) occupied[b] = 1;
  const startLow = regionLow(lv, occupied, lv.player, seen, ++stamp, stack);
  for (const b of lv.boxes) occupied[b] = 0;
  best.set(keyOf(lv.boxes, startLow), 0);

  // Binary heap on [f, h, seq, state]; f = pushes + heuristic, ties by h then by age.
  const heap: [number, number, number, number][] = [];
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  const h0 = assignmentHeuristic(lv.boxes, dists);
  if (!Number.isFinite(h0)) return null;
  heapPush([h0, h0, 0, 0]);
  let seq = 1;
  let expanded = 0;

  while (heap.length > 0) {
    const [, , , s] = heapPop();
    const g = sG[s]!;
    if (solved(sBoxes[s]!)) {
      // Reconstruct: walk the pushes back, then forward with player walks between them.
      const path: number[] = [];
      for (let t = s; t > 0; t = sParent[t]!) path.push(t);
      path.reverse();
      let moves = '';
      let player = lv.player;
      let boxes = lv.boxes.slice();
      for (const t of path) {
        const from = sFrom[t]!;
        const to = sTo[t]!;
        const dir = sDir[t]!;
        const d = DIRS[dir]![1] * w + DIRS[dir]![0];
        for (const b of boxes) occupied[b] = 1;
        const walk = walkTo(lv, occupied, player, from - d);
        for (const b of boxes) occupied[b] = 0;
        if (walk === null) return null;
        moves += walk + DIRS[dir]![2];
        player = from;
        boxes = boxes.map((b) => (b === from ? to : b)).sort((a, b) => a - b);
      }
      return { pushes: path.length, moves };
    }
    if (expanded >= maxExpansions) return null;
    expanded++;
    const boxes = sBoxes[s]!;
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    regionLow(lv, occupied, sPlayer[s]!, seen, here, stack);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k]![1] * w + DIRS[k]![0];
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(lv, occupied, goal, t);
        let key: number | string = -1;
        let next: number[] | null = null;
        let h = Infinity;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, b) => a - b);
          const low = regionLow(lv, occupied, b, mark, ++stamp, stack);
          key = keyOf(next, low);
          h = assignmentHeuristic(next, dists);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || !Number.isFinite(h)) continue;
        const known = best.get(key);
        if (known !== undefined && known <= g + 1) continue;
        best.set(key, g + 1);
        const idx = sBoxes.length;
        sBoxes.push(next!);
        sPlayer.push(b);
        sParent.push(s);
        sFrom.push(b);
        sTo.push(t);
        sDir.push(k);
        sG.push(g + 1);
        heapPush([g + 1 + h, h, seq++, idx]);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  return null;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor; each remaining part that
 * holds boxes is a room. Null when the level is no set of rooms.
 */
interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done?: boolean;
}

function roomsOf(lv: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = lv;
  const live = liveSquares(lv);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Solve the level room by room; null when any room's search gives up. */
function solveByRooms(lv: Level): { pushes: number; moves: string } | null {
  const rooms = roomsOf(lv);
  if (rooms === null) return null;
  let player = lv.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = lv.wall.slice();
    for (const other of rooms) {
      if (other !== room) for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: lv.w,
      h: lv.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushAStar(sub, MAX_ROOM_EXPANSIONS, false);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(lv.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** Greedy safety net: always take the legal push that most reduces the assignment heuristic. */
function solveGreedy(lv: Level): { pushes: number; moves: string } | null {
  const { w, wall, goals } = lv;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(lv);
  const dists = goals.map((g) => distTable(lv, g));
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  let player = lv.player;
  let boxes = lv.boxes.slice();
  let moves = '';
  let pushes = 0;
  const visited = new Set<string>();
  while (!solved(boxes) && pushes < MAX_GREEDY_PUSHES) {
    const key = boxes.join(',');
    if (visited.has(key)) return null;
    visited.add(key);
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    regionLow(lv, occupied, player, seen, here, stack);
    let bestH = Infinity;
    let best: { from: number; to: number; dir: number; walk: string } | null = null;
    for (const b of boxes) {
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k]![1] * w + DIRS[k]![0];
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(lv, occupied, goal, t);
        let h = Infinity;
        let walk: string | null = null;
        if (!frozen) {
          const next = boxes.map((x) => (x === b ? t : x)).sort((a, b) => a - b);
          h = assignmentHeuristic(next, dists);
          if (Number.isFinite(h)) walk = walkTo(lv, occupied, player, b - d);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (!Number.isFinite(h) || walk === null) continue;
        if (h < bestH) {
          bestH = h;
          best = { from: b, to: t, dir: k, walk };
        }
      }
    }
    for (const b of boxes) occupied[b] = 0;
    if (best === null) return null;
    moves += best.walk + DIRS[best.dir]![2];
    player = best.from;
    boxes = boxes.map((b) => (b === best!.from ? best!.to : b)).sort((a, b) => a - b);
    pushes++;
  }
  return solved(boxes) ? { pushes, moves } : null;
}

/** Replay `moves` on the level; true only when every step is legal and every box ends on a goal. */
function replayOk(lv: Level, moves: string): boolean {
  const { w, wall, goals } = lv;
  const goal = new Uint8Array(wall.length);
  for (const g of goals) goal[g] = 1;
  const box = new Uint8Array(wall.length);
  for (const b of lv.boxes) box[b] = 1;
  let player = lv.player;
  for (const ch of moves) {
    const dir = DIRS.find(([, , letter]) => letter === ch);
    if (!dir) return false;
    const d = dir[1] * w + dir[0];
    const next = player + d;
    if (wall[next]) return false;
    if (box[next]) {
      const beyond = next + d;
      if (wall[beyond] || box[beyond]) return false;
      box[next] = 0;
      box[beyond] = 1;
    }
    player = next;
  }
  for (let i = 0; i < box.length; i++) if (box[i] && !goal[i]) return false;
  return true;
}

/** Solve one level: rooms first, whole-board search next, greedy last. Never throws. */
function solve(text: string): string {
  const lv = parseLevel(text);
  let r = solveByRooms(lv);
  if (!r) r = solvePushAStar(lv, MAX_LEVEL_EXPANSIONS, true);
  if (r && replayOk(lv, r.moves)) return r.moves;
  const g = solveGreedy(lv);
  if (g && replayOk(lv, g.moves)) return g.moves;
  // Still answer the instance (a legal-but-unsolved answer scores 0 but counts as answered).
  return r ? r.moves : g ? g.moves : '';
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
