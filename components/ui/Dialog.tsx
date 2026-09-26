import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type DialogProps = {
  id: string;
  open: boolean;
  /** Called when the browser closes the dialog while it should be open, e.g. on Escape. */
  onClose: () => void;
  children: ReactNode;
};

/**
 * Lets content ask its dialog to stop being modal for a while. A modal <dialog> sits in the browser's top
 * layer and makes everything else inert, so an overlay a library appends to <body> (World ID's QR) would be
 * hidden behind it and unclickable.
 */
const DialogModeContext = createContext<((modal: boolean) => void) | null>(null);

/** Asks the enclosing Dialog to be non-modal while `nonModal` is true (no-op outside a Dialog). */
export function useNonModalWhile(nonModal: boolean) {
  const setModal = useContext(DialogModeContext);
  useEffect(() => {
    if (!setModal || !nonModal) return;
    setModal(false);
    return () => setModal(true);
  }, [setModal, nonModal]);
}

/** Native modal <dialog> driven by the `open` prop. */
export function Dialog({ id, open, onClose, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [modal, setModal] = useState(true);
  // Switching between modal and non-modal closes and reopens the element; that close isn't the user's.
  const switching = useRef(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!open) {
      if (dialog.open) dialog.close();
      return;
    }
    const isModal = dialog.open && dialog.matches(":modal");
    if (dialog.open && isModal === modal) return;
    if (dialog.open) {
      switching.current = true;
      dialog.close();
      switching.current = false;
    }
    if (modal) dialog.showModal();
    else dialog.show();
  }, [open, modal]);

  useEffect(() => {
    if (!open) setModal(true);
  }, [open]);

  return (
    <dialog
      id={id}
      ref={ref}
      onClose={() => {
        if (open && !switching.current) onClose();
      }}
    >
      <DialogModeContext value={setModal}>{children}</DialogModeContext>
    </dialog>
  );
}
