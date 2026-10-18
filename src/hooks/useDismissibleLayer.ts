import { useEffect, useRef, type RefObject } from 'react';

/** Keep interactions within a popup open; dismiss it when focus or input leaves. */
export function useDismissibleLayer(
  open: boolean,
  root: RefObject<HTMLElement | null>,
  onDismiss: () => void,
) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target))
        dismiss.current();
    };
    const blur = () => dismiss.current();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
      window.removeEventListener('blur', blur);
    };
  }, [open, root]);
}
