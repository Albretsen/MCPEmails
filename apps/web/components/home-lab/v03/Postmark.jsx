import styles from './Home.module.css';
import { INNER_RING, POSTMARK_TILT, WAVE_COUNT } from './rng.mjs';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** "2026-11-11" -> { day: "11 NOV", year: "2026" } */
function stampDate(iso) {
  const [y, m, d] = String(iso || '').split('-');
  if (!y || !m || !d) return { day: '', year: '' };
  return { day: `${Number(d)} ${MONTHS[Number(m) - 1] ?? ''}`, year: y };
}

/**
 * The page's only ornament: a circular postmark in cobalt line work with a
 * date and STOCKHOLM, trailing cancellation waves that act as the section
 * rule. Decorative (aria-hidden); the data-location fact is stated in text in
 * the security chapter.
 */
export default function Postmark({ date, index = 0 }) {
  const { day, year } = stampDate(date);
  const tilt = POSTMARK_TILT[index % POSTMARK_TILT.length];
  const id = `v03pm${index}`;
  const waveGap = 9;
  const waveTop = 24 - ((WAVE_COUNT - 1) * waveGap) / 2;
  return (
    <div className={styles.postmark} aria-hidden="true">
      <svg className={styles.postmarkStamp} viewBox="0 0 132 132" width="132" height="132" focusable="false">
        <defs>
          <path id={`${id}top`} d="M 22 66 A 44 44 0 0 1 110 66" />
          <path id={`${id}bot`} d="M 16 66 A 50 50 0 0 0 116 66" />
        </defs>
        <g transform={`rotate(${tilt} 66 66)`} fill="none" stroke="currentColor">
          <circle cx="66" cy="66" r="62" strokeWidth="1.6" />
          <circle cx="66" cy="66" r="34" strokeWidth="1" strokeDasharray={INNER_RING === 'dashed' ? '3 3' : undefined} />
          <g stroke="none" fill="currentColor">
            <text className={styles.postmarkRing}>
              <textPath href={`#${id}top`} startOffset="50%" textAnchor="middle">STOCKHOLM</textPath>
            </text>
            <text className={styles.postmarkRingSmall}>
              <textPath href={`#${id}bot`} startOffset="50%" textAnchor="middle">MCPEMAILS</textPath>
            </text>
            <text x="66" y="64" textAnchor="middle" className={styles.postmarkDay}>{day}</text>
            <text x="66" y="82" textAnchor="middle" className={styles.postmarkYear}>{year}</text>
          </g>
        </g>
      </svg>
      <svg className={styles.postmarkWaves} width="100%" height="48" focusable="false">
        <defs>
          <pattern id={`${id}w`} width="48" height="48" patternUnits="userSpaceOnUse">
            {Array.from({ length: WAVE_COUNT }, (_, i) => {
              const y = waveTop + i * waveGap;
              return (
                <path
                  key={i}
                  d={`M0 ${y} C 12 ${y - 6}, 12 ${y - 6}, 24 ${y} S 36 ${y + 6}, 48 ${y}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
              );
            })}
          </pattern>
        </defs>
        <rect x="0" y="0" width="100%" height="48" fill={`url(#${id}w)`} />
      </svg>
    </div>
  );
}
