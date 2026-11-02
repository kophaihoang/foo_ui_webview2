import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useAtomValueRawSync } from 'jotai/react';
import { reducedMotionAtom } from '../../motion/reducedMotion.ts';
import { CURVE } from '../../motion/timing.ts';

/**
 * Switching to Blueprint glides the cover across in a view transition. The browser holds the old picture
 * until the new scene has rendered, so everything mounted in that moment makes the switch stall. The light
 * parts (dial, record, titles) come with the glide; the live panels wrapped in this one (spectrum, waveform,
 * meters, stereo, lyrics) wait until the transition is over, then come in one per frame and fade in.
 */

/** `data-scene-transition` on the root while a scene transition runs (`TRANSITION_ATTRIBUTE`) */
const TRANSITION_DATA = 'data-scene-transition';
/** Never wait longer than this for a transition to end */
const WAIT_LIMIT_MS = 1500;
const FADE_MS = 280;

const waiting: (() => void)[] = [];
let pumping = false;

/** Mount the waiting panels one per frame, so they don't land in the same frame either */
function pump(): void {
  if (pumping) return;
  pumping = true;
  const tick = () => {
    const next = waiting.shift();
    if (!next) {
      pumping = false;
      return;
    }
    next();
    requestAnimationFrame(() => requestAnimationFrame(tick));
  };
  requestAnimationFrame(tick);
}

/** Call `then` once no scene transition is running; returns a cancel */
function whenSettled(then: () => void): () => void {
  const root = document.documentElement;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    observer.disconnect();
    clearTimeout(limit);
    then();
  };
  const observer = new MutationObserver(() => {
    if (!root.hasAttribute(TRANSITION_DATA)) finish();
  });
  const limit = setTimeout(finish, WAIT_LIMIT_MS);
  if (!root.hasAttribute(TRANSITION_DATA)) {
    // no transition (first open, reduced motion): still let the scene paint once before the panels
    requestAnimationFrame(finish);
  } else {
    observer.observe(root, { attributes: true, attributeFilter: [TRANSITION_DATA] });
  }
  return () => {
    done = true;
    observer.disconnect();
    clearTimeout(limit);
  };
}

export function Deferred({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const reduced = useAtomValueRawSync(reducedMotionAtom);
  const marker = useRef<HTMLTemplateElement>(null);
  useEffect(() => {
    let live = true;
    const cancel = whenSettled(() => {
      waiting.push(() => {
        if (live) setReady(true);
      });
      pump();
    });
    return () => {
      live = false;
      cancel();
    };
  }, []);
  // fade the panel's own box in: the element rendered just before the marker
  useLayoutEffect(() => {
    if (!ready || reduced) return;
    const panel = marker.current?.previousElementSibling;
    if (!(panel instanceof HTMLElement) || typeof panel.animate !== 'function') return;
    panel.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: FADE_MS,
      easing: CURVE.decelerateMid.timing,
    });
  }, [ready, reduced]);
  return ready ? (
    <>
      {children}
      <template ref={marker} />
    </>
  ) : null;
}
