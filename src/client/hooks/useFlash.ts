'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Returns an animation class when `value` changes: green flash when it rises,
 * red when it falls. Used to make live updates visible without re-rendering
 * whole tables.
 */
export function useFlash(value: number | null | undefined): string {
  const prev = useRef(value);
  const [cls, setCls] = useState('');
  const [key, setKey] = useState(0);

  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (typeof before !== 'number' || typeof value !== 'number' || before === value) return;
    setCls(value > before ? 'animate-flash-up' : 'animate-flash-down');
    setKey((k) => k + 1);
  }, [value]);

  useEffect(() => {
    if (!cls) return;
    const t = setTimeout(() => setCls(''), 900);
    return () => clearTimeout(t);
  }, [cls, key]);

  return cls;
}
