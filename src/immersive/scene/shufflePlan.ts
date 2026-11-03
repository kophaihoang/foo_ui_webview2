import { fb } from 'foo-webview-sdk/bridge';
import { atom, type Atom } from 'jotai/vanilla';
import { settle } from '../../host/hostCall.ts';
import type { Store } from '../../kit/store.ts';
import { currentTrackAtom, playbackOrderAtom } from '../../playback/playback.ts';
import { queueViewAtom } from '../../playback/queue/queueState.ts';
import {
  UP_NEXT_FIELDS,
  upNextTrackOf,
  type UpNextTrack,
} from '../../playback/queue/upNextModel.ts';

/**
 * Shuffle plan: in a random playback order foobar2000 picks the next song only when the current one ends,
 * so nothing can be shown ahead of it (nor mixed into, for AutoMix). The theme deals the order itself,
 * like shuffling a deck: every song of the playing playlist once, then playback stops. A playlist started
 * while songs are still to come is dealt on top of them: its songs play first, then the rest, and a song in
 * both comes up once. Only the very next song is put in the playback queue, so what the coverflow shows is
 * what really plays, and the queue stays one song long. Songs the user queued by hand play first; the plan
 * carries on after them.
 *
 * Most entries are rows of the playing playlist. A song dragged in from elsewhere (one from the history)
 * is kept by path and queued by path when its turn comes.
 */

const RANDOM_ORDERS = new Set(['random', 'shuffle-tracks', 'shuffle-albums', 'shuffle-folders']);
/** At most this many rows per metadata read */
const READ_BATCH = 120;

/**
 * One song in the plan. `id` is its identity for as long as it is in the plan (its coverflow card keeps it
 * from far right to the middle, so reorders and song changes slide cards instead of swapping them)
 */
export type PlanEntry =
  | { readonly id: number; readonly row: number }
  | { readonly id: number; readonly row: null; readonly path: string; readonly track: UpNextTrack };
/** A song to put into the plan; it gets its id there */
export type NewPlanEntry =
  | { readonly row: number }
  | { readonly row: null; readonly path: string; readonly track: UpNextTrack };

let nextId = 1;
const withId = (entry: NewPlanEntry): PlanEntry => ({ ...entry, id: nextId++ }) as PlanEntry;

export interface ShufflePlan {
  readonly guid: string;
  readonly count: number;
  /** Played songs, then what will play, in order; every song once */
  readonly order: readonly PlanEntry[];
  /** Position in `order` of the next song to play */
  readonly cursor: number;
  /** Metadata of the rows read so far, by row */
  readonly tracks: ReadonlyMap<number, UpNextTrack>;
  /**
   * The song just picked to play (its entry id) until the plan has moved to it: the coverflow lays the cards
   * out for it already, so it can tell a pick further on, or a step back, from the next song coming up
   */
  readonly pending?: number | null;
}

export interface PlannedRow {
  readonly id: number;
  /** Playlist row; null for a song kept by path */
  readonly row: number | null;
  readonly track: UpNextTrack;
  /** Position in the plan */
  readonly position: number;
}

const planAtom = atom<ShufflePlan | null>(null);
export const shufflePlanAtom: Atom<ShufflePlan | null> = atom((get) => get(planAtom));

const trackAt = (plan: ShufflePlan, entry: PlanEntry | undefined): UpNextTrack | undefined =>
  entry === undefined ? undefined : entry.row !== null ? plan.tracks.get(entry.row) : entry.track;

/** A song before the plan's cursor: played, skipped over by a jump, or put among the played ones by hand */
export interface PlanPlayed {
  readonly id: number;
  /** Playlist row; null for a song the plan keeps by path */
  readonly row: number | null;
  readonly handle: string;
  readonly track: UpNextTrack;
  /** Position in the plan */
  readonly position: number;
}

/** How many songs before the cursor the coverflow shows at most */
const HISTORY_SHOWN = 200;

/** The songs before the plan's cursor, newest first, so the coverflow can keep their cards as they move left */
export const planHistoryAtom: Atom<readonly PlanPlayed[]> = atom((get) => {
  const plan = get(planAtom);
  if (!plan) return [];
  const done: PlanPlayed[] = [];
  for (let position = plan.cursor - 1; position >= 0 && done.length < HISTORY_SHOWN; position--) {
    const entry = plan.order[position];
    const track = trackAt(plan, entry);
    if (!entry || !track) break;
    done.push({ id: entry.id, row: entry.row, handle: track.handle, track, position });
  }
  return done;
});

/** The upcoming songs whose metadata is in, from the next one on, stopping at the first gap */
export const plannedRowsAtom: Atom<readonly PlannedRow[]> = atom((get) => {
  const plan = get(planAtom);
  if (!plan) return [];
  const rows: PlannedRow[] = [];
  for (let position = plan.cursor; position < plan.order.length; position++) {
    const entry = plan.order[position];
    const track = trackAt(plan, entry);
    if (entry === undefined || !track) break;
    rows.push({ id: entry.id, row: entry.row, track, position });
  }
  return rows;
});

function deal(count: number): PlanEntry[] {
  const rows = Array.from({ length: count }, (_, row) => row);
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rows[i], rows[j]] = [rows[j] as number, rows[i] as number];
  }
  return rows.map((row) => withId({ row }));
}

/**
 * A playlist started on top of the plan: its deal (`top`) plays first, then the songs the plan still had to
 * come, kept by path as they belong to the old playlist. Those of the new one (`skip`, by handle) leave the
 * rest, so every song comes up once. The played side stays, by path too
 */
export function stackOrder(
  order: readonly PlanEntry[],
  cursor: number,
  trackOf: (entry: PlanEntry) => UpNextTrack | undefined,
  top: readonly PlanEntry[],
  skip: ReadonlySet<string>,
): { order: PlanEntry[]; cursor: number } {
  const byPath = (entry: PlanEntry): PlanEntry[] => {
    const track = trackOf(entry);
    return track ? [{ id: entry.id, row: null, path: track.path, track }] : [];
  };
  const played = order.slice(Math.max(0, cursor - HISTORY_SHOWN), cursor).flatMap(byPath);
  const rest = order
    .slice(cursor)
    .flatMap(byPath)
    .filter((entry) => entry.row !== null || !skip.has(entry.track.handle));
  return { order: [...played, ...top, ...rest], cursor: played.length };
}

const keyOf = (entry: PlanEntry): string =>
  entry.row !== null ? `row:${entry.row}` : `path:${entry.path}`;

/** What a change to the order did: the new cursor, and where a song that was at `position` is now */
export interface PlanChange {
  readonly cursor: number;
  shift(position: number): number;
  /** Where the song that was moved or put in now sits */
  readonly placed: number;
}

/**
 * Move the song at `position` (in `order`, changed in place) so it plays `index`-th after the cursor.
 * A song from before the cursor leaves the played side, so the cursor steps back by one
 */
export function moveInPlan(
  order: PlanEntry[],
  cursor: number,
  position: number,
  index: number,
): PlanChange | null {
  if (position < 0 || position >= order.length) return null;
  const [entry] = order.splice(position, 1);
  if (entry === undefined) return null;
  const from = position < cursor ? cursor - 1 : cursor;
  const to = Math.min(order.length, from + Math.max(0, index));
  order.splice(to, 0, entry);
  return {
    cursor: from,
    placed: to,
    shift: (p) => {
      if (p === position) return to;
      const out = p > position ? p - 1 : p;
      return out >= to ? out + 1 : out;
    },
  };
}

/**
 * Put a song among the played ones in front of position `at` (`order` changes in place): a song of the plan
 * by position, or a new entry, followed by `along`. They all end up before the cursor
 */
export function retireInPlan(
  order: PlanEntry[],
  cursor: number,
  source: { readonly position: number } | { readonly entry: PlanEntry },
  at: number,
  along: readonly PlanEntry[] = [],
): PlanChange | null {
  let target = at;
  let next = cursor;
  let entry: PlanEntry | undefined;
  let removed = -1;
  if ('position' in source) {
    removed = source.position;
    if (removed < 0 || removed >= order.length) return null;
    [entry] = order.splice(removed, 1);
    if (removed < next) next -= 1;
    if (removed < target) target -= 1;
  } else {
    entry = source.entry;
  }
  if (entry === undefined) return null;
  const added = [entry, ...along];
  target = Math.max(0, Math.min(target, next));
  order.splice(target, 0, ...added);
  return {
    cursor: next + added.length,
    placed: target,
    shift: (p) => {
      if (p === removed) return target;
      const out = removed >= 0 && p > removed ? p - 1 : p;
      return out >= target ? out + added.length : out;
    },
  };
}

/**
 * Where the playing song sits in the plan: still its next song right after a song change, the one just
 * behind the cursor once the plan caught up, or nowhere (a detour), when songs put among the played ones go
 * at the cursor
 */
export function playingPosition(plan: ShufflePlan, handle: string | undefined): number {
  if (handle === undefined) return plan.cursor;
  if (trackAt(plan, plan.order[plan.cursor])?.handle === handle) return plan.cursor;
  if (trackAt(plan, plan.order[plan.cursor - 1])?.handle === handle) return plan.cursor - 1;
  return plan.cursor;
}

/**
 * How a song joins the plan: as its playlist row when it is a song of the plan's playlist (the plan follows
 * that playlist's playback), by path otherwise
 */
export function planEntryFor(
  plan: ShufflePlan,
  track: UpNextTrack,
  row: number | null = null,
): NewPlanEntry {
  if (row !== null) return { row };
  for (const [index, known] of plan.tracks) {
    if (known.handle === track.handle) return { row: index };
  }
  return { row: null, path: track.path, track };
}

export interface ShufflePlanService {
  /** Make sure metadata is in for the next `ahead` songs */
  ensure(ahead: number): void;
  /** Play the planned song at `position`; the plan jumps there and the queue follows */
  playAt(position: number): Promise<boolean>;
  /**
   * Move the song at `position` so it plays `index`-th from now (0 = next). A song from before the cursor
   * (one shown on the played side) leaves that side
   */
  move(position: number, index: number): void;
  /**
   * Put a song among the played ones, in front of the song at `at` (a position before the cursor, or the
   * playing song's): it counts as played and won't come up in this deal. `source` is a song of the plan by
   * position (an upcoming one, or one on the played side being reordered) or a new one. `along` follow it
   * in, in order: songs of the playback history that sat between the drop spot and the plan's own
   */
  retire(
    source: { position: number } | { entry: NewPlanEntry },
    at: number,
    along?: readonly NewPlanEntry[],
  ): number | null;
  /** Put a song into the plan so it plays `index`-th from now (0 = next) */
  insert(entry: NewPlanEntry, index: number): void;
  dispose(): void;
}

let active: ShufflePlanService | null = null;

/** The running plan, if any (it runs for the whole app, so the queue is always one song ahead) */
export function activeShufflePlan(): ShufflePlanService | null {
  return active;
}

export function startShufflePlan(store: Store): ShufflePlanService {
  let disposed = false;
  let running = false;
  let again = false;
  /** The song this plan put in the queue, so only that one is ever taken back out */
  let queuedByPlan: { key: string; handle: string } | null = null;
  let wanted = 16;
  let reading = false;
  /** A song picked in the coverflow, until it starts playing */
  let jump: { position: number } | null = null;
  /** Stop after current is on because the plan's last song is playing */
  let stopping = false;

  const isRandom = () => {
    const order = store.get(playbackOrderAtom);
    return order !== null && RANDOM_ORDERS.has(order);
  };

  async function fresh(guid: string, playingRow: number | null): Promise<ShufflePlan | null> {
    const counted = await settle(() => fb.playlist.getCount(guid));
    if (!counted?.success || counted.count < 2) return null;
    const order = deal(counted.count).filter((entry) => entry.row !== playingRow);
    return { guid, count: counted.count, order, cursor: 0, tracks: new Map() };
  }

  /** Metadata of `rows` of a playlist, read in batches; null when a read fails */
  async function readAll(
    guid: string,
    rows: readonly number[],
  ): Promise<Map<number, UpNextTrack> | null> {
    const tracks = new Map<number, UpNextTrack>();
    for (let i = 0; i < rows.length; i += READ_BATCH) {
      const answer = await settle(() =>
        fb.playlist.getTracksAt(guid, rows.slice(i, i + READ_BATCH), undefined, [
          ...UP_NEXT_FIELDS,
        ]),
      );
      if (disposed || !answer?.success) return null;
      for (const track of answer.tracks) {
        if (typeof track.index === 'number') tracks.set(track.index, upNextTrackOf(track));
      }
    }
    return tracks;
  }

  /** A playlist started while the plan is on: its deal goes on top of what the plan still had to come */
  async function stack(
    old: ShufflePlan,
    guid: string,
    playingRow: number | null,
    playingHandle: string,
  ): Promise<ShufflePlan | null> {
    const top = await fresh(guid, playingRow);
    if (!top) return null;
    const tracks = await readAll(
      guid,
      Array.from({ length: top.count }, (_, row) => row),
    );
    if (!tracks) return null;
    const unread = old.order
      .slice(old.cursor)
      .flatMap((entry) => (entry.row !== null && !old.tracks.has(entry.row) ? [entry.row] : []));
    const more = (await readAll(old.guid, unread)) ?? new Map<number, UpNextTrack>();
    const trackOf = (entry: PlanEntry) =>
      entry.row !== null ? (old.tracks.get(entry.row) ?? more.get(entry.row)) : entry.track;
    const skip = new Set([playingHandle, ...[...tracks.values()].map((track) => track.handle)]);
    return { ...top, ...stackOrder(old.order, old.cursor, trackOf, top.order, skip), tracks };
  }

  /** Stop after the plan's last song, or no longer when songs came in after it */
  async function stopAfterLast(last: boolean): Promise<void> {
    if (last === stopping) return;
    stopping = last;
    await settle(() => fb.player.setStopAfterCurrent(last));
  }

  /** Bring the plan in line with what is playing, then keep the next planned song queued */
  async function sync(): Promise<void> {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await step();
      } while (again && !disposed);
    } finally {
      running = false;
    }
  }

  async function step(): Promise<void> {
    if (disposed) return;
    const current = store.get(currentTrackAtom);
    if (!isRandom() || current === null) {
      store.set(planAtom, null);
      await stopAfterLast(false);
      return;
    }
    const playing = await settle(() => fb.player.getPlayingPlaylist());
    if (disposed || !playing?.success || !playing.found || playing.playlistGuid === null) return;
    const at = await settle(() => fb.player.getCurrentTrackIndex());
    const playingRow = at?.success && at.found && at.index !== null ? at.index : null;

    let plan = store.get(planAtom);
    // a song the plan queued by path plays without moving foobar2000 off the plan's playlist; any other
    // change of playlist means the user started somewhere else, and the deck is dealt from there
    const ours = queuedByPlan !== null && queuedByPlan.handle === current.handle;
    if (!plan) {
      plan = await fresh(playing.playlistGuid, playingRow);
    } else if (plan.guid !== playing.playlistGuid && !ours) {
      plan = await stack(plan, playing.playlistGuid, playingRow, current.handle);
    }
    if (!plan || disposed) return;
    const counted = await settle(() => fb.playlist.getCount(plan!.guid));
    if (counted?.success && counted.count !== plan.count) plan = await fresh(plan.guid, playingRow);
    if (!plan || disposed) return;

    // the song now playing is the plan's next one (it came off the queue), or the one picked in the
    // coverflow: the plan moves on to just after it. Anything else (previous, a song picked elsewhere) is a
    // detour; the plan waits where it is and its next song stays queued
    const isPlaying = (entry: PlanEntry | undefined): boolean =>
      entry !== undefined &&
      (entry.row !== null
        ? playing.playlistGuid === plan!.guid && playingRow === entry.row
        : entry.track.handle === current.handle || entry.path === current.path);
    if (jump && isPlaying(plan.order[jump.position])) {
      plan = { ...plan, cursor: jump.position + 1, pending: null };
      jump = null;
    } else if (isPlaying(plan.order[plan.cursor])) {
      plan = { ...plan, cursor: plan.cursor + 1 };
    }
    // every song came up: a song started after the last one deals the playlist anew
    if (plan.cursor >= plan.order.length && !isPlaying(plan.order[plan.cursor - 1])) {
      plan = await fresh(plan.guid, playingRow);
      if (!plan || disposed) return;
    }
    store.set(planAtom, plan);
    await stopAfterLast(
      plan.cursor >= plan.order.length && store.get(queueViewAtom).entries.length === 0,
    );

    const next = plan.order[plan.cursor];
    if (next === undefined) return;
    const entries = store.get(queueViewAtom).entries;
    // our queued song is no longer the next one (the plan jumped or was reordered): take it back out
    if (queuedByPlan && queuedByPlan.key !== keyOf(next)) {
      const stale = queuedByPlan;
      const index = entries.findIndex((entry) => entry.track.handle === stale.handle);
      queuedByPlan = null;
      if (index >= 0) {
        await settle(() => fb.queue.remove(index));
        again = true;
        return;
      }
    }
    if (entries.length > 0) return;
    const added =
      next.row !== null
        ? await settle(() => fb.queue.add({ playlistGuid: plan!.guid, track: next.row }))
        : await settle(() => fb.queue.insertNext([next.path], 0));
    if (added?.success) {
      const track = trackAt(plan, next);
      queuedByPlan = { key: keyOf(next), handle: track?.handle ?? '' };
      if (!track && next.row !== null) readTracks([next.row]);
    }
  }

  function readTracks(rows: readonly number[]): void {
    const plan = store.get(planAtom);
    if (!plan || rows.length === 0) {
      reading = false;
      return;
    }
    void settle(() =>
      fb.playlist.getTracksAt(plan.guid, rows, undefined, [...UP_NEXT_FIELDS]),
    ).then(
      (answer) => {
        reading = false;
        const now = store.get(planAtom);
        if (disposed || !answer?.success || !now || now.guid !== plan.guid) return;
        if (answer.total !== now.count) return void sync();
        const tracks = new Map(now.tracks);
        for (const track of answer.tracks) {
          if (typeof track.index === 'number') tracks.set(track.index, upNextTrackOf(track));
        }
        if (queuedByPlan && queuedByPlan.handle === '' && queuedByPlan.key.startsWith('row:')) {
          const row = Number(queuedByPlan.key.slice(4));
          queuedByPlan = { ...queuedByPlan, handle: tracks.get(row)?.handle ?? '' };
        }
        store.set(planAtom, { ...now, tracks });
      },
      () => {
        reading = false;
      },
    );
  }

  /** Read the metadata missing between the cursor and `wanted` songs ahead */
  function fill(): void {
    if (reading || disposed) return;
    const plan = store.get(planAtom);
    if (!plan) return;
    const missing: number[] = [];
    const seen = new Set<number>();
    for (let p = plan.cursor; p <= plan.cursor + wanted && missing.length < READ_BATCH; p++) {
      const entry = plan.order[p];
      const row = entry?.row;
      if (row === undefined || row === null || plan.tracks.has(row) || seen.has(row)) continue;
      seen.add(row);
      missing.push(row);
    }
    if (missing.length === 0) return;
    reading = true;
    readTracks(missing);
  }

  /**
   * Change the order, then let the queue follow (its next song may have changed). `change` returns the new
   * cursor when songs went in or out before it
   */
  function reorder(change: (order: PlanEntry[], cursor: number) => number | void): void {
    const plan = store.get(planAtom);
    if (!plan) return;
    const order = [...plan.order];
    const cursor = change(order, plan.cursor) ?? plan.cursor;
    store.set(planAtom, { ...plan, order, cursor });
    void sync();
  }

  // track change and queue change arrive as separate events: let both land before looking
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void sync(), 250);
  };
  const offs = [
    store.sub(currentTrackAtom, later),
    store.sub(playbackOrderAtom, later),
    store.sub(queueViewAtom, later),
    store.sub(planAtom, () => fill()),
  ];
  void sync();

  const service: ShufflePlanService = {
    ensure(ahead) {
      wanted = Math.max(wanted, ahead);
      fill();
    },
    async playAt(position) {
      const plan = store.get(planAtom);
      const entry = plan?.order[position];
      if (!plan || entry === undefined) return false;
      jump = { position };
      store.set(planAtom, { ...plan, pending: entry.id });
      const answer =
        entry.row !== null
          ? await settle(() => fb.playlist.playTrack(plan.guid, entry.row))
          : await settle(() => fb.player.playPath(entry.path));
      return answer?.success === true;
    },
    move(position, index) {
      reorder((order, cursor) => {
        const moved = moveInPlan(order, cursor, position, index);
        if (!moved) return;
        if (jump) jump = { position: moved.shift(jump.position) };
        return moved.cursor;
      });
    },
    retire(source, at, along = []) {
      let placed: number | null = null;
      reorder((order, cursor) => {
        const retired = retireInPlan(
          order,
          cursor,
          'position' in source ? source : { entry: withId(source.entry) },
          at,
          along.map(withId),
        );
        if (!retired) return;
        if (jump) jump = { position: retired.shift(jump.position) };
        placed = retired.placed;
        return retired.cursor;
      });
      return placed as number | null;
    },
    insert(entry, index) {
      reorder((order, cursor) => {
        const to = Math.min(order.length, cursor + Math.max(0, index));
        order.splice(to, 0, withId(entry));
        if (jump && jump.position >= to) jump = { position: jump.position + 1 };
      });
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      active = null;
      for (const off of offs) off();
      store.set(planAtom, null);
    },
  };
  active = service;
  return service;
}
