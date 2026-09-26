"use client";

import { useLive } from "../LiveContext";

/** A labelled, copyable command or token (SRC Checklist CodeBlock/CopyButton in khaki). */
export function Snippet({ label, text }: { label?: string; text: string }) {
  const { toast } = useLive();
  const copy = () => {
    navigator.clipboard?.writeText(text).then(
      () => toast("Copied."),
      () => toast("Couldn't copy. Select the text instead."),
    );
  };
  return (
    <div className="live-snippet">
      <div className="live-snippet-head">
        {label && <span>{label}</span>}
        <button type="button" className="live-snippet-copy" onClick={copy}>
          Copy
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
}
