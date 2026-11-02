import type { Store } from '../../kit/store.ts';
import { flushSync } from 'react-dom';
import { reducedMotionAtom } from '../../motion/reducedMotion.ts';
import { CURVE, DURATION_MS } from '../../motion/timing.ts';
import { GLIDE_MS, GLIDE_SPEED, TRANSITION_ATTRIBUTE } from '../scene/sceneTransition.ts';
import { browserSceneTransition, forceSceneMode, sceneStateAtom } from '../scene/sceneActions.ts';
import type { SceneMode } from '../scene/sceneState.ts';
import { chooseImmersiveScene, immersiveSceneAtom } from './immersivePrefs.ts';
import { flyIntoBlueprint, flyIntoLyrics } from './coverFlight.ts';

/**
 * One-tap view cycle: Blueprint → Coverflow → Lyrics → Blueprint.
 * Blueprint is the `paper` scene; Coverflow and Lyrics are the `presets` scene with mode `coverflow` / `none`.
 * Every step glides the cover from where it is to where it goes; the rest of the view cross-fades.
 */
let enterPresetsAs: SceneMode | null = null;
let swapping = false;

/** Read once by the presets scene when it mounts, after it restored its own snapshot */
export function takePresetsEntryMode(): SceneMode | null {
  const mode = enterPresetsAs;
  enterPresetsAs = null;
  return mode;
}

/**
 * Swap scenes inside a view transition: the cover carries the shared name in both scenes (Blueprint's dial
 * cover, the coverflow's playing card, the lyrics cover), so the browser glides it from one spot to the
 * other while the rest of the view cross-fades under it. Same timing as the scene's own transitions.
 */
function morphSwap(store: Store, update: () => void): void {
  const doc = document;
  const content = doc.querySelector<HTMLElement>('[data-immersive-content]');
  if (
    !doc.startViewTransition ||
    !content ||
    store.get(reducedMotionAtom) ||
    doc.visibilityState !== 'visible'
  ) {
    update();
    return;
  }
  if (swapping) return;
  swapping = true;
  const root = doc.documentElement;
  root.style.setProperty('--scene-glide-duration', `${GLIDE_MS}ms`);
  root.style.setProperty('--scene-glide-easing', CURVE.pointToPoint.timing);
  root.style.setProperty(
    '--scene-fade-duration',
    `${Math.round(DURATION_MS.faster / GLIDE_SPEED)}ms`,
  );
  root.style.setProperty(
    '--scene-exit-duration',
    `${Math.round(DURATION_MS.fast / GLIDE_SPEED)}ms`,
  );
  root.dataset[TRANSITION_ATTRIBUTE] = '';
  content.style.viewTransitionName = 'scene-body';
  const done = () => {
    content.style.viewTransitionName = '';
    delete root.dataset[TRANSITION_ATTRIBUTE];
    swapping = false;
  };
  try {
    const transition = doc.startViewTransition(() => flushSync(update));
    transition.ready.catch(() => {});
    transition.finished.then(done, done);
  } catch {
    done();
    update();
  }
}

/** Blueprint → Coverflow */
export function cycleFromBlueprint(store: Store): void {
  morphSwap(store, () => {
    enterPresetsAs = 'coverflow';
    chooseImmersiveScene(store, 'presets');
  });
}

/** Lyrics → Blueprint: the cover flies into the record's label (`coverFlight.ts`) */
export function cycleFromLyrics(store: Store): void {
  if (swapping) return;
  const update = () => {
    forceSceneMode(store, 'none');
    chooseImmersiveScene(store, 'paper');
  };
  if (!flyIntoBlueprint(store, update)) morphSwap(store, update);
}

/** Coverflow → Lyrics: the middle card flies into the lyrics view's cover (`coverFlight.ts`) */
export function cycleFromCoverflow(store: Store): void {
  const update = () => forceSceneMode(store, 'none');
  if (!flyIntoLyrics(store, update)) browserSceneTransition(store)(update);
}

/** Step to the next view from wherever the immersive view is now */
export function cycleNext(store: Store): void {
  if (store.get(immersiveSceneAtom) === 'paper') cycleFromBlueprint(store);
  else if (store.get(sceneStateAtom).mode === 'coverflow') cycleFromCoverflow(store);
  else cycleFromLyrics(store);
}

/** Things that do something on their own when clicked; a double tap on them never switches the view */
const INTERACTIVE = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  '[contenteditable]',
  '[role="button"]',
  '[role="slider"]',
  '[role="option"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="toolbar"]',
  '[role="search"]',
  '[role="tab"]',
  '[role="dialog"]',
  '[data-scene-element="cover"]',
  '[data-scene-element="progress"]',
  '[data-dial-cover]',
  '[data-no-cycle]',
].join(',');

export function isCycleTarget(target: EventTarget): boolean {
  return target instanceof Element && target.closest(INTERACTIVE) === null;
}
