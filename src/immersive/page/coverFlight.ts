import { flushSync } from 'react-dom';
import type { Store } from '../../kit/store.ts';
import { immersiveCoverAtom } from '../../covers/immersiveCover.ts';
import { reducedMotionAtom } from '../../motion/reducedMotion.ts';
import { CURVE } from '../../motion/timing.ts';
import { paperCoverBox } from '../dial/recordGeometry.ts';
import { TRANSITION_ATTRIBUTE } from '../scene/sceneTransition.ts';
import { sharedCoverHolders } from '../scene/coverHolders.ts';
import styles from './CoverFlight.module.css';

/**
 * The cover's flight into Blueprint.
 *
 * Why not a view transition: the browser re-captures a named element's picture every frame it changes, and
 * Blueprint's cover is a turning record label inside a scene that is still drawing itself in, so each frame of
 * the glide waited on a fresh capture and the glide stuttered. Here the cover is a copy that only moves and
 * fades (transform and opacity, which the compositor can run on its own), and the page does nothing heavy
 * while it moves: Blueprint is mounted after the landing.
 *
 * The order of things:
 *  1. a copy of the cover appears exactly over the cover on screen and starts flying to where Blueprint
 *     will put its label (worked out from the window size, `paperCoverBox`, so the flight doesn't wait for
 *     Blueprint to exist); the square copy turns round on the way by fading into a round one
 *  2. the old scene fades out quickly under it; nothing else happens while the copy moves
 *  3. once it has landed, Blueprint mounts (its label hidden under the copy) and fades in around it (if the
 *     label turned out somewhere else, the copy slides onto it)
 *  4. the label shows and the record spins up, the copy goes; the live panels (`paper/Deferred.tsx`) come in
 *     one by one after that
 */

/** The flight itself */
const FLIGHT_MS = 620;
/** How far into the flight the copy counts as landed (with this curve it has covered ~98% of the way) */
const LANDED_AT = 0.78;
/** A soft start and a long, gentle landing */
const FLIGHT_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
/** Coverflow → Lyrics moves everything together, a little quicker than a flight into another scene */
const SYNC_MS = 540;
/** The scene being left fades out this fast under the flying copy */
const OUT_MS = 200;
/** Blueprint fades in around the landed copy */
const IN_MS = 360;
/** Data attribute on the root while the copy is up: Blueprint's own label stays hidden under it */
const FLIGHT_ATTRIBUTE = 'coverFlight';
/** Landing never waits longer than this for the label's image */
const IMAGE_WAIT_MS = 300;

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

let flying = false;
const listeners = new Set<() => void>();

function setFlying(next: boolean): void {
  if (flying === next) return;
  flying = next;
  for (const listener of [...listeners]) listener();
}

/** Whether a cover is in flight; Blueprint's record waits for the landing before it turns */
export const coverFlight = {
  active: (): boolean => flying,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** The copy: a square layer that fades into a round one, at the larger of the two sizes so it stays sharp */
function buildPlane(
  from: string | null,
  url: string | null,
  size: number,
  radius: number,
  ring: number,
): {
  plane: HTMLDivElement;
  square: HTMLDivElement;
  round: HTMLDivElement;
} {
  const plane = document.createElement('div');
  plane.className = styles.plane ?? '';
  plane.style.width = `${size}px`;
  plane.style.height = `${size}px`;
  plane.setAttribute('aria-hidden', 'true');
  const layer = (className: string | undefined, src: string | null) => {
    const element = document.createElement('div');
    element.className = className ?? '';
    if (src) {
      const image = document.createElement('img');
      image.decoding = 'sync';
      image.alt = '';
      image.draggable = false;
      image.src = src;
      element.append(image);
    }
    return element;
  };
  // the start layer shows the very picture the cover had on screen, the end layer the one it will have
  const square = layer(styles.square, from ?? url);
  square.style.borderRadius = `${radius}px`;
  const round = layer(styles.round, url);
  round.style.setProperty('--ring', `${ring}px`);
  const spindle = document.createElement('span');
  spindle.className = styles.spindle ?? '';
  round.append(spindle);
  plane.append(square, round);
  return { plane, square, round };
}

const pose = (rect: Rect, size: number): string =>
  `translate(${rect.x}px, ${rect.y}px) scale(${rect.size / size})`;

/** Where the cover lands, relative to the immersive content's top left corner (unzoomed CSS pixels) */
export interface LandingBox {
  readonly left: number;
  readonly top: number;
  readonly size: number;
  /** A record label (round) or a square cover with this corner radius at the landing size */
  readonly round: boolean;
  readonly radius?: number;
}

/** One kind of flight: where it goes and what moves around it */
export interface FlightPlan {
  /** Where the cover will be once `update` has run, worked out before it runs; null to not fly */
  landing(content: HTMLElement): LandingBox | null;
  /** The part of the view that goes away under the flying cover */
  leaving(content: HTMLElement): HTMLElement | null;
  /** Switch views; runs once the copy has landed */
  update(): void;
  /** After `update`: the part that comes in around the landed copy */
  entering(content: HTMLElement): HTMLElement | null;
  /** After `update`: the real cover the copy stands in for */
  cover(content: HTMLElement): HTMLElement | null;
}

/**
 * Fly the cover from where it is now to where `plan` says, switching views on landing. Returns false (doing
 * nothing) when there is no cover to fly or no motion wanted; the caller then switches the plain way.
 */
export function flyCover(store: Store, plan: FlightPlan): boolean {
  const doc = document;
  const root = doc.documentElement;
  const content = doc.querySelector<HTMLElement>('[data-immersive-content]');
  const source = sharedCoverHolders.holder();
  if (
    flying ||
    !content ||
    !(source instanceof HTMLElement) ||
    store.get(reducedMotionAtom) ||
    doc.visibilityState !== 'visible' ||
    typeof content.animate !== 'function'
  ) {
    return false;
  }
  const area = content.getBoundingClientRect();
  const start = source.getBoundingClientRect();
  if (start.width < 1 || content.clientWidth < 1 || content.clientHeight < 1) return false;
  const box = plan.landing(content);
  if (!box || box.size < 1) return false;
  // the landing is worked out in the content's own pixels (a transform on the view, like its entrance
  // zoom, doesn't change the layout); it is then placed where the content shows on screen
  const zoom = area.width / content.clientWidth;
  let target: Rect = {
    x: area.left + box.left * zoom,
    y: area.top + box.top * zoom,
    size: box.size * zoom,
  };
  const from: Rect = { x: start.left, y: start.top, size: start.width };

  const cover = store.get(immersiveCoverAtom);
  const url = cover.status === 'missing' ? null : cover.url;
  const size = Math.max(from.size, target.size);
  const radius =
    (parseFloat(getComputedStyle(source).borderTopLeftRadius) || 0) * (size / from.size);
  // the label's ring (2 px dark + 1 px light) as it will look once landed, drawn at the copy's own scale
  const ring = size / target.size;
  const shown = source.querySelector('img');
  const startImage =
    shown && shown.complete && shown.naturalWidth > 0 ? shown.currentSrc || shown.src : null;
  const { plane, square, round } = buildPlane(startImage, url, size, radius, ring);
  if (!box.round) {
    // a square cover at the end too: the corners only change from the start's to the end's radius
    round.style.borderRadius = `${(box.radius ?? 0) * (size / box.size)}px`;
    round.style.boxShadow = 'none';
    round.querySelector('span')?.remove();
  }
  (content.parentElement ?? doc.body).append(plane);

  setFlying(true);
  root.dataset[FLIGHT_ATTRIBUTE] = '';
  root.dataset[TRANSITION_ATTRIBUTE] = '';

  const timing = { duration: FLIGHT_MS, easing: FLIGHT_EASING, fill: 'forwards' } as const;
  const flight = plane.animate(
    [{ transform: pose(from, size) }, { transform: pose(target, size) }],
    timing,
  );
  // the corners change shape in the middle of the flight
  square.animate(
    [{ opacity: 1 }, { opacity: 1, offset: 0.2 }, { opacity: 0, offset: 0.7 }, { opacity: 0 }],
    { duration: FLIGHT_MS, fill: 'forwards' },
  );
  round.animate(
    [{ opacity: 0 }, { opacity: 0, offset: 0.2 }, { opacity: 1, offset: 0.7 }, { opacity: 1 }],
    { duration: FLIGHT_MS, fill: 'forwards' },
  );

  // the view being left fades out under the copy
  plan.leaving(content)?.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: OUT_MS,
    easing: CURVE.accelerateMid.timing,
    fill: 'forwards',
  });

  // Nothing heavy happens while the cover moves: the new view is built only once the copy has landed, so
  // the flight never shares the main thread with it, whether or not the compositor runs it on its own
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    delete root.dataset[FLIGHT_ATTRIBUTE];
    setFlying(false);
    // the real cover shows again: take the copy away once its image is on screen, never in the same frame
    const image = plan.cover(content)?.querySelector('img');
    const away = () => {
      requestAnimationFrame(() => {
        plane.remove();
        delete root.dataset[TRANSITION_ATTRIBUTE];
      });
    };
    if (!image || (image.complete && !image.hasAttribute('data-loading'))) {
      away();
      return;
    }
    const limit = setTimeout(away, IMAGE_WAIT_MS);
    image.addEventListener(
      'load',
      () => {
        clearTimeout(limit);
        away();
      },
      { once: true },
    );
  };

  let arrived = false;
  const arrive = () => {
    if (arrived) return;
    arrived = true;
    try {
      flushSync(plan.update);
    } catch {
      plan.update();
    }
    // the new view fades in around the landed copy once its first frame is on screen: started earlier, a
    // heavy first paint would eat into the fade and it would pop in half done
    const entering = plan.entering(content);
    if (entering) entering.style.opacity = '0';
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        // worked out right, the real cover is exactly under the copy; if not, slide the copy onto it
        const real = plan.cover(content)?.getBoundingClientRect();
        if (real && real.width > 0) {
          const there: Rect = { x: real.left, y: real.top, size: real.width };
          const off = Math.max(
            Math.abs(there.x - target.x),
            Math.abs(there.y - target.y),
            Math.abs(there.size - target.size),
          );
          if (off >= 1.5) {
            const now = getComputedStyle(plane).transform;
            plane.animate([{ transform: now }, { transform: pose(there, size) }], {
              duration: 200,
              easing: CURVE.decelerateMid.timing,
              fill: 'forwards',
            });
            target = there;
          }
        }
        if (!entering) return finish();
        entering.style.opacity = '';
        entering
          .animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: IN_MS,
            easing: CURVE.decelerateMid.timing,
          })
          .finished.then(finish, finish);
      }),
    );
  };
  // the new view starts being built when the copy is all but there: the last stretch of the landing moves only
  // a pixel or two, so nothing shows if that work holds a frame back, and the view comes in a beat sooner
  setTimeout(arrive, Math.round(FLIGHT_MS * LANDED_AT));
  flight.finished.then(arrive, arrive);
  // never leave the copy behind, whatever happens to the page meanwhile
  setTimeout(arrive, FLIGHT_MS + 400);
  setTimeout(finish, FLIGHT_MS + IN_MS + 1500);

  return true;
}

/** Lyrics → Blueprint: into the record's label (or the narrow tier's square cover) */
export function flyIntoBlueprint(store: Store, update: () => void): boolean {
  return flyCover(store, {
    landing: (content) => paperCoverBox(content.clientWidth, content.clientHeight),
    leaving: (content) => content.querySelector<HTMLElement>('[data-scene]'),
    update,
    entering: (content) => content.querySelector<HTMLElement>('[data-scene="paper"]'),
    cover: (content) => content.querySelector<HTMLElement>('[data-dial-cover]'),
  });
}

/** The split preset's own root; the presets scene's root carries the preset id too */
const SPLIT = '[data-scene="presets"] [data-preset="split"]';

/** Scale every length in a computed box-shadow, for a layer drawn at another size than the element it copies */
function scaledShadow(shadow: string, by: number): string {
  if (!shadow || shadow === 'none') return 'none';
  return shadow.replace(/(-?\d*\.?\d+)px/g, (_, value: string) => `${Number(value) * by}px`);
}

/**
 * Coverflow → Lyrics, all in one movement: the lyrics view is in the page already (hidden behind the
 * coverflow), so it is shown first, see-through, and laid out; then, from the next frame on, the middle card's
 * copy glides into the lyrics cover while the coverflow fades out and the lyrics view fades in on the same
 * curve. Only transforms and opacity change from then on, so nothing waits on the page while things move.
 * The copy wears the card's picture, corners and shadow at the start and the lyrics cover's at the end.
 */
export function flyIntoLyrics(store: Store, update: () => void): boolean {
  const doc = document;
  const root = doc.documentElement;
  const content = doc.querySelector<HTMLElement>('[data-immersive-content]');
  const source = sharedCoverHolders.holder();
  const stage = content?.querySelector<HTMLElement>('[data-stage="coverflow"]');
  if (
    flying ||
    !content ||
    !stage ||
    !(source instanceof HTMLElement) ||
    !content.querySelector(SPLIT) ||
    store.get(reducedMotionAtom) ||
    doc.visibilityState !== 'visible' ||
    typeof content.animate !== 'function'
  ) {
    return false;
  }
  const start = source.getBoundingClientRect();
  if (start.width < 1) return false;
  const from: Rect = { x: start.left, y: start.top, size: start.width };
  const sourceStyle = getComputedStyle(source);
  const shown = source.querySelector('img');
  const startImage =
    shown && shown.complete && shown.naturalWidth > 0 ? shown.currentSrc || shown.src : null;
  const cover = store.get(immersiveCoverAtom);
  const url = cover.status === 'missing' ? null : cover.url;

  setFlying(true);
  root.dataset[FLIGHT_ATTRIBUTE] = '';
  root.dataset[TRANSITION_ATTRIBUTE] = '';
  // the copy sits on the card first (built at the card's size, so it is exact before anything is measured)
  const first = buildPlane(startImage, url, from.size, 0, 1);
  first.plane.style.transform = pose(from, from.size);
  (content.parentElement ?? doc.body).append(first.plane);

  // show the lyrics view, see-through, and let it lay out
  try {
    flushSync(update);
  } catch {
    update();
  }
  const entering = content.querySelector<HTMLElement>(SPLIT);
  if (entering) entering.style.opacity = '0';
  const real = content.querySelector<HTMLElement>(`${SPLIT} [data-scene-element="cover"]`);
  const end = real?.getBoundingClientRect();
  if (!real || !end || end.width < 1) {
    first.plane.remove();
    if (entering) entering.style.opacity = '';
    delete root.dataset[FLIGHT_ATTRIBUTE];
    delete root.dataset[TRANSITION_ATTRIBUTE];
    setFlying(false);
    return true;
  }
  const target: Rect = { x: end.left, y: end.top, size: end.width };
  const targetStyle = getComputedStyle(real);
  const size = Math.max(from.size, target.size);
  // the real copy, at the larger of the two sizes, with both ends' corners and shadows
  const { plane, square, round } = buildPlane(startImage, url, size, 0, 1);
  square.style.borderRadius = `${(parseFloat(sourceStyle.borderTopLeftRadius) || 0) * (size / from.size)}px`;
  square.style.boxShadow = scaledShadow(sourceStyle.boxShadow, size / from.size);
  round.style.borderRadius = `${(parseFloat(targetStyle.borderTopLeftRadius) || 0) * (size / target.size)}px`;
  round.style.boxShadow = scaledShadow(targetStyle.boxShadow, size / target.size);
  round.querySelector('span')?.remove();
  plane.style.transform = pose(from, size);
  first.plane.replaceWith(plane);

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    delete root.dataset[FLIGHT_ATTRIBUTE];
    setFlying(false);
    if (entering) entering.style.opacity = '';
    const image = real.querySelector('img');
    const away = () =>
      requestAnimationFrame(() => {
        plane.remove();
        delete root.dataset[TRANSITION_ATTRIBUTE];
      });
    if (!image || image.complete) {
      away();
      return;
    }
    const limit = setTimeout(away, IMAGE_WAIT_MS);
    image.addEventListener(
      'load',
      () => {
        clearTimeout(limit);
        away();
      },
      { once: true },
    );
  };

  // two frames: the lyrics view's first (see-through) frame is on screen, then everything moves at once
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const flight = plane.animate(
        [{ transform: pose(from, size) }, { transform: pose(target, size) }],
        { duration: SYNC_MS, easing: FLIGHT_EASING, fill: 'forwards' },
      );
      square.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: SYNC_MS,
        easing: CURVE.decelerateMid.timing,
        fill: 'forwards',
      });
      round.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: SYNC_MS,
        easing: CURVE.decelerateMid.timing,
        fill: 'forwards',
      });
      stage.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: OUT_MS,
        easing: CURVE.accelerateMid.timing,
        fill: 'forwards',
      });
      if (entering) {
        entering.style.opacity = '';
        entering.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: SYNC_MS,
          easing: FLIGHT_EASING,
          fill: 'backwards',
        });
      }
      flight.finished.then(finish, finish);
    }),
  );
  setTimeout(finish, SYNC_MS + 1500);
  return true;
}
