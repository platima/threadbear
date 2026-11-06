import { PAGES } from './registry.ts';

const mod = navigator.platform.toLowerCase().includes('mac') ? 'Cmd' : 'Ctrl';

export function Shortcuts({ onClose, onTour }: { onClose: () => void; onTour: () => void }) {
  const rows: [string, string][] = [
    [`${mod}+N`, 'New thread'],
    [`${mod}+K`, 'Search threads'],
    ['Up, Down', 'Next or previous thread, with the sidebar focused'],
    [`${mod}+1 to ${mod}+${Math.min(9, PAGES.length + 1)}`, 'Threads, then each page in the rail'],
    ['Enter', 'Send'],
    ['Shift+Enter', 'New line'],
    [`${mod}+/`, 'This list'],
    ['Esc', 'Close this list'],
  ];
  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <h2>Keyboard shortcuts</h2>
        <table>
          <tbody>
            {rows.map(([k, what]) => (
              <tr key={k}>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ margin: '12px 0 0' }}>
          <button title="Add three sample threads and walk through the window" onClick={onTour}>
            Take the tour
          </button>
        </p>
      </div>
    </div>
  );
}
