/**
 * AI 提供方门面。
 *
 * 核心只依赖这个**最小接口**，具体的网络实现由宿主注入：
 * - Obsidian 插件用 `requestUrl`（官方 API，可绕过 CORS，且没有 AbortSignal）
 * - Node CLI/MCP 用 `fetch`
 *
 * 这样核心既能“没有模型也完全可用”，也不会把凭据、HTTP 细节或平台差异
 * 带进领域逻辑。密钥永远不进 Markdown、导出、日志、示例和发布包。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** 采样温度。默认 0，让提取结果尽量稳定可复现。 */
  temperature?: number;
  /** 输出上限。 */
  maxTokens?: number;
  /** 单次调用超时（毫秒）。 */
  timeoutMs?: number;
  /** 只要 JSON 对象（OpenAI 兼容的 response_format）。 */
  json?: boolean;
  /** 取消信号。传输层不支持时会被忽略，此时必须依赖“迟到提交拦截”。 */
  signal?: { aborted: boolean };
}

export interface ChatResult {
  ok: boolean;
  text: string;
  model: string;
  /** 是否真的发出了网络请求并拿到响应。 */
  delivered: boolean;
  /** 传输层是否支持真正中止请求（决定了能否声称“已停止计费”）。 */
  aborted: boolean;
  /**
   * 本次等待是怎么结束的。**这是诚实报告的关键字段**：
   * - `completed`：拿到响应；
   * - `timed_out`：本端停止等待（有中止能力时也发出了中止）；
   * - `cancelled`：调用方取消了本次等待；
   * - `refused`：请求在发出**之前**就被拒绝（例如已经取消）。
   *
   * `timed_out` / `cancelled` 一律 `delivered: true`，因为请求可能已经到达
   * 服务端并**产生费用**——中止传输层不等于停止远端计费。
   */
  waitOutcome?: 'completed' | 'timed_out' | 'cancelled' | 'refused';
  /** 迟到结果是否仍有可能计费（用于作业队列的“未知”判定）。 */
  billableUnknown?: boolean;
  error?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface AiProvider {
  readonly id: string;
  readonly model: string;
  /** 该提供方是否具备真实的请求中止能力（不是“停止等待”）。 */
  readonly supportsAbort: boolean;
  complete(request: ChatRequest): Promise<ChatResult>;
}

export interface CredentialStore {
  /** 读取密钥；返回 null 表示未保存。 */
  get(key: string): Promise<string | null>;
  /** 保存密钥。 */
  set(key: string, value: string): Promise<void>;
  /** 删除密钥。 */
  remove(key: string): Promise<void>;
  /** 描述存储位置，用于在 UI 中如实说明安全性。 */
  describe(): string;
}

/** 只在内存里保存密钥：用于“无法安全持久化时仅本次运行”。 */
export class EphemeralCredentialStore implements CredentialStore {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
  describe(): string {
    return '仅本次运行有效（进程退出即丢失，不写入磁盘）';
  }
}

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 额外请求头。 */
  headers?: Record<string, string>;
  /** 组织/项目标识。 */
  organization?: string;
}

export type HttpFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: unknown;
  },
) => Promise<{ status: number; text: string; aborted?: boolean }>;

/**
 * OpenAI 兼容提供方。
 *
 * `transport` 由宿主注入：CLI 用 fetch（支持真中止），Obsidian 用 requestUrl
 * （不支持真中止，此时 `supportsAbort === false`，UI 必须如实显示
 * “已停止等待，但无法确认远端的计费是否中止”）。
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly id = 'openai-compatible';
  readonly model: string;
  readonly supportsAbort: boolean;
  private readonly config: OpenAiCompatibleConfig;
  private readonly transport: HttpFetch;
  private readonly controllerFactory: ((timeoutMs: number) => { signal: unknown; abort: () => void; aborted: () => boolean }) | null;

  constructor(options: {
    config: OpenAiCompatibleConfig;
    transport: HttpFetch;
    /**
     * 提供真中止能力的工厂；不传则声明为不支持真中止。
     * 参数是本调用生效的超时时间，便于宿主用 `AbortSignal.timeout()`。
     */
    controllerFactory?: (timeoutMs: number) => { signal: unknown; abort: () => void; aborted: () => boolean };
  }) {
    this.config = options.config;
    this.model = options.config.model;
    this.transport = options.transport;
    this.controllerFactory = options.controllerFactory ?? null;
    this.supportsAbort = options.controllerFactory !== undefined;
  }

  /** 规范化 baseUrl，接受带或不带 `/v1` 的写法。 */
  static resolveEndpoint(baseUrl: string): string {
    const trimmed = baseUrl.trim().replace(/\/+$/, '');
    if (trimmed === '') throw new Error('模型地址为空。');
    if (/\/chat\/completions$/.test(trimmed)) return trimmed;
    if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`;
    return `${trimmed}/v1/chat/completions`;
  }

  /**
   * 建立中止控制器。
   *
   * 单独抽成方法是为了让 TypeScript 不要把 `controller` 收窄成 `never`
   * （内联的 `?? null` 配合 undefined 联合类型会触发这个已知的控制流分析问题）。
   */
  private buildController(timeoutMs: number): { signal: unknown; abort: () => void; aborted: () => boolean } | null {
    const factory = this.controllerFactory;
    if (!factory) return null;
    return factory(timeoutMs);
  }

  async complete(request: ChatRequest): Promise<ChatResult> {
    const endpoint = OpenAiCompatibleProvider.resolveEndpoint(this.config.baseUrl);
    const timeoutMs = clampTimeout(request.timeoutMs);

    /**
     * A1-a：**发出之前**先看取消意图。
     *
     * 审计复现（修复前）：`signal.aborted === true` 时只有存在 controller 才
     * 处理取消，随后依然调用 transport——请求被发出去，费用可能已经产生。
     * 取消意图必须在建立连接之前生效，与传输层是否有中止能力无关。
     */
    const abortedBeforeSend = isAborted(request.signal);
    if (abortedBeforeSend) {
      return {
        ok: false,
        text: '',
        model: this.config.model,
        delivered: false,
        aborted: true,
        waitOutcome: 'refused',
        billableUnknown: false,
        error: '请求在发出前已被取消，未发送任何网络请求。',
      };
    }

    const controller = this.buildController(timeoutMs);
    /**
     * A1-b：**有界等待**与中止能力分离。
     *
     * 审计复现（修复前）：没有 controller 时（正是 Obsidian `requestUrl` 的
     * 正常路径）根本不创建超时定时器，一次调用可以永久 pending 占住作业。
     * 现在无论有没有中止能力，本端都只等 `timeoutMs`：
     * - 能中止 → 同时发出中止，`aborted: true`；
     * - 不能中止 → 只是停止等待，并**如实**报告 `aborted: false`
     *   与 `billableUnknown: true`（远端可能仍在跑、可能已计费）。
     */
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      if (timeoutMs <= 0) return;
      timer = setTimeout(() => {
        timedOut = true;
        try {
          controller?.abort();
        } catch {
          /* 中止本身失败不改变“本端已停止等待”的事实 */
        }
        reject(new Error(`本端等待超过 ${timeoutMs}ms`));
      }, timeoutMs);
    });
    if (isAborted(request.signal) && controller) controller.abort();

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.config.headers,
    };
    if (this.config.apiKey !== '') headers.authorization = `Bearer ${this.config.apiKey}`;
    if (this.config.organization) headers['openai-organization'] = this.config.organization;

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: request.messages,
      temperature: request.temperature ?? 0,
    };
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.json) body.response_format = { type: 'json_object' };

    try {
      const transportCall = this.transport(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller?.signal,
      });
      /**
       * 迟到的响应不允许再影响任何状态：超时后我们把 transport 的结果
       * 标记为“未采用”，并且**不会**把它当作成功回到调用方。
       * 这里用 `void` 显式吞掉迟到 Promise 的拒绝，避免未处理拒绝告警。
       */
      void transportCall.catch(() => undefined);
      const response = await Promise.race([transportCall, timeoutPromise]);
      if (timer) clearTimeout(timer);
      const aborted = response.aborted === true || (controller?.aborted() ?? false);
      if (response.status < 200 || response.status >= 300) {
        return {
          ok: false,
          text: '',
          model: this.config.model,
          delivered: true,
          aborted,
          error: `模型接口返回 HTTP ${response.status}：${truncate(response.text, 400)}`,
        };
      }
      const parsed = safeJson(response.text);
      const text = extractContent(parsed) ?? '';
      const usage = extractUsage(parsed);
      if (text === '') {
        return {
          ok: false,
          text: '',
          model: this.config.model,
          delivered: true,
          aborted,
          waitOutcome: 'completed',
          billableUnknown: false,
          error: '模型返回内容为空（可能是被截断或触发了内容策略）。',
        };
      }
      return {
        ok: true,
        text,
        model: this.config.model,
        delivered: true,
        aborted,
        waitOutcome: 'completed',
        billableUnknown: false,
        usage,
      };
    } catch (error) {
      if (timer) clearTimeout(timer);
      const aborted = controller?.aborted() ?? false;
      const message = error instanceof Error ? error.message : String(error);
      if (timedOut) {
        /**
         * 关键诚实点：请求**已经发出**。即使我们中止了传输层，
         * 也不能声称“远端的计费已停止”。`delivered: true` 表示这点。
         */
        return {
          ok: false,
          text: '',
          model: this.config.model,
          delivered: true,
          aborted,
          waitOutcome: 'timed_out',
          billableUnknown: true,
          error: `等待超过 ${timeoutMs}ms：本端已停止等待${aborted ? '并请求中止传输' : ''}。请求已经发出，无法确认远端是否仍在处理或已经计费；结果未采用。`,
        };
      }
      if (isAborted(request.signal)) {
        return {
          ok: false,
          text: '',
          model: this.config.model,
          delivered: true,
          aborted,
          waitOutcome: 'cancelled',
          billableUnknown: true,
          error: `调用方已取消耗时收到（${message}）：请求可能已到达服务端，无法确认是否计费；结果未采用。`,
        };
      }
      return {
        ok: false,
        text: '',
        model: this.config.model,
        delivered: false,
        aborted,
        waitOutcome: 'completed',
        billableUnknown: false,
        error: `模型请求失败：${message}`,
      };
    }
  }
}

/** 读取取消信号而不让类型收窄影响后面的代码。 */
function isAborted(signal: { aborted: boolean } | undefined): boolean {
  return signal !== undefined && signal.aborted === true;
}

const MAX_TIMEOUT = 180_000;
const DEFAULT_TIMEOUT = 45_000;

function clampTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT;
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT;
  return Math.max(0, Math.min(MAX_TIMEOUT, Math.floor(value)));
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractContent(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown };
  if (first.message && typeof first.message.content === 'string') return first.message.content;
  // 部分兼容实现把内容放在 message.content 数组里。
  if (first.message && Array.isArray(first.message.content)) {
    return first.message.content
      .map(part => (typeof part === 'string' ? part : typeof part === 'object' && part && 'text' in part ? String((part as { text: unknown }).text) : ''))
      .join('');
  }
  if (typeof first.text === 'string') return first.text;
  return null;
}

function extractUsage(parsed: unknown): { promptTokens?: number; completionTokens?: number } | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const usage = (parsed as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const out: { promptTokens?: number; completionTokens?: number } = {};
  if (typeof u.prompt_tokens === 'number') out.promptTokens = u.prompt_tokens;
  if (typeof u.completion_tokens === 'number') out.completionTokens = u.completion_tokens;
  return out;
}

/**
 * 从模型输出里提取 JSON 对象。
 * 模型经常包一层 ```json 围栏或加解释文字，这里做保守剥离。
 */
export function extractJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  const direct = safeJson(trimmed);
  if (direct !== null && typeof direct === 'object') return direct;
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fence && fence[1]) {
    const parsed = safeJson(fence[1].trim());
    if (parsed !== null) return parsed;
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const parsed = safeJson(trimmed.slice(start, end + 1));
    if (parsed !== null) return parsed;
  }
  return null;
}

/** 测试与离线演示用的确定性提供方：不回网络，按规则“假回答”。 */
export class ScriptedProvider implements AiProvider {
  readonly id = 'scripted';
  readonly model: string;
  readonly supportsAbort = true;
  private readonly responses: string[];
  private index = 0;
  /** 记录调用次数，用于验证“无新增证据时不请求模型”。 */
  calls = 0;
  /** 模拟迟到响应：设为 true 时返回前先等待一次微任务。 */
  delay = false;

  constructor(responses: string[], model = 'scripted-model') {
    this.responses = responses;
    this.model = model;
  }

  async complete(): Promise<ChatResult> {
    this.calls += 1;
    if (this.delay) await Promise.resolve();
    const text = this.responses[Math.min(this.index, this.responses.length - 1)] ?? '{}';
    this.index += 1;
    return { ok: true, text, model: this.model, delivered: true, aborted: false };
  }
}

/** 永远失败的提供方：用于验证错误如实上报，而不是静默降级。 */
export class FailingProvider implements AiProvider {
  readonly id = 'failing';
  readonly model = 'failing-model';
  readonly supportsAbort = false;
  calls = 0;
  constructor(private readonly message = '未配置模型') {}
  async complete(): Promise<ChatResult> {
    this.calls += 1;
    return { ok: false, text: '', model: this.model, delivered: false, aborted: false, error: this.message };
  }
}
