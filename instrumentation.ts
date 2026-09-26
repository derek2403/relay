// Runs once when the Next.js server starts, before it serves requests.
// Loads the encrypted service credentials (<RELAY_DATA_DIR>/credentials.json)
// and applies them to process.env, where the relay reads its keys; stored
// values win over .env, and clearing one restores the original. Then registers
// the approvals guard (lib/relay/approvals). Node.js only.
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
    // Registers the approvals guard (suspensions, approved scopes, drift) before the first request.
    try {
      await import("./lib/relay/approvals");
    } catch (err) {
      console.error("[relay] could not load approvals:", err instanceof Error ? err.message : "error");
    }
    // Sets the chain proposal hooks approvals calls, and resumes tracking of txs left pending by a restart.
    try {
      (await import("./lib/chain/service")).startChainRuntime();
    } catch (err) {
      console.error("[relay] could not start the chain runtime:", err instanceof Error ? err.message : "error");
    }
  }
}
