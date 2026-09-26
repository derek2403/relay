import { Icon } from "@/components/ui/Icon";

type PageHeadingProps = {
  eyebrow: string;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
};

export function PageHeading({ eyebrow, title, description, action }: PageHeadingProps) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1 id="pageTitle">
          {title}
          <span>.</span>
        </h1>
        <p id="pageDescription">{description}</p>
      </div>
      {action && (
        <button className="primary" id="newAccess" onClick={action.onClick}>
          <span>
            <Icon name="plus" />
          </span>
          {` ${action.label}`}
        </button>
      )}
    </div>
  );
}
