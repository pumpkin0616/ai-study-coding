import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CollaborationOrigin } from './collaboration.js';

const WorkspaceDocumentPathSchema = z.string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    // 校验本地文档路径：供 specPath、ticketsPath 解析时使用，拒绝前导 / 和 .. 路径段。
    (value) => !value.startsWith('/') && !value.split(/[\\/]/).includes('..'),
    '文档路径必须位于当前工作目录内',
  );

const ProductSpecBaseSchema = z.object({
  title: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(500),
});

const LarkDocumentUrlSchema = z.url().refine(
  // 在 URL 格式校验后检查路径包含 /docx/，用于筛选飞书 Docx 类型的文档链接。
  (value) => /\/docx\//.test(new URL(value).pathname),
  'documentUrl 必须是飞书 Docx 文档链接',
);

export const LocalProductSpecRequestSchema = ProductSpecBaseSchema.extend({
  deliveryMode: z.literal('local'),
  specPath: WorkspaceDocumentPathSchema,
  ticketsPath: WorkspaceDocumentPathSchema,
}).strict();

export const LarkProductSpecRequestSchema = ProductSpecBaseSchema.extend({
  deliveryMode: z.literal('lark-doc'),
  documentUrl: LarkDocumentUrlSchema,
}).strict();

export const ProductSpecRequestSchema = z.discriminatedUnion('deliveryMode', [
  LocalProductSpecRequestSchema,
  LarkProductSpecRequestSchema,
]);

export type ProductSpecRequest = z.infer<typeof ProductSpecRequestSchema>;
export type LocalProductSpecRequest = z.infer<
  typeof LocalProductSpecRequestSchema
>;

export interface ProductSpecFlow {
  token: string;
  taskId: string;
  botId: string;
  sessionId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  collaboration?: CollaborationOrigin;
  request: ProductSpecRequest;
  status: 'pending' | 'approved' | 'expired';
  approvedAt?: string;
}

export interface CreateProductSpecFlowOptions {
  taskId: string;
  botId: string;
  sessionId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  collaboration?: CollaborationOrigin;
  request: ProductSpecRequest;
}

/**
 * 从工具调用记录中倒序查找最近一次有效的产品规格审批请求。
 * 将一轮执行的 toolCalls 传入即可；跳过其他工具和校验失败的输入，
 * 返回经过 Schema 校验、裁剪首尾空白后的请求，未找到时返回 undefined。
 */
export function findProductSpecRequest(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): ProductSpecRequest | undefined {
  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index];
    if (call?.toolName !== 'request_spec_approval') continue;
    const parsed = ProductSpecRequestSchema.safeParse(call.input);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

/**
 * 判断当前操作者是否为审批流程的发起人，供处理审批操作前校验身份。
 * 传入流程中保存的所有者 ID 和事件中的操作者 ID；双方都有 unionId 时
 * 以 unionId 为准（即使 openId 相同也不回退），否则比较 openId。
 */
export function isProductSpecOwner(
  flow: Pick<ProductSpecFlow, 'ownerOpenId' | 'ownerUnionId'>,
  operator: { operatorOpenId: string; operatorUnionId?: string },
): boolean {
  if (flow.ownerUnionId && operator.operatorUnionId) {
    return flow.ownerUnionId === operator.operatorUnionId;
  }
  return flow.ownerOpenId === operator.operatorOpenId;
}

export class ProductSpecFlowStore {
  private readonly flows = new Map<string, ProductSpecFlow>();

  /**
   * 创建内存流程仓库，可传入已保存的流程列表进行初始化。
   * 不传参数时创建空仓库；相同 token 的后项覆盖前项，流程对象按引用保存。
   */
  constructor(initialFlows: ProductSpecFlow[] = []) {
    for (const flow of initialFlows) {
      this.flows.set(flow.token, flow);
    }
  }

  /**
   * 根据任务、机器人、所有者和规格请求创建待审批流程，并返回仓库中的对象。
   * 发起新审批时调用；同一 taskId、botId 下原有的 pending 流程会先变为
   * expired，新流程使用去除连字符的 UUID 作为审批 token。
   */
  create(options: CreateProductSpecFlowOptions): ProductSpecFlow {
    for (const flow of this.flows.values()) {
      if (
        flow.taskId === options.taskId
        && flow.botId === options.botId
        && flow.status === 'pending'
      ) {
        flow.status = 'expired';
      }
    }
    const flow: ProductSpecFlow = {
      token: randomUUID().replaceAll('-', ''),
      ...options,
      status: 'pending',
    };
    this.flows.set(flow.token, flow);
    return flow;
  }

  /**
   * 使用审批 token 获取任意状态的流程，不存在时返回 undefined。
   * 适用于审批回调中查询流程；返回内部对象引用，修改它会直接影响仓库。
   */
  get(token: string): ProductSpecFlow | undefined {
    return this.flows.get(token);
  }

  /**
   * 使用机器人 ID 和飞书文档 fileToken 查找关联的待审批流程。
   * 处理文档事件时调用；仅匹配 lark-doc 模式和完整的 /docx/<token> 路径，
   * 有多条匹配时返回 Map 遍历顺序中的第一条，未找到时返回 undefined。
   */
  findPendingByDocument(
    botId: string,
    fileToken: string,
  ): ProductSpecFlow | undefined {
    for (const flow of this.flows.values()) {
      if (
        flow.botId === botId
        && flow.status === 'pending'
        && flow.request.deliveryMode === 'lark-doc'
        && documentToken(flow.request.documentUrl) === fileToken
      ) return flow;
    }
    return undefined;
  }

  /**
   * 将 token 对应的 pending 流程标记为 approved，并记录 ISO 格式的审批时间。
   * 调用方应先校验操作者身份；本方法只检查流程状态。
   * 成功时返回内部流程对象，不存在或已非待审批状态时返回 undefined。
   */
  approve(token: string): ProductSpecFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status !== 'pending') return undefined;
    flow.status = 'approved';
    flow.approvedAt = new Date().toISOString();
    return flow;
  }

  /**
   * 获取全部流程的深拷贝，供子类持久化或保存回滚快照。
   * 在子类中调用 this.snapshot()；修改返回的数组或流程不会影响当前仓库。
   */
  protected snapshot(): ProductSpecFlow[] {
    return structuredClone([...this.flows.values()]);
  }

  /**
   * 用给定流程列表完全替换仓库内容，供子类加载持久化数据或恢复快照。
   * 在子类中调用 this.restore(flows)；旧记录会被清空，新对象按引用保存，
   * 相同 token 的后项覆盖前项。
   */
  protected restore(flows: ProductSpecFlow[]): void {
    this.flows.clear();
    for (const flow of flows) {
      this.flows.set(flow.token, flow);
    }
  }
}

/**
 * 从文档 URL 的完整 /docx/<token> 路径中提取 token，允许一个结尾斜杠。
 * 供文档关联查询使用；路径不匹配时返回 undefined，URL 无效时会抛出异常，
 * 因此调用方应传入经过请求 Schema 校验的 URL。
 */
function documentToken(documentUrl: string): string | undefined {
  const match = /^\/docx\/([A-Za-z0-9_-]+)\/?$/.exec(
    new URL(documentUrl).pathname,
  );
  return match?.[1];
}
