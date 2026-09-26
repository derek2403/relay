// Runs once when the Next.js server starts, before it serves requests.
// Loads the encrypted service credentials (<RELAY_DATA_DIR>/credentials.json)
// and applies them to process.env, where the relay reads its keys; stored
// values win over .env, and clearing one restores the original. Node.js only.
// See docs/credentials-and-attestation.md.

export async function register() {
  // The docs' pattern: a constant NEXT_RUNTIME check lets the edge build drop this import.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initCredentials } = await import("./lib/relay/credentials");
    try {
      initCredentials(process.env);
    } catch (err) {
      console.error("[relay] could not load stored credentials:", err instanceof Error ? err.message : "error");
    }
  }
}
