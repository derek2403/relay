export function Footer({ note }: { note: string }) {
  return (
    <footer>
      {"RELAY "}
      <span>Permission without possession.</span>
      <span className="footer-right">{note}</span>
    </footer>
  );
}
