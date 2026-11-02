import { Record48Regular } from '@fluentui/react-icons';
import { useAtomValueRawSync, useStore } from 'jotai/react';
import { atom } from 'jotai/vanilla';
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { playbackAtom } from '../../playback/playback.ts';
import { immersiveCoverAtom } from '../../covers/immersiveCover.ts';
import { FadeImage } from '../../kit/FadeImage.tsx';
import { useViewServices } from '../page/viewServices.ts';
import { cycleFromBlueprint } from '../page/viewCycle.ts';
import { coverFlight } from '../page/coverFlight.ts';
import { SCENE_COVER_LAYER, useCoverHolder } from '../page/sharedCover.ts';
import styles from './DialCover.module.css';

export interface DialCoverProps {
  /** 封面的位置与边长，所在内容层的坐标 */
  readonly box: CSSProperties;
  /** `data-decor-guard` 的外扩，单位像素：生成式网格不在封面周围这么远以内放装饰 */
  readonly guard: number;
  /** Blueprint's record: the cover is the round label and turns while music plays */
  readonly round?: boolean;
}

const playingAtom = atom((get) => get(playbackAtom).state === 'playing');
/** One turn of the label, ms: a slow, calm 10 rpm */
const TURN_MS = 6000;
/** Spin up and run down like a platter, ms */
const RAMP_MS = 700;

/** Turns `element` while `on`, easing the speed up from rest and back down to rest */
function useSpin(element: HTMLElement | null, on: boolean): void {
  const spin = useRef<Animation | null>(null);
  useEffect(() => {
    if (!element) return;
    const animation = element.animate([{ rotate: '0deg' }, { rotate: '360deg' }], {
      duration: TURN_MS,
      iterations: Infinity,
    });
    animation.pause();
    spin.current = animation;
    return () => {
      animation.cancel();
      spin.current = null;
    };
  }, [element]);
  useEffect(() => {
    const animation = spin.current;
    if (!animation) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (on) animation.play();
      else animation.pause();
      return;
    }
    const from = animation.playState === 'running' ? animation.playbackRate : 0;
    const to = on ? 1 : 0;
    if (on) animation.play();
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / RAMP_MS);
      const eased = on ? 1 - (1 - t) ** 3 : 1 - t * t;
      const rate = on ? from + (to - from) * eased : from * eased;
      animation.updatePlaybackRate(Math.max(rate, on ? 0.02 : 0));
      if (t < 1) frame = requestAnimationFrame(tick);
      else if (!on) animation.pause();
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [on, element]);
}

/**
 * 罗盘里的封面：占位盘片一直垫在下面，图叠在上面；地址可用不等于图存在或能解码。封面状态与背景的封面底色
 * 共用同一份，解码结果由这里的 `<img>` 回报
 */
export function DialCover({ box, guard, round = false }: DialCoverProps) {
  const cover = useAtomValueRawSync(immersiveCoverAtom);
  const services = useViewServices();
  const store = useStore();
  // the same shared name as the covers of the other views, so a view switch glides the cover across
  const holder = useCoverHolder(SCENE_COVER_LAYER);
  const url = cover.status === 'missing' ? null : cover.url;
  const { token } = cover;
  const playing = useAtomValueRawSync(playingAtom);
  const [spinner, setSpinner] = useState<HTMLDivElement | null>(null);
  // while the cover flies in (`coverFlight.ts`) the label waits at rest, then spins up as the copy lands on it
  const flying = useSyncExternalStore(coverFlight.subscribe, coverFlight.active);
  useSpin(round ? spinner : null, round && playing && !flying);
  return (
    <div
      ref={holder}
      className={round ? `${styles.cover} ${styles.round}` : styles.cover}
      style={box}
      data-decor-guard={guard}
      data-dial-cover
      // one-tap view cycle: Blueprint → Coverflow
      onClick={() => cycleFromBlueprint(store)}
    >
      <div ref={setSpinner} className={styles.spinner}>
        <Record48Regular />
        {/* 按身份换元素：上一张图晚到的 load / error 带的是旧身份，进不了当前这一张。 */}
        {url && (
          <FadeImage
            key={token}
            className={styles.art}
            src={url}
            alt=""
            draggable={false}
            onLoad={() => services.cover?.markLoaded(token)}
            onError={() => services.cover?.markFailed(token)}
          />
        )}
      </div>
      {round && <span className={styles.spindle} aria-hidden />}
    </div>
  );
}
