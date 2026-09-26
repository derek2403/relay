import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/ui/Icon";
import { providerOf, type OrgNodeView, type ProviderIndex } from "@/lib/view-model";

const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 8;

type ProviderPopoverProps = {
  node: OrgNodeView;
  providerIndex: ProviderIndex;
  trigger: HTMLButtonElement;
  onClose: () => void;
};

/**
 * Every provider of a node, under the overflow button. Rendered in <body> so the canvas zoom
 * does not scale it. Closes on an outside click, any scroll, resize, or Escape (which refocuses the trigger).
 */
export function ProviderPopover({ node, providerIndex, trigger, onClose }: ProviderPopoverProps) {
  const ref = useRef<HTMLElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const close = useEffectEvent(onClose);

  useLayoutEffect(() => {
    const anchor = trigger.getBoundingClientRect();
    const box = ref.current!.getBoundingClientRect();
    setPosition({
      left: Math.max(VIEWPORT_MARGIN, Math.min(anchor.left, innerWidth - box.width - VIEWPORT_MARGIN)),
      top: Math.max(VIEWPORT_MARGIN, Math.min(anchor.bottom + TRIGGER_GAP, innerHeight - box.height - VIEWPORT_MARGIN)),
    });
  }, [trigger]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !trigger.contains(target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      trigger.focus();
    };
    const dismiss = () => close();
    document.addEventListener("click", onClick);
    document.addEventListener("scroll", dismiss, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("scroll", dismiss, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", dismiss);
    };
  }, [trigger]);

  return createPortal(
    <section ref={ref} className="node-provider-popover" aria-label={`${node.label} providers`} style={position}>
      <strong>{`${node.label} · Providers`}</strong>
      <div>
        {node.providers.map((id) => {
          const provider = providerOf(providerIndex, id);
          return (
            <span key={id} className="expanded-provider">
              <i className="provider-circle">
                <Icon name={provider.mark} />
              </i>
              {provider.name}
            </span>
          );
        })}
      </div>
    </section>,
    document.body,
  );
}
