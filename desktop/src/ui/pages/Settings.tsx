import { useState } from 'react';
import type { PageDef, PageProps } from '../registry.ts';
import { CliSection } from '../pages-lib/settings-cli.tsx';
import { DevicesSection } from '../pages-lib/settings-devices.tsx';
import { GeneralSection } from '../pages-lib/settings-general.tsx';
import { PoolsSection } from '../pages-lib/settings-pools.tsx';
import { AppSection } from '../pages-lib/settings-app.tsx';
import './settings.css';

const SECTIONS = [
  { id: 'general', label: 'General', Section: GeneralSection },
  { id: 'pools', label: 'Logins and pools', Section: PoolsSection },
  { id: 'cli', label: 'Claude Code updates', Section: CliSection },
  { id: 'devices', label: 'Phone and browser', Section: DevicesSection },
  { id: 'app', label: 'This app', Section: AppSection },
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
            <button key={s.id} role="tab" aria-selected={s.id === id} className={`ghost${s.id === id ? ' on' : ''}`} onClick={() => pick(s.id)} title={s.label}>
              {s.label}
            </button>
          ))}
        </div>
        <current.Section store={store} snap={snap} />
      </div>
    </div>
  );
}

const page: PageDef = { id: 'settings', title: 'Settings', icon: '⚙\uFE0E', order: 100, Main: SettingsPage };
export default page;
