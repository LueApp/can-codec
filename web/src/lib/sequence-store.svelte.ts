/**
 * Open-loop SOP runner with a small AST: nested statements that include
 * send / wait / repeat / every / sweep / group. The interpreter walks the
 * tree, dispatching frames via busStore.client.send(). Open-loop: never
 * waits for ack/feedback; failures are recorded but don't pause the run.
 *
 * `every` semantics:
 *   - durationMs unset  ⇒ background. Parent advances immediately; the
 *     periodic task fires until the whole sequence ends or stop() is called.
 *   - durationMs set    ⇒ blocking. Parent advances after the duration
 *     elapses; the periodic task is cancelled when the block ends.
 *
 * `sweep` is a built-in iteration: it sends the same message N times,
 * varying one signal across [from, to] with step `step`, separated by
 * `periodMs`. Re-encodes from signal values at send time (so the active
 * config must define `msgName`).
 *
 * The old flat steps[] format is migrated on load: each step becomes a
 * top-level `send` statement with raw bytes.
 */

import { busStore } from './bus-store.svelte';
import { codecStore } from './codec-store.svelte';

export type SeqStmtType = 'send' | 'wait' | 'repeat' | 'every' | 'sweep' | 'group' | 'set' | 'bind' | 'read';

interface BaseStmt {
  id: string;
  enabled: boolean;
}

/** Send a single CAN frame (re-encoded from signal values, or raw fallback). */
export interface SendStmt extends BaseStmt {
  type: 'send';
  label: string;
  /** Message name from the loaded config. If absent, the `raw` field is used. */
  msgName?: string;
  /** Numeric id, or a string expression (e.g. "=node_counter * 2"). Resolved at send time. */
  nodeId?: number | string;
  sysId?: number | string;
  compId?: number | string;
  isMavlink?: boolean;
  isBroadcast?: boolean;
  /** Signal values; for broadcast this maps node_id → {signal: value}. */
  values?: Record<string, string | number>;
  perNodeValues?: Record<number, Record<string, string | number>>;
  /** Fallback raw frame when no msgName / no config loaded. */
  raw?: { canId: number; data: number[]; isFd: boolean };
}

export interface WaitStmt extends BaseStmt {
  type: 'wait';
  label?: string;
  ms: number;
}

export interface RepeatStmt extends BaseStmt {
  type: 'repeat';
  label?: string;
  count: number;
  body: SeqStatement[];
}

export interface EveryStmt extends BaseStmt {
  type: 'every';
  label?: string;
  periodMs: number;
  initialDelayMs: number;
  /** Optional bound; unset = background, fires until parent body ends. */
  durationMs?: number;
  body: SeqStatement[];
}

export interface SweepStmt extends BaseStmt {
  type: 'sweep';
  label?: string;
  msgName: string;
  signal: string;
  from: number;
  to: number;
  step: number;
  periodMs: number;
  baseValues?: Record<string, string | number>;
  nodeId?: number | string;
  sysId?: number | string;
  compId?: number | string;
  isMavlink?: boolean;
}

export interface GroupStmt extends BaseStmt {
  type: 'group';
  label: string;
  body: SeqStatement[];
}

/** Set a variable. Expression is evaluated at run time against the current vars map.
 * The variable is then visible to all *later* statements (and to send-value strings
 * of the form "=expr"). Variables persist across cell runs and Run All — clear with
 * clearVars(). */
export interface SetStmt extends BaseStmt {
  type: 'set';
  name: string;
  expr: string;
}

/** Continuous binding from a received CAN signal to a variable.
 *  When this statement executes, the runner subscribes to live RX frames.
 *  Every matching frame decodes the named signal's physical value and writes it
 *  to `vars[varName]`. The subscription stays active until clearVars() is called
 *  or the var is re-bound (latest replaces earlier). Multi-node messages require
 *  `nodeId`; single-node messages ignore it. */
export interface BindStmt extends BaseStmt {
  type: 'bind';
  varName: string;
  msgName: string;
  signal: string;
  /** Node id for multi-node messages. Either a literal number or a string like
   *  `=expr` that's evaluated against the current vars map at bind time. */
  nodeId?: number | string;
}

/** One-shot blocking read: waits for the next matching RX frame, writes the
 *  decoded signal value into `vars[varName]`, then proceeds. Errors (logs and
 *  continues) if the timeout elapses with no matching frame. */
export interface ReadStmt extends BaseStmt {
  type: 'read';
  varName: string;
  msgName: string;
  signal: string;
  /** Node id for multi-node messages. Same expression syntax as BindStmt. */
  nodeId?: number | string;
  timeoutMs: number;
}

export type SeqStatement =
  | SendStmt | WaitStmt | RepeatStmt | EveryStmt | SweepStmt
  | GroupStmt | SetStmt | BindStmt | ReadStmt;

export interface RunLogEntry {
  ts: number;
  stmtId: string;
  label: string;
  ok: boolean;
  error?: string;
}

/** Live binding state for the UI panel. */
export interface BindingEntry {
  msgName: string;
  signal: string;
  nodeId?: number;
  /** Last decoded physical value, or null if no frame received yet. */
  lastValue: number | null;
  /** Wall-clock timestamp of the last update (ms since epoch), or null. */
  lastTs: number | null;
}

const LS_AST_KEY = 'cancodec_sequence_ast_v2';
const LS_LEGACY_STEPS_KEY = 'cancodec_sequence_steps'; // pre-AST format
const RUN_LOG_MAX = 500;

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2, 11);
}

function migrateLegacySteps(raw: unknown): SeqStatement[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SeqStatement[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const x = s as Record<string, unknown>;
    if (typeof x.canId !== 'number' || !Array.isArray(x.data)) continue;
    const isFd = !!x.isFd;
    const data = (x.data as number[]).map(b => b & 0xff);
    const send: SendStmt = {
      id: typeof x.id === 'string' ? x.id : newId(),
      type: 'send',
      enabled: x.enabled !== false,
      label: typeof x.label === 'string' ? x.label : `0x${(x.canId as number).toString(16).toUpperCase()}`,
      raw: { canId: x.canId as number, data, isFd },
    };
    out.push(send);
    // Legacy postDelayMs becomes a wait sibling, for behavioural parity.
    const post = Number(x.postDelayMs) || 0;
    if (post > 0) {
      out.push({ id: newId(), type: 'wait', enabled: true, ms: post });
    }
  }
  return out;
}

function isValidAst(v: unknown): v is SeqStatement[] {
  if (!Array.isArray(v)) return false;
  return v.every(isValidStmt);
}

function isValidStmt(v: unknown): v is SeqStatement {
  if (!v || typeof v !== 'object') return false;
  const x = v as Record<string, unknown>;
  if (typeof x.id !== 'string') return false;
  switch (x.type) {
    case 'send':   return true;
    case 'wait':   return typeof x.ms === 'number';
    case 'repeat': return typeof x.count === 'number' && isValidAst(x.body);
    case 'every':  return typeof x.periodMs === 'number' && isValidAst(x.body);
    case 'sweep':  return typeof x.msgName === 'string' && typeof x.signal === 'string';
    case 'group':  return isValidAst(x.body);
    case 'set':    return typeof x.name === 'string' && typeof x.expr === 'string';
    case 'bind':   return typeof x.varName === 'string' && typeof x.msgName === 'string' && typeof x.signal === 'string';
    case 'read':   return typeof x.varName === 'string' && typeof x.msgName === 'string' && typeof x.signal === 'string' && typeof x.timeoutMs === 'number';
    default:       return false;
  }
}

function loadAst(): SeqStatement[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const v2 = localStorage.getItem(LS_AST_KEY);
    if (v2) {
      const parsed = JSON.parse(v2);
      if (isValidAst(parsed)) return parsed;
    }
    const legacy = localStorage.getItem(LS_LEGACY_STEPS_KEY);
    if (legacy) {
      const migrated = migrateLegacySteps(JSON.parse(legacy));
      if (migrated && migrated.length > 0) return migrated;
    }
  } catch { /* fall through */ }
  return [];
}

/** Compute the # of iterations a sweep produces for [from, to] with the given step. */
export function sweepCount(from: number, to: number, step: number): number {
  if (step === 0) return 0;
  if ((to > from && step < 0) || (to < from && step > 0)) return 0;
  return Math.floor(Math.abs((to - from) / step)) + 1;
}

class SequenceStore {
  ast = $state<SeqStatement[]>(loadAst());
  running = $state<boolean>(false);
  currentStmtId = $state<string | null>(null);
  /** id of the currently-running notebook cell, or null if none / Run All. */
  runningCellId = $state<string | null>(null);
  runLog = $state<RunLogEntry[]>([]);
  lastError = $state<string | null>(null);
  /** Live count of variables in scope. Updated as set-statements execute. */
  varsCount = $state<number>(0);
  /** Active signal-to-variable bindings, keyed by var name. Each binding's
   *  lastValue / lastTs is updated as RX frames arrive. Exposed for the UI
   *  bindings panel. */
  bindings = $state<Record<string, BindingEntry>>({});

  private activeTimers = new Set<ReturnType<typeof setTimeout>>();
  private activeIntervals = new Set<ReturnType<typeof setInterval>>();
  private cancelSleep: (() => void) | null = null;
  /** Variables shared across all cell runs and Run All. Cleared only by clearVars(). */
  private vars: Record<string, number> = {};
  /** Per-binding unsubscribe callbacks (from busStore.client.addFrameCallback). */
  private bindingUnsubs: Record<string, () => void> = {};

  // ---- Persistence ----

  persist() {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(LS_AST_KEY, JSON.stringify(this.ast));
    } catch { /* quota */ }
  }

  // ---- Generic AST mutation helpers ----

  /** Find a statement's parent list and index by id. Returns null if not found. */
  private locate(id: string): { parent: SeqStatement[]; index: number } | null {
    const walk = (list: SeqStatement[]): { parent: SeqStatement[]; index: number } | null => {
      for (let i = 0; i < list.length; i++) {
        if (list[i].id === id) return { parent: list, index: i };
        const body = (list[i] as Partial<RepeatStmt>).body;
        if (Array.isArray(body)) {
          const r = walk(body);
          if (r) return r;
        }
      }
      return null;
    };
    return walk(this.ast);
  }

  /** Replace AST with a deeply-mutated copy (forces Svelte 5 reactivity). */
  private mutateAst(fn: (draft: SeqStatement[]) => void) {
    const draft = JSON.parse(JSON.stringify(this.ast)) as SeqStatement[];
    fn(draft);
    this.ast = draft;
    this.persist();
  }

  addStmt<T extends SeqStatement>(parentId: string | null, stmt: Omit<T, 'id'> & { id?: string }): string {
    const withId = { ...stmt, id: stmt.id ?? newId() } as unknown as SeqStatement;
    if (parentId === null) {
      this.ast = [...this.ast, withId];
      this.persist();
      return withId.id;
    }
    this.mutateAst(draft => {
      const found = locateIn(draft, parentId);
      if (!found) return;
      const target = found.parent[found.index];
      const body = (target as Partial<RepeatStmt>).body;
      if (Array.isArray(body)) body.push(withId);
    });
    return withId.id;
  }

  /** Insert a statement *after* the given sibling id. */
  insertAfter<T extends SeqStatement>(siblingId: string, stmt: Omit<T, 'id'> & { id?: string }): string {
    const withId = { ...stmt, id: stmt.id ?? newId() } as unknown as SeqStatement;
    this.mutateAst(draft => {
      const found = locateIn(draft, siblingId);
      if (!found) return;
      found.parent.splice(found.index + 1, 0, withId);
    });
    return withId.id;
  }

  /** Insert a statement *before* the given sibling id (same parent). Used to cover
   *  the otherwise-unreachable first-gap slot in any parent's children list. */
  insertBefore<T extends SeqStatement>(siblingId: string, stmt: Omit<T, 'id'> & { id?: string }): string {
    const withId = { ...stmt, id: stmt.id ?? newId() } as unknown as SeqStatement;
    this.mutateAst(draft => {
      const found = locateIn(draft, siblingId);
      if (!found) return;
      found.parent.splice(found.index, 0, withId);
    });
    return withId.id;
  }

  /** Deep-clone a statement (including its subtree if it's a container) with all-new
   *  ids, then insert the clone immediately after the original. Returns the new id. */
  duplicateStmt(id: string): string | null {
    let newRootId: string | null = null;
    this.mutateAst(draft => {
      const found = locateIn(draft, id);
      if (!found) return;
      const original = found.parent[found.index];
      const cloned = reIdAll([JSON.parse(JSON.stringify(original))])[0];
      newRootId = cloned.id;
      found.parent.splice(found.index + 1, 0, cloned);
    });
    return newRootId;
  }

  removeStmt(id: string) {
    this.mutateAst(draft => {
      const found = locateIn(draft, id);
      if (!found) return;
      found.parent.splice(found.index, 1);
    });
  }

  moveStmt(id: string, direction: -1 | 1) {
    this.mutateAst(draft => {
      const found = locateIn(draft, id);
      if (!found) return;
      const j = found.index + direction;
      if (j < 0 || j >= found.parent.length) return;
      [found.parent[found.index], found.parent[j]] = [found.parent[j], found.parent[found.index]];
    });
  }

  updateStmt(id: string, patch: Partial<SeqStatement>) {
    this.mutateAst(draft => {
      const found = locateIn(draft, id);
      if (!found) return;
      found.parent[found.index] = { ...found.parent[found.index], ...(patch as object) } as SeqStatement;
    });
  }

  /**
   * Drag-and-drop move. Place `srcId` near `targetId` according to `position`:
   *   'before'  → same parent as target, index = target's index (pushes target down)
   *   'after'   → same parent as target, index = target's index + 1
   *   'inside'  → as last child of target (target MUST be a container; falls back to 'after')
   *   'end'     → as last top-level statement (targetId is ignored, may be null)
   * Refuses cycles (dropping a container into its own descendant) and no-ops.
   * Returns true if a move actually happened.
   */
  moveStmtTo(
    srcId: string,
    targetId: string | null,
    position: 'before' | 'after' | 'inside' | 'end',
  ): boolean {
    if (srcId === targetId) return false;
    // Cycle check: refuse to put a parent inside its own descendant.
    if (position === 'inside' && targetId !== null) {
      if (this._isDescendantOf(targetId, srcId)) return false;
      if (targetId === srcId) return false;
    }
    let moved = false;
    this.mutateAst(draft => {
      const src = locateIn(draft, srcId);
      if (!src) return;
      const [removed] = src.parent.splice(src.index, 1);

      if (position === 'end' || targetId === null) {
        draft.push(removed);
        moved = true;
        return;
      }

      const tgt = locateIn(draft, targetId);
      if (!tgt) {
        // Target vanished (shouldn't happen — but restore src to keep invariants).
        src.parent.splice(src.index, 0, removed);
        return;
      }

      if (position === 'inside') {
        const target = tgt.parent[tgt.index];
        const body = (target as Partial<RepeatStmt>).body;
        if (Array.isArray(body)) {
          body.push(removed);
        } else {
          // Target is not a container — fall back to "after".
          tgt.parent.splice(tgt.index + 1, 0, removed);
        }
      } else if (position === 'before') {
        tgt.parent.splice(tgt.index, 0, removed);
      } else {
        // 'after'
        tgt.parent.splice(tgt.index + 1, 0, removed);
      }
      moved = true;
    });
    return moved;
  }

  /**
   * Move a contiguous, same-parent group of statements as one operation.
   * Returns false (and makes no change) if:
   *   - srcIds is empty
   *   - srcIds aren't all siblings under the same parent
   *   - the target lands inside any source's subtree (cycle)
   *   - the target is one of the sources themselves
   * The moved block is placed at the same relative orientation
   * (before / after / inside / end) as the single-id variant.
   */
  moveStmtsTo(
    srcIds: string[],
    targetId: string | null,
    position: 'before' | 'after' | 'inside' | 'end',
  ): boolean {
    if (srcIds.length === 0) return false;
    if (srcIds.length === 1) return this.moveStmtTo(srcIds[0], targetId, position);
    if (targetId !== null && srcIds.includes(targetId)) return false;
    // All sources must share the same parent in the current tree.
    const firstLoc = locateIn(this.ast, srcIds[0]);
    if (!firstLoc) return false;
    const parentRef = firstLoc.parent;
    const indices: number[] = [];
    for (const id of srcIds) {
      const loc = locateIn(this.ast, id);
      if (!loc || loc.parent !== parentRef) return false;
      indices.push(loc.index);
    }
    // Ensure contiguous (after sorting). The caller should already provide them in order,
    // but we sort + verify to keep the call sites simple.
    indices.sort((a, b) => a - b);
    for (let i = 1; i < indices.length; i++) {
      if (indices[i] !== indices[i - 1] + 1) return false;
    }
    // Cycle prevention against every source.
    if (position === 'inside' && targetId !== null) {
      for (const id of srcIds) {
        if (this._isDescendantOf(targetId, id)) return false;
      }
    }
    let moved = false;
    this.mutateAst(draft => {
      // Re-locate sources inside the draft (separate object identity than `parentRef` above).
      const draftLocs = srcIds.map(id => locateIn(draft, id));
      if (draftLocs.some(l => l === null)) return;
      const draftParent = draftLocs[0]!.parent;
      const draftIndices = draftLocs.map(l => l!.index).sort((a, b) => a - b);
      // Splice out from the highest index downward so lower indices stay valid.
      const removed: SeqStatement[] = new Array(draftIndices.length);
      for (let i = draftIndices.length - 1; i >= 0; i--) {
        removed[i] = draftParent.splice(draftIndices[i], 1)[0];
      }

      if (position === 'end' || targetId === null) {
        for (const r of removed) draft.push(r);
        moved = true;
        return;
      }

      const tgt = locateIn(draft, targetId);
      if (!tgt) {
        // Restore: insert back at the lowest original index.
        draftParent.splice(draftIndices[0], 0, ...removed);
        return;
      }

      if (position === 'inside') {
        const target = tgt.parent[tgt.index];
        const body = (target as Partial<RepeatStmt>).body;
        if (Array.isArray(body)) {
          body.push(...removed);
        } else {
          tgt.parent.splice(tgt.index + 1, 0, ...removed);
        }
      } else if (position === 'before') {
        tgt.parent.splice(tgt.index, 0, ...removed);
      } else {
        // 'after'
        tgt.parent.splice(tgt.index + 1, 0, ...removed);
      }
      moved = true;
    });
    return moved;
  }

  /** Return true if `descendantId` is anywhere inside `ancestorId`'s body subtree. */
  private _isDescendantOf(descendantId: string, ancestorId: string): boolean {
    const found = locateIn(this.ast, ancestorId);
    if (!found) return false;
    const ancestor = found.parent[found.index];
    const body = (ancestor as Partial<RepeatStmt>).body;
    if (!Array.isArray(body)) return false;
    return containsId(body, descendantId);
  }

  /**
   * Return the ids of the sibling sub-range [id1 ... id2] (inclusive) if they
   * share a parent in the current AST. Returns null when the two ids don't
   * have the same parent. Order is top-to-bottom regardless of which id was
   * passed first.
   */
  siblingRange(id1: string, id2: string): string[] | null {
    const a = locateIn(this.ast, id1);
    const b = locateIn(this.ast, id2);
    if (!a || !b) return null;
    if (a.parent !== b.parent) return null;
    const lo = Math.min(a.index, b.index);
    const hi = Math.max(a.index, b.index);
    return a.parent.slice(lo, hi + 1).map(s => s.id);
  }

  clear() {
    this.stop();
    this.ast = [];
    this.persist();
  }

  clearLog() {
    this.runLog = [];
  }

  // ---- JSON import / export ----

  exportJson(): string {
    return JSON.stringify({ version: 2, ast: this.ast }, null, 2);
  }

  importJson(text: string): { ok: true } | { ok: false; error: string } {
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch (e) { return { ok: false, error: `JSON parse error: ${e instanceof Error ? e.message : String(e)}` }; }
    const wrapper = parsed as { version?: number; ast?: unknown };
    const raw = wrapper && typeof wrapper === 'object' && 'ast' in wrapper ? wrapper.ast : parsed;
    if (!isValidAst(raw)) return { ok: false, error: 'Not a valid sequence AST' };
    // Re-id everything so imports don't collide with existing ids.
    this.ast = reIdAll(raw);
    this.persist();
    return { ok: true };
  }

  // ---- Runner ----

  start() {
    if (this.running) return;
    if (!busStore.connected) {
      this.lastError = 'not connected to bus';
      return;
    }
    if (this.ast.length === 0) {
      this.lastError = 'sequence is empty';
      return;
    }
    this.lastError = null;
    this.running = true;
    this.runningCellId = null;
    // Vars are NOT cleared here — they persist across cell runs and Run-All
    // invocations (notebook-style). Use clearVars() to reset explicitly.
    this._runBody(this.ast).finally(() => {
      this.running = false;
      this.currentStmtId = null;
      this.runningCellId = null;
      // Cancel any still-running background `every`s.
      for (const i of this.activeIntervals) clearInterval(i);
      this.activeIntervals.clear();
      for (const t of this.activeTimers) clearTimeout(t);
      this.activeTimers.clear();
    });
  }

  /** Run a single top-level group as a notebook cell. */
  runCell(stmtId: string) {
    if (this.running) return;
    if (!busStore.connected) {
      this.lastError = 'not connected to bus';
      return;
    }
    const stmt = this.ast.find(s => s.id === stmtId);
    if (!stmt || stmt.type !== 'group') {
      this.lastError = 'cell not found';
      return;
    }
    if (stmt.body.length === 0) {
      this.lastError = `cell "${stmt.label}" is empty`;
      return;
    }
    this.lastError = null;
    this.running = true;
    this.runningCellId = stmtId;
    this._runBody(stmt.body).finally(() => {
      this.running = false;
      this.currentStmtId = null;
      this.runningCellId = null;
      for (const i of this.activeIntervals) clearInterval(i);
      this.activeIntervals.clear();
      for (const t of this.activeTimers) clearTimeout(t);
      this.activeTimers.clear();
    });
  }

  /** Wipe all variables and active bindings. Call from a UI Reset button. */
  clearVars() {
    for (const unsub of Object.values(this.bindingUnsubs)) {
      try { unsub(); } catch { /* ignore */ }
    }
    this.bindingUnsubs = {};
    this.bindings = {};
    this.vars = {};
    this.varsCount = 0;
  }

  stop() {
    this.running = false;
    this.currentStmtId = null;
    if (this.cancelSleep) { this.cancelSleep(); this.cancelSleep = null; }
    for (const t of this.activeTimers) clearTimeout(t);
    this.activeTimers.clear();
    for (const i of this.activeIntervals) clearInterval(i);
    this.activeIntervals.clear();
  }

  // -- Interpreter --

  private async _runBody(stmts: SeqStatement[]) {
    // Track background every's started inside *this* body so they get
    // cancelled when this scope ends.
    const localIntervals: ReturnType<typeof setInterval>[] = [];
    try {
      for (const s of stmts) {
        if (!this.running) return;
        if (!s.enabled) continue;
        await this._runStmt(s, localIntervals);
      }
    } finally {
      for (const iv of localIntervals) {
        clearInterval(iv);
        this.activeIntervals.delete(iv);
      }
    }
  }

  private async _runStmt(s: SeqStatement, localIntervals: ReturnType<typeof setInterval>[]) {
    this.currentStmtId = s.id;
    switch (s.type) {
      case 'send':
        this._dispatchSend(s);
        return;
      case 'wait':
        if (s.ms > 0) await this._sleep(s.ms);
        return;
      case 'repeat': {
        const n = Math.max(0, s.count | 0);
        for (let i = 0; i < n; i++) {
          if (!this.running) return;
          await this._runBody(s.body);
        }
        return;
      }
      case 'every':
        await this._runEvery(s, localIntervals);
        return;
      case 'sweep':
        await this._runSweep(s);
        return;
      case 'group':
        await this._runBody(s.body);
        return;
      case 'set':
        try {
          const value = evalExpr(s.expr, this.vars);
          const isNew = !(s.name in this.vars);
          this.vars[s.name] = value;
          if (isNew) this.varsCount = Object.keys(this.vars).length;
          this._logEntry(s.id, `set ${s.name} = ${value}`, true);
        } catch (e) {
          this._logEntry(s.id, `set ${s.name}`, false, e instanceof Error ? e.message : String(e));
        }
        return;
      case 'bind':
        this._installBinding(s);
        return;
      case 'read':
        await this._runRead(s);
        return;
    }
  }

  /** Install (or replace) a continuous binding from msg.signal → vars[varName]. */
  private _installBinding(s: BindStmt) {
    const msg = codecStore.codec.getMessageByName(s.msgName);
    if (!msg) {
      this._logEntry(s.id, `bind ${s.varName} ← ${s.msgName}.${s.signal}`, false, `unknown message '${s.msgName}'`);
      return;
    }
    const sig = msg.signals.find(g => g.name === s.signal);
    if (!sig) {
      this._logEntry(s.id, `bind ${s.varName} ← ${s.msgName}.${s.signal}`, false, `unknown signal '${s.signal}' on '${s.msgName}'`);
      return;
    }
    const multiNode = (msg.node_count ?? 1) > 1;
    let wantNode: number | undefined;
    if (multiNode) {
      try {
        wantNode = resolveNum(s.nodeId, NaN, this.vars);
      } catch (e) {
        this._logEntry(s.id, `bind ${s.varName} ← ${s.msgName}.${s.signal}`, false, e instanceof Error ? e.message : String(e));
        return;
      }
      if (typeof wantNode !== 'number' || isNaN(wantNode)) {
        this._logEntry(s.id, `bind ${s.varName} ← ${s.msgName}.${s.signal}`, false, `multi-node message requires nodeId`);
        return;
      }
    }

    // Replace any prior binding for this var (drop the old subscription cleanly).
    if (this.bindingUnsubs[s.varName]) {
      try { this.bindingUnsubs[s.varName](); } catch { /* ignore */ }
      delete this.bindingUnsubs[s.varName];
    }

    const unsub = busStore.client.addFrameCallback((frame) => {
      const dec = codecStore.codec.decode(frame.arbitration_id, frame.data, frame.dlc);
      if (!dec || dec.name !== s.msgName) return;
      if (multiNode && dec.node_id !== wantNode) return;
      const found = dec.signals.find(g => g.name === s.signal);
      if (!found) return;
      if (typeof found.physical_value !== 'number') {
        this._logEntry(
          s.id,
          `bind ${s.varName} ← ${s.msgName}.${s.signal}`,
          false,
          `decoded value ${found.physical_value} exceeds JavaScript's safe integer range and cannot be used in numeric expressions`,
        );
        return;
      }
      this.vars[s.varName] = found.physical_value;
      const wasNew = !(s.varName in this.bindings);
      this.bindings = {
        ...this.bindings,
        [s.varName]: {
          msgName: s.msgName, signal: s.signal,
          nodeId: multiNode ? wantNode : undefined,
          lastValue: found.physical_value, lastTs: Date.now(),
        },
      };
      if (wasNew) this.varsCount = Object.keys(this.vars).length;
    });
    this.bindingUnsubs[s.varName] = unsub;
    // Seed the panel entry so the user sees the binding exists even before the
    // first frame arrives.
    this.bindings = {
      ...this.bindings,
      [s.varName]: {
        msgName: s.msgName, signal: s.signal,
        nodeId: multiNode ? wantNode : undefined,
        lastValue: this.bindings[s.varName]?.lastValue ?? null,
        lastTs: this.bindings[s.varName]?.lastTs ?? null,
      },
    };
    this._logEntry(
      s.id,
      `bind ${s.varName} ← ${s.msgName}.${s.signal}${multiNode ? ` @node ${wantNode}` : ''}`,
      true,
    );
  }

  /** One-shot blocking read: resolve when the next matching frame arrives, or
   *  log a timeout error and continue. */
  private async _runRead(s: ReadStmt): Promise<void> {
    const msg = codecStore.codec.getMessageByName(s.msgName);
    if (!msg) {
      this._logEntry(s.id, `read ${s.varName} ← ${s.msgName}.${s.signal}`, false, `unknown message '${s.msgName}'`);
      return;
    }
    const sig = msg.signals.find(g => g.name === s.signal);
    if (!sig) {
      this._logEntry(s.id, `read ${s.varName} ← ${s.msgName}.${s.signal}`, false, `unknown signal '${s.signal}' on '${s.msgName}'`);
      return;
    }
    const multiNode = (msg.node_count ?? 1) > 1;
    let wantNode: number | undefined;
    if (multiNode) {
      try {
        wantNode = resolveNum(s.nodeId, NaN, this.vars);
      } catch (e) {
        this._logEntry(s.id, `read ${s.varName} ← ${s.msgName}.${s.signal}`, false, e instanceof Error ? e.message : String(e));
        return;
      }
      if (typeof wantNode !== 'number' || isNaN(wantNode)) {
        this._logEntry(s.id, `read ${s.varName} ← ${s.msgName}.${s.signal}`, false, `multi-node message requires nodeId`);
        return;
      }
    }
    const timeoutMs = Math.max(1, s.timeoutMs);

    await new Promise<void>(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        unsub();
        clearTimeout(timer);
        this.activeTimers.delete(timer);
        resolve();
      };
      const unsub = busStore.client.addFrameCallback((frame) => {
        if (!this.running) { finish(); return; }
        const dec = codecStore.codec.decode(frame.arbitration_id, frame.data, frame.dlc);
        if (!dec || dec.name !== s.msgName) return;
        if (multiNode && dec.node_id !== wantNode) return;
        const found = dec.signals.find(g => g.name === s.signal);
        if (!found) return;
        if (typeof found.physical_value !== 'number') {
          this._logEntry(
            s.id,
            `read ${s.varName} ← ${s.msgName}.${s.signal}`,
            false,
            `decoded value ${found.physical_value} exceeds JavaScript's safe integer range and cannot be used in numeric expressions`,
          );
          finish();
          return;
        }
        const isNew = !(s.varName in this.vars);
        this.vars[s.varName] = found.physical_value;
        if (isNew) this.varsCount = Object.keys(this.vars).length;
        this._logEntry(
          s.id,
          `read ${s.varName} = ${found.physical_value}${multiNode ? ` (node ${wantNode})` : ''}`,
          true,
        );
        finish();
      });
      const timer = setTimeout(() => {
        if (settled) return;
        this._logEntry(
          s.id,
          `read ${s.varName} ← ${s.msgName}.${s.signal}`,
          false,
          `timeout after ${timeoutMs}ms`,
        );
        finish();
      }, timeoutMs);
      this.activeTimers.add(timer);
    });
  }

  private async _runEvery(s: EveryStmt, localIntervals: ReturnType<typeof setInterval>[]) {
    const fire = () => {
      if (!this.running) return;
      // Body of `every` runs sequentially; we ignore the promise — keep cadence on schedule.
      void this._runBody(s.body);
    };
    if (s.initialDelayMs > 0) {
      await this._sleep(s.initialDelayMs);
      if (!this.running) return;
    }
    fire();
    const iv = setInterval(() => {
      if (!this.running) { clearInterval(iv); this.activeIntervals.delete(iv); return; }
      fire();
    }, Math.max(1, s.periodMs));
    this.activeIntervals.add(iv);
    localIntervals.push(iv);
    if (typeof s.durationMs === 'number' && s.durationMs > 0) {
      // Blocking: wait the requested duration, then stop this every.
      await this._sleep(s.durationMs);
      clearInterval(iv);
      this.activeIntervals.delete(iv);
      const idx = localIntervals.indexOf(iv);
      if (idx >= 0) localIntervals.splice(idx, 1);
    }
    // Otherwise background — caller's finally{} clears localIntervals.
  }

  private async _runSweep(s: SweepStmt) {
    const n = sweepCount(s.from, s.to, s.step);
    if (n === 0) {
      this._logEntry(s.id, sweepLabel(s), false, 'invalid sweep range/step');
      return;
    }
    for (let i = 0; i < n; i++) {
      if (!this.running) return;
      const value = s.from + i * s.step;
      const values: Record<string, string | number> = { ...(s.baseValues ?? {}), [s.signal]: value };
      const send: SendStmt = {
        id: s.id,
        type: 'send',
        enabled: true,
        label: `${s.msgName} ${s.signal}=${value}`,
        msgName: s.msgName,
        nodeId: s.nodeId,
        sysId: s.sysId,
        compId: s.compId,
        isMavlink: s.isMavlink,
        values,
      };
      this._dispatchSend(send);
      if (i < n - 1 && s.periodMs > 0) await this._sleep(s.periodMs);
    }
  }

  private _dispatchSend(s: SendStmt) {
    try {
      const frames = this._encodeSend(s);
      let allOk = true;
      let lastErr: string | null = null;
      for (const f of frames) {
        const ok = busStore.client.send(f.canId, f.data, f.isFd);
        if (!ok) {
          allOk = false;
          lastErr = busStore.client.lastSendError ?? 'send returned false';
        }
      }
      this._logEntry(s.id, s.label || sendLabel(s), allOk, allOk ? undefined : (lastErr ?? undefined));
    } catch (e) {
      this._logEntry(s.id, s.label || sendLabel(s), false, e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Public preview wrapper: returns the same frames the runner would emit,
   * or an error string. Used by the encode-page inline editor to show what
   * a send statement would actually transmit. Does NOT touch the bus.
   *
   * The preview walks the AST up to `s` in document order, applying any `set`
   * statements it finds, so previews resolve variables correctly.
   */
  encodeSendPreview(s: SendStmt): { frames: { canId: number; data: Uint8Array; isFd: boolean }[]; error: string | null } {
    try {
      const vars = this._collectVarsBefore(s.id);
      return { frames: this._encodeSend(s, vars), error: null };
    } catch (e) {
      return { frames: [], error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Walk the AST in document order, executing `set` statements until we reach
   *  `targetId`. Returns the var map at that point. Best-effort: skips disabled
   *  statements and ignores per-iteration updates inside repeat/every (we only
   *  pass through the body once). */
  private _collectVarsBefore(targetId: string): Record<string, number> {
    const vars: Record<string, number> = {};
    const walk = (list: SeqStatement[]): boolean => {
      for (const s of list) {
        if (s.id === targetId) return true; // stop, don't apply this one
        if (!s.enabled) continue;
        if (s.type === 'set') {
          try { vars[s.name] = evalExpr(s.expr, vars); } catch { /* ignore parse errors in preview */ }
          continue;
        }
        const body = (s as Partial<RepeatStmt>).body;
        if (Array.isArray(body)) {
          if (walk(body)) return true;
        }
      }
      return false;
    };
    walk(this.ast);
    return vars;
  }

  /** Re-encode a send statement to one-or-more {canId, data, isFd} frames.
   *  Optional `varsOverride` lets the preview path pass a precomputed vars map
   *  (collected by walking the AST up to this stmt's position). */
  private _encodeSend(s: SendStmt, varsOverride?: Record<string, number>): { canId: number; data: Uint8Array; isFd: boolean }[] {
    const vars = varsOverride ?? this.vars;
    if (s.msgName && codecStore.codec.getMessageByName(s.msgName)) {
      if (s.isMavlink) {
        const values = resolveValues(s.values ?? {}, vars);
        const sysId = resolveNum(s.sysId, 1, vars);
        const compId = resolveNum(s.compId, 1, vars);
        const r = codecStore.codec.encodeMavlink(s.msgName, values, sysId, compId);
        return r.frames.map(f => ({
          canId: parseInt(f.canId, 16),
          data: hexToBytes(f.data),
          isFd: f.fdFlag.startsWith('##') || f.data.length / 2 > 8,
        }));
      }
      if (s.isBroadcast && s.perNodeValues) {
        const resolved = resolvePerNodeValues(s.perNodeValues, vars);
        const perNode = new Map<number, Record<string, string | number | Record<string, boolean>>>();
        for (const [k, v] of Object.entries(resolved)) perNode.set(Number(k), v);
        const r = codecStore.codec.encodeBroadcast(s.msgName, perNode);
        return [{ canId: r.canId, data: r.data, isFd: r.data.length > 8 }];
      }
      const values = resolveValues(s.values ?? {}, vars);
      const nodeId = resolveNum(s.nodeId, 0, vars);
      const r = codecStore.codec.encode(s.msgName, values, nodeId);
      return [{ canId: r.canId, data: r.data, isFd: r.data.length > 8 }];
    }
    if (s.raw) {
      return [{ canId: s.raw.canId, data: new Uint8Array(s.raw.data), isFd: s.raw.isFd }];
    }
    throw new Error(`send "${s.label}": message "${s.msgName}" not found in loaded config (and no raw fallback)`);
  }

  private _logEntry(id: string, label: string, ok: boolean, error?: string) {
    const entry: RunLogEntry = { ts: Date.now(), stmtId: id, label, ok, error };
    this.runLog = [entry, ...this.runLog].slice(0, RUN_LOG_MAX);
  }

  private _sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.activeTimers.delete(t);
        this.cancelSleep = null;
        resolve();
      }, ms);
      this.activeTimers.add(t);
      this.cancelSleep = () => {
        clearTimeout(t);
        this.activeTimers.delete(t);
        resolve();
      };
    });
  }
}

// ---- Helpers used by the class (kept outside so `this` isn't captured into nested fns) ----

function locateIn(list: SeqStatement[], id: string): { parent: SeqStatement[]; index: number } | null {
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return { parent: list, index: i };
    const body = (list[i] as Partial<RepeatStmt>).body;
    if (Array.isArray(body)) {
      const r = locateIn(body, id);
      if (r) return r;
    }
  }
  return null;
}

/** True if `id` appears anywhere in `list` or its descendant bodies. */
function containsId(list: SeqStatement[], id: string): boolean {
  for (const s of list) {
    if (s.id === id) return true;
    const body = (s as Partial<RepeatStmt>).body;
    if (Array.isArray(body) && containsId(body, id)) return true;
  }
  return false;
}

function reIdAll(ast: SeqStatement[]): SeqStatement[] {
  return ast.map(s => {
    const copy = { ...s, id: newId() } as SeqStatement;
    const body = (copy as Partial<RepeatStmt>).body;
    if (Array.isArray(body)) {
      (copy as { body: SeqStatement[] }).body = reIdAll(body);
    }
    return copy;
  });
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/[^0-9A-Fa-f]/g, '');
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---- Expression evaluator ----
// A tiny, non-Turing-complete arithmetic language used by `set` statements and by
// `=expr` strings in send values. Grammar:
//
//   expr   = term (('+' | '-') term)*
//   term   = factor (('*' | '/' | '%') factor)*
//   factor = NUMBER | IDENT | '(' expr ')' | ('-' | '+') factor
//   NUMBER = /\d+(\.\d+)?/  or  /0x[0-9a-f]+/
//   IDENT  = /[a-zA-Z_][a-zA-Z0-9_]*/
//
// No `eval`, no Function, no property access — just arithmetic over a flat name
// scope. Throws on undefined variable, malformed input, or trailing tokens.

type Tok =
  | { kind: 'num'; value: number }
  | { kind: 'ident'; name: string }
  | { kind: 'op'; op: '+' | '-' | '*' | '/' | '%' }
  | { kind: 'lparen' }
  | { kind: 'rparen' };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '(') { out.push({ kind: 'lparen' }); i++; continue; }
    if (c === ')') { out.push({ kind: 'rparen' }); i++; continue; }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '%') {
      out.push({ kind: 'op', op: c });
      i++;
      continue;
    }
    if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
      const m = src.slice(i).match(/^0[xX][0-9a-fA-F]+/);
      if (!m) throw new Error(`expression: bad hex literal at offset ${i}`);
      out.push({ kind: 'num', value: parseInt(m[0], 16) });
      i += m[0].length;
      continue;
    }
    if (c >= '0' && c <= '9' || c === '.') {
      const m = src.slice(i).match(/^\d+(\.\d+)?|^\.\d+/);
      if (!m) throw new Error(`expression: bad number at offset ${i}`);
      out.push({ kind: 'num', value: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      const m = src.slice(i).match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
      if (!m) throw new Error(`expression: bad identifier at offset ${i}`);
      out.push({ kind: 'ident', name: m[0] });
      i += m[0].length;
      continue;
    }
    throw new Error(`expression: unexpected '${c}' at offset ${i}`);
  }
  return out;
}

export function evalExpr(src: string, vars: Record<string, number>): number {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = (): Tok | null => pos < tokens.length ? tokens[pos] : null;

  function parseExpr(): number {
    let left = parseTerm();
    while (true) {
      const t = peek();
      if (!t || t.kind !== 'op' || (t.op !== '+' && t.op !== '-')) break;
      pos++;
      const right = parseTerm();
      left = t.op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number {
    let left = parseFactor();
    while (true) {
      const t = peek();
      if (!t || t.kind !== 'op' || (t.op !== '*' && t.op !== '/' && t.op !== '%')) break;
      pos++;
      const right = parseFactor();
      if (t.op === '*') left = left * right;
      else if (t.op === '/') left = left / right;
      else left = left % right;
    }
    return left;
  }

  function parseFactor(): number {
    const t = peek();
    if (!t) throw new Error('expression: unexpected end of input');
    if (t.kind === 'op' && (t.op === '-' || t.op === '+')) {
      pos++;
      const v = parseFactor();
      return t.op === '-' ? -v : v;
    }
    if (t.kind === 'lparen') {
      pos++;
      const v = parseExpr();
      const close = peek();
      if (!close || close.kind !== 'rparen') throw new Error("expression: expected ')'");
      pos++;
      return v;
    }
    if (t.kind === 'num') {
      pos++;
      return t.value;
    }
    if (t.kind === 'ident') {
      pos++;
      if (!(t.name in vars)) throw new Error(`undefined variable '${t.name}'`);
      return vars[t.name];
    }
    throw new Error(`expression: unexpected token`);
  }

  const result = parseExpr();
  if (pos < tokens.length) throw new Error('expression: trailing tokens after expression');
  return result;
}

/** Resolve a values dict in-place: any string value of the form "=expr" is replaced by
 *  the evaluated number; other strings/numbers pass through unchanged. */
function resolveValues(
  values: Record<string, string | number>,
  vars: Record<string, number>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'string' && v.startsWith('=')) {
      out[k] = evalExpr(v.slice(1), vars);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function resolvePerNodeValues(
  perNode: Record<number, Record<string, string | number>>,
  vars: Record<string, number>,
): Record<number, Record<string, string | number>> {
  const out: Record<number, Record<string, string | number>> = {};
  for (const [k, v] of Object.entries(perNode)) {
    out[Number(k)] = resolveValues(v, vars);
  }
  return out;
}

/** Resolve a numeric field that may be a literal number, a pure numeric string ("5"),
 *  an explicit expression with a "=" prefix ("=node_counter * 2"), or absent.
 *
 *  Strings that are neither pure numbers nor "=expr" are REJECTED — this prevents
 *  the silent-NaN trap where a user types "counter" forgetting the "=" prefix and
 *  the value ends up packed as garbage bits. Same convention as send values. */
function resolveNum(
  v: number | string | undefined | null,
  defaultVal: number,
  vars: Record<string, number>,
): number {
  if (v === undefined || v === null) return defaultVal;
  if (typeof v === 'number') return v;
  const s = v.trim();
  if (s === '') return defaultVal;
  if (s.startsWith('=')) return evalExpr(s.slice(1), vars);
  // Pure number literal (decimal, hex, leading-dot)
  const asNum = Number(s);
  if (!isNaN(asNum) && s !== '' && /^-?(\d+\.?\d*|\.\d+|0x[0-9a-fA-F]+)$/.test(s)) {
    return asNum;
  }
  throw new Error(`'${v}' is not a number. Prefix with '=' to evaluate as expression (e.g. '=${s}').`);
}

export function sendLabel(s: SendStmt): string {
  if (s.label) return s.label;
  if (s.msgName) {
    const vals = s.values
      ? Object.entries(s.values).slice(0, 3).map(([k, v]) => `${k}=${v}`).join(', ')
      : '';
    return vals ? `${s.msgName}: ${vals}` : s.msgName;
  }
  if (s.raw) {
    const id = s.raw.canId.toString(16).toUpperCase();
    return `0x${id} (${s.raw.data.length}B${s.raw.isFd ? ' FD' : ''})`;
  }
  return 'send';
}

export function sweepLabel(s: SweepStmt): string {
  return s.label || `sweep ${s.signal}: ${s.from}→${s.to} step ${s.step}`;
}

export const sequenceStore = new SequenceStore();
