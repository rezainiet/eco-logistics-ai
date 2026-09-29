import { isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * Test helper: walk the React element tree returned by a hook-free
 * component (called as a plain function) and collect elements matching a
 * predicate. Only walks `props.children` — it does not render nested
 * components — which is exactly what's needed to find a button by its
 * accessible name and invoke its `onClick` without a DOM.
 */
export function findElements(
  node: ReactNode,
  match: (el: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  const visit = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (!isValidElement(n)) return;
    const el = n as ReactElement<Record<string, unknown>>;
    if (match(el)) out.push(el);
    visit(el.props.children as ReactNode);
  };
  visit(node);
  return out;
}

export function byAriaLabel(label: string) {
  return (el: ReactElement<Record<string, unknown>>) => el.props["aria-label"] === label;
}
