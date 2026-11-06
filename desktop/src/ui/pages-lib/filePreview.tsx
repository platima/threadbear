// A preview of a file on the runner's machine: a picture, a Markdown page, an
// HTML page (shown with scripts off), or text. Used by the Highlights, Actions
// and Files panes.
import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mdComponents } from '../thread/mdComponents.tsx';
import type { AppStore } from '../../core/store.ts';
import { baseName } from './pathStyle.ts';
import { errorText, formatSize, saveCopy, useRunnerFile, type LoadedFile } from './runnerFiles.ts';
import './filePreview.css';

const plugins = [remarkGfm];
const MAX_LINES = 4000;

// A small arrow that points right when closed and down when open.
export function Chev({ open }: { open: boolean }) {
  return (
    <svg className="chev" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ transform: open ? 'rotate(90deg)' : undefined, flex: 'none' }}>
      <path d="M3.5 1.5L7 5L3.5 8.5" />
    </svg>
  );
}

function Rendered({ text }: { text: string }) {
  return (
    <div className="md fp-md">
      <Markdown remarkPlugins={plugins} components={mdComponents}>
        {text}
      </Markdown>
    </div>
  );
}

function Source({ text }: { text: string }) {
  let shown = text;
  let cut = false;
  const lines = text.split('\n');
  if (lines.length > MAX_LINES) {
    shown = lines.slice(0, MAX_LINES).join('\n');
    cut = true;
  }
  return (
    <>
      <pre className="fp-text">{shown}</pre>
      {cut && <div className="fp-note">Showing the first {MAX_LINES.toLocaleString()} lines.</div>}
    </>
  );
}

function Body({ file, name, source }: { file: LoadedFile; name: string; source: boolean }) {
  const [full, setFull] = useState(false);
  if (file.kind === 'image' && file.url) {
    return (
      <div className={`fp-img ${full ? 'full' : ''}`}>
        <img src={file.url} alt={name} title={full ? 'Fit to the pane' : 'Show at full size'} onClick={() => setFull(!full)} />
      </div>
    );
  }
  if (file.kind === 'binary') {
    return <div className="fp-note">No preview for this kind of file ({formatSize(file.size)}).</div>;
  }
  const text = file.text ?? '';
  if (!text.trim()) return <div className="fp-note">This file is empty.</div>;
  if (file.kind === 'markdown' && !source) return <Rendered text={text} />;
  if (file.kind === 'html' && !source) {
    // sandbox="" switches off scripts, forms, popups and the page's own origin.
    return <iframe className="fp-html" title={`${name}, as a page`} sandbox="" srcDoc={text} />;
  }
  return <Source text={text} />;
}

export function FilePreview({ store, path, compact }: { store: AppStore; path: string; compact?: boolean }) {
  const [tries, setTries] = useState(0);
  const [source, setSource] = useState(false);
  const [saving, setSaving] = useState<string>();
  const st = useRunnerFile(store.rpc, path, tries);
  const name = baseName(path);
  if (st.status === 'loading') return <div className="fp-note">Loading...</div>;
  if (st.status === 'error') {
    return (
      <div className="fp-note fp-bad">
        {st.message}{' '}
        <button className="ghost" title="Try reading the file again" onClick={() => setTries(tries + 1)}>
          Try again
        </button>
      </div>
    );
  }
  const file = st.file;
  const togglable = file.kind === 'markdown' || file.kind === 'html';
  return (
    <div className={`fp ${compact ? 'compact' : ''}`}>
      <div className="fp-bar">
        <span className="fp-meta">
          {formatSize(file.size)}
          {file.truncated && file.kind !== 'binary' ? `, showing the first ${formatSize(file.bytes.length)}` : ''}
        </span>
        <span className="grow" />
        {togglable && (
          <>
            <button className={`ghost ${source ? '' : 'on'}`} title={file.kind === 'html' ? 'Show the page' : 'Show it formatted'} onClick={() => setSource(false)}>
              {file.kind === 'html' ? 'Page' : 'Formatted'}
            </button>
            <button className={`ghost ${source ? 'on' : ''}`} title="Show the file's own text" onClick={() => setSource(true)}>
              Source
            </button>
          </>
        )}
        <button
          className="ghost"
          title="Save a copy of this file to your downloads"
          disabled={saving === 'busy'}
          onClick={() => {
            setSaving('busy');
            saveCopy(store.rpc, file, name).then(
              () => setSaving(undefined),
              (e) => setSaving(errorText(e, 'send files')),
            );
          }}
        >
          Save a copy
        </button>
        <button className="ghost" title="Read the file again" onClick={() => setTries(tries + 1)}>
          Reload
        </button>
      </div>
      {saving && saving !== 'busy' && <div className="fp-note fp-bad">{saving}</div>}
      <Body file={file} name={name} source={source} />
    </div>
  );
}
