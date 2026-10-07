import { Globe, Search } from 'lucide-react';
import { crawlCategoryLabels, type PageRead, type SearchRecord } from '../shared/research';
import { safeHref } from './api';
import './ResearchTrail.css';

/** "kestrel.example.de/about" reads faster than a full URL. */
function pageName(url: string) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/$/, '');
  } catch {
    return url;
  }
}
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
/** The page's own path, since the site is named once above the list. */
const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};
function outcomeOf(search: SearchRecord) {
  if (search.error) return 'the search failed: ' + search.error;
  if (search.verified) return 'verified ' + search.verified;
  if (!search.results.length) return 'no results';
  return (
    search.results.length + (search.results.length === 1 ? ' result' : ' results') + ', none verified'
  );
}

/**
 * Where research looked: the web searches it ran (with the addresses each returned — a profile
 * only by its site, because it cannot be read) and the company pages it read, each with the kind
 * of page it was chosen as. Shown on the lead page and in the Research history log.
 */
export function ResearchTrail({
  searches,
  pages,
}: {
  searches?: SearchRecord[];
  pages?: PageRead[];
}) {
  if (!searches?.length && !pages?.length) return null;
  return (
    <div className="research-trail">
      {!!searches?.length && (
        <div className="research-trail-block">
          <strong>
            <Search size={14} aria-hidden="true" />
            Web {searches.length === 1 ? 'search' : 'searches'}
          </strong>
          <ul>
            {searches.map((search, index) => (
              <li key={index}>
                <span className="research-query">“{search.query}”</span>{' '}
                <span className="research-outcome">— {outcomeOf(search)}</span>
                {search.results.length > 0 && (
                  <details>
                    <summary>What the search returned</summary>
                    <ul className="research-results">
                      {search.results.map((result) => (
                        <li key={result}>{safeHref(result) ? pageName(result) : result}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!pages?.length && (
        // Folded: eight pages are worth a look, not a screenful on every visit.
        <details className="research-trail-block research-pages-block">
          <summary>
            <Globe size={14} aria-hidden="true" />
            {(pages.length === 1 ? 'Page read' : pages.length + ' pages read') +
              (hostOf(pages[0].url) ? ' on ' + hostOf(pages[0].url) : '')}
          </summary>
          <ul className="research-pages">
            {pages.map((item) => {
              const href = safeHref(item.url);
              return (
                <li key={item.url}>
                  <span className="research-page-kind">
                    {crawlCategoryLabels[item.category] || 'Page'}
                  </span>
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer">
                      {pathOf(href)}
                    </a>
                  ) : (
                    <span>{item.url}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}
