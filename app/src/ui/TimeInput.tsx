import { useEffect, useRef, useState } from 'react';
import { fmtTime, parseTime } from '../lib/time';

interface Props {
  value: number | null;
  onChange: (min: number | null) => void;
  placeholder?: string;
  allowEmpty?: boolean;
  className?: string;
  title?: string;
}

/**
 * Free-form time field: accepts "12h01", "12:01", "1201", "905", "9h", "midi"…
 * ↑/↓ = ±1 min (Shift = ±15 min). Any minute is valid — no 15-min grid.
 */
export function TimeInput({ value, onChange, placeholder = '12h01', allowEmpty, className = '', title }: Props) {
  const [text, setText] = useState(value == null ? '' : fmtTime(value));
  const [invalid, setInvalid] = useState(false);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(value == null ? '' : fmtTime(value));
  }, [value]);

  const commit = () => {
    const t = text.trim();
    if (!t) {
      if (allowEmpty) {
        setInvalid(false);
        if (value != null) onChange(null);
      } else setText(value == null ? '' : fmtTime(value));
      return;
    }
    const m = parseTime(t);
    if (m == null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setText(fmtTime(m));
    if (m !== value) onChange(m);
  };

  return (
    <input
      className={`field field-mono text-center ${invalid ? 'is-invalid' : ''} ${className}`}
      value={text}
      placeholder={placeholder}
      title={title ?? 'Heure libre : 12h01, 17:38, 2247…  ↑/↓ = ±1 min'}
      spellCheck={false}
      inputMode="numeric"
      onFocus={(e) => {
        focused.current = true;
        e.currentTarget.select();
      }}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onChange={(e) => {
        setText(e.target.value);
        if (invalid) setInvalid(parseTime(e.target.value) == null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          e.currentTarget.blur();
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const base = parseTime(text) ?? value ?? 12 * 60;
          const step = e.shiftKey ? 15 : 1;
          const m = (base + (e.key === 'ArrowUp' ? step : -step) + 1440) % 1440;
          setText(fmtTime(m));
          setInvalid(false);
          onChange(m);
        } else if (e.key === 'Escape') {
          setText(value == null ? '' : fmtTime(value));
          setInvalid(false);
        }
      }}
    />
  );
}
