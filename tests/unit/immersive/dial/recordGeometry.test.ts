import { describe, expect, it } from 'vitest';
import {
  NARROW_COVER,
  SHEET_LABEL,
  STAGE_RECORD,
  paperCoverBox,
} from '../../../../src/immersive/dial/recordGeometry.ts';
import { paperGeometry } from '../../../../src/immersive/paper/paperTiers.ts';

// where the cover flight into Blueprint lands: the label as StageDial / PaperDial place it

describe('paperCoverBox', () => {
  it('full tier: the record label on the scaled stage', () => {
    const { tier, origin, scale } = paperGeometry(1280, 800);
    expect(tier).toBe('full');
    const box = paperCoverBox(1280, 800);
    expect(box.round).toBe(true);
    expect(box.size).toBeCloseTo(STAGE_RECORD.label * scale, 6);
    expect(box.left).toBeCloseTo(origin.x + (STAGE_RECORD.x - STAGE_RECORD.label / 2) * scale, 6);
    expect(box.top).toBeCloseTo(origin.y + (STAGE_RECORD.y - STAGE_RECORD.label / 2) * scale, 6);
  });

  it('a tier with a dial: the label centred on the dial, sized by its scale', () => {
    for (const [width, height] of [
      [1100, 700],
      [800, 1200],
    ] as const) {
      const geometry = paperGeometry(width, height);
      if (geometry.tier === 'full' || !geometry.dial) continue;
      const box = paperCoverBox(width, height);
      const label = SHEET_LABEL * geometry.dial.scale;
      expect(box.round).toBe(true);
      expect(box.size).toBeCloseTo(label, 6);
      expect(box.left + box.size / 2).toBeCloseTo(geometry.origin.x + geometry.dial.x, 6);
      expect(box.top + box.size / 2).toBeCloseTo(geometry.origin.y + geometry.dial.y, 6);
    }
  });

  it('narrow tier: the square cover at the top of the column', () => {
    for (let width = 400; width <= 1400; width += 20) {
      const geometry = paperGeometry(width, 500);
      if (geometry.dial) continue;
      const box = paperCoverBox(width, 500);
      expect(box.round).toBe(false);
      expect(box.size).toBe(NARROW_COVER.size);
      expect(box.left).toBe(geometry.origin.x + geometry.fields.x);
      return;
    }
  });
});
