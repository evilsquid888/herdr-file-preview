// One way to run the mod's POSIX shell scripts on every machine Herdr reaches.
//
// Remote machines and local macOS / Linux: `sh -c <script> fp <args…>` as before.
// Local Windows: there is no `sh` on PATH, so the scripts run in Git for Windows' own sh
// (MSYS2: sh, stat, find, head, tr, wc, base64 and git), with /usr/bin first on its PATH.
// Windows paths go in with forward slashes (C:/dev/x), which MSYS and Windows both accept.
import { exec, window } from "herdr";

/** Git for Windows' sh, when it is installed in a usual place (checked once, lazily). */
const CANDIDATES = [
  "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
  "C:\\Program Files (x86)\\Git\\usr\\bin\\sh.exe",
];
let gitSh;   // the lookup: a Promise of the path, or of null when there is none

export const isWindows = () => window()?.platform === "windows";
/** Local on Windows: the folder of the focused terminal is a Windows path, and needs Git sh. */
export const localWindows = (on) => !on && isWindows();

/** C:\dev\x → C:/dev/x (local Windows paths only; others are left alone). */
export const slash = (p, on) => (localWindows(on) && typeof p === "string" ? p.replace(/\\/g, "/") : p);

// Concurrent first calls share one lookup. A failed lookup is forgotten, so Retry looks again.
function findGitSh() {
  gitSh ??= (async () => {
    for (const c of CANDIDATES) {
      // `sh -c true` both proves the file exists and that it starts.
      const r = await exec(c, ["-c", "true"]).catch(() => null);
      if (r?.code === 0) return c;
    }
    return null;
  })().then((found) => { if (!found) gitSh = undefined; return found; });
  return gitSh;
}

/**
 * Runs a POSIX script: sh("printf %s \"$1\"", ["fp", x], { on }). `args[0]` is $0.
 * Rejects like exec when no shell can start (on Windows: Git for Windows missing).
 */
export async function sh(script, args = [], opts = {}) {
  if (!localWindows(opts?.on)) return exec("sh", ["-c", script, ...args], opts);
  const shell = await findGitSh();
  if (!shell) throw new Error("Local folders on Windows need Git for Windows (its sh.exe)");
  const cwd = opts?.cwd ? String(opts.cwd).replace(/\//g, "\\") : undefined;
  return exec(shell, ["-c", "export PATH=/usr/bin:/mingw64/bin:$PATH; " + script, ...args], cwd ? { cwd } : undefined);
}
