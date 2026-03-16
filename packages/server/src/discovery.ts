import fs from 'fs';
import path from 'path';
import readline from 'readline';

export interface DiscoveredSession {
  sessionId: string;
  projectPath: string;
  projectDir: string;
  filePath: string;
  fileSize: number;
  lastModified: string;
  firstUserMessage: string | null;
  lastTimestamp: string | null;
  messageCount: { user: number; assistant: number; total: number };
}

const CLAUDE_DIR = path.join(process.env.HOME || '', '.claude', 'projects');

/**
 * Scan ~/.claude/projects/ to discover all existing Claude Code sessions.
 */
export async function discoverSessions(): Promise<DiscoveredSession[]> {
  const sessions: DiscoveredSession[] = [];

  if (!fs.existsSync(CLAUDE_DIR)) {
    return sessions;
  }

  const projectDirs = fs.readdirSync(CLAUDE_DIR);

  for (const projectDir of projectDirs) {
    if (!projectDir.startsWith('-')) continue;

    const projectDirPath = path.join(CLAUDE_DIR, projectDir);
    const stat = fs.statSync(projectDirPath);
    if (!stat.isDirectory()) continue;

    const files = fs.readdirSync(projectDirPath);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

    for (const jsonlFile of jsonlFiles) {
      const filePath = path.join(projectDirPath, jsonlFile);
      const sessionId = jsonlFile.replace('.jsonl', '');
      const fileStat = fs.statSync(filePath);

      try {
        const meta = await parseSessionMetadata(filePath);
        sessions.push({
          sessionId,
          projectPath: meta.cwd || projectDir, // Use cwd from session data
          projectDir,
          filePath,
          fileSize: fileStat.size,
          lastModified: fileStat.mtime.toISOString(),
          firstUserMessage: meta.firstUserMessage,
          lastTimestamp: meta.lastTimestamp,
          messageCount: meta.messageCount,
        });
      } catch {
        // Skip unreadable files
        sessions.push({
          sessionId,
          projectPath: projectDir,
          projectDir,
          filePath,
          fileSize: fileStat.size,
          lastModified: fileStat.mtime.toISOString(),
          firstUserMessage: null,
          lastTimestamp: null,
          messageCount: { user: 0, assistant: 0, total: 0 },
        });
      }
    }
  }

  // Sort by last modified, most recent first
  sessions.sort((a, b) => {
    const ta = a.lastTimestamp || a.lastModified;
    const tb = b.lastTimestamp || b.lastModified;
    return tb.localeCompare(ta);
  });

  return sessions;
}

interface SessionMetadata {
  cwd: string | null;
  firstUserMessage: string | null;
  lastTimestamp: string | null;
  messageCount: { user: number; assistant: number; total: number };
}

async function parseSessionMetadata(filePath: string): Promise<SessionMetadata> {
  return new Promise((resolve, reject) => {
    const result: SessionMetadata = {
      cwd: null,
      firstUserMessage: null,
      lastTimestamp: null,
      messageCount: { user: 0, assistant: 0, total: 0 },
    };

    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      try {
        const obj = JSON.parse(line);
        const type = obj.type;

        // Extract cwd from the first message that has it
        if (!result.cwd && obj.cwd) {
          result.cwd = obj.cwd;
        }

        if (type === 'user') {
          result.messageCount.user++;
          result.messageCount.total++;

          // Capture first real user message (not IDE-generated)
          if (!result.firstUserMessage) {
            const text = extractTextFromMessage(obj);
            if (text && !text.startsWith('<ide_') && !text.startsWith('<system') && text.length > 5) {
              result.firstUserMessage = text.slice(0, 200);
            }
          }
        } else if (type === 'assistant') {
          result.messageCount.assistant++;
          result.messageCount.total++;
        }

        if (obj.timestamp) {
          result.lastTimestamp = obj.timestamp;
        }
      } catch {
        // Skip malformed lines
      }
    });

    rl.on('close', () => resolve(result));
    rl.on('error', reject);
  });
}

function extractTextFromMessage(obj: any): string | null {
  const msg = obj.message;
  if (!msg) return null;

  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'text') {
        return block.text || null;
      }
    }
  }
  return null;
}
