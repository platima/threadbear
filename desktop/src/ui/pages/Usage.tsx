import { useState } from 'react';
import type { Account, UsageWindow } from '../../core/types.ts';
import type { PageDef, PageProps } from '../registry.ts';
import { agoWords, compact, untilWords, whenWords } from '../pages-lib/ops-format.ts';
import { useNow, useRequest } from '../pages-lib/ops-rpc.ts';
import type { UsageStats } from '../pages-lib/ops-types.ts';
import { Card, Chip, Meter, Note, Problem, type Tone } from '../pages-lib/ops-ui.tsx';
import { HoneyPot } from '../pages-lib/HoneyPot.tsx';
import { potLevel, potTip } from '../pages-lib/honey.ts';
import { LimitsChart, TokensChart, type HourRow, type LimitSeries } from '../pages-lib/usage-charts.tsx';
import './usage.css';

const RANGES = [
  { days: 1, label: 'Last day' },
  { days: 3, label: 'Last 3 days' },
  { days: 7, label: 'Last week' },
  { days: 14, label: 'Last 2 weeks' },
];

const usedTone = (used: number): Tone => (used >= 90 ? 'bad' : used >= 70 ? 'warn' : undefined);

function WindowMeter({ w, now }: { w: UsageWindow; now: number }) {
  const used = Math.max(0, Math.min(100, 100 - w.remainingPercent));
  const parts = [w.resetsAt ? `resets ${untilWords(w.resetsAt, now)}${Date.parse(w.resetsAt) > now ? ` (${whenWords(w.resetsAt)})` : ''}` : undefined, w.detail].filter(Boolean);
  return <Meter label={w.title} value={`${Math.round(used)}% used`} percent={used} tone={usedTone(used)} sub={parts.join(', ') || undefined} title={`${w.title}: ${Math.round(used)}% used`} />;
}

// The tightest of a login's windows, as percent left.
function roomLeft(a: Account): number | undefined {
  const w = a.usage?.windows ?? [];
  return w.length ? Math.min(...w.map((x) => x.remainingPercent)) : undefined;
}

function tokenSummary(hours: HourRow[], cache: boolean, since: number) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const sum = (from: number) => {
    let fresh = 0;
    let cached = 0;
    for (const [t, input, output, read, write] of hours) {
      if (t + 3_600_000 <= from) continue;
      fresh += input + output;
      cached += read + write;
    }
    return cache ? `${compact(fresh + cached)} tokens (${compact(cached)} cached)` : `${compact(fresh)} new tokens`;
  };
  return { today: sum(midnight.getTime()), range: sum(since) };
}

function LoginCard({ account, stats, days, cache, now, statsError }: { account: Account; stats?: UsageStats; days: number; cache: boolean; now: number; statsError: boolean }) {
  const u = account.usage;
  const since = now - days * 86_400_000;
  const hours = (stats?.tokens.find((t) => t.accountId === account.id)?.hours ?? []) as HourRow[];
  const limits = (stats?.limits ?? []).filter((l) => l.accountId === account.id);
  const all: LimitSeries[] = [
    { kind: 'five_hour', label: '5-hour', className: 's1', samples: limits.find((l) => l.kind === 'five_hour')?.samples ?? [] },
    { kind: 'weekly', label: 'Weekly', className: 's2', samples: limits.find((l) => l.kind === 'weekly')?.samples ?? [] },
  ];
  const series = all.filter((s) => s.samples.length);
  const left = roomLeft(account);
  const summary = tokenSummary(hours, cache, since);
  const label = (kind: string) => `${kind} for ${account.title}`;

  return (
    <Card>
      <h3>
        <span title={account.configDir}>{account.title}</span>
        {account.plan && <Chip>{account.plan}</Chip>}
        {account.note && <Chip tone="warn">{account.note}</Chip>}
        {u?.blocked && <Chip tone="bad">At its limit</Chip>}
        {u?.stale && <Chip tone="warn" title="Token Stats has gone quiet, so this reading may be out of date">Reading may be out of date</Chip>}
        {u?.source === 'shared' && <Chip title="Another runner read this login more recently">From another runner</Chip>}
        <span className="ops-spacer" />
        {left !== undefined && <span className="usage-left" title="The tighter of its windows">{Math.round(left)}% left</span>}
      </h3>
      {account.email && !account.title.includes(account.email) && <Note>{account.email}</Note>}

      {u?.windows.length ? (
        <div className="ops-meters">
          {u.windows.map((w) => (
            <WindowMeter key={w.kind + w.title} w={w} now={now} />
          ))}
        </div>
      ) : (
        <Note>This login hasn't said how much room it has yet.</Note>
      )}
      {u?.notice && <Note tone="warn">{u.notice}</Note>}
      {u && <Note>Read {agoWords(Date.parse(u.readAt), now)}.</Note>}

      {stats && (
        <>
          <div>
            <h4>Tokens by the hour</h4>
            <Note>
              Today: {summary.today}. {RANGES.find((r) => r.days === days)?.label ?? `Last ${days} days`}: {summary.range}.
            </Note>
          </div>
          {hours.length ? (
            <>
              <TokensChart hours={hours} since={since} now={now} cache={cache} label={label('Tokens by the hour')} />
              <div className="usage-legend">
                <span><i className="usage-swatch fresh" />New tokens (input and output)</span>
                {cache && <span><i className="usage-swatch cache" />Cached tokens</span>}
              </div>
            </>
          ) : (
            <Note>No tokens recorded for this login in this time.</Note>
          )}

          <h4>How full its limits have been</h4>
          {series.length ? (
            <>
              <LimitsChart series={series} since={since} now={now} label={label('Limit readings')} />
              <div className="usage-legend">
                {series.map((s) => (
                  <span key={s.kind}><i className={`usage-swatch line ${s.className}`} />{s.label}</span>
                ))}
              </div>
            </>
          ) : (
            <Note>No limit readings for this login in this time.</Note>
          )}
        </>
      )}
      {!stats && statsError && <Note>The history charts aren't available, but the figures above are current.</Note>}
    </Card>
  );
}

function UsagePage({ store, snap }: PageProps) {
  const [days, setDays] = useState(7);
  const [cache, setCache] = useState(false);
  const now = useNow(60_000);
  const req = useRequest<UsageStats>(store, snap.conn, 'usage.stats', { days }, 60_000);
  const stats = req.data;
  const accounts = [...snap.accounts].sort((a, b) => a.provider.localeCompare(b.provider) || a.title.localeCompare(b.title));

  return (
    <div className="page ops usage">
      <div className="ops-col">
        <div className="ops-title">
          <h2>Usage</h2>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} title="How far back the charts go">
            {RANGES.map((r) => (
              <option key={r.days} value={r.days}>
                {r.label}
              </option>
            ))}
          </select>
          <label className="usage-check" title="Count cache reads and writes as well as input and output">
            <input type="checkbox" checked={cache} onChange={(e) => setCache(e.target.checked)} title="Count cache reads and writes as well as input and output" /> Count cached tokens
          </label>
          <button onClick={() => void req.reload()} disabled={req.loading || snap.conn !== 'open'} title="Ask the runner for the latest history">
            Refresh
          </button>
        </div>

        {stats && !stats.ready && <Note tone="warn">The runner is still reading the transcripts, so token counts are partial for now.</Note>}
        {req.error && !req.error.missing && <Problem error={req.error} what="The usage history" />}
        {req.error?.missing && <Note>This runner is older than the usage history, so there are no charts. The figures for each login still work.</Note>}

        {accounts.length === 0 ? (
          <Card>
            <Note>{snap.conn === 'open' ? 'No logins yet. Sign in to Claude Code on this machine and it shows up here.' : 'Waiting for the runner.'}</Note>
          </Card>
        ) : (
          accounts.map((a) => <LoginCard key={a.id} account={a} stats={stats} days={days} cache={cache} now={now} statsError={!!req.error} />)
        )}
      </div>
    </div>
  );
}

const page: PageDef = { id: 'usage', title: 'Usage', hint: "How much of each login's 5-hour and weekly limits is left, and what threads have cost", icon: '◔', foot: true, order: 63, renderIcon: (snap) => <HoneyPot level={potLevel(snap.accounts)} />, signal: (snap) => ({ tip: potTip(snap.accounts) }), Main: UsagePage };
export default page;
