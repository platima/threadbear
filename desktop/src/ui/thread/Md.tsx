import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const plugins = [remarkGfm];

export const Md = memo(function Md({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={plugins} components={{ a: (p) => <a {...p} target="_blank" rel="noopener noreferrer" /> }}>
        {text}
      </Markdown>
    </div>
  );
});
