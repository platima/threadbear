// The choices that sit with the message box: which model, how hard it thinks,
// and how much it may do without asking. For an open thread they change it
// (threads.update); for a new thread they are what it starts with.

import type { Account, EffortLevel, ModelChoice, PermissionMode, Provider } from '../../core/types.ts';
import { modelLabel } from '../../../../web/src/format.ts';
import { Menu } from './Menu.tsx';
import { modelMenuTip } from './modelTip.ts';

export const MODES: { id: PermissionMode; label: string; note: string }[] = [
  { id: 'ask', label: 'Ask first', note: 'Asks before it changes anything' },
  { id: 'auto', label: 'Auto', note: 'A second model approves or blocks each action' },
  { id: 'full', label: 'Full access', note: 'Does what it needs without asking' },
];

const LEVEL: Record<string, string> = { xhigh: 'Extra high' };
const cap = (s: string): string => LEVEL[s] ?? s.charAt(0).toUpperCase() + s.slice(1);

// The model the thread runs on, as the account lists it.
export function findModel(account: Account | undefined, id?: string, inUse?: string): ModelChoice | undefined {
  const list = account?.models ?? [];
  return list.find((m) => m.id === id) ?? list.find((m) => m.model === (inUse ?? id) || m.id === inUse);
}

export function ModelMenu({ account, provider, model, inUse, onPick, disabled, offline }: { account?: Account; provider?: Provider; model?: string; inUse?: string; onPick: (id: string | null) => void; disabled?: boolean; offline?: boolean }) {
  const list = account?.models ?? [];
  const current = findModel(account, model, inUse);
  const shown = inUse ?? model ?? account?.defaultModel;
  const label = current?.title ?? findModel(account, undefined, shown)?.title ?? (shown ? modelLabel(provider ?? account?.provider, shown) : 'Model');
  const def = findModel(account, undefined, account?.defaultModel);
  return (
    <Menu
      label={label}
      title={modelMenuTip({ offline, models: list.length, hasAccount: !!account })}
      disabled={disabled || !list.length}
      items={[
        { key: '', label: 'Default', note: def ? `Currently ${def.title}` : 'The login’s own choice', on: !model, onPick: () => onPick(null) },
        ...list.map((m) => ({ key: m.id, label: m.title, note: m.description, on: !!model && current?.id === m.id, onPick: () => onPick(m.id) })),
      ]}
    />
  );
}

export function EffortMenu({ account, model, inUse, effort, now, onPick, disabled }: { account?: Account; model?: string; inUse?: string; effort?: EffortLevel; now?: EffortLevel; onPick: (level: EffortLevel | null) => void; disabled?: boolean }) {
  const levels = (findModel(account, model, inUse) ?? findModel(account, undefined, account?.defaultModel))?.effortLevels ?? [];
  if (!levels.length) return null;
  const shown = effort ?? now;
  return (
    <Menu
      label={shown ? `${cap(shown)} effort` : 'Effort'}
      title="How hard the model thinks"
      disabled={disabled}
      items={[{ key: '', label: 'Default', note: 'The model’s own level', on: !effort, onPick: () => onPick(null) }, ...levels.map((l) => ({ key: l, label: cap(l), on: effort === l, onPick: () => onPick(l) }))]}
    />
  );
}

export function ModeMenu({ mode, onPick, disabled }: { mode: PermissionMode; onPick: (m: PermissionMode) => void; disabled?: boolean }) {
  const now = MODES.find((m) => m.id === mode);
  return <Menu label={now?.label ?? mode} title="How much it may do without asking" disabled={disabled} items={MODES.map((m) => ({ key: m.id, label: m.label, note: m.note, on: m.id === mode, onPick: () => onPick(m.id) }))} />;
}
