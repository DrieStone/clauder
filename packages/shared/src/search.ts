/** Global search — see the plan for full design. Two scopes (project working directories vs
 *  the whole disk) and two speeds (instant keyword match vs a Haiku-assisted "smart" pass that
 *  expands the query and re-ranks results with a one-line reason). */
export type SearchScope = 'projects' | 'everywhere';

export interface SessionHit {
  kind: 'session';
  sessionId: string;
  sessionName: string;
  /** The specific message that matched, if the hit came from message content rather than the
   *  session's name/summary/notes. */
  messageId?: string;
  role?: 'user' | 'assistant' | 'system';
  snippet: string;
  timestamp?: string;
  score: number;
  /** One-line "why this matches", set only by the smart (Haiku) pass. */
  reason?: string;
}

export interface FileHit {
  kind: 'file';
  path: string;
  name: string;
  dir: string;
  snippet?: string;
  source: 'spotlight' | 'grep';
  /** Line number, for grep hits (exact phrase found in source). */
  line?: number;
  /** Set when the file lives under a known session's working directory. */
  sessionId?: string;
  score: number;
  /** One-line "why this matches", set only by the smart (Haiku) pass. */
  reason?: string;
}

export interface SearchResponse {
  query: string;
  scope: SearchScope;
  smart: boolean;
  /** Alternate phrasings Haiku generated for the smart pass, if smart search ran. */
  expandedTerms?: string[];
  sessions: SessionHit[];
  files: FileHit[];
  tookMs: number;
  errors?: string[];
}
