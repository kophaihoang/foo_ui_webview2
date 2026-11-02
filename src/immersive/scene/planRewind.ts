import type { Store } from '../../kit/store.ts';
import { playbackAtom } from '../../playback/playback.ts';
import { coverflowItemsAtom } from './coverflowAtoms.ts';
import { currentIndexOf, type CoverflowItem } from './coverflowItems.ts';
import {
  activeShufflePlan,
  planEntryFor,
  playingPosition,
  shufflePlanAtom,
} from './shufflePlan.ts';

/** Past this many seconds into a song, "previous" starts it over instead (like a phone) */
export const RESTART_AFTER_SECONDS = 3;

/**
 * Play a song from the coverflow's played side the shuffle plan's way: the plan steps back to it, so the
 * songs after it (the one that was playing included) come up again in the order the coverflow shows. A song
 * of the playback history from before the plan is first put in just before the playing song, if it is a song
 * of the plan's playlist. False when the plan can't take it; the caller then plays it the usual way.
 */
export async function rewindTo(store: Store, item: CoverflowItem): Promise<boolean> {
  const service = activeShufflePlan();
  const plan = store.get(shufflePlanAtom);
  if (!service || !plan || item.kind !== 'played' || !item.track) return false;
  if (item.position !== undefined) return service.playAt(item.position);
  // a song from before the plan: only one of the plan's playlist can join it (the plan follows that
  // playlist's playback); anything else plays the usual way
  const entry = planEntryFor(plan, item.track);
  if (entry.row === null) return false;
  const items = store.get(coverflowItemsAtom);
  const playing = items[currentIndexOf(items)]?.track?.handle;
  const placed = service.retire({ entry }, playingPosition(plan, playing));
  return placed === null ? false : service.playAt(placed);
}

export interface PreviousTarget {
  previous(): Promise<void>;
  seek(seconds: number): Promise<void>;
}

/**
 * "Previous" everywhere in the immersive view: a few seconds into the song it starts the song over; otherwise
 * it plays the card just left of the playing one in the coverflow, so stepping back follows the order shown
 * there (random order included). Without the shuffle plan, foobar2000's own previous, which in list order is
 * that same card.
 */
export async function previousSong(store: Store, playback: PreviousTarget): Promise<void> {
  const { track, canSeek, position } = store.get(playbackAtom);
  if (track && canSeek && position > RESTART_AFTER_SECONDS) {
    await playback.seek(0);
    return;
  }
  const items = store.get(coverflowItemsAtom);
  const at = currentIndexOf(items);
  const left = at > 0 ? items[at - 1] : undefined;
  if (left && (await rewindTo(store, left))) return;
  await playback.previous();
}
