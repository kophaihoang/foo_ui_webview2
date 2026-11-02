import { fb } from 'foo-webview-sdk/bridge';
import { settle } from '../../host/hostCall.ts';
import type { Store } from '../../kit/store.ts';
import { queueViewAtom } from '../../playback/queue/queueState.ts';
import type { CoverflowItem } from '../scene/coverflowItems.ts';
import {
  activeShufflePlan,
  planEntryFor,
  playingPosition,
  shufflePlanAtom,
  type NewPlanEntry,
} from '../scene/shufflePlan.ts';

/**
 * Whether dropping `dragged` into the gap before `items[gap]` changes anything: not next to where it is,
 * not the playing song, and on the played side only where that side can be rearranged (the shuffle plan's
 * side, or the playlist's own rows when playing in list order)
 */
export function canDrop(
  store: Store,
  items: readonly CoverflowItem[],
  dragged: CoverflowItem,
  gap: number,
): boolean {
  const currentAt = items.findIndex((item) => item.kind === 'current');
  if (currentAt < 0 || dragged.kind === 'current' || !dragged.track) return false;
  const from = items.indexOf(dragged);
  if (from === gap || from === gap - 1) return false;
  if (gap > currentAt) return true;
  if (store.get(shufflePlanAtom) && activeShufflePlan()) return true;
  // list order: only rows of the playing playlist move, and the played side has to be that playlist's rows
  return (
    (dragged.kind === 'earlier' || dragged.kind === 'upNext') &&
    items.slice(0, currentAt).every((item) => item.kind === 'earlier')
  );
}

/**
 * "Pick up a song", on either side of the playing song. Dropped on the played side (left), the song counts as
 * played: in random order it leaves the shuffle plan's upcoming songs and sits among the played ones where it
 * was dropped; in list order the playlist itself is rearranged, so the song really moves to that row.
 * Dropped on the upcoming side, see `dropUpcoming`.
 */
export async function dropSong(
  store: Store,
  items: readonly CoverflowItem[],
  dragged: CoverflowItem,
  gap: number,
): Promise<void> {
  if (!canDrop(store, items, dragged, gap)) return;
  const currentAt = items.findIndex((item) => item.kind === 'current');
  if (gap > currentAt) return dropUpcoming(store, items, dragged, gap);
  return dropPlayed(store, items, dragged, gap, currentAt);
}

async function dropPlayed(
  store: Store,
  items: readonly CoverflowItem[],
  dragged: CoverflowItem,
  gap: number,
  currentAt: number,
): Promise<void> {
  if (!dragged.track) return;
  const plan = store.get(shufflePlanAtom);
  const service = activeShufflePlan();
  if (plan && service) {
    const playing = items[currentAt]?.track?.handle;
    const currentPosition = playingPosition(plan, playing);
    const handleOf = (entry: (typeof plan.order)[number] | undefined) =>
      entry === undefined
        ? undefined
        : entry.row !== null
          ? plan.tracks.get(entry.row)?.handle
          : entry.track.handle;
    const head = plan.order[plan.cursor];
    const left = items.slice(0, currentAt);
    const firstOwn = left.findIndex(
      (item) => item.kind === 'played' && item.position !== undefined,
    );
    const ownStart = firstOwn < 0 ? left.length : firstOwn;
    const firstOwnPosition = (() => {
      const item = left[ownStart];
      return item?.kind === 'played' && item.position !== undefined
        ? item.position
        : currentPosition;
    })();
    const target = items[gap];
    let at: number;
    let along: NewPlanEntry[] = [];
    if (target?.kind === 'played' && target.position !== undefined) {
      at = target.position;
    } else if (gap >= ownStart) {
      at = currentPosition;
    } else {
      // dropped among the older history: the songs between here and the plan's own join the plan behind it,
      // so everything shows in the order it was left in
      at = firstOwnPosition;
      along = left
        .slice(gap, ownStart)
        .filter((item) => item !== dragged && item.track)
        .map((item) => planEntryFor(plan, item.track!));
    }

    // the plan's next song sits in the queue; dragging that card is dragging the plan's first song
    const headHandle = handleOf(head);
    const position =
      dragged.kind === 'planned'
        ? dragged.position
        : dragged.kind === 'played' && dragged.position !== undefined
          ? dragged.position
          : dragged.kind === 'queued' && dragged.track.handle === headHandle
            ? plan.cursor
            : null;
    if (position !== null) {
      service.retire({ position }, at, along);
      return;
    }
    if (dragged.kind === 'queued') {
      const entries = store.get(queueViewAtom).entries;
      const index = entries.findIndex((entry) => entry.key === dragged.entry);
      if (index >= 0) await settle(() => fb.queue.remove(index));
    }
    const row =
      (dragged.kind === 'earlier' || dragged.kind === 'upNext') && dragged.guid === plan.guid
        ? dragged.row
        : null;
    service.retire({ entry: planEntryFor(plan, dragged.track, row) }, at, along);
    return;
  }

  // list order: move the row in the playlist itself, in front of the row it was dropped before
  if (dragged.kind !== 'earlier' && dragged.kind !== 'upNext') return;
  const target = items[gap];
  let before: number;
  if (target?.kind === 'earlier') {
    before = target.row;
  } else {
    const at = await settle(() => fb.player.getCurrentTrackIndex());
    if (!at?.success || !at.found || at.index === null) return;
    before = at.index;
  }
  const delta = before > dragged.row ? before - dragged.row - 1 : before - dragged.row;
  if (delta === 0) return;
  await settle(() => fb.playlist.moveTracks(dragged.guid, [dragged.row], delta));
}

/**
 * The upcoming side: a card dropped right of the playing song plays at the spot it was dropped. `items` is the coverflow's list; the drop lands in the gap just before `items[gap]`
 * (`gap === items.length` is the very end). Only gaps right of the playing song count.
 *
 * With the shuffle plan running, songs ahead of the plan are reordered in the plan itself and the queue
 * follows. Without it (list order), the queue is the only thing that can be reordered: the song goes into the
 * queue, at the drop spot or at the queue's end when dropped among the playlist's own songs.
 */
async function dropUpcoming(
  store: Store,
  items: readonly CoverflowItem[],
  dragged: CoverflowItem,
  gap: number,
): Promise<void> {
  const currentAt = items.findIndex((item) => item.kind === 'current');
  if (currentAt < 0 || gap <= currentAt || dragged.kind === 'current' || !dragged.track) return;
  const from = items.indexOf(dragged);
  if (from === gap || from === gap - 1) return;
  const entries = store.get(queueViewAtom).entries;
  // queue slots before the gap, not counting the dragged song itself
  const queuedBefore = items
    .slice(currentAt + 1, gap)
    .filter((item) => item.kind === 'queued' && item !== dragged).length;
  const queueRef = (item: CoverflowItem): string | { playlistGuid: string; item: number } =>
    (item.kind === 'earlier' || item.kind === 'upNext' || item.kind === 'planned') &&
    item.row !== null
      ? { playlistGuid: item.guid, item: item.row }
      : (item.track?.path ?? '');

  const plan = store.get(shufflePlanAtom);
  const service = activeShufflePlan();
  if (plan && service) {
    const next = items[gap];
    const prev = items[gap - 1];
    const planIndex =
      next?.kind === 'planned'
        ? next.position - plan.cursor
        : prev?.kind === 'planned'
          ? prev.position - plan.cursor + 1
          : null;
    // the plan's next song sits in the queue; dragging it is moving the plan's first song
    const planHead = plan.order[plan.cursor];
    const headHandle =
      planHead === undefined
        ? null
        : planHead.row !== null
          ? plan.tracks.get(planHead.row)?.handle
          : planHead.track.handle;
    // a song of the plan moves: an upcoming one, or one from the played side (it leaves that side)
    const position =
      dragged.kind === 'planned' || (dragged.kind === 'played' && dragged.position !== undefined)
        ? (dragged.position ?? null)
        : dragged.kind === 'queued' && dragged.track.handle === headHandle
          ? plan.cursor
          : null;
    if (position !== null) {
      const target = planIndex ?? 0;
      const ahead = position - plan.cursor;
      service.move(position, ahead >= 0 && ahead < target ? target - 1 : target);
      return;
    }
    if (planIndex !== null) {
      // a song from the history or the queue joins the plan
      if (dragged.kind === 'queued') {
        const index = entries.findIndex((entry) => entry.key === dragged.entry);
        if (index >= 0) await settle(() => fb.queue.remove(index));
      }
      const row =
        (dragged.kind === 'earlier' || dragged.kind === 'upNext') && dragged.guid === plan.guid
          ? dragged.row
          : null;
      service.insert(planEntryFor(plan, dragged.track, row), planIndex);
      return;
    }
  }

  // the queue: reorder an entry, or put the song in at the drop spot (the end of the queue at most)
  const slot = Math.min(queuedBefore, entries.length);
  if (dragged.kind === 'queued') {
    const index = entries.findIndex((entry) => entry.key === dragged.entry);
    if (index < 0) return;
    const order = entries.map((_, i) => i).filter((i) => i !== index);
    order.splice(Math.min(slot, order.length), 0, index);
    await settle(() => fb.queue.setContents(order.map((queueIndex) => ({ queueIndex }))));
    return;
  }
  const ref = queueRef(dragged);
  if (ref === '') return;
  await settle(() => fb.queue.insertNext([ref], slot));
}

/** Whether `dragged` can be sunk to the end (see `sinkSong`) */
export function canSink(store: Store, dragged: CoverflowItem): boolean {
  if (dragged.kind === 'current' || !dragged.track) return false;
  if (store.get(shufflePlanAtom) && activeShufflePlan()) return true;
  return dragged.kind === 'queued' || dragged.kind === 'earlier' || dragged.kind === 'upNext';
}

/**
 * A card dragged off the bottom of the screen sinks: the song leaves what plays next and goes to the very
 * end. In random order it moves to the end of the shuffle plan (a queued song leaves the queue for it); in
 * list order a queued song leaves the queue and a playlist song moves to the playlist's last row.
 */
export async function sinkSong(store: Store, dragged: CoverflowItem): Promise<void> {
  if (!canSink(store, dragged) || !dragged.track) return;
  const removeQueued = async () => {
    if (dragged.kind !== 'queued') return;
    const entries = store.get(queueViewAtom).entries;
    const index = entries.findIndex((entry) => entry.key === dragged.entry);
    if (index >= 0) await settle(() => fb.queue.remove(index));
  };
  const plan = store.get(shufflePlanAtom);
  const service = activeShufflePlan();
  if (plan && service) {
    const head = plan.order[plan.cursor];
    const headHandle =
      head === undefined
        ? null
        : head.row !== null
          ? plan.tracks.get(head.row)?.handle
          : head.track.handle;
    const position =
      dragged.kind === 'planned' || (dragged.kind === 'played' && dragged.position !== undefined)
        ? (dragged.position ?? null)
        : dragged.kind === 'queued' && dragged.track.handle === headHandle
          ? plan.cursor
          : null;
    if (position !== null) {
      service.move(position, Number.MAX_SAFE_INTEGER);
      return;
    }
    await removeQueued();
    const row =
      (dragged.kind === 'earlier' || dragged.kind === 'upNext') && dragged.guid === plan.guid
        ? dragged.row
        : null;
    service.insert(planEntryFor(plan, dragged.track, row), Number.MAX_SAFE_INTEGER);
    return;
  }
  if (dragged.kind === 'queued') return removeQueued();
  if (dragged.kind !== 'earlier' && dragged.kind !== 'upNext') return;
  const counted = await settle(() => fb.playlist.getCount(dragged.guid));
  if (!counted?.success) return;
  const delta = counted.count - 1 - dragged.row;
  if (delta > 0) await settle(() => fb.playlist.moveTracks(dragged.guid, [dragged.row], delta));
}
