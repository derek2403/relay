import { LEVEL_GAP, LEVEL_LABELS } from "@/lib/view-model";

const FIRST_LABEL_TOP = 37;

export function LevelLabels() {
  return (
    <>
      {LEVEL_LABELS.map((label, index) => (
        <div key={label} className="level-label" style={{ top: FIRST_LABEL_TOP + index * LEVEL_GAP }}>
          {`0${index + 1}`}
          <span>{label}</span>
        </div>
      ))}
    </>
  );
}
