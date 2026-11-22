import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './index.css';
import { App } from './App';
import { bootstrap } from './sync/boot';
import { AuthScreen, BootScreen, JoinScreen, MaintenanceScreen, OfflineScreen, ResetScreen, SetupScreen, SuspendedScreen } from './ui/Gate';

const root = createRoot(document.getElementById('root')!);
root.render(<BootScreen />);

// Servi par le serveur Synapse (scripts/synapse.mjs sur le PC, scripts/serveur-public.mjs en ligne) :
// le serveur garde les cerveaux, les comptes et les partages.
// Sans serveur Synapse (développement), l'application fonctionne seule, dans ce navigateur.
bootstrap().then((b) => {
  switch (b.kind) {
    case 'join':
      return root.render(<JoinScreen token={b.token} info={b.info} hello={b.hello} />);
    case 'auth':
      return root.render(<AuthScreen hello={b.hello} code={b.code} codeInfo={b.codeInfo} />);
    case 'setup':
      return root.render(<SetupScreen token={b.token} />);
    case 'reset':
      return root.render(<ResetScreen token={b.token} info={b.info} />);
    case 'maintenance':
      return root.render(<MaintenanceScreen hello={b.hello} />);
    case 'suspended':
      return root.render(<SuspendedScreen />);
    case 'offline':
      return root.render(<OfflineScreen ownerName={b.ownerName} />);
    default:
      return root.render(<App />);
  }
});
