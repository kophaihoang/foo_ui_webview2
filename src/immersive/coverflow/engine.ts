import { reanchor } from './anchor.ts';
import {
  ENTRY_DELAY_MS,
  EXIT_MS,
  REDUCED_FADE_MS,
  enteringPose,
  entryEnd,
  entryProgress,
  entryTilt,
  exitFactor,
  fadeInFactor,
} from './entrance.ts';
import { CARRY, glideAt, glideDone, glideVelocity, startGlide, type Glide } from './glide.ts';
import { DIM_SHADE, RENDER_RADIUS, slotAt } from './slots.ts';

/**
 * Coverflow 逐帧动效引擎
 *
 * 核心驱动浏览位置 pos 补间插值，按帧将几何变换（transform）与透明度（opacity）直接写入卡片元素样式，
 * 避免经过 React 重渲染周期；入场阶段两侧卡片依序从屏外滑入，退出阶段执行淡出过渡；
 * 动效降级或视口不可见时直接同步至终态；解耦 DOM 与浏览器依赖，由外部注入元素节点与时钟源
 */

/** 引擎托管卡片元素样式接口契约 */
export interface CardElement {
  readonly style: {
    transform: string;
    opacity: string;
    visibility: string;
    zIndex: string;
    setProperty(name: string, value: string): void;
  };
  readonly dataset: Record<string, string | undefined>;
}

export interface EngineCard {
  readonly key: string;
  /** 条目在全局序列中的索引下标 */
  readonly index: number;
  readonly element: CardElement;
  /** 当前播放曲目标记（退出时即刻隐藏，共享过渡命名已交接） */
  readonly current: boolean;
}

export interface StageGeometry {
  /** 舞台总宽度（像素），用于屏外位移计算 */
  readonly width: number;
  /** 焦点封面边长（像素） */
  readonly cover: number;
  /** 侧封面水平间距的收紧系数，乘在槽位表的偏移上 */
  readonly spread: number;
  readonly perspective: number;
}

export interface EngineClock {
  /** 毫秒，单调 */
  now(): number;
  /** 下一帧叫一次 `callback`，答取消函数 */
  frame(callback: () => void): () => void;
}

export interface CoverflowEngine {
  /** 每次渲染提交后给全部要画的卡；下标会随条目表重排变，所以整张表替换 */
  setCards(cards: readonly EngineCard[]): void;
  setGeometry(geometry: StageGeometry): void;
  /** 窗口看不见时为假：进行中的动效直接到终态，之后的变化也不播 */
  setVisible(visible: boolean): void;
  /** 减弱动效：位置直接跳，进入时只淡入，不飞 */
  setReduced(reduced: boolean): void;
  /** 此刻的浏览位置（第几条，小数） */
  position(): number;
  /** 位置直接放到 `target`，不补间（挂上时用） */
  jumpTo(target: number): void;
  /** 补间到 `target`；补间途中再调，从当时的位置和速度接着走，速度不跳 */
  goTo(target: number): void;
  /** Speed of the position now, items/s */
  velocity(): number;
  /**
   * Fingers on the touchpad: the position is put right at `pos` and follows them, no glide. The speed is
   * measured from the moves. A `goTo` meanwhile only changes where the browse lands
   */
  follow(pos: number): void;
  /** The fingers are off: glide from where they left to `target`, carrying their speed */
  release(target: number): void;
  /** The card under the pointer: it lifts toward the viewer, once the covers stand still */
  hover(key: string | null): void;
  /** 条目表重排：先按键把位置接到新表上（卡留在原地），再补间到 `target` */
  rekey(previous: readonly string[], next: readonly string[], target: number): void;
  /** 进入：选中项 `center` 不飞，其余登记着的卡从左到右依次飞入；减弱动效时在槽位上淡入 */
  enter(center: number): void;
  /**
   * A new song: the side covers on the given sides fold back behind the playing cover, then fan out again
   * as on entering. A side left out keeps its cards where they are (they glide as usual)
   */
  regather(center: number, sides: GatherSides): void;
  /** 退出：整排淡出，正在播放那张当帧藏起 */
  leave(): void;
  /** 立刻按此刻的状态写一遍 */
  paint(): void;
  dispose(): void;
}

export interface GatherSides {
  readonly left: boolean;
  readonly right: boolean;
}

export interface EngineOptions {
  /** 位置补间走完时叫，用来把渲染的范围收回到选中项两侧 */
  readonly onSettle?: () => void;
}

interface Intro {
  readonly start: number;
  readonly fade: boolean;
  readonly duration: number;
  readonly ranks: ReadonlyMap<string, number>;
}

/** 点亮系数朝目标走的时间常数，毫秒：约 70 ms 走过 63%、210 ms 走过 95%。比相邻两次按键的间隔长，快速滚动时来不及亮 */
const LIT_TAU_MS = 70;
/** Folding the side covers back behind the playing one, ms */
const GATHER_MS = 220;
/** After a fold the fan-out starts this soon, ms (entering waits for the shared cover glide instead) */
const REGATHER_DELAY_MS = 40;
const LIT_EPSILON = 0.005;
/**
 * While gliding the covers lean into the motion, sink back and spread apart, by speed (items/s). The speed
 * goes through two smoothing stages first, so the covers ease into and out of it and never snap when a
 * new step changes the glide
 */
const MOTION_TAU_MS = 55;
const MOTION_EPSILON = 0.01;
const LEAN_DEG_PER_SPEED = 6;
const LEAN_MAX_DEG = 28;
const SINK_PER_SPEED = 0.04;
const SINK_MAX = 0.18;
const STRETCH_PER_SPEED = 0.035;
const STRETCH_MAX = 0.18;
/**
 * Depth of field: covers past the first side slot blur by this many px per slot, at most `BLUR_MAX_PX`.
 * It moves in steps of `BLUR_STEP_PX` and is written only when the step changes: a blur that changes every
 * frame is costly
 */
const BLUR_PER_SLOT_PX = 1.5;
const BLUR_MAX_PX = 3;
const BLUR_STEP_PX = 0.5;
/** Fingers resting on the touchpad: their measured speed fades with this time constant, ms */
const HELD_SPEED_TAU_MS = 60;
const HELD_MIN_DT_MS = 4;
/**
 * Touchpad events don't come in step with the frames (one or two per frame), so the covers ease after the
 * fingers with this time constant, ms: smooth, and too short to feel behind
 */
const HELD_EASE_MS = 24;
/** Hover: the card grows, rises, turns this share of its angle toward the viewer and brightens */
const HOVER_TAU_MS = 80;
const HOVER_GROW = 0.05;
const HOVER_RISE = 0.025;
const HOVER_TURN = 0.35;
const HOVER_BRIGHTEN = 0.6;
/** Above this smoothed speed (items/s) nothing lifts: the cover under a still pointer keeps changing */
const HOVER_STILL_SPEED = 0.3;

export function createCoverflowEngine(
  clock: EngineClock,
  options: EngineOptions = {},
): CoverflowEngine {
  let cards: readonly EngineCard[] = [];
  let geometry: StageGeometry = { width: 0, cover: 0, spread: 1, perspective: 0 };
  let visible = true;
  let reduced = false;
  let rest = 0;
  let glide: Glide | null = null;
  let intro: Intro | null = null;
  let outro: { readonly start: number } | null = null;
  let gather: {
    readonly start: number;
    readonly center: number;
    readonly sides: GatherSides;
  } | null = null;
  const onSide = (index: number, center: number, sides: GatherSides) =>
    index < center ? sides.left : index > center ? sides.right : false;
  let cancel: (() => void) | null = null;
  // 每张卡的点亮系数，0 到 1：只有浏览的落点那一张（序号等于 `rest`）朝 1 走，别的朝 0 走。
  // 没有点亮的封面经过中间位置也保持压暗，滚动时一张张掠过不会一闪一闪地变亮，只有确定的落点才亮起来
  const lit = new Map<string, number>();
  let lastPaint = Number.NEGATIVE_INFINITY;
  // the glide speed, smoothed twice: `motion` is what the covers show
  let motionLag = 0;
  let motion = 0;

  // 退场开始后位置定在原地：淡出就是原地淡出，不跟着选中项（关模式时选中会回到正在播放那一首）再滚
  let frozenAt: number | null = null;
  /** Fingers on the touchpad, see `follow` */
  let held: { pos: number; velocity: number; time: number; shown: number } | null = null;
  let hovered: string | null = null;
  // each card's hover lift, 0 to 1, eased like `lit`
  const lifted = new Map<string, number>();
  const liftGoal = (card: EngineCard) =>
    card.key === hovered && !glide && !held && Math.abs(motion) < HOVER_STILL_SPEED ? 1 : 0;
  const positionAt = (now: number) => frozenAt ?? held?.pos ?? (glide ? glideAt(glide, now) : rest);
  // fingers that stopped moving bring the speed down, even with no event to tell
  const velocityAt = (now: number) =>
    held
      ? held.velocity * Math.exp(-(now - held.time) / HELD_SPEED_TAU_MS)
      : glide
        ? glideVelocity(glide, now)
        : 0;
  const litGoal = (card: EngineCard) => (card.index === rest ? 1 : 0);

  function animating(now: number): boolean {
    return (
      (glide !== null && !glideDone(glide, now)) ||
      (frozenAt === null && held !== null) ||
      gather !== null ||
      (frozenAt === null && motion !== 0) ||
      (intro !== null && now - intro.start < intro.duration) ||
      (outro !== null && now - outro.start < EXIT_MS) ||
      (frozenAt === null &&
        cards.some(
          (card) =>
            (lit.get(card.key) ?? litGoal(card)) !== litGoal(card) ||
            (lifted.get(card.key) ?? 0) !== liftGoal(card),
        ))
    );
  }

  function write(
    card: EngineCard,
    d: number,
    now: number,
    brightness: number,
    speed: number,
    lift: number,
  ): void {
    const slot = slotAt(d);
    const lean = Math.max(-LEAN_MAX_DEG, Math.min(LEAN_MAX_DEG, -speed * LEAN_DEG_PER_SPEED));
    const sink = 1 - Math.min(SINK_MAX, Math.abs(speed) * SINK_PER_SPEED);
    const stretch = 1 + Math.min(STRETCH_MAX, Math.abs(speed) * STRETCH_PER_SPEED);
    // 间距在入场插值之前收紧，飞入的终点才是收紧后的槽位
    let pose = {
      ...slot,
      offset: slot.offset * geometry.spread * stretch,
      tilt: slot.tilt * (1 - HOVER_TURN * lift) + lean,
      size: slot.size * sink * (1 + HOVER_GROW * lift),
    };
    let factor = 1;
    if (gather && !card.current && onSide(card.index, gather.center, gather.sides)) {
      const t = Math.min(1, (now - gather.start) / GATHER_MS);
      const folded = t * t;
      pose = { ...pose, offset: pose.offset * (1 - folded), tilt: pose.tilt * (1 - folded) };
      factor *= 1 - folded;
    }
    const rank = intro?.ranks.get(card.key);
    if (intro && rank !== undefined) {
      const elapsed = now - intro.start;
      if (intro.fade) factor = fadeInFactor(elapsed);
      else {
        // the side cards slide out from behind the playing cover, nearest first
        const progress = entryProgress(rank, elapsed);
        pose = enteringPose(pose, progress, 0, entryTilt(rank, elapsed));
        factor = Math.min(1, progress * 1.6);
      }
    }
    if (outro) factor *= card.current ? 0 : exitFactor(now - outro.start);
    const opacity = pose.opacity * factor;
    const { style } = card.element;
    const flat = Math.abs(pose.tilt) < 1e-3;
    // 不倾斜时不写透视：视图过渡认的是二维变换，进出模式时正在播放那张封面是平的
    style.transform =
      `translateX(${pose.offset * geometry.cover}px) ` +
      (lift > 0.001 ? `translateY(${-HOVER_RISE * lift * geometry.cover}px) ` : '') +
      (flat ? '' : `perspective(${geometry.perspective}px) rotateY(${pose.tilt}deg) `) +
      `scale(${pose.size})`;
    style.opacity = String(opacity);
    style.visibility = opacity > 0.001 ? 'visible' : 'hidden';
    style.zIndex = String(Math.round((RENDER_RADIUS - Math.min(Math.abs(d), RENDER_RADIUS)) * 10));
    // 没点亮的至少压到 DIM_SHADE，点亮的照槽位的暗层（正中是 0）；两者之间随点亮系数过渡
    const dim = Math.max(pose.shade, DIM_SHADE);
    const shade = (dim + (pose.shade - dim) * brightness) * (1 - HOVER_BRIGHTEN * lift);
    style.setProperty('--shade', String(shade));
    style.setProperty('--center', String(Math.max(0, 1 - Math.abs(d))));
    card.element.dataset.side = d < 0 ? 'left' : 'right';
    const blur =
      Math.round(
        Math.min(BLUR_MAX_PX, Math.max(0, Math.abs(d) - 1) * BLUR_PER_SLOT_PX) / BLUR_STEP_PX,
      ) * BLUR_STEP_PX;
    const { dataset } = card.element;
    if ((dataset.blur ?? '0') !== String(blur)) {
      if (blur > 0) {
        style.setProperty('--blur', `${blur}px`);
        dataset.blur = String(blur);
      } else {
        delete dataset.blur;
      }
    }
  }

  function paintAt(now: number): void {
    const velocity = frozenAt !== null ? 0 : velocityAt(now);
    const dt = Number.isFinite(lastPaint) ? Math.min(100, Math.max(0, now - lastPaint)) : 0;
    lastPaint = now;
    if (held && frozenAt === null) {
      const ease = reduced || !visible ? 1 : 1 - Math.exp(-dt / HELD_EASE_MS);
      held.shown += (held.pos - held.shown) * ease;
    }
    const pos = held && frozenAt === null ? held.shown : positionAt(now);
    // frozen while leaving, like the position
    const follow =
      frozenAt !== null ? 0 : reduced || !visible ? 1 : 1 - Math.exp(-dt / MOTION_TAU_MS);
    motionLag += (velocity - motionLag) * follow;
    motion += (motionLag - motion) * follow;
    if (
      velocity === 0 &&
      Math.abs(motionLag) < MOTION_EPSILON &&
      Math.abs(motion) < MOTION_EPSILON
    ) {
      motionLag = 0;
      motion = 0;
    }
    // 减弱动效与窗口看不见时不过渡，直接到位；退场期间遮罩定住不变
    const rate = frozenAt !== null ? 0 : reduced || !visible ? 1 : 1 - Math.exp(-dt / LIT_TAU_MS);
    const liftRate =
      frozenAt !== null ? 0 : reduced || !visible ? 1 : 1 - Math.exp(-dt / HOVER_TAU_MS);
    for (const card of cards) {
      const goal = litGoal(card);
      const before = lit.get(card.key);
      // 新挂上的卡直接在目标上，免得进入时整排先暗后亮；离目标不到千分之五就落在目标上，停帧时遮罩是干净的
      const stepped = before === undefined ? goal : before + (goal - before) * rate;
      const next = Math.abs(goal - stepped) < LIT_EPSILON ? goal : stepped;
      lit.set(card.key, next);
      const goalLift = liftGoal(card);
      const steppedLift = (lifted.get(card.key) ?? 0) * (1 - liftRate) + goalLift * liftRate;
      const lift = Math.abs(goalLift - steppedLift) < LIT_EPSILON ? goalLift : steppedLift;
      if (lift === 0) lifted.delete(card.key);
      else lifted.set(card.key, lift);
      write(card, card.index - pos, now, next, motion, lift);
    }
  }

  function settle(now: number): void {
    if (glide && glideDone(glide, now)) {
      glide = null;
      options.onSettle?.();
    }
    if (intro && now - intro.start >= intro.duration) intro = null;
  }

  function schedule(): void {
    if (cancel) return;
    cancel = clock.frame(() => {
      cancel = null;
      const now = clock.now();
      paintAt(now);
      if (gather && now - gather.start >= GATHER_MS) {
        const { center, sides } = gather;
        gather = null;
        startIntro(center, now - (ENTRY_DELAY_MS - REGATHER_DELAY_MS), sides);
      }
      if (animating(now)) schedule();
      else settle(now);
    });
  }

  function startIntro(
    center: number,
    start: number,
    sides: GatherSides = { left: true, right: true },
  ): void {
    const ranks = new Map<string, number>();
    for (const card of cards) {
      if (onSide(card.index, center, sides)) {
        ranks.set(card.key, Math.abs(card.index - center) - 1);
      }
    }
    intro = {
      start,
      fade: reduced,
      duration: reduced ? REDUCED_FADE_MS : entryEnd(ranks.size),
      ranks,
    };
  }

  /**
   * `velocity` 是此刻带着的速度：条目表重排时是同一段运动的延续，先记下来整个传过来；缺省是用户又操作了一下，
   * 只保留补间途中当前速度的一部分（`CARRY`），免得松手后惯性太大
   */
  function goTo(target: number, velocity?: number): void {
    if (frozenAt !== null) return;
    if (held) {
      rest = target;
      return;
    }
    // already on its way there (a release picks the song after starting the glide)
    if (velocity === undefined && glide?.to === target) return;
    const now = clock.now();
    if (!visible || reduced) {
      glide = null;
      rest = target;
      options.onSettle?.();
      return;
    }
    const from = positionAt(now);
    const carried = velocity ?? velocityAt(now) * CARRY;
    rest = target;
    if (from === target) {
      glide = null;
      options.onSettle?.();
      return;
    }
    glide = startGlide(from, target, now, carried);
    schedule();
  }

  return {
    goTo: (target) => goTo(target),
    velocity: () => velocityAt(clock.now()),
    follow(pos) {
      if (frozenAt !== null) return;
      const now = clock.now();
      const before = held ?? { pos: positionAt(now), velocity: velocityAt(now), time: now };
      const dt = now - before.time;
      // events come about every 8 ms; ones closer than that are merged into the next measure
      if (held && dt < HELD_MIN_DT_MS) {
        held = { ...held, pos };
      } else {
        const measured = dt > 0 ? ((pos - before.pos) / dt) * 1000 : before.velocity;
        held = {
          pos,
          velocity: before.velocity * 0.5 + measured * 0.5,
          time: now,
          shown: held?.shown ?? before.pos,
        };
      }
      glide = null;
      schedule();
    },
    release(target) {
      if (!held || frozenAt !== null) return;
      const now = clock.now();
      const from = held.shown;
      const velocity = velocityAt(now);
      held = null;
      rest = target;
      if (!visible || reduced || from === target) {
        glide = null;
        options.onSettle?.();
        paintAt(now);
        return;
      }
      glide = startGlide(from, target, now, velocity);
      schedule();
    },
    hover(key) {
      if (key === hovered) return;
      hovered = key;
      schedule();
    },
    jumpTo(target) {
      glide = null;
      held = null;
      rest = target;
    },
    setCards(next) {
      cards = next;
      const keys = new Set(next.map((card) => card.key));
      for (const key of lit.keys()) if (!keys.has(key)) lit.delete(key);
      for (const key of lifted.keys()) if (!keys.has(key)) lifted.delete(key);
    },
    setGeometry(next) {
      geometry = next;
    },
    setVisible(next) {
      visible = next;
      if (visible) return;
      // 看不见时没有人在看动效：位置、入场、退场都落到终态
      glide = null;
      intro = null;
      gather = null;
      if (outro) outro = { start: Number.NEGATIVE_INFINITY };
      cancel?.();
      cancel = null;
    },
    setReduced(next) {
      reduced = next;
    },
    position: () => positionAt(clock.now()),
    rekey(previous, next, target) {
      if (frozenAt !== null) return;
      const now = clock.now();
      const velocity = velocityAt(now);
      if (held) {
        // the fingers carry on from the same cover in the new list
        held = {
          ...held,
          pos: reanchor(previous, held.pos, next, target),
          shown: reanchor(previous, held.shown, next, target),
        };
        rest = target;
        return;
      }
      rest = reanchor(previous, positionAt(now), next, target);
      glide = null;
      goTo(target, velocity);
    },
    enter(center) {
      if (!visible) return;
      startIntro(center, clock.now());
      schedule();
    },
    regather(center, sides) {
      if (!visible || reduced || frozenAt !== null || (!sides.left && !sides.right)) return;
      intro = null;
      gather = { start: clock.now(), center, sides };
      schedule();
    },
    leave() {
      // 补间还在走也停在此刻的位置
      frozenAt = positionAt(clock.now());
      glide = null;
      outro = { start: visible ? clock.now() : Number.NEGATIVE_INFINITY };
      if (visible) schedule();
    },
    paint() {
      const now = clock.now();
      paintAt(now);
      // 动效还没放完而帧被取消过（卸载后重新挂上）时接着放
      if (animating(now)) schedule();
    },
    dispose() {
      cancel?.();
      cancel = null;
    },
  };
}
