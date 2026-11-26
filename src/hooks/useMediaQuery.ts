import { useCallback, useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener('change', onStoreChange);
      return () => mq.removeEventListener('change', onStoreChange);
    },
    [query]
  );

  const getSnapshot = useCallback(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  }, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function useViewportBreakpoints() {
  const isSmOrLarger = useMediaQuery('(min-width: 640px)');
  const isLgOrLarger = useMediaQuery('(min-width: 1024px)');
  return {
    isMobile: !isSmOrLarger,
    isTablet: isSmOrLarger && !isLgOrLarger,
    isDesktop: isLgOrLarger,
  };
}
