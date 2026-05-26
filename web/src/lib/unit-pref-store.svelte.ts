/**
 * Per-signal display-unit preferences.
 *
 * Key shape: `messageName::signalName` — message-level scope. Same message
 * name across files is rare in practice; when it happens, the same parameter
 * truly means the same thing, so sharing one preference is correct.
 *
 * Persists to localStorage. Only stores entries where the user picked a unit
 * different from the signal's raw unit; resetting to the raw unit deletes
 * the entry.
 */

import { canConvert, canonicalUnit } from './unit-conversion';

const STORAGE_KEY = 'cancodec_unit_prefs_v1';

function loadFromStorage(): Record<string, string> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveToStorage(prefs: Record<string, string>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch { /* quota exceeded etc. */ }
}

function makeKey(messageName: string, signalName: string): string {
  return `${messageName}::${signalName}`;
}

class UnitPrefStore {
  prefs = $state<Record<string, string>>(loadFromStorage());

  /**
   * Get the user-chosen display unit for a signal, or null if none set.
   * If the stored unit isn't compatible with `rawUnit`, returns null (stale).
   */
  get(messageName: string, signalName: string, rawUnit: string): string | null {
    const stored = this.prefs[makeKey(messageName, signalName)];
    if (!stored) return null;
    if (!rawUnit) return null;
    if (!canConvert(rawUnit, stored)) return null;
    return stored;
  }

  /**
   * Resolve the unit to actually display: user preference if set + compatible,
   * else the raw unit. Always returns a non-empty string when rawUnit is non-empty.
   */
  resolve(messageName: string, signalName: string, rawUnit: string): string {
    return this.get(messageName, signalName, rawUnit) ?? rawUnit;
  }

  /** Set the display unit. If `unit` matches `rawUnit` canonically, clear instead. */
  set(messageName: string, signalName: string, rawUnit: string, unit: string): void {
    const key = makeKey(messageName, signalName);
    const canonical = canonicalUnit(unit);
    if (!rawUnit || canonicalUnit(rawUnit) === canonical) {
      // No conversion needed → don't persist.
      const next = { ...this.prefs };
      delete next[key];
      this.prefs = next;
    } else {
      this.prefs = { ...this.prefs, [key]: canonical };
    }
    saveToStorage(this.prefs);
  }

  clear(messageName: string, signalName: string): void {
    const key = makeKey(messageName, signalName);
    if (!(key in this.prefs)) return;
    const next = { ...this.prefs };
    delete next[key];
    this.prefs = next;
    saveToStorage(this.prefs);
  }
}

export const unitPrefs = new UnitPrefStore();
