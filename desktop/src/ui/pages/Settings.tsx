import { useState } from 'react';
import { tip, type PageDef, type PageProps } from '../registry.ts';
import { CliSection } from '../pages-lib/settings-cli.tsx';
import { DevicesSection } from '../pages-lib/settings-devices.tsx';
import { GeneralSection } from '../pages-lib/settings-general.tsx';
import { PoolsSection } from '../pages-lib/settings-pools.tsx';
import { AppSection } from '../pages-lib/settings-app.tsx';
import './settings.css';

const SECTIONS = [
  { id: 'general', label: 'General', hint: "The runner's defaults: the folder new threads start in, idle sessions, titles, and how replies read", Section: GeneralSection },
  { id: 'pools', label: 'Logins and pools', hint: 'The logins the runner found, and pools that let a thread use whichever login has room', Section: PoolsSection },
  { id: 'cli', label: 'Claude Code updates', hint: 'Whether the runner keeps the claude program up to date, and when it last did', Section: CliSection },
  { id: 'devices', label: 'Phone and browser', hint: 'Pair a phone or a browser so it can read your threads, and sign one out', Section: DevicesSection },
  { id: 'app', label: 'This app', hint: "This app's version and its own options: Exit on close and the daily update check", Section: AppSection },
];

function SettingsPage({ store, snap }: PageProps) {
  const [id, setId] = useState(() => {
    const wanted = location.hash.split('/')[2];
    return SECTIONS.some((s) => s.id === wanted) ? wanted! : 'general';
  });
  const current = SECTIONS.find((s) => s.id === id) ?? SECTIONS[0]!;
  const pick = (next: string) => {
    setId(next);
    history.replaceState(null, '', `#/settings/${next}`);
  };
  return (
    <div className="page ops settings">
      <div className="ops-col">
        <div className="ops-title">
          <h2>Settings</h2>
        </div>
        <div className="set-tabs" role="tablist">
          {SECTIONS.map((s) => (
            <button key={s.id} role="tab" aria-selected={s.id === id} className={`ghost${s.id === id ? ' on' : ''}`} onClick={() => pick(s.id)} title={tip(s.label, s.hint)}>
              {s.label}
            </button>
          ))}
        </div>
        <current.Section store={store} snap={snap} />
      </div>
    </div>
  );
}

const page: PageDef = { id: 'settings', title: 'Settings', hint: "The runner's defaults, your logins and pools, pairing a phone or browser, and this app's own options", icon: '⚙\uFE0E', foot: true, order: 100, Main: SettingsPage };
export default page;
