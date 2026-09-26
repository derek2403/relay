import { iconPaths } from "@/lib/icons";
import { providerMarks } from "@/lib/provider-marks";

/** Brand mark when one exists for `name`, otherwise a stroke icon (falling back to the providers grid). */
export function Icon({ name }: { name: string }) {
  const mark = providerMarks[name];
  if (mark) {
    return (
      <svg
        className={`ui-icon brand-icon brand-${name}`}
        viewBox={mark.viewBox}
        fill="currentColor"
        fillRule="evenodd"
        stroke="none"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: mark.body }}
      />
    );
  }
  return (
    <svg
      className="ui-icon"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: iconPaths[name] ?? iconPaths.providers }}
    />
  );
}
