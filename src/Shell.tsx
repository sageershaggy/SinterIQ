import { Sparkles } from 'lucide-react';
import './Shell.css';

/**
 * The workspace's one line of advice. It used to fill a card at the foot of the sidebar; as a
 * quiet line in the header it is still on every project page and costs no navigation space.
 */
export function HeaderQuote() {
  return (
    <p className="header-quote">
      <Sparkles size={14} aria-hidden="true" />
      <span>
        <strong>Good research starts with good context.</strong>
        <span className="header-quote-more">
          {' '}
          Give each project the knowledge it needs to qualify with confidence.
        </span>
      </span>
    </p>
  );
}
