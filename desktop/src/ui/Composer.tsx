import { useEffect, useRef, useState } from 'react';
import type { AppStore, Snapshot } from '../core/store.ts';
import type { PermissionMode } from '../core/types.ts';

export function Composer({ store, snap, busy = false }: { store: AppStore; snap: Snapshot; busy?: boolean }) {
  const [text, setText] = useState('');
  const [cwd, setCwd] = useState('');
  const [accountId, setAccountId] = useState('');
  const [mode, setMode] = useState<PermissionMode>('ask');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const area = useRef<HTMLTextAreaElement>(null);
  const existing = snap.selected;
  const defaults = snap.hello?.defaults;

  // Each thread keeps its own draft until it is sent.
  const drafts = useRef(new Map<string | undefined, string>());
  const was = useRef(existing);
  const current = useRef(text);
  current.current = text;
  useEffect(() => {
    drafts.current.set(was.current, current.current);
    was.current = existing;
    setText(drafts.current.get(existing) ?? '');
    area.current?.focus();
  }, [existing]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const online = snap.conn === 'open';
  const send = async () => {
    const body = text.trim();
    if (!body || sending || !online) return;
    setSending(true);
    setError(undefined);
    try {
      if (existing) await store.send(existing, body);
      else await store.create(body, { cwd: cwd.trim() || defaults?.cwd, accountId: accountId || undefined, permissionMode: mode });
      setText('');
      drafts.current.delete(existing);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="composer">
      <div className="box">
        <textarea
          ref={area}
          rows={1}
          placeholder={existing ? 'Message' : 'What would you like done?'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="bar">
          {!existing && (
            <>
              <input title="Folder" placeholder={defaults?.cwd ?? 'Folder'} value={cwd} onChange={(e) => setCwd(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
              <select title="Login" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">Login: {defaults?.accountId ?? 'default'}</option>
                {snap.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                  </option>
                ))}
              </select>
              <select title="Access" value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
                <option value="ask">Ask first</option>
                <option value="auto">Auto</option>
                <option value="full">Full access</option>
              </select>
            </>
          )}
          <span className="grow" />
          {error && <span className="error">{error}</span>}
          {existing && busy && <button onClick={() => void store.interrupt(existing)}>Stop</button>}
          <button className="primary" disabled={!text.trim() || sending || !online} onClick={() => void send()}>
            {existing && busy ? 'Send now' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
