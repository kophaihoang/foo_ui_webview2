import { useFocusFinders } from '@fluentui/react-components';
import { useAtomValueRawSync, useStore } from 'jotai/react';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type RefObject,
} from 'react';
import { translateAtom } from '../../i18n/locale.ts';
import { historyAtom } from '../../nav/navHistory.ts';
import { pageTransition, type LayerMotion } from '../../motion/pageTransition.ts';
import { reducedMotionAtom } from '../../motion/reducedMotion.ts';
import { controlsVisibleAtom, type ImmersiveShell } from './immersiveShell.ts';
import { attachImmersiveRoot } from './keyFocus.ts';
import { PaperScene } from '../paper/PaperScene.tsx';
import { useSceneSize } from '../paper/useSceneSize.ts';
import { PerfOverlay } from '../perf/PerfOverlay.tsx';
import { EntryStageContext, useEntryStages } from '../scene/entryStage.ts';
import { ControlSlotsContext, type ControlSlots } from '../scene/sceneContext.ts';
import { ImmersiveControls } from './ImmersiveControls.tsx';
import type { ImmersiveScene } from './immersivePrefs.ts';
import { PresetsScene } from './PresetsScene.tsx';
import styles from './ImmersiveView.module.css';
import { cycleNext, isCycleTarget } from './viewCycle.ts';

const COVERFLOW = '[data-scene-element="coverflow"]';
/** how long a double tap in Coverflow waits for a third tap before it switches view */
const TRIPLE_TAP_WAIT_MS = 380;
/** The view's design size, CSS px: a smaller window shows it scaled down, not laid out again */
export const DESIGN_SIZE = { width: 1280, height: 800 } as const;

/** How much the view shrinks to fit a window of `size`: 1 at the design size and above */
export function fitScale(size: { readonly width: number; readonly height: number }): number {
  if (size.width <= 0 || size.height <= 0) return 1;
  return Math.min(1, size.width / DESIGN_SIZE.width, size.height / DESIGN_SIZE.height);
}
import { handleViewCycle } from '../scene/viewCycleRequest.ts';
import { setImmersiveUp } from '../../theme/backdrop.ts';

export interface ImmersiveViewProps {
  readonly shell: Pick<ImmersiveShell, 'touch' | 'toggleFullscreen' | 'leave'> | null;
  /** 这一页此刻是不是当前地点；离开后的退场过渡里为假 */
  readonly current: boolean;
  /** 画哪个场景；外壳（退出、全屏、静止隐藏、焦点）与场景无关 */
  readonly scene: ImmersiveScene;
}

/** 在元素上播一组动画，先停掉它身上还在播的（进场没播完就离场，或离场没播完又被接回来） */
function play(element: HTMLElement, motions: readonly LayerMotion[]): Animation[] {
  for (const running of element.getAnimations()) running.cancel();
  return motions.map((motion) => element.animate(motion.keyframes, motion.options));
}

/**
 * 进出这一页的过渡：与别的二级地点一样走 drill（`pageTransition.ts`），按历史记下的到达方式与方向
 * 这一层挂在窗口顶层、不在中央区域的页面层里，那边的过渡动不到它，这里自己播；时长与那边相同，
 * 离场播完时页面层正好被移走
 *
 * 返回进场是否播完（没有到达方式时没有过渡，视为已播完）；被取消的进场不算，重新进场时再等
 */
function useViewMotion(root: RefObject<HTMLElement | null>, current: boolean): boolean {
  const store = useStore();
  const [entered, setEntered] = useState(false);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const arrival = store.get(historyAtom).arrival;
    if (!arrival) {
      if (current) setEntered(true);
      return;
    }
    const motion = pageTransition(arrival.kind, arrival.direction, store.get(reducedMotionAtom));
    const animations = play(element, current ? motion.enter : motion.exit);
    if (!current) return;
    let stale = false;
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (!stale) setEntered(true);
    });
    return () => {
      stale = true;
    };
  }, [root, store, current]);
  return entered;
}

/**
 * 正在播放全屏页的视图：盖住整窗的一层（标题栏、侧边栏、内容卡都在它底下），里面是当前场景（图纸或预设）、拖窗条与控件层
 *
 * 指针与键盘都静止 3 s 后控件层与光标一起藏（`immersiveShell.ts`）；用键盘把焦点移到控件层的键上时不藏，
 * 视同有动作。动作只在这一层的根元素上听，Esc 不算动作：它是离开。焦点跟踪（`keyFocus.ts`）挂在根元素上，
 * 挂上时把焦点收进来，离开时还给进来前拿着焦点的那个元素；Tab 只在这一层里转，不落到底下被盖住的键上
 * 离开后的退场过渡里整层不接指针与焦点
 */
export function ImmersiveView({ shell, current, scene }: ImmersiveViewProps) {
  const t = useAtomValueRawSync(translateAtom);
  const store = useStore();
  const controlsVisible = useAtomValueRawSync(controlsVisibleAtom);
  const [controlsFocused, setControlsFocused] = useState(false);
  const root = useRef<HTMLElement>(null);
  // Coverflow: a triple tap on empty space glides back to the playing song, so a double tap there
  // waits a moment for a third before it switches view
  const pendingCycle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropPendingCycle = () => {
    if (pendingCycle.current !== null) clearTimeout(pendingCycle.current);
    pendingCycle.current = null;
  };
  useEffect(() => dropPendingCycle, []);
  const content = useRef<HTMLDivElement>(null);
  // 控制层留给场景元素的挂载点：控制层与场景是兄弟，经上下文交给场景里的元素
  const [slots, setSlots] = useState<ControlSlots>({ tabs: null, views: null });
  const slotRefs = useMemo(
    () => ({
      tabs: (tabs: HTMLElement | null) =>
        setSlots((last) => (last.tabs === tabs ? last : { ...last, tabs })),
      views: (views: HTMLElement | null) =>
        setSlots((last) => (last.views === views ? last : { ...last, views })),
    }),
    [],
  );
  const { findFirstFocusable, findLastFocusable } = useFocusFinders();
  // a window smaller than the design size shrinks the whole view like a picture instead of laying it out
  // again: the content is laid out at least that big and scaled down to fit
  const windowSize = useSceneSize(root);
  const fit = fitScale(windowSize);
  const fitted: CSSProperties | undefined =
    fit < 1
      ? {
          width: windowSize.width / fit,
          height: windowSize.height / fit,
          transform: `scale(${fit})`,
          transformOrigin: '0 0',
        }
      : undefined;
  const shown = controlsVisible || controlsFocused;

  const stage = useEntryStages(useViewMotion(root, current));
  useEffect(() => {
    const element = root.current;
    if (!element || !current) return;
    return attachImmersiveRoot(element);
  }, [current]);

  // a tap on the cover (Lyrics) moves on to the next view
  useEffect(() => {
    if (!current) return;
    return handleViewCycle(() => cycleNext(store));
  }, [current, store]);

  // clear glass: the window turns to glass while the view is up (the rest of the app keeps Mica), and the main
  // window underneath is hidden
  useEffect(() => {
    if (!current) return;
    const html = document.documentElement;
    html.dataset.immersive = '';
    setImmersiveUp(store, true);
    return () => {
      delete html.dataset.immersive;
      setImmersiveUp(store, false);
    };
  }, [current, store]);

  // Tab 回绕的哨兵：焦点从层里的键退到哨兵上（Tab 走过了头）就绕到另一头的键；从根元素进来就落在近的这一头
  // 层里一颗能拿焦点的键都没有时回到根元素
  const guard = (edge: 'start' | 'end') => (event: FocusEvent<HTMLSpanElement>) => {
    const box = content.current;
    const from = event.relatedTarget;
    const overran = from instanceof Node && box !== null && box.contains(from);
    const first = edge === 'start' ? !overran : overran;
    const target = first ? findFirstFocusable(box) : findLastFocusable(box);
    (target ?? root.current)?.focus();
  };

  return (
    <section
      ref={root}
      className={styles.view}
      data-idle={!shown || undefined}
      tabIndex={-1}
      aria-label={t('place.nowPlaying')}
      inert={!current}
      onPointerMove={() => shell?.touch()}
      // a double tap on empty space moves on to the next view (Blueprint → Coverflow → Lyrics)
      onDoubleClick={(event) => {
        // menus and popovers live in portals: their events bubble here through React, not through the DOM
        const inside = event.target instanceof Node && event.currentTarget.contains(event.target);
        if (!current || !inside || !isCycleTarget(event.target)) return;
        window.getSelection()?.removeAllRanges();
        dropPendingCycle();
        if (event.target instanceof Element && event.target.closest(COVERFLOW)) {
          pendingCycle.current = setTimeout(() => {
            pendingCycle.current = null;
            cycleNext(store);
          }, TRIPLE_TAP_WAIT_MS);
          return;
        }
        cycleNext(store);
      }}
      onClick={(event) => {
        // the third tap of a triple tap: Coverflow glides back instead (see Coverflow)
        if (event.detail >= 3) dropPendingCycle();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') shell?.touch();
      }}
    >
      <span className={styles.guard} tabIndex={0} aria-hidden onFocus={guard('start')} />
      <div ref={content} className={styles.content} style={fitted} data-immersive-content>
        <ControlSlotsContext value={slots}>
          <EntryStageContext value={stage}>
            {scene === 'paper' ? <PaperScene /> : <PresetsScene />}
          </EntryStageContext>
          <div className={styles.drag} aria-hidden />
          <ImmersiveControls
            shell={shell}
            shown={shown}
            onFocusWithin={setControlsFocused}
            slotRefs={slotRefs}
          />
          <PerfOverlay />
        </ControlSlotsContext>
      </div>
      <span className={styles.guard} tabIndex={0} aria-hidden onFocus={guard('end')} />
    </section>
  );
}
