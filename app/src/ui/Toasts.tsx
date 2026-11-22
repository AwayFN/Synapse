import { useUI } from '../store/ui';
import { cvar } from './common';

export function Toasts() {
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismissToast);
  return (
    <div className="fixed left-1/2 -translate-x-1/2 bottom-24 z-[60] flex flex-col items-center gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="glass neon anim-pop pointer-events-auto flex items-center gap-3 pl-3.5 pr-2 py-2"
          style={cvar(t.color ?? '#00e5ff')}
          data-ui
        >
          <span className="dot" />
          <span className="hud text-[10.5px] text-white/85 max-w-[460px] truncate">{t.text}</span>
          {t.action && (
            <button
              className="btn btn-primary !py-1 !px-2 !text-[9.5px]"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="text-white/30 hover:text-white px-1 text-xs" onClick={() => dismiss(t.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
