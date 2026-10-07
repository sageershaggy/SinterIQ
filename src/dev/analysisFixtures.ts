/**
 * The header's "Analysis running" indicator (src/AnalysisIndicator.tsx) in the harness.
 *
 * - ?analysis: a qualification job running in Innovista Research, one lead every three seconds.
 * - ?analysis=many: also one in Sintertechnik, started by someone else.
 * - ?analysis=ending: the Innovista job is two leads from the end, to see the finished summary.
 * Stop analysis (in the header or on the lead list) marks a job stopping; a moment later it reads
 * as stopped. Without the flag nothing runs. Separately, every single-lead qualify answers after a
 * pause, so the lead list's 20-lead batch can be watched in the indicator and stopped there.
 */
import type {
  QualificationJobState,
  RunningAnalyses,
  RunningAnalysisJob,
} from '../../shared/qualification-jobs';

const flags = new URLSearchParams(location.search);
const mode = flags.get('analysis');
const opened = Date.now();
const startedAt = new Date(opened - 25 * 60_000).toISOString();
const STEP_MS = 3000;

interface Fixture {
  id: number;
  project_id: number;
  project_name: string;
  created_by: string;
  mine: boolean;
  /** Leads processed when the harness opened, and in all. */
  from: number;
  total: number;
  lead: string;
  /** Leads processed when Stop was pressed (the one in progress included), and when. */
  stoppedAt?: { processed: number; at: number; by: string };
}
const fixtures: Fixture[] = !flags.has('analysis')
  ? []
  : [
      {
        id: 5,
        project_id: 2,
        project_name: 'Innovista Research',
        created_by: 'Workspace Administrator',
        mine: true,
        from: mode === 'ending' ? 38 : 12,
        total: 40,
        lead: 'The Chopin Law Firm LLC',
      },
      ...(mode === 'many'
        ? [
            {
              id: 9,
              project_id: 1,
              project_name: 'Sintertechnik',
              created_by: 'Qudsiya Researcher',
              mine: false,
              from: 3,
              total: 120,
              lead: 'Alternative Decor Works',
            },
          ]
        : []),
    ];

function view(f: Fixture): RunningAnalysisJob {
  const now = Date.now();
  const flowing = Math.min(f.total, f.from + Math.floor((now - opened) / STEP_MS));
  const processed = f.stoppedAt ? f.stoppedAt.processed : flowing;
  const stopped = Boolean(f.stoppedAt && now - f.stoppedAt.at > 1500);
  const status = stopped ? 'STOPPED' : processed >= f.total ? 'DONE' : 'RUNNING';
  const failed = Math.min(1, processed);
  const done = processed - failed;
  const review = Math.floor(done / 10);
  const qualified = Math.floor(done * 0.4);
  const finishedAt = status === 'RUNNING' ? null : new Date(now).toISOString();
  return {
    id: f.id,
    project_id: f.project_id,
    project_name: f.project_name,
    mine: f.mine,
    status,
    scope: 'stale',
    training_version: 10,
    total: f.total,
    done,
    failed,
    skipped: 0,
    current_lead: status === 'RUNNING' ? { id: 7, name: f.lead } : null,
    created_by: f.created_by,
    created_at: startedAt,
    updated_at: new Date(now).toISOString(),
    finished_at: finishedAt,
    stopping: status === 'RUNNING' && Boolean(f.stoppedAt),
    stop_reason: status === 'STOPPED' ? 'Stopped by ' + f.stoppedAt!.by + '.' : '',
    outcomes: {
      QUALIFIED: qualified,
      NOT_A_TARGET: done - qualified - review,
      NEEDS_REVIEW: review,
    },
    failures: failed
      ? [
          {
            lead_id: 4,
            lead_name: 'Aloha Dental Group',
            error: 'The AI provider took too long to answer.',
          },
        ]
      : [],
    can_stop: status === 'RUNNING',
  };
}
function state(projectId: number): QualificationJobState {
  const fixture = fixtures.find((f) => f.project_id === projectId);
  return {
    job: fixture ? view(fixture) : null,
    counts: { requalify: 0, raw: 198, total: 198, qualified: 0 },
    ready: true,
    training_version: 10,
    can_start_project_wide: true,
  };
}

export const analysisRoutes: Array<[RegExp, (route: string) => unknown]> = [
  [
    /^\/analysis\/running$/,
    (): RunningAnalyses => {
      const jobs = fixtures.map(view);
      return {
        running: jobs.filter((job) => job.status === 'RUNNING'),
        recent: jobs.filter((job) => job.status !== 'RUNNING'),
      };
    },
  ],
  [/^\/projects\/\d+\/qualification-jobs\/current$/, (route) => state(Number(route.split('/')[2]))],
];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

export async function analysisWrite(method: string, route: string) {
  if (method !== 'POST') return null;
  const stop = /^\/projects\/(\d+)\/qualification-jobs\/(\d+)\/stop$/.exec(route);
  if (stop) {
    const fixture = fixtures.find((f) => f.id === Number(stop[2]));
    if (fixture && !fixture.stoppedAt) {
      const now = view(fixture);
      fixture.stoppedAt = {
        processed: Math.min(fixture.total, now.done + now.failed + 1),
        at: Date.now(),
        by: 'Workspace Administrator',
      };
    }
    return json(state(Number(stop[1])));
  }
  // One lead of the selection batch: long enough to watch it in the header and press Stop.
  if (/^\/projects\/2\/leads\/\d+\/qualify$/.test(route)) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return json({});
  }
  return null;
}
