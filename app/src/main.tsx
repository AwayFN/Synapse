import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './index.css';
import { App } from './App';
import { AppGuard } from './ui/Crash';
import { installBack } from './lib/back';

/**
 * Synapse V8 : 100 % local. Pas de compte, pas de serveur, pas de connexion : l'application s'ouvre directement sur
 * ton réseau, gardé sur cet appareil (le PC ou le téléphone).
 */
// Échap (et le bouton retour du téléphone) ferment ce qui est ouvert
installBack();
createRoot(document.getElementById('root')!).render(
  <AppGuard>
    <App />
  </AppGuard>,
);
