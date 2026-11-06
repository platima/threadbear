import { createRoot } from 'react-dom/client';
import { RpcClient, bridgeTransport } from './core/rpc.ts';
import { AppStore } from './core/store.ts';
import { App } from './ui/App.tsx';
import './ui/styles.css';

const rpc = new RpcClient(() => bridgeTransport());
const store = new AppStore(rpc);
store.start();
// For scripted checks (docs/windows-port-plan.md): the same store the page uses.
(window as unknown as { __store: AppStore }).__store = store;

createRoot(document.getElementById('root')!).render(<App store={store} />);
