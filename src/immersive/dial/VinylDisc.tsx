import styles from './VinylDisc.module.css';

export interface VinylDiscProps {
  /** Centre of the disc, in the layer's coordinates */
  readonly x: number;
  readonly y: number;
  /** Diameter */
  readonly size: number;
}

/**
 * A vinyl record drawn in CSS: grooves, a few track gaps, a soft light sheen and a rim. The cover sits on it
 * as the round label (`DialCover` with `round`) and is what visibly turns; the grooves are symmetric, so the
 * disc itself needs no motion. It grows in from behind the label when Blueprint opens.
 */
export function VinylDisc({ x, y, size }: VinylDiscProps) {
  return (
    <div
      className={styles.disc}
      style={{ left: x - size / 2, top: y - size / 2, width: size, height: size }}
      aria-hidden
    >
      <span className={styles.sheen} />
    </div>
  );
}
