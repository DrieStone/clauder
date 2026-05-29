import type { UIMessage } from '@clauder/shared';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

/** Returns true if newMessage appears to be starting a different task from the recent conversation. */
export async function classifyTaskSwitch(
  messages: UIMessage[],
  newMessage: string,
): Promise<boolean> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return false;

  const history = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-6)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 200)}`)
    .join('\n\n');

  if (!history) return false;

  const prompt =
    `Recent conversation:\n${history}\n\n` +
    `New message: "${newMessage.slice(0, 300)}"\n\n` +
    `Is this new message starting a completely different task or topic from the recent conversation? Answer only "yes" or "no".`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 5,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return false;
    const data = await res.json() as { content?: Array<{ text: string }> };
    return (data.content?.[0]?.text?.trim().toLowerCase() ?? '').startsWith('yes');
  } catch {
    return false; // fail open — never block a message
  }
}
