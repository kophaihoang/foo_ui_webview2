import { STAGE_COVER } from '../paper/paperStage.ts';
import { paperGeometry, type DialPlacement } from '../paper/paperTiers.ts';

/**
 * Where Blueprint's record and its cover sit. The record components and the cover flight into Blueprint
 * (`page/coverFlight.ts`) both read these, so the flight lands exactly on the label.
 */

/** The record on the stage (stage coordinates): centred where the cover was, sized to clear the album name and the cells */
export const STAGE_RECORD = {
  x: STAGE_COVER.x + STAGE_COVER.size / 2,
  y: STAGE_COVER.y + STAGE_COVER.size / 2 + 4,
  size: 540,
  label: 320,
} as const;

/** The record in the dial of the smaller tiers, at the original size: disc diameter and label (cover) diameter */
export const SHEET_VINYL = 384;
export const SHEET_LABEL = 224;

/** The narrow tier has no dial: a square cover at the top of the single column */
export const NARROW_COVER = { size: 160, top: 24 } as const;

/** The record of a tier with a dial, in sheet coordinates */
export function sheetRecord(dial: DialPlacement): {
  x: number;
  y: number;
  size: number;
  label: number;
} {
  return { x: dial.x, y: dial.y, size: SHEET_VINYL * dial.scale, label: SHEET_LABEL * dial.scale };
}

export interface CoverBox {
  readonly left: number;
  readonly top: number;
  readonly size: number;
  /** The round label of the record; false for the narrow tier's square cover */
  readonly round: boolean;
}

/** Where the cover sits in a Blueprint scene of `width` × `height`, relative to the scene's top left corner */
export function paperCoverBox(width: number, height: number): CoverBox {
  const geometry = paperGeometry(width, height);
  const { origin, scale } = geometry;
  if (geometry.tier === 'full') {
    return {
      left: origin.x + (STAGE_RECORD.x - STAGE_RECORD.label / 2) * scale,
      top: origin.y + (STAGE_RECORD.y - STAGE_RECORD.label / 2) * scale,
      size: STAGE_RECORD.label * scale,
      round: true,
    };
  }
  if (geometry.dial) {
    const record = sheetRecord(geometry.dial);
    return {
      left: origin.x + record.x - record.label / 2,
      top: origin.y + record.y - record.label / 2,
      size: record.label,
      round: true,
    };
  }
  return {
    left: origin.x + geometry.fields.x,
    top: origin.y + NARROW_COVER.top,
    size: NARROW_COVER.size,
    round: false,
  };
}
