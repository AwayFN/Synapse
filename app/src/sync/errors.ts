/**
 * Les erreurs de l'application remontent à l'espace créateur (message technique et pile d'appels,
 * jamais le contenu du cerveau), pour que le créateur puisse corriger ce qui casse chez les autres.
 */
let installed = false;
let sent = 0;
let build = '';
const seen = new Set<string>();

/** Une erreur rattrapée par l'application (ex. la 3D qui ne démarre pas) : remonte aussi, sans rien casser */
export function reportError(err: unknown, where = '') {
  const e = err as { message?: string; stack?: string } | undefined;
  if (!installed) return;
  report(`${where ? `${where} : ` : ''}${String(e?.message ?? err ?? 'erreur')}`, String(e?.stack ?? ''), build);
}

function report(message: string, stack: string, version: string) {
  const key = `${message}|${stack.split('\n')[1] ?? ''}`;
  if (seen.has(key) || sent >= 20) return;
  seen.add(key);
  sent++;
  void fetch('/api/errors', {
    method: 'POST',
    headers: { 'X-Synapse': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: message.slice(0, 400), stack: stack.slice(0, 3000), where: location.pathname, version }),
    credentials: 'same-origin',
    keepalive: true,
  }).catch(() => {});
}

export function installErrorReporter(version: string) {
  if (installed) return;
  installed = true;
  build = version;
  window.addEventListener('error', (e) => {
    if (!e.error && !e.message) return;
    report(String(e.message || e.error?.message || 'erreur'), String(e.error?.stack || `${e.filename}:${e.lineno}:${e.colno}`), version);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string; stack?: string } | undefined;
    // les coupures réseau ne sont pas des bugs
    if (r && /Failed to fetch|NetworkError|Load failed|api \d+/.test(String(r.message))) return;
    report(String(r?.message ?? r ?? 'promesse rejetée'), String(r?.stack ?? ''), version);
  });
}
