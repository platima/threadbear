import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConvexProvider, ConvexReactClient } from 'convex/react';
import { App } from './App';
import { deploymentUrl } from './deployment';
import { PairScreen } from './pair';
import { takeTokenFromHash } from './token';
import { applyTheme } from './theme';
import './styles.css';

// A sign-in link (`npm run web:sign-in`) carries the token in the fragment,
// which never reaches a server. Keep it and wipe it from the address bar
// before anything renders.
takeTokenFromHash();
applyTheme();

// The website knows its deployment. The Android app learns it from the link
// that pairs it (pairing.ts), and until then has nothing to connect to.
const url = deploymentUrl();
const convex = url ? new ConvexReactClient(url) : undefined;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {convex ? (
      <ConvexProvider client={convex}>
        <App />
      </ConvexProvider>
    ) : (
      <PairScreen />
    )}
  </StrictMode>,
);
