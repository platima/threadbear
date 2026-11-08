// The row in the settings menu that turns notifications on for this phone. It
// shows only in the Android app, and only when that build has a Firebase project
// (push.ts asks the shell). Turning it on asks Android for permission, then
// tells the person's own backend about this phone: its Firebase token and its
// own push key, which the backend seals each notification with
// (convex/push.ts; docs/push-relay.md).
import { useEffect, useState } from 'react';
import { useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { isApp } from './deployment';
import { MenuChoice } from './menu';
import { PUSH_API_VERSION, pushRegister, pushStatus, saveToken, savedToken, type PushStatus } from './push';
import * as Icon from './icons';

export function PushRow({ token, apiVersion }: { token: string; apiVersion: number | undefined }) {
  const register = useMutation(api.phone.registerDevice);
  const setNotifications = useMutation(api.phone.setNotifications);
  const [status, setStatus] = useState<PushStatus | undefined>();
  const [on, setOn] = useState(() => Boolean(savedToken()));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  // An older backend refuses an Android phone's registration
  const backendKnows = apiVersion !== undefined && apiVersion >= PUSH_API_VERSION;

  useEffect(() => {
    if (isApp) void pushStatus().then(setStatus);
  }, []);

  // A phone with it on tells its backend again each time the app opens, as the
  // Firebase token can change. Never asks for the permission: if it was taken
  // away, the row just says off the next time it is turned on.
  useEffect(() => {
    if (!on || !backendKnows || status?.available !== true || status.permission !== 'granted') return;
    let stale = false;
    pushRegister()
      .then(async (r) => {
        if (stale) return;
        await register({ token, apnsToken: r.token, environment: 'production', pushKey: r.key, platform: 'android' });
        saveToken(r.token);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, on, backendKnows, token]);

  if (!isApp || status?.available !== true) return null;

  const toggle = async () => {
    if (busy || !backendKnows) return;
    setBusy(true);
    setProblem(undefined);
    try {
      if (on) {
        const saved = savedToken();
        if (saved) await setNotifications({ token, apnsToken: saved, notify: 'off' });
        saveToken(undefined);
        setOn(false);
      } else {
        const r = await pushRegister();
        await register({ token, apnsToken: r.token, environment: 'production', pushKey: r.key, platform: 'android' });
        // A phone that was turned off before is back to the usual setting
        await setNotifications({ token, apnsToken: r.token, notify: 'away' });
        saveToken(r.token);
        setOn(true);
        setStatus(await pushStatus());
      }
    } catch (e) {
      setProblem(e instanceof Error && e.message ? e.message : 'Notifications could not be changed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <hr />
      <MenuChoice
        icon={<Icon.Bolt />}
        label="Notifications on this phone"
        note={!backendKnows ? 'Needs a newer backend' : busy ? 'Working' : on ? 'On' : 'Off'}
        on={on}
        pick={() => void toggle()}
      />
      {problem ? <div className="note-line bad">{problem}</div> : null}
    </>
  );
}
