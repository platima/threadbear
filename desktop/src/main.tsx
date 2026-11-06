import { createRoot } from 'react-dom/client';
import { RpcClient, bridgeKey, bridgeTransport } from './core/rpc.ts';
import { AppStore } from './core/store.ts';
import { openLinksOutside } from './core/native.ts';
import { App } from './ui/App.tsx';
import './ui/styles.css';

openLinksOutside();
bridgeKey(); // reads the launch key from the address before the page's own routes do
const rpc = new RpcClient(() => bridgeTransport());
const store = new AppStore(rpc);
store.start();
// For scripted checks (docs/windows-port-plan.md): the same store the page uses.
(window as unknown as { __store: AppStore }).__store = store;

createRoot(document.getElementById('root')!).render(<App store={store} />);
