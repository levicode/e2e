/**
 * The SSO session the local `bili-auth` client already maintains.
 *
 * The browser needs the company SSO cookie as a cookie, not as an HTTP header,
 * so a small Python helper asks `internal_auth` for the session id and writes
 * the two cookies the UAT apps read into a 0600 file. The value never enters
 * this process's arguments, standard output, or a log: only the file path does.
 */
import { execFileSync } from 'node:child_process';

const PROGRAM = `
import json, os, sys
sys.path.insert(0, os.path.expanduser('~/.agents/skills/bilibili-auth'))
sys.path.insert(0, os.path.expanduser('~/code/script'))
from internal_auth import get_session_id

value = get_session_id()
cookies = [{"name": "_AJSESSIONID", "value": value, "domain": ".bilibili.co", "path": "/", "secure": True, "httpOnly": True}]
try:
    with open(os.path.expanduser('~/.config/bilibili-auth/credentials.json')) as handle:
        username = json.load(handle).get("username")
    if username:
        cookies.append({"name": "username", "value": username, "domain": ".bilibili.co", "path": "/"})
except Exception:
    pass
descriptor = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(descriptor, "w") as handle:
    json.dump(cookies, handle)
`;

/** Writes the browser cookies for the current SSO session to a 0600 file. */
export function writeSsoCookieFile(file: string): void {
  try {
    execFileSync('python3', ['-c', PROGRAM, file], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (cause) {
    throw new Error(
      `UAT_SSO_UNAVAILABLE: the local bili-auth client could not provide an SSO session (${cause instanceof Error ? cause.message : String(cause)}). Its cached logger may need attention, or run ~/code/script/bili-auth status.`,
      { cause },
    );
  }
}
