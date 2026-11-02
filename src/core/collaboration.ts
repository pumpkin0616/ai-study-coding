export interface CollaborationMessage {
  dispatchId: string;
  taskId: string;
  fromBotId: string;
  toBotId: string;
  round: number;
  maxRounds: number;
  workspaceDir: string;
  prompt: string;
}
export interface CollaborationOrigin {
  taskId: string;
  fromBotId: string;
  reportToBotId: string;
  round: number;
  maxRounds: number;
}
// 第一轮可以得到 T123:1:reviewer，第二轮则是 T123:2:developer。同一个任务的两次交接不会被误判成重复消息。
export function collaborationTurnKey(message: CollaborationMessage): string {
  return `${message.taskId}:${message.round}:${message.toBotId}`;
}

export class CollaborationInbox {
  private readonly messages = new Map<string, CollaborationMessage>();

  register(message: CollaborationMessage): void {
    this.messages.set(message.dispatchId, message);
  }

  consume(
    dispatchId: string,
    toBotId: string,
  ): CollaborationMessage | undefined {
    const message = this.messages.get(dispatchId);
    if (!message || message.toBotId !== toBotId) return undefined;
    this.messages.delete(dispatchId);
    return message;
  }
}