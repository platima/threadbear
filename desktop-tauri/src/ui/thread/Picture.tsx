import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AppStore } from '../../core/store.ts';
import type { ImageRef } from '../../core/types.ts';
import { fileName, useImage } from './images.ts';
import './thread.css';

// A picture from the runner's machine, loaded when it comes near the screen
// and opened full size by a click.
export const Picture = memo(function Picture({ store, image, className = '', label }: { store: AppStore; image: ImageRef; className?: string; label?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [big, setBig] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver((hits) => hits.some((h) => h.isIntersecting) && setNear(true), { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  const name = label ?? fileName(image.path);
  const isPicture = !image.mediaType || image.mediaType.startsWith('image/');
  const { url, error } = useImage(store, image, near && isPicture);
  if (!isPicture) {
    return (
      <div ref={box} className={`pic ${className}`}>
        <div className="pic-fail" title={`${image.path}. Open it on the runner's machine.`}>
          {image.mediaType.startsWith('video/') ? 'Video' : 'File'}: {fileName(image.path)}
        </div>
      </div>
    );
  }
  const ratio = image.width && image.height ? `${image.width} / ${image.height}` : undefined;
  return (
    <div ref={box} className={`pic ${className}`} style={ratio && !url ? { aspectRatio: ratio } : undefined}>
      {url ? (
        <img src={url} alt={name} title={`${name}. Click to see it larger.`} onClick={() => setBig(true)} draggable={false} />
      ) : error ? (
        <div className="pic-fail" title={error}>
          Can't show {name}
        </div>
      ) : (
        <div className="pic-wait" title={`Loading ${name}`} />
      )}
      {big && url && <Lightbox url={url} name={name} close={() => setBig(false)} />}
    </div>
  );
});

function Lightbox({ url, name, close }: { url: string; name: string; close: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  return createPortal(
    <div className="lightbox" role="dialog" aria-label={name} title="Click to close" onClick={close}>
      <img src={url} alt={name} />
    </div>,
    document.body,
  );
}
