// GET /install : the CLI installer, same as /install.sh.
//
//   curl -fsSL <relay>/install | sh

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export { GET } from "../install.sh/route";
