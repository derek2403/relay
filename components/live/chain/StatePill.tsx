import { cx } from "@/lib/cx";

import type { ProposalState } from "./api";
import { STATE_LABELS, stateTone } from "./view";

/** A proposal's state as a khaki pill (waiting states pulse). */
export function StatePill({ state }: { state: ProposalState }) {
  return <span className={cx("status-pill", "chain-pill", `tone-${stateTone(state)}`)}>{STATE_LABELS[state] ?? state}</span>;
}
