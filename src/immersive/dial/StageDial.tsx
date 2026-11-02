import { useAtomValueRawSync } from 'jotai/react';
import type { CSSProperties } from 'react';
import { currentTrackAtom } from '../../playback/playback.ts';
import { MISSING, formatTagDate, formatTrackPosition } from '../paper/paperScale.ts';
import { STAGE_TRANSPORT } from '../paper/paperStage.ts';
import { trackExtrasAtom } from '../fields/trackExtras.ts';
import { DialCover } from './DialCover.tsx';
import { VinylDisc } from './VinylDisc.tsx';
import { STAGE_RECORD } from './recordGeometry.ts';
import { PaperTransport } from './PaperTransport.tsx';
import styles from './StageDial.module.css';

const RECORD = STAGE_RECORD;
const LABEL_BOX: CSSProperties = {
  left: RECORD.x - RECORD.label / 2,
  top: RECORD.y - RECORD.label / 2,
  width: RECORD.label,
  height: RECORD.label,
};

const [FIRST_KEY, , LAST_KEY] = STAGE_TRANSPORT.centers;
const TRANSPORT_SIZE = {
  side: STAGE_TRANSPORT.side,
  play: STAGE_TRANSPORT.play,
  width: LAST_KEY - FIRST_KEY + STAGE_TRANSPORT.side,
};
const TRANSPORT_BOX: CSSProperties = {
  left: FIRST_KEY - STAGE_TRANSPORT.side / 2,
  top: STAGE_TRANSPORT.y - STAGE_TRANSPORT.play / 2,
};

const CELL_KEY_CLASS = `${styles.base} ${styles['cell-key']}`;
const CELL_VALUE_CLASS = `${styles.base} ${styles['cell-value']}`;
const MISSING_VALUE_CLASS = `${CELL_VALUE_CLASS} ${styles.missing}`;

/**
 * full 档舞台的左区：三圈实线环、转动层（`PaperOrbit`，压在实线环之上、刻度字与封面之下）、刻度字、
 * 封面上方的专辑名、封面与四角括号、封面下三格
 * （Date · Track · Label）与传输三键。本身是舞台原点上的零尺寸定位锚，各件按舞台坐标绝对定位；
 * 字按基线落位（字盒底边裁到字母基线，`top` 写基线）
 *
 * 封面（`DialCover`）与背景的封面底色共用同一份状态。封面、封面下三格与传输键标了
 * `data-decor-guard`，生成式网格不在它们周围放装饰；传输键压在歌词卡之上
 */
export function StageDial() {
  const track = useAtomValueRawSync(currentTrackAtom);
  const extras = useAtomValueRawSync(trackExtrasAtom);
  const cells = [
    { id: 'date', key: 'Date', value: formatTagDate(track?.date) },
    {
      id: 'track',
      key: 'Track',
      value: formatTrackPosition({
        trackNumber: track?.trackNumber,
        discNumber: track?.discNumber,
        totalTracks: extras.totalTracks,
        totalDiscs: extras.totalDiscs,
      }),
    },
    { id: 'label', key: 'Label', value: extras.label || MISSING },
  ];
  return (
    <div className={styles.dial}>
      <VinylDisc x={RECORD.x} y={RECORD.y} size={RECORD.size} />
      <div className={`${styles.base} ${styles.album}`} data-field="dialAlbum">
        {track?.album ?? ''}
      </div>
      <DialCover box={LABEL_BOX} guard={72} round />
      <dl className={styles.cells} data-decor-guard="24">
        {cells.map((cell) => (
          <div key={cell.id} className={styles.cell}>
            <dt className={CELL_KEY_CLASS}>{cell.key}</dt>
            <dd
              className={cell.value === MISSING ? MISSING_VALUE_CLASS : CELL_VALUE_CLASS}
              data-field={cell.id}
            >
              {cell.value}
            </dd>
          </div>
        ))}
      </dl>
      <PaperTransport
        className={styles.transport}
        size={TRANSPORT_SIZE}
        guard={60}
        style={TRANSPORT_BOX}
      />
    </div>
  );
}
