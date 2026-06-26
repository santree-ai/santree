/** The file browser shown beside a worktree's terminal/diff. */
import { branchFor } from "../../lib/format";
import { useFileTree } from "../../lib/queries";
import { useTrees } from "./model";

export function FileTreePanel() {
  const { data: files = [] } = useFileTree();
  const { activeId } = useTrees();

  return (
    <div className="w-[236px] flex-none overflow-y-auto border-r border-line bg-deep px-2 py-2.5">
      <div className="px-1.5 pb-2 font-mono text-[10px] tracking-[.06em] text-muted-4 uppercase">
        Files · {branchFor(activeId)}
      </div>
      {files.map((f) => (
        <div
          key={`${f.depth}-${f.name}`}
          className="flex cursor-default items-center gap-1.5 rounded-[5px] px-1.5 py-[3px] font-mono text-[11.5px] hover:bg-hover"
          style={{
            paddingLeft: 8 + f.depth * 14,
            color: f.dir ? "var(--color-fg-2)" : "var(--color-muted)",
          }}
        >
          <span
            className="flex-none"
            style={{ color: f.dir ? "var(--accent)" : "var(--color-muted-5)" }}
          >
            {f.icon}
          </span>
          <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{f.name}</span>
          {f.modified && <span className="text-[10px] text-status-amber">M</span>}
        </div>
      ))}
    </div>
  );
}
