import { useSyncExternalStore } from 'react';

/**
 * Analyses that run in this browser tab rather than on the server: the lead list's selection
 * batch (up to 20 leads, one request each). The header's "Analysis running" indicator
 * (src/AnalysisIndicator.tsx) lists them beside the server's qualification jobs, so they stay
 * visible, and can be stopped, from every page. Nothing here is stored: a reload ends the batch
 * and forgets it.
 */
export interface BrowserAnalysis {
  id: number;
  project_id: number;
  project_name: string;
  total: number;
  /** Leads started so far, the one in progress included. */
  started: number;
  /** Leads that came back with a result. */
  completed: number;
  status: 'RUNNING' | 'DONE' | 'STOPPED';
  /** Stop was pressed; the lead in progress is finished first. */
  stopping: boolean;
  /** Why it ended before its last lead. */
  reason: string;
}
export interface BrowserAnalysisHandle {
  /** The batch has started its `started`-th lead, with `completed` analysed before it. */
  progress(started: number, completed: number): void;
  /** The same as the indicator's Stop analysis. */
  stop(): void;
  finish(completed: number, reason?: string): void;
}

/** Fired after a server job is started or stopped, so every view of it reads it again at once. */
export const analysisChangedEvent = 'innovista:analysis-changed';
export const analysisChanged = () => window.dispatchEvent(new Event(analysisChangedEvent));

let items: readonly BrowserAnalysis[] = [];
let sequence = 0;
const stops = new Map<number, () => void>();
const listeners = new Set<() => void>();
function publish(next: readonly BrowserAnalysis[]) {
  items = next;
  for (const listener of listeners) listener();
}
const patch = (id: number, change: Partial<BrowserAnalysis>) =>
  publish(items.map((item) => (item.id === id ? { ...item, ...change } : item)));

export function startBrowserAnalysis(init: {
  projectId: number;
  projectName: string;
  total: number;
  /** What Stop does: the batch finishes the lead in progress and starts no other. */
  onStop: () => void;
}): BrowserAnalysisHandle {
  const id = ++sequence;
  stops.set(id, init.onStop);
  publish([
    ...items,
    {
      id,
      project_id: init.projectId,
      project_name: init.projectName,
      total: init.total,
      started: 0,
      completed: 0,
      status: 'RUNNING',
      stopping: false,
      reason: '',
    },
  ]);
  return {
    progress: (started, completed) => patch(id, { started, completed }),
    stop: () => stopBrowserAnalysis(id),
    finish(completed, reason = '') {
      stops.delete(id);
      const item = items.find((entry) => entry.id === id);
      if (!item) return;
      const early = item.started < item.total;
      patch(id, {
        completed,
        stopping: false,
        status: early ? 'STOPPED' : 'DONE',
        reason: early ? reason || (item.stopping ? 'Stopped by you.' : '') : '',
      });
    },
  };
}
export function stopBrowserAnalysis(id: number) {
  const item = items.find((entry) => entry.id === id);
  if (!item || item.status !== 'RUNNING' || item.stopping) return;
  stops.get(id)?.();
  patch(id, { stopping: true });
}
/** Signing out leaves nothing to show a batch in, so it stops after its lead in progress. */
export function stopAllBrowserAnalyses() {
  for (const item of items) stopBrowserAnalysis(item.id);
}
export function dismissBrowserAnalysis(id: number) {
  publish(items.filter((item) => item.id !== id || item.status === 'RUNNING'));
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const snapshot = () => items;
export function useBrowserAnalyses() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
