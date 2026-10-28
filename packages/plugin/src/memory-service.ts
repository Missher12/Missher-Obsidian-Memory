/**
 * 记忆服务：把核心 `MemoryStore` 接到 Obsidian 上。
 *
 * 三件事：
 * 1. 持有唯一的 `MemoryStore` 实例（所有界面共用同一份缓存）；
 * 2. 把 AI 传输接到 Obsidian 的 `requestUrl`，并**如实**报告等待结局；
 * 3. 承载作业队列与队列服务（外部写请求的唯一提交者）。
 *
 * 这一层不做业务判定：候选是否待审、删除是否需要期望值、过期是否召回，
 * 全部由核心决定。界面只把用户意图翻译成核心调用。
 */

import { Notice, requestUrl, type App } from 'obsidian';
import {
  MemoryStore,
  OpenAiCompatibleProvider,
  PATCH_FILE,
  type ChatResult,
  type AiProvider,
  type PluginSettings,
  normalizeOrganization,
  type OrganizationSettings,
  type SyncReport,
} from '@mom/core';
import { VaultFileStore } from './vault-store.js';
import { probeCapabilities, type CapabilityReport } from './capabilities.js';
import { QueueService } from './queue-service.js';
import { createCommitHandler, createCommitRecovery } from './commit-handler.js';
import { AiJobRunner } from './job-runner.js';

export interface MemoryServiceOptions {
  app: App;
  memoryRoot: string;
  /** 插件实例内的随机标识，用于队列认领与回执对账。 */
  instanceId: string;
  /** 读取当前设置（设置变更后立即生效，不需要重建服务）。 */
  getSettings: () => PluginSettings;
  /**
   * 本插件自己写下的路径回调。
   *
   * 用来把「自己造成的 Vault 事件」和「用户/外部造成的改动」分开：
   * 前者必须跳过索引刷新，否则一次提交会触发刷新、刷新又触发事件，
   * 变成没完没了的重载。
   */
  onSelfWrite?: (path: string, content?: string) => void;
}

export class MemoryService {
  readonly organization: OrganizationSettings;
  readonly vaultStore: VaultFileStore;
  readonly store: MemoryStore;
  /** AI 作业运行器：调度、预算、暂停、迟到拒绝、崩溃恢复。 */
  readonly jobs: AiJobRunner;
  readonly writeQueue: QueueService;
  private readonly app: App;
  private readonly instanceId: string;
  private readonly getSettings: () => PluginSettings;
  private loaded = false;
  /**
   * 本次运行的密钥覆盖。
   *
   * `undefined` = 没有覆盖（读取走持久存储）；`''` = 显式清空，必须压住旧持久值；
   * 其他 = 临时密钥。用 `undefined` 而非 `''` 表示「没有」，因为「显式空」与
   * 「没设置」是两件事：混同会让清空后旧的持久密钥复活。
   */
  private sessionOverride: string | undefined = undefined;
  /**
   * 上一次写入是否**可能**已经落进持久存储但无法确认。
   *
   * 覆盖「setter 已调用但没确认读回」的全部情形（读回不一致、读回抛错、
   * setter 抛错——setter 可能先落盘再抛）。只用于让界面措辞准确：
   * 这条路径上既不能承诺「已保存」，也不能承诺「没落盘」。
   * 未尝试持久化时才为 `false`。
   */
  private persistUnconfirmed = false;

  constructor(options: MemoryServiceOptions) {
    this.app = options.app;
    this.instanceId = options.instanceId;
    this.getSettings = options.getSettings;
    this.organization = normalizeOrganization(options.getSettings().organization);
    this.vaultStore = new VaultFileStore({
      app: options.app,
      memoryRoot: options.memoryRoot,
      organization: this.organization,
      onWrite: (path, content) => options.onSelfWrite?.(path, content),
    });
    this.store = new MemoryStore({
      store: this.vaultStore,
      root: options.memoryRoot,
      organization: this.organization,
      now: () => Date.now(),
      rand: () => Math.random(),
    });
    /**
     * 待审补丁本来由核心自己写状态文件；插件这里显式接管，把「写失败」当成
     * 可报告的结论（而不是抛错打断用户操作）。补丁文件在 `.memory/` 下，
     * 不参与召回，但它是用户审核决定的历史，读不懂时会 fail-closed。
     */
    this.store.setPatchPersist(async body => {
      try {
        await this.store.writeStateFile(PATCH_FILE, body);
        return true;
      } catch {
        return false;
      }
    });
    this.jobs = new AiJobRunner({
      store: this.store,
      instanceId: options.instanceId,
      /**
       * 作业状态持久化到 `<记忆根>/.memory/jobs.json`：
       * 应用关闭再打开时，未处理区间必须能补上（而不是假装常驻）。
       */
      persist: async state => {
        try {
          await this.store.writeStateFile('jobs.json', `${JSON.stringify(state, null, 2)}\n`);
          return true;
        } catch {
          return false;
        }
      },
    });
    this.writeQueue = new QueueService({
      app: options.app,
      store: this.vaultStore,
      memoryRoot: options.memoryRoot,
      organization: this.organization,
      owner: options.instanceId,
      now: () => Date.now(),
      random: () => Math.random(),
      /**
       * 提交走 MemoryStore 的公开方法；「自己写入」的登记发生在 VaultFileStore 层
       * （所有落盘都经过它），因此队列提交与 UI 写入都会被 Vault 事件监听跳过。
       */
      commit: createCommitHandler(this.store),
      /** 回执丢失时的恢复路径：从持久事务标记找回同一次提交，不重复执行。 */
      findCommitted: createCommitRecovery(this.store),
    });
  }

  get memoryRoot(): string {
    return this.vaultStore.memoryRoot;
  }

  /**
   * 载入（或重载）记忆库，返回核心的同步报告。
   *
   * 读盘失败（权限、I/O、宿主缓存错误）会**抛出**：绝不能把删除账本
   * 读不出来当成「新库还没有删除记录」——那会让遗忘承诺静默失效。
   * 调用方（插件入口）必须把错误显示出来并保持不可操作状态。
   */
  async load(force = false): Promise<SyncReport> {
    const report = await this.store.load({ force });
    this.loaded = report.problems.every(problem => problem.issues.every(issue => !issue.fatal));
    return report;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * 恢复 AI 作业队列。
   *
   * `resumeRunning=false` 是默认值：上次运行中断的作业按「是否已发出计费请求」
   * 归类——付费未知的固定为 `unknown`，必须由用户显式处理，绝不自动重放。
   */
  async restoreJobs(): Promise<{ touched: number; unknown: number }> {
    let raw: string | null = null;
    try {
      raw = await this.store.readStateText('jobs.json');
    } catch {
      raw = null;
    }
    const touched = await this.jobs.load(raw, { resumeRunning: false });
    return {
      touched: touched.length,
      unknown: touched.filter(job => job.status === 'unknown').length,
    };
  }

  /** 把当前作业队列写回磁盘（界面上的暂停/取消等动作之后调用）。 */
  async persistJobs(): Promise<boolean> {
    try {
      await this.store.writeStateFile('jobs.json', this.jobs.serialize());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 处理一次外部写请求队列。
   *
   * 这是插件作为**权威提交者**的核心动作：外部 CLI/MCP 只排队，
   * 真正的 Markdown 写入发生在这里（内部走 `Vault.process`）。
   */
  async drainQueue() {
    if (!this.loaded) await this.load();
    return this.writeQueue.processOnce();
  }

  /**
   * AI 传输：**复用核心的 `OpenAiCompatibleProvider`**，只注入传输层。
   *
   * 这一步是刻意的：插件的网络边界不该另写一套。核心的提供方已经包含
   * 有界等待（`timeoutMs`）、发送前取消检查、迟到响应不使用、以及
   * 「停止等待 ≠ 停止远端计费」的诚实报告；另写一份只会漏掉它们。
   *
   * 关于中止：Obsidian 的 `requestUrl` 不接受 `AbortSignal`，
   * 但本插件可以在**本端**抢先结束等待（transport 与中止信号竞速），
   * 因此这里声明 `supportsAbort: true` 表示「本端等待可被中止」，
   * 而 `billableUnknown` 仍然如实报告远端计费未知。
   */
  createProvider(): AiProvider {
    const settings = this.getSettings();
    const controllerFactory =
      typeof AbortController === 'function'
        ? (): { signal: unknown; abort: () => void; aborted: () => boolean } => {
            const controller = new AbortController();
            return {
              signal: controller.signal,
              abort: () => controller.abort(),
              aborted: () => controller.signal.aborted,
            };
          }
        : undefined;
    /**
     * 没有配置时**不构造**真实 provider：核心的 `resolveEndpoint` 会因为
     * 空地址抛错，而界面需要的是「未配置，因此没有发送」这种可展示结论。
     */
    const notConfigured =
      !settings.ai.enabled
        ? 'AI 功能未启用（设置 → AI）。'
        : settings.ai.baseUrl.trim() === ''
          ? '未配置模型接口地址（设置 → AI）。'
          : settings.ai.model.trim() === ''
            ? '未配置模型名（设置 → AI）。'
            : '';
    if (notConfigured !== '') {
      return {
        id: 'openai-compatible-unconfigured',
        model: settings.ai.model || '未配置',
        supportsAbort: true,
        async complete(): Promise<ChatResult> {
          return {
            ok: false,
            text: '',
            model: settings.ai.model || '',
            delivered: false,
            aborted: false,
            waitOutcome: 'refused',
            billableUnknown: false,
            error: notConfigured,
          };
        },
      };
    }
    return new OpenAiCompatibleProvider({
      config: {
        baseUrl: settings.ai.baseUrl,
        apiKey: this.readCredential(settings),
        model: settings.ai.model,
      },
      transport: (url, init) => this.transport(url, init),
      ...(controllerFactory === undefined ? {} : { controllerFactory }),
    });
  }

  /** 是否存在可用的模型配置（界面据此显示「未配置」）。 */
  aiConfigured(): boolean {
    const settings = this.getSettings();
    return settings.ai.enabled && settings.ai.baseUrl.trim() !== '' && settings.ai.model.trim() !== '';
  }

  /** 密钥是否已配置（只回答「有没有」，不透露内容）。 */
  keyConfigured(): boolean {
    return this.readCredential(this.getSettings()) !== '';
  }

  /**
   * 传输层：把核心的 `HttpFetch` 契约接到 `requestUrl`。
   *
   * 两个细节不可省：
   * 1. `throw: false`——HTTP 错误码要交给上层判断，不要变成异常；
   * 2. 与 `init.signal` 竞速——本端可以停止等待，但**不能**声称
   *    远端停止处理或停止计费。
   */
  private async transport(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal?: unknown },
  ): Promise<{ status: number; text: string; aborted?: boolean }> {
    const promise = requestUrl({
      url,
      method: init.method,
      contentType: 'application/json',
      headers: init.headers,
      body: init.body,
      throw: false,
    }).then(response => ({ status: response.status, text: typeof response.text === 'string' ? response.text : '' }));

    const signal = init.signal as { aborted?: boolean; addEventListener?: (type: string, listener: () => void) => void } | undefined;
    if (signal === undefined || typeof signal.addEventListener !== 'function') return promise;
    if (signal.aborted === true) {
      // 已经在等待前被取消：本端立即结束，不再占用作业。
      void promise.catch(() => undefined);
      return { status: 0, text: '', aborted: true };
    }
    return await new Promise((resolve, reject) => {
      let settled = false;
      signal.addEventListener!('abort', () => {
        if (settled) return;
        settled = true;
        // 传输层无法真正取消 requestUrl；本端停止等待并如实标记。
        reject(new Error('本端等待被中止（远端请求可能仍在进行，是否计费未知）。'));
      });
      promise.then(
        value => {
          if (settled) return;
          settled = true;
          resolve(value);
        },
        error => {
          if (settled) return;
          settled = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /** 读取 API Key 并生成请求头；未配置时返回 null。 */
  private credentialHeader(settings: PluginSettings): Record<string, string> | null {
    const key = this.readCredential(settings);
    if (key === '') return null;
    return { authorization: `Bearer ${key}` };
  }

  /**
   * 写入本次运行的临时密钥（不落盘）。
   *
   * 空串是**有效**的显式覆盖：表示「此刻没有密钥」，而不是「没有覆盖」。
   */
  writeSessionKey(value: string): void {
    this.sessionOverride = value.trim();
  }

  /** 是否存在本次运行的覆盖（含显式空覆盖）。 */
  hasSessionKey(): boolean {
    return this.sessionOverride !== undefined;
  }

  /** 清除本次运行的覆盖，让读取重新走持久存储。 */
  clearSessionOverride(): void {
    this.sessionOverride = undefined;
  }

  /**
   * 读取 API Key：本次运行的覆盖优先，其次持久存储。
   *
   * 覆盖存在时直接返回（哪怕是空串），绝不回落到旧持久值——清空必须立即生效。
   * **如实声明**：不验证底层是否使用系统钥匙串，也不声称所有平台都加密；
   * 只声称「没有把密钥写进插件 data.json 或 Markdown」。
   * `SecretStorage` 无 removeSecret（1.13.x 实测），清空持久密钥只能写入空串。
   */
  readCredential(settings: PluginSettings): string {
    if (this.sessionOverride !== undefined) return this.sessionOverride;
    if (!settings.ai.persistKey) return '';
    if (settings.ai.keyStorage !== 'secret-storage') return '';
    const storage = this.secretStorage();
    if (storage !== null && typeof storage.getSecret === 'function') {
      try {
        const value = storage.getSecret(SECRET_ID);
        if (typeof value === 'string' && value !== '') return value;
      } catch {
        /* 读取失败按“没有配置”处理，界面上会提示去设置里填 */
      }
    }
    return '';
  }

  /**
   * 写入密钥。
   *
   * 返回 `true` 仅当密钥**真的能再次读回**：只有 setter 而没有 getter 的宿主
   * 上，写进去的值本次运行内读不回来，等于凭据丢失，不能报成已持久化。
   * 其他情况落到本次运行的覆盖并返回 `false`。
   *
   * 失败分两类，界面据此措辞：
   * - **尝试过 setter 但未确认读回**（读回不一致、读回抛错、setter 抛错）→ 置
   *   `persistUnconfirmed`：setter 可能已经落盘再失败，不能承诺「没写入」；
   * - **没有尝试持久化**（未启用持久化、无存储、能力不足）→ 确定没落盘。
   *
   * 空串是**有效**写入：表示「此刻清空」，必须压住旧持久值，而不是「什么都不做」。
   */
  writeCredential(value: string, settings: PluginSettings): boolean {
    const trimmed = value.trim();
    const wantsPersist = settings.ai.persistKey && settings.ai.keyStorage === 'secret-storage';
    const storage = wantsPersist ? this.secretStorage() : null;
    if (storage !== null && typeof storage.setSecret === 'function' && this.canPersistCredential()) {
      const setSecret = storage.setSecret;
      try {
        setSecret.call(storage, SECRET_ID, trimmed);
        // 写后读回验证：只有验得回来才清掉覆盖，否则凭据可能已经丢了。
        const readBack = this.readPersistedSecret();
        if (readBack !== trimmed) {
          // setSecret 已调用：持久值可能已被改写，只是无法确认。
          this.persistUnconfirmed = true;
          this.writeSessionKey(trimmed);
          return false;
        }
        this.persistUnconfirmed = false;
        this.sessionOverride = undefined;
        return true;
      } catch {
        /**
         * `setSecret` 抛错**不等于**写入没有发生：setter 可能先落盘再抛。
         * 只要 setter 已被调用就无法确认读回，因此与读回失败同一处理。
         */
        this.persistUnconfirmed = true;
        this.writeSessionKey(trimmed);
        return false;
      }
    }
    // 没有尝试持久化（未启用、无存储、或能力不足）才确定「没落盘」。
    this.persistUnconfirmed = false;
    this.writeSessionKey(trimmed);
    return false;
  }

  /** 上一次写入是否可能已落盘但无法确认（仅用于界面措辞，不改变行为）。 */
  persistUnconfirmedLastWrite(): boolean {
    return this.persistUnconfirmed;
  }

  /**
   * 是否具备**完整**的密钥持久化能力（读 + 写）。
   *
   * 不是「对象存在」：只有 getter 或只有 setter 都算不上可用的持久化。
   */
  hasSecretStorage(): boolean {
    return this.canPersistCredential();
  }

  /**
   * 与 `capabilities.ts` 同一判据的能力报告。
   *
   * 直接复用探测函数，避免设置页与实际行为两套判断不一致。
   */
  capabilities(): CapabilityReport {
    return probeCapabilities(this.app);
  }

  /**
   * 能否持久化密钥：必须同时具备 setSecret 与 getSecret。
   *
   * 只有 setter 时写进去的值读不回来；这种宿主上一律走本次运行的覆盖。
   */
  canPersistCredential(): boolean {
    const optional = this.capabilities().optional;
    return optional.secretStorageWrite && optional.secretStorageRead;
  }

  /** 能否读回已持久化的密钥（只探测 getter）。 */
  canReadPersistedCredential(): boolean {
    return this.capabilities().optional.secretStorageRead;
  }

  /** 读一次持久存储；不可用或读取失败都返回 `null`。 */
  private readPersistedSecret(): string | null {
    const storage = this.secretStorage();
    if (storage === null || typeof storage.getSecret !== 'function') return null;
    try {
      const value = storage.getSecret.call(storage, SECRET_ID);
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  }

  private secretStorage(): {
    getSecret?: (id: string) => string | null;
    setSecret?: (id: string, value: string) => void;
  } | null {
    const storage = (this.app as unknown as {
      secretStorage?: {
        getSecret?: (id: string) => string | null;
        setSecret?: (id: string, value: string) => void;
      };
    }).secretStorage;
    // 只要求「是对象」：getter / setter 各自是否可用由调用点单独判定。
    if (storage === null || typeof storage !== 'object') return null;
    return storage;
  }

  notify(message: string): void {
    new Notice(message);
  }
}

/** SecretStorage 的 id 必须是「小写字母数字加短横线」。 */
export const SECRET_ID = 'missher-memory-model-key';

/**
 * 把用户填的「基础地址」补成 chat/completions 端点。
 * 已经写了完整端点就原样使用——不猜用户意图之外的路径。
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}
