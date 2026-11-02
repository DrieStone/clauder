#!/bin/bash
# Does a CLI version reuse the prompt cache the way Clauder runs it? Copies a real conversation under
# a new id (the original is never touched), then resumes it turn after turn, each a fresh process
# with Clauder's flags (stream-json in/out, bypass permissions, an appended system prompt), and
# prints how much of each turn was read from the cache vs written to it. Uses real (subscription)
# usage: about $1-2 for a mid-size Opus conversation.
# usage: cli-cache-check.sh <claude binary> <label> <transcript.jsonl> [model]
BIN="$1"; LABEL="$2"; SRC="$3"; MODEL="${4:-claude-opus-5-5}"
DIR=/private/tmp/cli-cache-check; mkdir -p "$DIR"
PROJ="$HOME/.claude/projects/$(echo "$DIR" | sed 's#[/.]#-#g')"; mkdir -p "$PROJ"
OLD=$(basename "$SRC" .jsonl); NEW=$(uuidgen | tr A-Z a-z)
sed "s/$OLD/$NEW/g" "$SRC" > "$PROJ/$NEW.jsonl"
APPEND="You are running inside Clauder, a web multiplexer. $(printf 'Follow the house rules. %.0s' {1..150})"
turn() { # label effort
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply with just the word ok."}}' \
  | (cd "$DIR" && env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT "$BIN" --print --output-format=stream-json --input-format=stream-json \
      --include-partial-messages --verbose --permission-mode bypassPermissions --resume "$NEW" \
      --model "$MODEL" --effort "$2" --append-system-prompt "$APPEND" 2>/dev/null) \
  | python3 -c "
import json,sys
for line in sys.stdin:
    try: d=json.loads(line)
    except: continue
    if d.get('type')=='result':
        u=d.get('usage',{}); r=u.get('cache_read_input_tokens',0); w=u.get('cache_creation_input_tokens',0)
        print(f'  {sys.argv[1]:28} read={r:>8} written={w:>8}  ({100*w/max(1,r+w):4.1f}% written)')
" "$1 ($2)"
}
echo "== $LABEL  (conversation copy $NEW)"
turn "1 first resume (cold)" medium
turn "2" medium
turn "3 keep-warm style" low
turn "4 after low effort" medium
turn "5" high
turn "6" medium
