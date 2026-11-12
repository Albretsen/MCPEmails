'use client';

import { useState } from 'react';
import s from './Home.module.css';

/**
 * Before/after comparison with a draggable divider. The divider is a native
 * range input laid over the frame, so it works by pointer, touch and the arrow
 * keys. Without JavaScript the frame still renders, split at the start value.
 */
export default function Compare({ before, after, beforeLabel, afterLabel, rangeLabel, start = 50 }) {
  const [pos, setPos] = useState(start);
  return (
    <div className={s.compare} style={{ '--split': `${pos}%` }}>
      <div className={s.compareLayer}>{before}</div>
      <div className={`${s.compareLayer} ${s.compareAfter}`}>{after}</div>
      <span className={`${s.compareTag} ${s.compareTagBefore}`}>{beforeLabel}</span>
      <span className={`${s.compareTag} ${s.compareTagAfter}`}>{afterLabel}</span>
      <span className={s.compareRule} aria-hidden="true" />
      <input
        className={s.compareRange}
        type="range"
        min="0"
        max="100"
        step="1"
        value={pos}
        aria-label={rangeLabel}
        aria-valuetext={`${pos}%`}
        onChange={(e) => setPos(Number(e.target.value))}
      />
    </div>
  );
}
