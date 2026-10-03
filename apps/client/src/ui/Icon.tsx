import {
  AlignLeft,
  Archive,
  ArrowDown,
  Clock,
  Eye,
  FilePen,
  Folder,
  FolderInput,
  Inbox,
  type LucideIcon,
  Mail,
  Newspaper,
  Receipt,
  Reply,
  Search,
  Send,
  ShieldAlert,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";

/* Data-driven icons. Components import lucide icons by name directly; this
 * map exists only for names that arrive as DATA (assistant cards, tool calls,
 * folder roles). It is a fixed list so the bundle stays tree-shaken: add a
 * name here when the backend starts sending it. Unknown names fall back to
 * Sparkles. */
const ICONS: Record<string, LucideIcon> = {
  "align-left": AlignLeft,
  archive: Archive,
  "arrow-down": ArrowDown,
  clock: Clock,
  eye: Eye,
  "file-pen": FilePen,
  folder: Folder,
  "folder-input": FolderInput,
  inbox: Inbox,
  mail: Mail,
  newspaper: Newspaper,
  receipt: Receipt,
  reply: Reply,
  search: Search,
  send: Send,
  "shield-alert": ShieldAlert,
  sparkles: Sparkles,
  star: Star,
  "trash-2": Trash2,
};

export interface IconProps {
  /** lucide name in kebab case ("folder-input"). An "icon-" prefix is tolerated. */
  name: string;
  size?: number;
  className?: string;
}

export function Icon({ name, size = 16, className }: IconProps) {
  const Cmp = ICONS[name.replace(/^icon-/, "")] ?? Sparkles;
  return <Cmp size={size} className={className} aria-hidden="true" />;
}

/** The icon for a system folder role. */
export const FOLDER_ROLE_ICON: Record<string, LucideIcon> = {
  inbox: Inbox,
  starred: Star,
  drafts: FilePen,
  scheduled: Clock,
  sent: Send,
  archive: Archive,
  trash: Trash2,
  spam: ShieldAlert,
};
