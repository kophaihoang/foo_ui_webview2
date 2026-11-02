import { describe, expect, it } from 'vitest';
import {
  planEntryFor,
  playingPosition,
  moveInPlan,
  retireInPlan,
  type PlanEntry,
} from '../../../../src/immersive/scene/shufflePlan.ts';

const deck = (...rows: number[]): PlanEntry[] => rows.map((row) => ({ id: row + 100, row }));
const rows = (order: readonly PlanEntry[]) => order.map((entry) => entry.row);

describe('retireInPlan: a song put among the played ones', () => {
  // played 0 1 2 | playing 3 (cursor 4) | upcoming 4 5 6
  it('an upcoming song dropped before the playing one lands right before it and counts as played', () => {
    const order = deck(0, 1, 2, 3, 4, 5, 6);
    const change = retireInPlan(order, 4, { position: 6 }, 3);
    expect(rows(order)).toEqual([0, 1, 2, 6, 3, 4, 5]);
    expect(change?.cursor).toBe(5);
    expect(order[change!.cursor]?.row).toBe(4);
  });

  it('dropped further left it sits between the played songs', () => {
    const order = deck(0, 1, 2, 3, 4, 5, 6);
    const change = retireInPlan(order, 4, { position: 5 }, 1);
    expect(rows(order)).toEqual([0, 5, 1, 2, 3, 4, 6]);
    expect(change?.cursor).toBe(5);
    expect(order[change!.cursor]?.row).toBe(4);
  });

  it('reordering on the played side keeps the cursor on the next song', () => {
    const order = deck(0, 1, 2, 3, 4, 5, 6);
    const change = retireInPlan(order, 4, { position: 0 }, 3);
    expect(rows(order)).toEqual([1, 2, 0, 3, 4, 5, 6]);
    expect(change?.cursor).toBe(4);
    const back = retireInPlan(order, 4, { position: 2 }, 0);
    expect(rows(order)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(back?.cursor).toBe(4);
  });

  it('right after a song change the playing song is still the next one: dropping before it keeps it next', () => {
    // played 0 1 2 | playing 3 = order[cursor] (cursor 3)
    const order = deck(0, 1, 2, 3, 4, 5);
    const change = retireInPlan(order, 3, { position: 5 }, 3);
    expect(rows(order)).toEqual([0, 1, 2, 5, 3, 4]);
    expect(order[change!.cursor]?.row).toBe(3);
  });

  it('a new song and the history songs it passes come in together, in order', () => {
    const order = deck(0, 1, 2, 3);
    const extra = (id: number): PlanEntry => ({
      id,
      row: null,
      path: `p${id}`,
      track: {} as never,
    });
    const change = retireInPlan(order, 2, { entry: extra(1) }, 0, [extra(2), extra(3)]);
    expect(order.map((entry) => entry.id)).toEqual([1, 2, 3, 100, 101, 102, 103]);
    expect(change?.cursor).toBe(5);
  });

  it('a pending jump follows its song', () => {
    const order = deck(0, 1, 2, 3, 4, 5, 6);
    const change = retireInPlan(order, 4, { position: 5 }, 1);
    // the song that was at 6 is still row 6
    expect(order[change!.shift(6)]?.row).toBe(6);
    expect(order[change!.shift(5)]?.row).toBe(5);
  });
});

describe('moveInPlan', () => {
  it('a played song dragged to the upcoming side leaves the played side', () => {
    const order = deck(0, 1, 2, 3, 4, 5, 6);
    const change = moveInPlan(order, 4, 1, 1);
    // cursor steps back: played 0 2 | playing 3 | next 4 then 1
    expect(rows(order)).toEqual([0, 2, 3, 4, 1, 5, 6]);
    expect(change?.cursor).toBe(3);
    expect(order[change!.cursor]?.row).toBe(4);
  });

  it('upcoming songs reorder as before', () => {
    const order = deck(0, 1, 2, 3, 4, 5, 6);
    const change = moveInPlan(order, 4, 6, 0);
    expect(rows(order)).toEqual([0, 1, 2, 3, 6, 4, 5]);
    expect(change?.cursor).toBe(4);
  });
});

describe('where things land', () => {
  it('retireInPlan says where the song now sits', () => {
    const order = deck(0, 1, 2, 3, 4, 5, 6);
    const change = retireInPlan(order, 4, { position: 6 }, 3);
    expect(order[change!.placed]?.row).toBe(6);
  });

  it('moveInPlan says where the song now sits', () => {
    const order = deck(0, 1, 2, 3, 4, 5, 6);
    const change = moveInPlan(order, 4, 1, 1);
    expect(order[change!.placed]?.row).toBe(1);
  });
});

describe('planEntryFor / playingPosition', () => {
  const song = (name: string) => ({ handle: `h-${name}`, path: `p-${name}` }) as never;
  const plan = {
    guid: 'g',
    count: 5,
    order: deck(0, 1, 2, 3, 4),
    cursor: 3,
    tracks: new Map([
      [0, song('a')],
      [1, song('b')],
      [2, song('c')],
      [3, song('d')],
    ]),
  };

  it('a song of the playlist joins by row, anything else by path', () => {
    expect(planEntryFor(plan, song('b'))).toEqual({ row: 1 });
    expect(planEntryFor(plan, song('x'))).toMatchObject({ row: null, path: 'p-x' });
    expect(planEntryFor(plan, song('x'), 4)).toEqual({ row: 4 });
  });

  it('the playing song: just behind the cursor, still the next one, or a detour', () => {
    expect(playingPosition(plan, 'h-c')).toBe(2);
    expect(playingPosition(plan, 'h-d')).toBe(3);
    expect(playingPosition(plan, 'h-x')).toBe(3);
  });
});
