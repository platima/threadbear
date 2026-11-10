import { useEffect, useState } from 'react';
import type { PageDef, PageProps } from '../registry.ts';
import { isNative, openExternal } from '../../core/native.ts';
import { Card, Note } from '../pages-lib/ops-ui.tsx';
import { buttonTitle, emptyLine, host, manageUrl, needsYou, quiet, serviceUrl, stateLine, tooltip } from '../pages-lib/connectors-text.ts';

// An address in the person's browser: through the shell in the installed app, in a new tab otherwise.
const open = (url: string) => (isNative() ? void openExternal(url) : void window.open(url, '_blank', 'noopener,noreferrer'));

// The services the runner's Connectors gateway gives the agents, and which of them need
// signing in (the Mac app's Connectors panel). Only for a runner that has a gateway set up
// (docs/protocol.md, "Connectors"). The app never calls the gateway: the runner looks every
// few minutes, and when this page opens or its refresh button is pressed.
function ConnectorsPage({ store, snap }: PageProps) {
  const status = snap.connectors;
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (snap.conn === 'open') void store.loadConnectors(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.conn]);
  const refresh = async () => {
    setBusy(true);
    try {
      await store.loadConnectors(true);
    } finally {
      setBusy(false);
    }
  };
  const manage = manageUrl(status);
  const empty = emptyLine(status);
  return (
    <div className="page ops">
      <div className="ops-col">
        <div className="ops-title">
          <h2>Connectors</h2>
        </div>
        <Card>
          <div className="ops-row">
            <h3 className="grow">{host(status) ?? 'Gateway'}</h3>
            {manage && (
              <button className="ghost" onClick={() => open(manage)} title={`Manage connectors on ${host(status) ?? 'the gateway'}: its own page, to connect, sign out or retry a service`}>
                Manage
              </button>
            )}
            <button onClick={() => void refresh()} disabled={busy || snap.conn !== 'open'} title="Ask the runner to check the gateway again now">
              {busy ? 'Checking...' : 'Check now'}
            </button>
          </div>
          {empty && !status?.services.length && <Note tone={status?.state === 'unreachable' ? 'bad' : undefined}>{empty}</Note>}
          {status?.services.map((service) => {
            const button = buttonTitle(service);
            const url = serviceUrl(status, service);
            return (
              <div className="ops-row" key={service.id}>
                <span className="grow">
                  <b>{service.title}</b> <span className="ops-dim">{stateLine(service)}</span>
                  {service.message && service.state !== 'connected' && <div className="ops-sub">{service.message}</div>}
                </span>
                {button && url ? (
                  <button className={service.state === 'signed_out' ? 'primary' : undefined} onClick={() => open(url)} title={`Open ${service.title}'s sign-in page in your browser`}>
                    {button}
                  </button>
                ) : url ? (
                  <button className="ghost" onClick={() => open(url)} title={`Open ${service.title}'s page on ${host(status) ?? 'the gateway'} to sign out or reconnect`}>
                    Open
                  </button>
                ) : null}
              </div>
            );
          })}
          <Note>
            These are the services your agents get from the Connectors gateway{host(status) ? ` on ${host(status)}` : ''}. Connect opens a service's sign-in page in your browser. When an agent runs into a service that needs signing in, it asks you with a link to the page. claude.ai's own connectors are signed in on claude.ai, for each login.
            {status?.checkedAt && ` Last checked ${new Date(status.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`}
          </Note>
        </Card>
      </div>
    </div>
  );
}

const page: PageDef = {
  id: 'connectors',
  title: 'Connectors',
  hint: 'The services your agents get from your Connectors gateway, and which need signing in',
  icon: '🔌',
  foot: true,
  order: 60,
  // Only for a runner that has a gateway: with none, the button would be clutter.
  available: (snap) => !!snap.connectors && snap.connectors.state !== 'off',
  signal: (snap) => (needsYou(snap.connectors) ? { dot: 'accent', tip: tooltip(snap.connectors) } : quiet(snap.connectors) ? { dot: 'quiet', tip: tooltip(snap.connectors) } : undefined),
  Main: ConnectorsPage,
};
export default page;
