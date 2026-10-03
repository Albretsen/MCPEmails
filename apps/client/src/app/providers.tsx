import { QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect } from "react";
import { queryClient, startQueryPersistence, startRealtime } from "../data";
import { getPlatform } from "../platform";
import { RouteEffects, initRouting, openDeepLink } from "./route-sync";

/** App-wide providers and the once-per-page side effects: cache persistence,
 *  server events, URL restoration, the service worker and deep links. */
export function Providers({ children }: { children: ReactNode }) {
  useEffect(() => {
    const stopRouting = initRouting();
    const stopPersist = startQueryPersistence();
    const stopRealtime = startRealtime();
    const platform = getPlatform();
    // Production only (the adapter checks): push needs the service worker.
    void platform.registerBackground();
    // A notification click asks the running app to open a path or approve a send.
    const stopLinks = platform.deepLinks.onOpen(openDeepLink);
    return () => {
      stopRouting();
      stopPersist();
      stopRealtime();
      stopLinks();
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <RouteEffects />
      {children}
    </QueryClientProvider>
  );
}
