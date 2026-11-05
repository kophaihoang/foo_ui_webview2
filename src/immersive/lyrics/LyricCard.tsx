import { useService } from '../../kit/useService.ts';
import { lyricsDisplayKey, lyricsFontFamily } from '../../lyrics/lyricsDisplay.ts';
import { useAtomValueRawSync } from 'jotai/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { translateAtom } from '../../i18n/locale.ts';
import { lyricCardAtom, lyricLogAtom, LYRIC_STATUS_MESSAGES } from './lyricLog.ts';
import { LYRIC_FONT, LYRIC_TEXT_WIDTH } from '../paper/paperStage.ts';
import { fittedFontSize } from '../fields/titleScroll.ts';
import styles from './LyricCard.module.css';

const MAIN_FIT = { max: LYRIC_FONT.main, min: LYRIC_FONT.minMain, step: 1 };
const SUB_FIT = { max: LYRIC_FONT.sub, min: LYRIC_FONT.minSub, step: 1 };

/**
 * 字号在布局副作用里量：按原字号排、量出超宽的行按比例降字号，画出来的第一帧就是量好的样子
 */
interface CardFit {
  /** 量的是哪一份内容；内容一变重量 */
  key: string;
  done: boolean;
  main: number;
  sub: number;
}

const freshFit = (key: string, sub: number): CardFit => ({
  key,
  done: false,
  main: LYRIC_FONT.main,
  sub,
});

/**
 * full 档舞台底部的歌词卡。主行是当前行（热色）；副行有译文放译文，没有放下一句（颜色更弱）；
 * 首行之前与无词时卡不出，无时间轴时一行卡只写「纯文本 · n 行」
 *
 * The card lines up under the gauge pad, same left edge and width, so it reads as the pad's last row.
 * Text wider than `LYRIC_TEXT_WIDTH` scales its font down (main to 20, sub to 16), then is cut with an ellipsis
 */
export function LyricCard() {
  const t = useAtomValueRawSync(translateAtom);
  const displayService = useService(lyricsDisplayKey);
  const display = useAtomValueRawSync(displayService.display);
  const { state, source, lineCount } = useAtomValueRawSync(lyricLogAtom);
  const card = useAtomValueRawSync(lyricCardAtom);
  const synced = state === 'synced' ? card : null;
  const notice =
    state !== 'synced' && state !== 'none'
      ? state === 'plain'
        ? t('immersive.lyricsPlain', { n: lineCount })
        : t(LYRIC_STATUS_MESSAGES[state])
      : '';
  const shown = Boolean(notice) || synced !== null;
  const twoLine = Boolean(synced?.sub);

  const mainRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const subSize =
    synced?.subKind === 'translation'
      ? (display.translationFontSize ?? LYRIC_FONT.sub)
      : LYRIC_FONT.sub;
  const key = JSON.stringify([
    state,
    card?.main ?? null,
    card?.sub ?? null,
    lineCount,
    subSize,
    display.fontFamily,
  ]);
  const [fit, setFit] = useState<CardFit>(() => freshFit(key, subSize));
  if (fit.key !== key) setFit(freshFit(key, subSize));

  useLayoutEffect(() => {
    if (fit.done) return;
    const main = mainRef.current;
    const sub = subRef.current;
    const mainSize = main ? fittedFontSize(LYRIC_TEXT_WIDTH, main.scrollWidth, MAIN_FIT) : fit.main;
    const fittedSub = sub
      ? fittedFontSize(LYRIC_TEXT_WIDTH, sub.scrollWidth, {
          ...SUB_FIT,
          max: subSize,
          min: Math.min(subSize, SUB_FIT.min),
        })
      : fit.sub;
    setFit({ ...fit, done: true, main: mainSize, sub: fittedSub });
  }, [fit, subSize]);

  if (!shown) return null;
  return (
    <div className={styles.card} data-two-line={twoLine || undefined} data-field="lyric-card">
      {synced ? (
        <>
          <div
            ref={mainRef}
            className={`${styles.text} ${styles.main}`}
            style={{ fontSize: `${fit.main}px`, fontFamily: lyricsFontFamily(display.fontFamily) }}
            data-field="lyric-main"
          >
            {synced.main}
          </div>
          {synced.sub ? (
            <div
              ref={subRef}
              className={`${styles.text} ${styles.sub}`}
              data-kind={synced.subKind}
              style={{ fontSize: `${fit.sub}px`, fontFamily: lyricsFontFamily(display.fontFamily) }}
              data-field="lyric-sub"
            >
              {synced.sub}
            </div>
          ) : null}
          <span className={`${styles.text} ${styles.source}`} data-field="lyrics-source">
            {`${source} · synced`}
          </span>
        </>
      ) : (
        <div
          className={`${styles.text} ${styles.plain}`}
          data-field={state === 'plain' ? 'lyrics-plain' : 'lyrics-status'}
          role="status"
        >
          {notice}
        </div>
      )}
    </div>
  );
}
