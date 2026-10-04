import { FlaskConical } from "lucide-react";
import { Suspense, lazy } from "react";
import { IS_MOCK_BACKEND } from "../api";
import { selectIsPhone, useUiStore } from "../state/ui-store";
import s from "./Scenes.module.css";

/** Scenes drive the mock mailbox, so they only exist in mock mode: in dev
 *  builds, or anywhere with `?scenes` in the URL. */
export const SCENES_ENABLED: boolean =
  IS_MOCK_BACKEND &&
  (import.meta.env.DEV || (typeof location !== "undefined" && new URLSearchParams(location.search).has("scenes")));

const ScenesMenu = lazy(() => import("./ScenesMenu"));

/** Mount point for the dev tools. Renders nothing (and loads nothing) unless enabled. */
export function DevTools() {
  const phone = useUiStore(selectIsPhone);
  const wanted = useUiStore((u) => u.menu === "scenes");
  if (!SCENES_ENABLED) return null;
  return (
    <>
      {/* The sidebar has the flask button on desktop; phones have no sidebar. */}
      {phone ? (
        <button type="button" className={s.fab} aria-label="Prototype scenes" onClick={() => useUiStore.getState().toggleMenu("scenes")}>
          <FlaskConical size={13} aria-hidden="true" />
        </button>
      ) : null}
      {wanted ? (
        <Suspense fallback={null}>
          <ScenesMenu />
        </Suspense>
      ) : null}
    </>
  );
}
