import { Icon } from "@/components/ui/Icon";

export function UnderTree({ note }: { note: string }) {
  return (
    <div className="under-tree">
      <span>{note}</span>
      <span>
        {"Built on ENS "}
        <span className="ens-mark">
          <Icon name="ens" />
        </span>
      </span>
    </div>
  );
}
