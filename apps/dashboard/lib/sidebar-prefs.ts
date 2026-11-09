/**
 * Sidebar open and closed state per user (docs/PRODUCT.md section 7), kept in localStorage for a fast first paint.
 * Storage can be missing or throw (private mode, blocked site data), so every access is guarded and the sidebar
 * falls back to the defaults from section 3.
 */
import type { NavSection, SectionId } from "./nav";

export type SidebarPrefs = {
  /** Only sections the user toggled; the rest follow their defaults, so new defaults still reach old users. */
  sections: Partial<Record<SectionId, boolean>>;
  /** The collapsed icon rail; null follows the screen width (rail between 1024 and 1280 px). */
  rail: boolean | null;
};

export const EMPTY_PREFS: SidebarPrefs = { sections: {}, rail: null };

const SECTION_IDS: readonly SectionId[] = ["payments", "agents", "platform", "records", "developers"];

export function prefsKey(userId: string | null | undefined): string {
  return `payminto.sidebar.${userId || "anon"}`;
}

/** Parses whatever is stored, dropping anything unexpected rather than trusting it. */
export function parsePrefs(raw: string | null | undefined): SidebarPrefs {
  if (!raw) return { ...EMPTY_PREFS, sections: {} };
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return { ...EMPTY_PREFS, sections: {} };
    const o = v as { sections?: unknown; rail?: unknown };
    const sections: SidebarPrefs["sections"] = {};
    if (o.sections && typeof o.sections === "object") {
      for (const id of SECTION_IDS) {
        const s = (o.sections as Record<string, unknown>)[id];
        if (typeof s === "boolean") sections[id] = s;
      }
    }
    return { sections, rail: typeof o.rail === "boolean" ? o.rail : null };
  } catch {
    return { ...EMPTY_PREFS, sections: {} };
  }
}

export function loadPrefs(userId: string | null | undefined, storage: Pick<Storage, "getItem"> | null = safeStorage()): SidebarPrefs {
  try {
    return parsePrefs(storage?.getItem(prefsKey(userId)) ?? null);
  } catch {
    return { ...EMPTY_PREFS, sections: {} };
  }
}

export function savePrefs(userId: string | null | undefined, prefs: SidebarPrefs, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(prefsKey(userId), JSON.stringify(prefs));
  } catch {
    // Quota or blocked storage: the choice lasts for this page only.
  }
}

export function clearPrefs(userId: string | null | undefined, storage: Pick<Storage, "removeItem"> | null = safeStorage()): void {
  try {
    storage?.removeItem(prefsKey(userId));
  } catch {
    // Nothing stored, or storage blocked.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Whether a section is open: the section holding the current page always is, then the user's own choice, then the
 * default for the role.
 */
export function isSectionOpen(section: Pick<NavSection, "id" | "defaultOpen">, prefs: SidebarPrefs, activeSection: SectionId | null): boolean {
  if (section.id === activeSection) return true;
  return prefs.sections[section.id] ?? section.defaultOpen;
}

export function toggleSection(prefs: SidebarPrefs, section: Pick<NavSection, "id" | "defaultOpen">, currentlyOpen: boolean): SidebarPrefs {
  const next = !currentlyOpen;
  const sections = { ...prefs.sections };
  // Back at the default, forget the override so later default changes apply.
  if (next === section.defaultOpen) delete sections[section.id];
  else sections[section.id] = next;
  return { ...prefs, sections };
}
