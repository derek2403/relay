import { Icon } from "@/components/ui/Icon";
import type { ActivityView } from "@/lib/view-model";

type ActivityListProps = {
  /** Newest first. */
  events: readonly ActivityView[];
  limit?: number;
};

export function ActivityList({ events, limit = 30 }: ActivityListProps) {
  return (
    <div id="activityList" className="activity-list">
      {events.slice(0, limit).map((event) => (
        <div key={event.id} className="activity-row">
          <span>
            <Icon name="activity" />
          </span>
          <div>
            <strong>{event.title}</strong>
            <p>{event.detail}</p>
          </div>
          <time>{event.time}</time>
        </div>
      ))}
    </div>
  );
}
