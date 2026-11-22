import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './index.css';
import { App } from './App';
import { bootstrap } from './sync/boot';
import { AuthScreen, BootScreen, FirstRunScreen, JoinScreen, MaintenanceScreen, OfflineScreen, ResetScreen, SetupScreen, SuspendedScreen } from './ui/Gate';
import { AppGuard } from './ui/Crash';

const root = createRoot(document.getElementById('root')!);
const show = (node: ReactNode) => root.render(<AppGuard>{node}</AppGuard>);
show(<BootScreen />);

// Servi par le serveur Synapse (scripts/synapse.mjs sur le PC, scripts/serveur-public.mjs en ligne) :
// le serveur garde les cerveaux, les comptes et les partages.
// Sans serveur Synapse (développement), l'application fonctionne seule, dans ce navigateur.
bootstrap().then((b) => {
  switch (b.kind) {
    case 'first':
      return show(<FirstRunScreen hello={b.hello} />);
    case 'join':
      return show(<JoinScreen token={b.token} info={b.info} hello={b.hello} />);
    case 'auth':
      return show(<AuthScreen hello={b.hello} code={b.code} codeInfo={b.codeInfo} linkError={b.linkError} />);
    case 'setup':
      return show(<SetupScreen token={b.token} />);
    case 'reset':
      return show(<ResetScreen token={b.token} info={b.info} />);
    case 'maintenance':
      return show(<MaintenanceScreen hello={b.hello} />);
    case 'suspended':
      return show(<SuspendedScreen />);
    case 'offline':
      return show(<OfflineScreen ownerName={b.ownerName} />);
    default:
      return show(<App />);
  }
});

// Sur le PC qui fait tourner Synapse : tant que cette connexion est ouverte, le serveur sait qu'une fenêtre
// a encore besoin de lui ; il s'arrête tout seul après la fermeture de la dernière (sauf partage ouvert).
// Ailleurs (pas de point d'accès), le navigateur abandonne après une requête.
if (import.meta.env.PROD && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
  try {
    new EventSource('/__alive');
  } catch {
    /* pas servi par le lanceur */
  }
}
