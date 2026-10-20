import { useEffect, useState } from 'react';

export type Layout = 'wide' | 'medium' | 'small';

/** wide: both panels inline (>= 1280px); medium: left panel inline, inspector as an overlay (768-1279px); small: both as overlays (< 768px). */
export function useLayout(): Layout {
  const calc = (): Layout => (window.innerWidth >= 1280 ? 'wide' : window.innerWidth >= 768 ? 'medium' : 'small');
  const [l, setL] = useState<Layout>(calc);
  useEffect(() => {
    const on = () => setL(calc());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return l;
}
