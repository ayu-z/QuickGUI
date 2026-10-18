import { useLayoutEffect, useRef, useState } from 'react';
import { commandForKey, type CommandItem, type DesignerCommand, type Point } from './commands';
import { useDismissibleLayer } from '../hooks/useDismissibleLayer';

export function ContextMenu({
  point,
  items,
  onCommand,
  onClose,
}: {
  point: Point;
  items: CommandItem[];
  onCommand: (command: DesignerCommand) => void;
  onClose: () => void;
}) {
  const element = useRef<HTMLDivElement>(null),
    previous = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState(point);
  useDismissibleLayer(true, element, onClose);
  useLayoutEffect(() => {
    previous.current = document.activeElement as HTMLElement;
    const menu = element.current!;
    const bounds = menu.getBoundingClientRect();
    setPosition({
      x: Math.max(6, Math.min(point.x, innerWidth - bounds.width - 6)),
      y: Math.max(6, Math.min(point.y, innerHeight - bounds.height - 6)),
    });
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => {
      if (document.activeElement === document.body || menu.contains(document.activeElement))
        previous.current?.focus();
    };
  }, []);
  return (
    <div
      ref={element}
      className="qg-context-menu"
      role="menu"
      aria-label="Canvas actions"
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          onClose();
          return;
        }
        const command = commandForKey(event.nativeEvent);
        if (command) {
          event.preventDefault();
          if (items.some((item) => item.id === command && !item.disabled)) {
            onCommand(command);
            onClose();
          }
          return;
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const buttons = [
            ...element.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
          ];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement),
            next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                    buttons.length;
          buttons[next]?.focus();
        }
      }}
    >
      {items.map((item) => (
        <div key={item.id} className={item.divider ? 'qg-menu-group' : ''}>
          <button
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onCommand(item.id);
              onClose();
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && <kbd>{item.shortcut}</kbd>}
          </button>
        </div>
      ))}
    </div>
  );
}
