import { useEffect, useRef, type ReactNode } from "react";

type DialogProps = {
  id: string;
  open: boolean;
  /** Called when the browser closes the dialog while it should be open, e.g. on Escape. */
  onClose: () => void;
  children: ReactNode;
};

/** Native modal <dialog> driven by the `open` prop. */
export function Dialog({ id, open, onClose, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      id={id}
      ref={ref}
      onClose={() => {
        if (open) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
