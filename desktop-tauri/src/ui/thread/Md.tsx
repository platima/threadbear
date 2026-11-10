import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mdComponents } from './mdComponents.tsx';

const plugins = [remarkGfm];

export const Md = memo(function Md({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={plugins} components={mdComponents}>
        {text}
      </Markdown>
    </div>
  );
});
