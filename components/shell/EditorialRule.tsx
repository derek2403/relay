export function EditorialRule({ left, right }: { left: string; right: string }) {
  return (
    <div className="editorial-rule">
      <span>{left}</span>
      <span>{right}</span>
    </div>
  );
}
