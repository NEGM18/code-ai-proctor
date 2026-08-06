// =============================================================================
// Link — the component half of the minimal router (see lib/route.js for
// usePathname/navigate). Split out for the same reason: a file exporting both
// a component and plain functions breaks React Fast Refresh.
// =============================================================================

import { useCallback } from 'react';

import { navigate } from './route.js';

/**
 * In-app link. Falls through to a normal browser navigation for anything that
 * isn't a plain left-click (new tab, download-as, browser extensions that
 * inspect real <a> elements) — it only intercepts the common case.
 *
 * @param {object} props
 * @param {string} props.to
 * @param {string} [props.className]
 * @param {import('react').ReactNode} props.children
 */
export function Link({ to, className, children, ...rest }) {
  const handleClick = useCallback(
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      navigate(to);
      window.scrollTo(0, 0);
    },
    [to],
  );

  return (
    <a href={to} className={className} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
