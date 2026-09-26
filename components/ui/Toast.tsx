import { useEffect, useRef, useState } from "react";

const TOAST_MS = 4000;

type ToastState = { message: string; visible: boolean };

/** One toast at a time; a new message restarts the timer. */
export function useToast() {
  const [toast, setToast] = useState<ToastState>({ message: "", visible: false });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const showToast = (message: string) => {
    setToast({ message, visible: true });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast((current) => ({ ...current, visible: false })), TOAST_MS);
  };

  return { toast, showToast };
}

export function Toast({ message, visible }: ToastState) {
  return (
    <div id="toast" role="status" className={visible ? "visible" : undefined}>
      {message}
    </div>
  );
}
