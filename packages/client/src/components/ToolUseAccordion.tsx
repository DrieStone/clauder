import { useState } from 'react';
import type { ToolUseInfo } from '@clauder/shared';
import { summarizeToolUse } from './MessageBubble';
import { useSessionActions } from '../context/SessionContext';
import { FileDiffView } from './FileDiffView';
import { WriteFileView } from './WriteFileView';

interface ToolUseAccordionProps {
  tool: ToolUseInfo;
  sessionId: string;
}

export function ToolUseAccordion({ tool, sessionId }: ToolUseAccordionProps) {
  const [open, setOpen] = useState(false);
  const [answered, setAnswered] = useState(false);
  const { respondToQuestion } = useSessionActions();
  const desc = summarizeToolUse(tool);

  const isQuestion = tool.name === 'AskUserQuestion';
  // Show interactive UI when the tool auto-failed (--print mode) and user hasn't answered yet
  const needsAnswer = isQuestion && tool.result?.isError && !answered;

  // Auto-expand when it needs an answer
  const isOpen = open || needsAnswer;

  // Parse the question from tool input
  const questions = isQuestion ? (tool.input as any)?.questions : null;
  const firstQuestion = Array.isArray(questions) ? questions[0] : null;

  const handleAnswer = (answer: string) => {
    setAnswered(true);
    // Deliver via respondToQuestion (not sendMessage): it jumps the queue so the answer is
    // processed next even if the session is mid-work, instead of being buried at the back.
    const header = firstQuestion?.header ? `[${firstQuestion.header}] ` : '';
    const questionRef = firstQuestion?.question ? `Re: "${firstQuestion.question}" — ` : '';
    respondToQuestion(sessionId, tool.id, `${header}${questionRef}${answer}`);
  };

  return (
    <div className={`rounded text-xs overflow-hidden ${needsAnswer ? 'bg-blue-900/30 border border-blue-700/50' : 'bg-gray-700/50'}`}>
      <button
        onClick={() => setOpen(!isOpen)}
        className="flex items-center gap-1.5 px-1.5 py-0.5 w-full text-left hover:bg-gray-700/80 transition-colors"
      >
        <span className="text-gray-400 text-[10px] shrink-0">{isOpen ? '\u25BC' : '\u25B6'}</span>
        <span className="text-gray-300 font-medium shrink-0">{isQuestion ? 'Question' : tool.name}</span>
        {!isQuestion && desc && <span className="text-gray-500 truncate">{desc}</span>}
        {needsAnswer && <span className="text-blue-400 truncate">Needs your answer</span>}
        {isQuestion && answered && <span className="text-green-400/60 truncate">Answered</span>}
        {!isQuestion && tool.result && (
          <span className={`ml-auto shrink-0 text-[10px] ${tool.result.isError ? 'text-red-400' : 'text-green-400/60'}`}>
            {tool.result.isError ? 'error' : 'ok'}
          </span>
        )}
      </button>
      {isOpen && (
        <div className="border-t border-gray-600/50 px-2 py-1.5 space-y-2">
          {isQuestion && firstQuestion ? (
            needsAnswer ? (
              <QuestionUI question={firstQuestion} onAnswer={handleAnswer} />
            ) : (
              <AnsweredQuestionUI question={firstQuestion} answered={answered} tool={tool} />
            )
          ) : (
            <>
              {/* File-aware view for Edit / MultiEdit / Write — falls back to JSON if input is malformed */}
              {(() => {
                const input = tool.input as Record<string, unknown>;
                if (tool.name === 'Edit') {
                  const file_path = input.file_path as string | undefined;
                  const old_string = input.old_string as string | undefined;
                  const new_string = input.new_string as string | undefined;
                  if (file_path && typeof old_string === 'string' && typeof new_string === 'string') {
                    return (
                      <div>
                        <div className="text-[10px] text-gray-500 mb-0.5">Diff</div>
                        <FileDiffView filePath={file_path} oldText={old_string} newText={new_string} />
                      </div>
                    );
                  }
                }
                if (tool.name === 'MultiEdit') {
                  const file_path = input.file_path as string | undefined;
                  const edits = input.edits as Array<{ old_string?: string; new_string?: string }> | undefined;
                  if (file_path && Array.isArray(edits)) {
                    return (
                      <div>
                        <div className="text-[10px] text-gray-500 mb-0.5 font-mono">Diff · {file_path}</div>
                        <div className="space-y-2">
                          {edits.map((edit, i) => (
                            <FileDiffView
                              key={i}
                              filePath={`Edit ${i + 1} of ${edits.length}`}
                              oldText={edit.old_string ?? ''}
                              newText={edit.new_string ?? ''}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  }
                }
                if (tool.name === 'Write') {
                  const file_path = input.file_path as string | undefined;
                  const content = input.content as string | undefined;
                  if (file_path && typeof content === 'string') {
                    return (
                      <div>
                        <div className="text-[10px] text-gray-500 mb-0.5">Write</div>
                        <WriteFileView filePath={file_path} content={content} />
                      </div>
                    );
                  }
                }
                // Fallback: raw JSON for any tool not handled above (or malformed file-tool input)
                return (
                  <div>
                    <div className="text-[10px] text-gray-500 mb-0.5">Input</div>
                    <pre className="text-[11px] text-gray-300 bg-gray-900 rounded p-1.5 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all">
                      {JSON.stringify(tool.input, null, 2)}
                    </pre>
                  </div>
                );
              })()}
              {/* Standard tool: Result */}
              <div>
                <div className="text-[10px] text-gray-500 mb-0.5">
                  Result
                  {tool.result?.originalLength && (
                    <span className="text-gray-600 ml-1">
                      (showing {tool.result.content.length.toLocaleString()} of {tool.result.originalLength.toLocaleString()} chars)
                    </span>
                  )}
                </div>
                {tool.result ? (
                  <pre className={`text-[11px] rounded p-1.5 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all ${
                    tool.result.isError
                      ? 'text-red-300 bg-red-950/40 border border-red-900/50'
                      : 'text-gray-300 bg-gray-900'
                  }`}>
                    {tool.result.content || '(empty)'}
                  </pre>
                ) : (
                  <div className="text-[11px] text-gray-500 italic">pending...</div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function QuestionUI({
  question,
  onAnswer,
}: {
  question: { question: string; header?: string; options?: { label: string; description?: string }[] };
  onAnswer: (answer: string) => void;
}) {
  const [customAnswer, setCustomAnswer] = useState('');

  return (
    <div className="space-y-2">
      {question.header && (
        <div className="text-[11px] font-medium text-blue-300">{question.header}</div>
      )}
      <div className="text-sm text-gray-200">{question.question}</div>
      {question.options && question.options.length > 0 && (
        <div className="space-y-1">
          {question.options.map((opt, i) => (
            <button
              key={i}
              onClick={() => onAnswer(opt.label)}
              className="w-full text-left px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-600 hover:border-blue-500 transition-colors"
            >
              <div className="text-sm text-gray-100">{opt.label}</div>
              {opt.description && (
                <div className="text-[11px] text-gray-400 mt-0.5">{opt.description}</div>
              )}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2 mt-2">
        <input
          type="text"
          value={customAnswer}
          onChange={(e) => setCustomAnswer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && customAnswer.trim()) {
              onAnswer(customAnswer.trim());
            }
          }}
          placeholder="Or type a custom answer..."
          className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-2 py-1 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={() => { if (customAnswer.trim()) onAnswer(customAnswer.trim()); }}
          disabled={!customAnswer.trim()}
          className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm rounded-lg transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}

function AnsweredQuestionUI({ question, answered, tool }: { question: { question: string; header?: string }; answered: boolean; tool: ToolUseInfo }) {
  return (
    <div className="space-y-1">
      {question.header && <div className="text-[11px] font-medium text-gray-400">{question.header}</div>}
      <div className="text-sm text-gray-300">{question.question}</div>
      {answered ? (
        <div className="text-[11px] text-green-400 italic">Answered via follow-up message</div>
      ) : tool.result && !tool.result.isError ? (
        <div className="text-sm text-green-300 bg-green-950/30 rounded p-1.5">
          Answered: {tool.result.content}
        </div>
      ) : null}
    </div>
  );
}
