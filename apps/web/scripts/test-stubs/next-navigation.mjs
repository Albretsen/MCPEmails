// `next/navigation` outside a Next request.
//
// The real module reads React contexts that only Next's app router provides, so
// importing it under `node --test` throws before any component renders. These
// are the four members the dashboard tree actually touches, with the shapes the
// callers depend on: a router whose methods record nothing, and empty search
// params. A test that needs a route or a query parameter should pass it as a
// prop rather than teaching this stub to lie in a new way.
export function useRouter() {
  return {
    push: () => {},
    replace: () => {},
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  };
}

export function useSearchParams() {
  return new URLSearchParams();
}

export function usePathname() {
  return '/dashboard';
}

export function useParams() {
  return {};
}

export function useSelectedLayoutSegment() {
  return null;
}

export function useSelectedLayoutSegments() {
  return [];
}

export function useServerInsertedHTML() {
  return null;
}

// next-intl's `createNavigation` re-exports these by name, so they have to
// exist as bindings even though no test path calls one.
export function redirect() {
  throw new Error('redirect() is not available under node --test');
}

export function permanentRedirect() {
  throw new Error('permanentRedirect() is not available under node --test');
}

export function notFound() {
  throw new Error('notFound() is not available under node --test');
}

export function forbidden() {
  throw new Error('forbidden() is not available under node --test');
}

export function unauthorized() {
  throw new Error('unauthorized() is not available under node --test');
}

export const ReadonlyURLSearchParams = URLSearchParams;

export class RedirectType {}
