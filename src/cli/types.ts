export type CliId = "claude";

export type CliPromptInput = "argument" | "stdin";

// Windows 上 prompt 必须走 stdin（避免 cmd 对命令行参数转义/乱码），其他平台直接走参数。
export function promptInputForPlatform(platform: NodeJS.Platform): CliPromptInput {
  return platform === "win32" ? "stdin" : "argument";
}
export interface CliRunStats {
  durationMs?: number;
  turns?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
}
export type CliEvent =
  | { type: "session"; sessionId: string }
  | {
    type: "tool_start";
    toolUseId: string;
    toolName: string;
    label: string;
    detail?: string;
  }
  | { type: "tool_end"; toolUseId: string; failed: boolean }
  | { type: "context"; usedTokens: number }
  | { type: "result"; answer: string; sessionId?: string; stats?: CliRunStats }
  | { type: "error"; message: string; sessionId?: string };

/**
 * 新会话怎样组装参数，由 buildArgs() 决定。
 * 已有会话怎样续接，由 buildResumeArgs() 决定。
 * 原始输出怎样变成统一事件，由 parseEvent() 决定。
 */
export interface CliAdapter {
  readonly id: CliId;
  readonly command: string;
  readonly displayName: string;
  buildArgs(prompt: string): string[];
  buildResumeArgs(prompt: string, sessionId: string): string[];
  parseEvents(line: string): CliEvent[];
}

export interface CliRunResult {
  answer: string;
  sessionId?: string;
  stats?: CliRunStats;
}