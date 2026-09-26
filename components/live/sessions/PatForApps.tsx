"use client";

// "PAT for apps": one key for an app's .env that reaches every API a name may use, through the
// relay's OpenAI-style /v1 routes. The relay CLI on the laptop signs it with the key that owns the
// name (GET /pat hands back a script that runs `relay pat`), so it is shown only for names whose
// key can be there: a member made with `relay init`, and the agents the CLI made for it.

import { DEFAULT_MAX_TOKEN_TTL_SEC } from "@/lib/relay/token";

import { useLive } from "../LiveContext";
import { formatTtl, patCommand, patEnvPreview, patNameOk, patWeatherCheck, relayOrigin } from "./logic";
import { Snippet } from "./Snippet";

/** A PAT lasts a day at most unless `relay pat --hours` asks for less (the relay may cap it lower). */
const PAT_DEFAULT_SEC = 24 * 3600;

/** Rendered only inside an opened dialog (after a click), so reading the page's origin can't break hydration. */
export function PatForApps({ name, weather }: { name: string; weather: boolean }) {
  const live = useLive();
  const origin = relayOrigin(live.status?.baseUrl, typeof window === "undefined" ? null : window.location.origin);
  if (!origin || !patNameOk(name)) {
    return <p className="form-hint">No PAT snippet for {name}: the relay&apos;s address or this name can&apos;t go into a shell command as is.</p>;
  }
  const ttl = Math.min(PAT_DEFAULT_SEC, live.status?.maxTokenTtlSec ?? DEFAULT_MAX_TOKEN_TTL_SEC);
  return (
    <>
      <Snippet label="PAT for apps: in your app's folder, on the laptop with the key (~/.relay)" text={patCommand(origin, name)} />
      <Snippet label="It appends one line to .env" text={patEnvPreview()} />
      {weather && <Snippet label="Check it: Tokyo's weather through the relay (no model cost)" text={patWeatherCheck(origin)} />}
      <p className="form-hint">
        The key never leaves the laptop: the relay CLI signs the PAT itself. It lasts {formatTtl(ttl)} at most, never past {name}&apos;s end, and only
        within its limits; run the command again for a fresh one. No relay CLI yet? curl -fsSL {origin}/install | sh
      </p>
    </>
  );
}
