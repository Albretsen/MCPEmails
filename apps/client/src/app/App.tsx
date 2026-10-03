import { DevTools } from "../dev";
import { AssistantPane } from "../features/assistant";
import { AssistantOverlays } from "../features/assistant/overlays";
import { ComposePane } from "../features/compose";
import { ListPane } from "../features/list";
import { PaletteHost } from "../features/palette";
import { ReaderPane } from "../features/reader";
import { AppShell } from "../features/shell";
import { SidebarPane } from "../features/sidebar";
import { Providers } from "./providers";

/* The whole app is one screen: the shell lays out four panes and each feature
 * folder fills one slot. The slot elements are created once, here, so the
 * shell can re-render (resize, selection) without re-rendering the panes. */

const sidebar = <SidebarPane />;
const list = <ListPane />;
const reader = <ReaderPane />;
const compose = <ComposePane />;
const assistant = <AssistantPane />;
const overlays = (
  <>
    <AssistantOverlays />
    <PaletteHost />
    <DevTools />
  </>
);

export function App() {
  return (
    <Providers>
      <AppShell sidebar={sidebar} list={list} reader={reader} compose={compose} assistant={assistant} overlays={overlays} />
    </Providers>
  );
}
