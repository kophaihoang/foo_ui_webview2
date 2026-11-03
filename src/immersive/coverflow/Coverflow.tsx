import { useAtomValueRawSync, useStore } from 'jotai/react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type WheelEvent,
} from 'react';
import { translateAtom } from '../../i18n/locale.ts';
import { useService } from '../../kit/useService.ts';
import { reducedMotionAtom } from '../../motion/reducedMotion.ts';
import { useCommand } from '../../nav/useCommand.ts';
import { playbackKey } from '../../playback/playbackContract.ts';
import { pathOf } from '../../playback/queue/queueMenu.ts';
import type { RowPoint } from '../../playback/queue/QueueRow.tsx';
import { queueKey } from '../../playback/queue/queueServices.ts';
import { upEarlierAtom, upNextAtom } from '../../playback/queue/upNext.ts';
import { activeShufflePlan } from '../scene/shufflePlan.ts';
import { rewindTo } from '../scene/planRewind.ts';
import { createWheelStepper } from '../../playback/volume/wheelSteps.ts';
import { coverflowItemsAtom } from '../scene/coverflowAtoms.ts';
import { currentIndexOf, selectedIndexOf } from '../scene/coverflowItems.ts';
import { SCENE_COVER_LAYER } from '../scene/coverHolders.ts';
import { sceneStateAtom } from '../scene/sceneActions.ts';
import { useSceneActions, useSceneFrame } from '../scene/sceneContext.ts';
import { useCoverHolder } from '../scene/useCoverHolder.ts';
import styles from './Coverflow.module.css';
import { canDrop, canSink, dropSong, sinkSong } from './dropUpcoming.ts';
import { CoverflowCard, coverRequestSizes } from './CoverflowCard.tsx';
import { CoverflowMenu } from './CoverflowMenu.tsx';
import { createCoverflowEngine, type EngineCard, type EngineClock } from './engine.ts';
import { menuTargetOf, type CoverflowMenuTarget } from './menuTarget.ts';
import { playPlanOf, type PlayPlan } from './playPlan.ts';
import { RENDER_RADIUS, coverflowLayout, inViewRange, visibleIndexes } from './slots.ts';

/** 无交互自动回位至当前播放曲目的超时时间（毫秒） */
const IDLE_MS = 10_000;
/** A dragged card this close to the bottom edge (share of the height, at least the minimum) sinks */
const SINK_EDGE_SHARE = 0.12;
const SINK_EDGE_MIN = 64;
/** 前向预读深度增量；除两侧基础视界外，为补间动画预留额外缓冲卡片 */
const EARLIER_AHEAD = RENDER_RADIUS * 2;
/** Touchpad: swipe this many px to move one cover */
const SWIPE_PX = 100;
/** No swipe event for this long: the fingers (and the touchpad's own coasting) are done, ms */
const SWIPE_END_MS = 90;
/** On release the covers settle on the song this far ahead along the swipe speed, s */
const SWIPE_AHEAD_S = 0.12;
/** Past either end the covers stretch like a rubber band, at most this many covers */
const RUBBER_MAX = 0.5;
const WHEEL_LINE_PX = 100 / 3;

/**
 * A mouse wheel moves in whole lines of 100/3 px (or that times the screen scale) and never sideways;
 * anything else is a touchpad. A touchpad taken for a mouse only falls back to stepping a song at a time
 */
function fromTouchpad(event: WheelEvent): boolean {
  if (event.deltaMode !== 0) return false;
  if (event.deltaX !== 0) return true;
  const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  const whole = (px: number) => {
    const lines = Math.abs(px) / WHEEL_LINE_PX;
    return lines >= 0.99 && Math.abs(lines - Math.round(lines)) < 0.02;
  };
  return !whole(event.deltaY) && !whole(event.deltaY / ratio);
}

const browserClock: EngineClock = {
  now: () => performance.now(),
  frame(callback) {
    const handle = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(handle);
  },
};

export interface CoverflowProps {
  /** 模式退出退场状态；退场期间释放共享封面标识与按键捕获，当前曲目即刻隐藏，其余卡片在 167 ms 内淡出 */
  readonly leaving?: boolean;
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

/**
 * Coverflow 封面流交互容器
 *
 * 以当前焦点项为视心中轴，两侧卡片按槽位规格递减缩放、渐隐与偏转；左侧为历史已播序列，右侧为队列与接下来曲目；
 * 支持方向键、滚轮与点击卡片切换焦点；Enter 或点击视心卡片触发播放（若处于当前播放曲目则切换播放/暂停）；
 * 闲置 3 秒自动回位至正在播放曲目，Esc 优先回位、再次触发退出模式；动效调度解耦于独立引擎
 */
export function Coverflow({ leaving = false }: CoverflowProps) {
  const t = useAtomValueRawSync(translateAtom);
  const store = useStore();
  const frame = useSceneFrame();
  const reduced = useAtomValueRawSync(reducedMotionAtom);
  const items = useAtomValueRawSync(coverflowItemsAtom);
  const { browsed } = useAtomValueRawSync(sceneStateAtom);
  const sceneActions = useSceneActions();
  const queue = useService(queueKey);
  const playback = useService(playbackKey);
  const holder = useCoverHolder(SCENE_COVER_LAYER);
  const baseId = useId();
  const root = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const settle = useRef<() => void>(() => {});
  const [engine] = useState(() =>
    createCoverflowEngine(browserClock, { onSettle: () => settle.current() }),
  );
  const [stepper] = useState(createWheelStepper);
  const [menu, setMenu] = useState<CoverflowMenuTarget | null>(null);
  const selected = selectedIndexOf(items, browsed);
  const layout = coverflowLayout(frame);
  const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  const sizes = coverRequestSizes(layout.cover, ratio);
  // 选中项与当前播放曲目重合或键已失效时视为默认状态，Esc 无需二次回位
  const currentAt = currentIndexOf(items);
  // 仅当当前播放曲目位于视口时赋予共享封面标识，以便退出时执行位置飞移；若已移出视口则释放标识，退出时走淡入淡出过渡
  const nameInView = currentAt >= 0 && inViewRange(currentAt - selected);
  useEffect(() => {
    if (browsed !== null && selected === currentAt) sceneActions.browse(null);
  }, [browsed, selected, currentAt, sceneActions]);
  // 沿列表顺序浏览历史曲目时，按浏览深度动态向前预读缓存数据
  const earlier = useAtomValueRawSync(upEarlierAtom);
  const depth = Math.max(0, currentAt - selected);
  useEffect(() => {
    if (earlier.total <= 0) return;
    const wanted = depth + EARLIER_AHEAD;
    void queue.upNext.readEarlier(Math.max(0, earlier.total - wanted), earlier.total - 1);
  }, [queue, earlier.total, earlier.version, earlier.refreshing, depth]);
  // show the songs coming up on the right too: read the next page of the playing list ahead of the browse depth
  const upNext = useAtomValueRawSync(upNextAtom);
  const ahead = Math.max(0, selected - currentAt);
  useEffect(() => {
    if (upNext.total <= 0 || upNext.refreshing) return;
    const last = Math.min(upNext.total - 1, ahead + EARLIER_AHEAD);
    void queue.upNext.readRange(0, last);
  }, [queue, upNext.total, upNext.version, upNext.refreshing, ahead]);
  // 补间过渡期间的可见渲染跨度（首尾两端可见窗口并集）
  const [span, setSpan] = useState({ from: selected, to: selected });
  const indexes = visibleIndexes(span.from, span.to, items.length);

  const attach = useCallback((key: string, element: HTMLElement | null) => {
    if (element) elements.current.set(key, element);
    else elements.current.delete(key);
  }, []);

  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const touch = () => {
    clearTimeout(idleTimer.current);
    if (store.get(sceneStateAtom).browsed === null) return;
    idleTimer.current = setTimeout(() => sceneActions.browse(null), IDLE_MS);
  };
  useEffect(() => () => clearTimeout(idleTimer.current), []);
  useEffect(() => {
    if (browsed === null) clearTimeout(idleTimer.current);
  }, [browsed]);

  const selectedNow = () =>
    selectedIndexOf(store.get(coverflowItemsAtom), store.get(sceneStateAtom).browsed);
  const selectIndex = (index: number) => {
    const list = store.get(coverflowItemsAtom);
    const item = list[Math.min(list.length - 1, Math.max(0, index))];
    if (!item) return;
    // 选中当前播放曲目时清除显式浏览状态，保持与默认视心一致
    sceneActions.browse(item.kind === 'current' ? null : item.key);
    touch();
  };
  const step = (delta: number) => selectIndex(selectedNow() + delta);

  // ── touchpad: the covers follow the fingers, then glide on and settle on a song ──
  const swipeEnd = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(swipeEnd.current), []);
  const swipe = (px: number) => {
    const last = store.get(coverflowItemsAtom).length - 1;
    if (last < 0 || px === 0) return;
    const pos = engine.position();
    const over = pos < 0 ? -pos : pos > last ? pos - last : 0;
    const outward = (pos <= 0 && px < 0) || (pos >= last && px > 0);
    const give = outward ? Math.max(0, 0.4 * (1 - over / RUBBER_MAX)) : 1;
    const next = pos + (px / SWIPE_PX) * give;
    engine.follow(next);
    const at = Math.min(last, Math.max(0, Math.round(next)));
    if (at !== selectedNow()) selectIndex(at);
    clearTimeout(swipeEnd.current);
    swipeEnd.current = setTimeout(() => {
      const end = store.get(coverflowItemsAtom).length - 1;
      const ahead = engine.position() + engine.velocity() * SWIPE_AHEAD_S;
      const target = Math.min(end, Math.max(0, Math.round(ahead)));
      engine.release(target);
      if (target !== selectedNow()) selectIndex(target);
    }, SWIPE_END_MS);
  };

  const perform = (plan: PlayPlan): Promise<boolean> => {
    if (plan.kind === 'handle') return queue.commands.playHandle(plan.handle);
    if (plan.kind === 'queue') return queue.actions.playNow(plan.entry);
    if (plan.kind === 'planned')
      return activeShufflePlan()?.playAt(plan.position) ?? Promise.resolve(false);
    const { list, refreshing } = store.get(plan.source === 'earlier' ? upEarlierAtom : upNextAtom);
    if (refreshing || list?.guid !== plan.guid) return Promise.resolve(false);
    return queue.commands.playFrom(plan.guid, plan.row, plan.handle);
  };
  /** 播放当前选中项；toggle 控制当前焦点与播放曲目重合时是否切换暂停状态 */
  const play = async (toggle: boolean) => {
    const item = store.get(coverflowItemsAtom)[selectedNow()];
    if (!item) return;
    if (item.kind === 'current') {
      if (toggle && item.track) void playback.playOrPause();
      return;
    }
    const plan = playPlanOf(item);
    // which side the song comes from is known only now: by the time playback reports the new song the
    // shuffle plan may already have moved its cursor, so the old card order no longer tells
    const items = store.get(coverflowItemsAtom);
    picked.current = selectedNow() > currentIndexOf(items) ? 'right' : 'left';
    // a played card with the shuffle plan running: the plan steps back to it, so what comes after it is
    // again what the coverflow shows
    if (item.kind === 'played' && (await rewindTo(store, item))) return;
    // 起播成功后暂存选中状态，避免数据表尚未响应切歌前视心回弹至旧曲目位置；待数据表更新且该曲目转为当前曲目后，由联动副作用重置浏览状态；起播失败时保留选中位置
    if (plan) await perform(plan);
  };
  const activate = (key: string) => {
    // the click that ends a drag is not a tap on the card
    if (justDragged.current) return;
    const at = store.get(coverflowItemsAtom).findIndex((item) => item.key === key);
    if (at < 0) return;
    if (at === selectedNow()) void play(true);
    else selectIndex(at);
  };
  // 右键呼出上下文菜单时不改变当前焦点选中项
  const openMenu = (key: string, at: RowPoint) => {
    const list = store.get(coverflowItemsAtom);
    const item = list.find((entry) => entry.key === key);
    const track = item?.track;
    if (leaving || !item || !track) return;
    const plan = playPlanOf(item);
    const target = menuTargetOf(item, list, at, () => {
      if (plan) void perform(plan);
      else void queue.commands.playHandle(track.handle);
    });
    if (!target) return;
    setMenu(target);
    void queue.menu.prepare([pathOf(track)]);
  };

  const inside = () => root.current?.contains(document.activeElement) ?? false;
  const listening = () => !leaving && inside();
  useCommand({
    id: 'immersive.coverflow.previous',
    layer: 'widget',
    keys: [{ key: 'ArrowLeft' }],
    enabled: listening,
    run: () => step(-1),
  });
  useCommand({
    id: 'immersive.coverflow.next',
    layer: 'widget',
    keys: [{ key: 'ArrowRight' }],
    enabled: listening,
    run: () => step(1),
  });
  useCommand({
    id: 'immersive.coverflow.play',
    layer: 'widget',
    keys: [{ key: 'Enter' }],
    enabled: listening,
    run: () => void play(false),
  });
  useCommand({
    id: 'immersive.coverflow.menu',
    layer: 'widget',
    keys: [{ key: 'ContextMenu' }, { key: 'F10', shift: true }],
    enabled: listening,
    run: () => {
      const item = store.get(coverflowItemsAtom)[selectedNow()];
      const box = item && elements.current.get(item.key)?.getBoundingClientRect();
      if (item && box) openMenu(item.key, { x: box.left + box.width / 2, y: box.bottom });
    },
  });
  // 注册于 gesture 命令层，优先级高于外壳 overlay 退出层
  useCommand({
    id: 'immersive.coverflow.reset',
    layer: 'gesture',
    keys: [{ key: 'Escape' }],
    enabled: () => !leaving && store.get(sceneStateAtom).browsed !== null,
    run: () => sceneActions.browse(null),
  });

  // 每次渲染提交将最新卡片映射与舞台规格同步至底层动效引擎
  useLayoutEffect(() => {
    const cards: EngineCard[] = [];
    for (const index of indexes) {
      const item = items[index];
      const element = item && elements.current.get(item.key);
      if (item && element) {
        cards.push({ key: item.key, index, element, current: item.kind === 'current' });
      }
    }
    engine.setCards(cards);
    engine.setGeometry({
      width: frame.width,
      cover: layout.cover,
      spread: layout.spread,
      perspective: layout.perspective,
    });
    engine.setVisible(frame.visible);
    engine.setReduced(reduced);
  });
  // 焦点或条目序列变更时触发补间位移
  const prior = useRef<{
    keys: readonly string[];
    selected: number;
    playing: string | null;
    /** where the playing song sat in `keys` */
    current: number;
  } | null>(null);
  /** A song was just started from a card here; its arrival is handled as following playback */
  const picked = useRef<'left' | 'right' | null>(null);
  useLayoutEffect(() => {
    settle.current = () => setSpan({ from: selected, to: selected });
    const keys = items.map((item) => item.key);
    const before = prior.current;
    const playing = items[currentAt]?.track?.handle ?? null;
    prior.current = { keys, selected, playing, current: currentAt };
    // 退场期间保持视心位置固定，避免关闭模式时因重置为当前曲目而产生滚动
    if (leaving && before) return;
    if (!before) {
      engine.jumpTo(selected);
      if (!leaving) engine.enter(selected);
    } else if (before.playing !== playing && (selected === currentAt || picked.current !== null)) {
      // a new song while following playback (or one just picked here). Only a side whose songs changed
      // folds back behind the playing cover and fans out again:
      //  - the next song, or one picked on the right: the songs ahead only slide over, so they glide; the
      //    side behind gains the song that just played, so it folds and fans out
      //  - a song picked on the left (played before): both sides change, both fold
      // not picked here: a song that ran on by itself (the next one, from the right), or "previous" pressed
      // anywhere in the view (the card that was left of the playing one)
      const was = before.keys.indexOf(items[currentAt]?.key ?? '');
      const side = picked.current ?? (was >= 0 && was < before.current ? 'left' : 'right');
      const fromRight = side === 'right';
      picked.current = null;
      if (browsed !== null) sceneActions.browse(null);
      prior.current = { keys, selected: currentAt, playing, current: currentAt };
      if (fromRight) {
        engine.rekey(before.keys, keys, currentAt);
        engine.regather(currentAt, { left: true, right: false });
        setSpan({ from: engine.position(), to: currentAt });
      } else {
        engine.jumpTo(currentAt);
        engine.regather(currentAt, { left: true, right: true });
        setSpan({ from: currentAt, to: currentAt });
      }
    } else if (!sameKeys(before.keys, keys)) {
      engine.rekey(before.keys, keys, selected);
      setSpan({ from: engine.position(), to: selected });
    } else if (before.selected !== selected) {
      const from = engine.position();
      // 继承当前动量滑向目标；长距回位（如超时重置）保持恒定过渡时长
      engine.goTo(selected);
      setSpan({ from, to: selected });
    }
  }, [engine, items, selected, leaving, currentAt, browsed, sceneActions]);
  // 提交后重绘以避免新挂载卡片首帧位置闪烁
  useLayoutEffect(() => {
    engine.paint();
  });
  useLayoutEffect(() => {
    if (!leaving) return;
    engine.leave();
    engine.paint();
  }, [leaving, engine]);
  useEffect(() => () => engine.dispose(), [engine]);
  // 进入模式后将焦点转移至舞台容器以拦截方向键
  useLayoutEffect(() => root.current?.focus({ preventScroll: true }), []);

  // ── pick up a song: press (or double-tap and hold on a touchpad) a card and drag it to a new spot ──
  interface DragView {
    readonly key: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly grabX: number;
    readonly grabY: number;
    readonly src: string | null;
    readonly bar: { readonly x: number; readonly top: number; readonly height: number } | null;
    /** over the bottom edge: dropping it sinks the song to the end */
    readonly sink: boolean;
  }
  const [drag, setDrag] = useState<DragView | null>(null);
  const press = useRef<{
    key: string;
    x: number;
    y: number;
    id: number;
    element: HTMLElement;
  } | null>(null);
  const dragging = useRef<{
    key: string;
    gap: number | null;
    sink: boolean;
    x: number;
    y: number;
  } | null>(null);
  const justDragged = useRef(false);
  const edge = useRef(0);

  const keyOfElement = (element: Element): string | null => {
    for (const [key, card] of elements.current) if (card === element) return key;
    return null;
  };
  /** The gap the pointer is over, on either side of the playing song, and where to draw the marker */
  const gapAt = (x: number, skip: string): Pick<DragView, 'bar'> & { gap: number | null } => {
    const box = root.current?.getBoundingClientRect();
    const list = store.get(coverflowItemsAtom);
    const at = currentIndexOf(list);
    const cards: { index: number; rect: DOMRect }[] = [];
    list.forEach((item, index) => {
      const element = elements.current.get(item.key);
      if (element && item.key !== skip)
        cards.push({ index, rect: element.getBoundingClientRect() });
    });
    cards.sort((a, b) => a.index - b.index);
    const centerOf = (rect: DOMRect) => rect.left + rect.width / 2;
    const after = cards.find((card) => x < centerOf(card.rect));
    const gap = after ? after.index : list.length;
    const dragged = list.find((item) => item.key === skip);
    if (!box || at < 0 || !dragged || !canDrop(store, list, dragged, gap))
      return { gap: null, bar: null };
    const before = [...cards].reverse().find((card) => card.index < gap);
    const playing = elements.current.get(list[at]?.key ?? '')?.getBoundingClientRect();
    const barX =
      after && before
        ? (centerOf(after.rect) + centerOf(before.rect)) / 2
        : after
          ? after.rect.left
          : before
            ? before.rect.right + 12
            : x;
    const top = playing ? playing.top : box.top + box.height * 0.25;
    const height = playing ? playing.height : box.height * 0.5;
    return { gap, bar: { x: barX - box.left, top: top - box.top, height } };
  };
  const moveDrag = (x: number, y: number) => {
    const state = dragging.current;
    const box = root.current?.getBoundingClientRect();
    if (!state || !box) return;
    state.x = x;
    state.y = y;
    // dragged off the bottom of the screen: the song sinks to the end
    const item = store.get(coverflowItemsAtom).find((entry) => entry.key === state.key);
    const sink =
      y > box.bottom - Math.max(SINK_EDGE_MIN, box.height * SINK_EDGE_SHARE) &&
      item !== undefined &&
      canSink(store, item);
    const { gap, bar } = sink ? { gap: null, bar: null } : gapAt(x, state.key);
    state.gap = gap;
    state.sink = sink;
    edge.current = sink ? 0 : x > box.right - 80 ? 1 : x < box.left + 80 ? -1 : 0;
    setDrag((view) => (view ? { ...view, x: x - box.left, y: y - box.top, bar, sink } : view));
  };
  const endDrag = (drop: boolean) => {
    const state = dragging.current;
    press.current = null;
    if (!state) return;
    dragging.current = null;
    edge.current = 0;
    const element = elements.current.get(state.key);
    if (element) delete element.dataset.dragging;
    setDrag(null);
    justDragged.current = true;
    setTimeout(() => (justDragged.current = false), 0);
    const list = store.get(coverflowItemsAtom);
    const item = list.find((entry) => entry.key === state.key);
    if (drop && item && state.sink) void sinkSong(store, item);
    else if (drop && item && state.gap !== null) void dropSong(store, list, item, state.gap);
  };
  // near an edge the covers scroll on by themselves, so a song can travel far
  useEffect(() => {
    if (!drag) return;
    const timer = setInterval(() => {
      const state = dragging.current;
      if (!state || edge.current === 0) return;
      step(edge.current);
      requestAnimationFrame(() => moveDrag(state.x, state.y));
    }, 320);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);

  // keep sideways swipes for the covers: stop the browser from treating them as back/forward gestures
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const hold = (event: globalThis.WheelEvent) => {
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) event.preventDefault();
    };
    element.addEventListener('wheel', hold, { passive: false });
    return () => element.removeEventListener('wheel', hold);
  }, []);

  // random order: ask the shuffle plan to deal and read far enough ahead of where the coverflow is
  useEffect(() => {
    activeShufflePlan()?.ensure(ahead + EARLIER_AHEAD);
  }, [ahead]);
  const onEmpty = (target: EventTarget) =>
    !(target instanceof Element && target.closest(`.${styles.card}`));

  const style: CSSProperties & Record<`--${string}`, string> = {
    '--cf-cover': `${layout.cover}px`,
    '--cf-top': `${layout.top}px`,
  };
  return (
    <>
      <div
        ref={root}
        className={styles.root}
        style={style}
        role="listbox"
        tabIndex={0}
        aria-label={t('immersive.coverflow')}
        aria-activedescendant={`${baseId}-${selected}`}
        data-scene-element="coverflow"
        data-key-pass
        // empty space: a triple tap glides back to the playing song (a double tap switches view, see ImmersiveView)
        onClick={(event) => {
          if (event.detail === 3 && !justDragged.current && onEmpty(event.target))
            sceneActions.browse(null);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || leaving) return;
          const card =
            event.target instanceof Element ? event.target.closest(`.${styles.card}`) : null;
          const key = card ? keyOfElement(card) : null;
          if (!card || !key) return;
          press.current = {
            key,
            x: event.clientX,
            y: event.clientY,
            id: event.pointerId,
            element: card as HTMLElement,
          };
        }}
        onPointerMove={(event) => {
          const pressed = press.current;
          if (!pressed || pressed.id !== event.pointerId) return;
          if (dragging.current) {
            moveDrag(event.clientX, event.clientY);
            return;
          }
          if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < 8) return;
          const item = store.get(coverflowItemsAtom).find((entry) => entry.key === pressed.key);
          const box = root.current?.getBoundingClientRect();
          if (!item || item.kind === 'current' || !box) {
            press.current = null;
            return;
          }
          root.current?.setPointerCapture(event.pointerId);
          const rect = pressed.element.getBoundingClientRect();
          pressed.element.dataset.dragging = '';
          dragging.current = {
            key: pressed.key,
            gap: null,
            sink: false,
            x: event.clientX,
            y: event.clientY,
          };
          setDrag({
            key: pressed.key,
            x: event.clientX - box.left,
            y: event.clientY - box.top,
            width: rect.width,
            height: rect.height,
            grabX: pressed.x - rect.left,
            grabY: pressed.y - rect.top,
            src: pressed.element.querySelector('img')?.src ?? null,
            bar: null,
            sink: false,
          });
          moveDrag(event.clientX, event.clientY);
        }}
        onPointerUp={() => endDrag(true)}
        onPointerCancel={() => endDrag(false)}
        onLostPointerCapture={() => {
          if (dragging.current) endDrag(true);
        }}
        onWheel={(event: WheelEvent) => {
          // two-finger swipe on a touchpad: sideways swipes move the covers too (right = next)
          const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
          if (fromTouchpad(event)) {
            swipe(sideways ? event.deltaX : event.deltaY);
            return;
          }
          const steps = stepper({
            deltaY: sideways ? event.deltaX : event.deltaY,
            deltaMode: event.deltaMode,
            timeStamp: event.timeStamp,
          });
          if (steps !== 0) step(-steps);
        }}
      >
        {indexes.map((index) => {
          const item = items[index];
          if (!item) return null;
          return (
            <CoverflowCard
              key={item.key}
              item={item}
              id={`${baseId}-${index}`}
              selected={index === selected}
              sizes={sizes}
              distant={Math.abs(index - selected) > 1}
              attach={attach}
              holder={item.kind === 'current' && !leaving && nameInView ? holder : undefined}
              onActivate={activate}
              onMenu={openMenu}
            />
          );
        })}
        {drag?.bar && (
          <span
            className={styles.dropBar}
            style={{ left: drag.bar.x, top: drag.bar.top, height: drag.bar.height }}
            aria-hidden
          />
        )}
        {drag && (
          <div
            className={styles.ghost}
            data-sink={drag.sink || undefined}
            style={{
              left: drag.x - drag.grabX,
              top: drag.y - drag.grabY,
              width: drag.width,
              height: drag.height,
            }}
            aria-hidden
          >
            {drag.src && <img src={drag.src} alt="" draggable={false} />}
          </div>
        )}
      </div>
      {/* 脱离列表容器渲染，阻断菜单内部点击与滚轮事件冒泡至封面流 */}
      {menu && <CoverflowMenu target={menu} onClose={() => setMenu(null)} />}
    </>
  );
}
