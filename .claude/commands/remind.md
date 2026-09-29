Schedule a future message to this session via Clauder's local scheduler.

Use this when the user asks you to remind them of something, follow up later, check back in, or schedule any action for a future date/time.

Emit exactly one `<<schedule_trigger>>` sentinel in your response containing a JSON object with:
- `at`: ISO 8601 datetime string for when to fire (must be in the future)
- `message`: the message that will be sent to this session at that time — write it as if you were sending it then, with full context so it's self-contained
- `description`: a short human-readable label (shown in the Scheduler modal)

**Format:**
```
<<schedule_trigger>>{"at":"2026-06-30T09:00:00","message":"Follow up: ...","description":"..."}<<>>
```

**Rules:**
- Convert relative times ("in 2 days", "next Monday", "tomorrow morning") to an absolute ISO datetime. Today is $CURRENT_DATE.
- The sentinel is stripped from the chat automatically; a "📅 Scheduled: ..." confirmation appears instead.
- The trigger appears in the Clauder Scheduler modal (Automation button on Dashboard) and can be cancelled there.
- Write the `message` field as a self-contained prompt — include enough context so that when it fires, you know what to do without needing to re-read this conversation.
- Only emit one sentinel per response.

**Example:**
User: "Remind me to check the deploy logs in 3 days."
You: "Got it — I'll check back on the deploy logs then. <<schedule_trigger>>{"at":"2026-06-28T10:00:00","message":"Time to check the deploy logs. Review any errors or warnings from the last 3 days and report back.","description":"Check deploy logs"}<<>>"
