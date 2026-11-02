import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  ProductSpecRequestSchema,
  ProductSpecFlowStore,
  type CreateProductSpecFlowOptions,
  type ProductSpecFlow,
} from './product-spec.js';

const ProductSpecFlowSchema = z.object({
  token: z.string().min(1),
  taskId: z.string().min(1),
  botId: z.string().min(1),
  sessionId: z.string().min(1),
  ownerOpenId: z.string().min(1),
  ownerUnionId: z.string().min(1).optional(),
  collaboration: z.object({
    taskId: z.string().min(1),
    fromBotId: z.string().min(1),
    reportToBotId: z.string().min(1),
    round: z.number().int().positive(),
    maxRounds: z.number().int().positive(),
  }).optional(),
  request: ProductSpecRequestSchema,
  status: z.enum(['pending', 'approved', 'expired']),
  approvedAt: z.iso.datetime().optional(),
});

export class JsonProductSpecFlowStore extends ProductSpecFlowStore {
  /**
   * 创建以 JSON 文件持久化的审批流程仓库，启动时从 filePath 加载已有流程。
   * 使用 new JsonProductSpecFlowStore(filePath) 初始化；文件不存在时从空仓库开始，
   * 其他读取错误、JSON 解析错误或顶层格式错误会直接抛出。
   */
  constructor(private readonly filePath: string) {
    super(loadFlows(filePath));
  }

  /**
   * 创建待审批流程，并将包含旧流程过期状态的完整仓库同步保存到文件。
   * 传入任务、机器人、所有者及请求信息；返回新流程，保存失败时回滚内存并抛错。
   */
  override create(options: CreateProductSpecFlowOptions): ProductSpecFlow {
    return this.mutate(() => super.create(options));
  }

  /**
   * 按 token 批准待审批流程并同步保存，调用方应事先校验操作者身份。
   * 成功时返回已更新的流程，不存在或非 pending 状态时返回 undefined，
   * 即使未发生状态变更也会保存；保存失败时回滚内存并抛错。
   */
  override approve(token: string): ProductSpecFlow | undefined {
    return this.mutate(() => super.approve(token));
  }

  /**
   * 执行一次同步内存变更并持久化，供 create、approve 包装父类操作时使用。
   * 传入无参数回调，保存成功后原样返回其结果；回调或保存抛错时，
   * 用执行前的深拷贝恢复仓库再重新抛错，外部已持有的旧对象引用不会随之恢复。
   */
  private mutate<T>(operation: () => T): T {
    const previous = this.snapshot();
    try {
      const result = operation();
      this.persist();
      return result;
    } catch (error) {
      this.restore(previous);
      throw error;
    }
  }

  /**
   * 将当前仓库快照保存为 UTF-8 JSON，供变更操作完成后调用。
   * 自动创建父目录，先写入同目录的 .tmp 文件再重命名替换目标文件，
   * 避免直接覆盖时留下不完整 JSON；文件系统错误交由调用方处理。
   */
  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(this.snapshot(), null, 2)}\n`,
      'utf8',
    );
    renameSync(temporaryPath, this.filePath);
  }
}

/**
 * 读取并校验 JSON 状态文件，供仓库构造时恢复流程列表。
 * 传入文件路径；文件不存在时返回空数组，数组中校验失败的记录会被跳过。
 * 其他读取错误、无效 JSON 或非数组的顶层数据会抛错，不会静默重置已有文件。
 */
function loadFlows(filePath: string): ProductSpecFlow[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const rows: unknown = JSON.parse(content);
  if (!Array.isArray(rows)) {
    throw new Error(`产品方案状态文件格式错误: ${filePath}`);
  }
  return rows.flatMap((row) => {
    // 逐条校验记录：有效项保留为单元素数组，无效项返回空数组，由 flatMap 过滤。
    const result = ProductSpecFlowSchema.safeParse(row);
    return result.success ? [result.data] : [];
  });
}
