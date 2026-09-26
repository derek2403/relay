export function SectionHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="section-heading">
      <h2>{title}</h2>
      <span className="subtle">{subtitle}</span>
    </div>
  );
}
