import { MIcon } from '../MarketingPrimitives';
import RichText from './RichText';

/**
 * Closed-by-default cards for the long, secondary copy on the /connect/<provider>
 * and /docs/<client> pages: the gotchas, the limits and the auth detail.
 *
 * Shown open, that copy was most of the page's words and buried the setup
 * steps. Folded, the reader scans the headings and opens the one that applies;
 * the text is still in the HTML for search. Native <details>, so this stays a
 * server component.
 */
export function ConnectFold({ icon, color, title, children }) {
  return (
    <details className="connect-fold">
      <summary>
        <MIcon name={icon} size={17} color={color} />
        <h3>{title}</h3>
      </summary>
      <div className="connect-fold-body">{children}</div>
    </details>
  );
}

/** The gotchas, then the limits as one more fold. */
export default function ConnectFolds({ gotchas = [], limitsTitle, limits = [] }) {
  return (
    <div className="connect-folds">
      {gotchas.map((g, i) => (
        <ConnectFold key={i} icon="alert-triangle" color="var(--amber-700)" title={g.h}>
          <p><RichText>{g.p}</RichText></p>
        </ConnectFold>
      ))}
      {limits.length > 0 && (
        <ConnectFold icon="server" color="var(--fg-3)" title={limitsTitle}>
          <ul>
            {limits.map((l, i) => (
              <li key={i}><RichText>{l}</RichText></li>
            ))}
          </ul>
        </ConnectFold>
      )}
    </div>
  );
}
