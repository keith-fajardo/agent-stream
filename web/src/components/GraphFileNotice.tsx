import { formatFileErrors } from '@agent-stream/shared';
import { bootGraphId, sendHost } from '../bridge';
import { useStore } from '../store';

/** The graph's Markdown file has problems, or is gone (Markdown graph files spec §6.3, §6.5). */
export function GraphFileNotice() {
  const errors = useStore((s) => s.fileErrors);
  const gone = useStore((s) => s.graphGone);
  if (gone) return <div className="banner">This graph was deleted.</div>;
  if (!errors.length) return null;
  return (
    <div className="banner file-errors">
      {`The file ${bootGraphId()}.md has errors, so the last good version is shown. ${formatFileErrors(errors)} `}
      <button className="link" onClick={() => sendHost('openGraphMarkdown')}>
        Open as Markdown
      </button>
    </div>
  );
}
