import fs from 'fs';
import os from 'os';
import path from 'path';

// Cold resumes. A session's prompt cache lasts an hour; after that, its next message re-sends the
// whole conversation at the cache-write price (a 900k-token Opus conversation: about $7 at API
// rates, from the subscription). The browser warns before sending to such a session and offers to
// start fresh instead: Claude gets a summary and the path of the old conversation
// (SessionManager.sendFresh). These helpers find a conversation's file and its size.

/** Where the CLI keeps a session's conversation: ~/.claude/projects/<folder, non-alphanumerics as ->/<id>.jsonl */
export function transcriptPath(cwd: string, sdkSessionId: string): string {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9-]/g, '-'), `${sdkSessionId}.jsonl`);
}

/** The size of the conversation's last request (input + cache read + cache write), from the usage the
 *  CLI recorded on its last main-conversation reply. Reads only the file's end. Null if unknown. */
export function promptTokensFromTranscript(file: string): number | null {
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, 2 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
      try {
        const d = JSON.parse(line);
        if (d.type !== 'assistant' || d.isSidechain) continue;
        const u = d.message?.usage;
        if (!u) continue;
        const t = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        if (t > 0) return t;
      } catch { /* a line cut by the read window */ }
    }
  } catch { /* no file */ } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  return null;
}
