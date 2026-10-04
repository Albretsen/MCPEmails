import { QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect } from "react";
import { IS_MOCK_BACKEND } from "../api";
import { queryClient, startQueryPersistence, startRealtime } from "../data";
import { getPlatform } from "../platform";
import { getPushController, startSync, syncNow } from "./backend";
import { handleForegroundPush } from "./push";
import { RouteEffects, initRouting, openDeepLink } from "./route-sync";
import { useSelectionStore } from "../state/selection-store";
import { showToast } from "../state/toast-store";
import { isRoleRef } from "../api/types";

/** App-wide providers and the once-per-page side effects: cache persistence,
 *  server events, URL restoration, the service worker and deep links. */
export function Providers({ children }: { children: ReactNode }) {
  useEffect(() => {
    const stopRouting = initRouting();
    const stopPersist = startQueryPersistence();
    const stopRealtime = startRealtime();
    // HTTP: there is no server push. The sync engine polls `status` and
    // publishes what changed through the channel startRealtime listens on.
    const stopSync = IS_MOCK_BACKEND ? null : startSync();
    const platform = getPlatform();
    // Production only (the adapter checks): push needs the service worker.
    void platform.registerBackground();
    // A notification click asks the running app to open a path or approve a send.
    // It also looks for what the notification was about, at once, instead of
    // waiting for the next poll.
    const stopLinks = platform.deepLinks.onOpen((link) => {
      openDeepLink(link);
      syncNow();
    });
    // A push that arrived while this window was visible: the service worker
    // showed nothing and handed it over (public/sw.js).
    const stopPush = platform.notifications.onPush((payload) =>
      handleForegroundPush(payload, {
        syncNow,
        resync: () => void getPushController()?.sync({ force: true }),
        isShowingInbox: (inboxId) => {
          const { scope, folder, query } = useSelectionStore.getState();
          return !query && isRoleRef(folder) && folder.role === "inbox" && (scope === "all" || scope === inboxId);
        },
        toast: showToast,
        open: (url) => openDeepLink({ url, action: null }),
      }),
    );
    return () => {
      stopRouting();
      stopPersist();
      stopRealtime();
      stopSync?.();
      stopLinks();
      stopPush();
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <RouteEffects />
      {children}
    </QueryClientProvider>
  );
}
