import type { MouseEvent } from "react";
import { Icon } from "@/components/ui/Icon";
import { providerOf, type ProviderIndex } from "@/lib/view-model";

const MAX_CIRCLES = 3;

type ProviderCirclesProps = {
  ids: readonly string[];
  ownerLabel: string;
  providerIndex: ProviderIndex;
  expanded: boolean;
  onToggle: (trigger: HTMLButtonElement) => void;
};

/** Up to three circles; with more providers, the third becomes a button that lists them all. */
export function ProviderCircles({ ids, ownerLabel, providerIndex, expanded, onToggle }: ProviderCirclesProps) {
  const overflow = ids.length > MAX_CIRCLES;
  const shown = overflow ? ids.slice(0, MAX_CIRCLES - 1) : ids;

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onToggle(event.currentTarget);
  };

  return (
    <>
      {shown.map((id) => {
        const provider = providerOf(providerIndex, id);
        return (
          <span key={id} className="provider-circle" title={provider.name}>
            <Icon name={provider.mark} />
          </span>
        );
      })}
      {overflow && (
        <button
          className="provider-circle provider-overflow"
          aria-label={`Show all ${ids.length} providers for ${ownerLabel}`}
          aria-expanded={expanded}
          onClick={toggle}
        >
          <svg viewBox="0 0 24 24" className="overflow-dots" aria-hidden="true">
            <circle cx="6" cy="12" r="1.7" />
            <circle cx="12" cy="12" r="1.7" />
            <circle cx="18" cy="12" r="1.7" />
          </svg>
        </button>
      )}
    </>
  );
}
