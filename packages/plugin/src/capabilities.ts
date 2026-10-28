/**
 * 宿主 API 能力探测：区分「必要但缺失」与「可选但缺失」，不许静默降级。
 *
 * 必要接口缺失时拒绝写入并如实报错；可选接口缺失时只关闭对应功能。
 * 版本依据取自官方 `obsidian.d.ts` 的 `@since` 与逐版本比对，见 docs/COMPATIBILITY.md。
 *
 * 密钥读写**分别**暴露：真实宿主出现过只有 getter 的情况，
 * 合成一个布尔值必然误报（要么谎称能持久保存，要么谎称读得回来）。
 */

import type { App } from 'obsidian';

/** 必要接口：缺失即代表核心安全承诺无法成立。 */
export interface RequiredCapabilities {
  /** `vault.process`：同步回调内「读—比较—写」的原子区。 */
  vaultProcess: boolean;
}

/** 可选接口：缺失只关闭对应功能，不影响核心本地能力。 */
export interface OptionalCapabilities {
  /** `adapter.rename`：外部 CLI/MCP 请求的原子认领。 */
  adapterRename: boolean;
  /** `app.secretStorage.getSecret`：能读回已持久化的密钥。 */
  secretStorageRead: boolean;
  /** `app.secretStorage.setSecret`：能把密钥持久化。 */
  secretStorageWrite: boolean;
  /** 命令面板的 `app:reload`：改设置后原地重载插件。 */
  appReload: boolean;
}

/** 一次能力探测的完整结果。 */
export interface CapabilityReport {
  required: RequiredCapabilities;
  optional: OptionalCapabilities;
  /** 缺失的必要接口名（人类可读）。 */
  missingRequired: string[];
  /** 缺失的可选接口名（人类可读）。 */
  missingOptional: string[];
  /** 核心安全提交是否可用。为 false 时不得提交正文。 */
  canCommitSafely: boolean;
}

/** 缺 `Vault.process` 时的统一错误码（与 `PathError.code` 一致）。 */
export const NO_ATOMIC_WRITE = 'no_atomic_write';

/** 路径不在索引里、又拿不到原子写契约时的错误码。 */
export const UNSAFE_OFFINDEX_WRITE = 'unsafe_offindex_write';

/** 缺少 `Vault.process` 时的错误文案：说明拒绝原因，不退到 modify。 */
export function atomicWriteUnavailableMessage(action: string): string {
  return (
    `当前 Obsidian 版本缺少 Vault.process（需要 1.1.0+），无法安全地${action}。` +
    '本插件不会退到 vault.modify：那会在「读原文」和「写新值」之间留下窗口，' +
    '可能覆盖你刚手动编辑的内容。请升级 Obsidian 后重试；' +
    '检索、查看与本地复盘不受影响。'
  );
}

/** 未索引文件无原子契约（`vault.process` 只接受索引里的 `TFile`）时的错误文案。 */
export function offIndexWriteUnavailableMessage(action: string): string {
  return (
    `无法安全地${action}：这个文件在磁盘上存在，但不在 Obsidian 索引里，` +
    '因此拿不到 Vault.process 的原子「读—比较—写」。' +
    '本插件不会用非原子的先读后写去覆盖它（那会静默吃掉你或外部工具刚写下的内容）。' +
    '请先在 Obsidian 里打开或重命名该文件让它进入索引，再重试；' +
    '插件自己的状态目录不受影响。'
  );
}

function hasFunction(target: unknown, name: string): boolean {
  if (target === null || typeof target !== 'object') return false;
  return typeof (target as Record<string, unknown>)[name] === 'function';
}

/**
 * 探测当前宿主实际提供了哪些接口。
 *
 * 只看**运行时真实存在与类型**，不看版本号字符串：宿主版本号不保证
 * 某个接口存在，接口本身才是证据。
 */
export function probeCapabilities(app: App): CapabilityReport {
  const vault: unknown = app?.vault;
  const adapter = (vault as { adapter?: unknown } | undefined)?.adapter;
  const commands = (app as unknown as { commands?: unknown } | undefined)?.commands;

  const required: RequiredCapabilities = {
    vaultProcess: hasFunction(vault, 'process'),
  };

  const secretStorage = (app as unknown as { secretStorage?: unknown } | undefined)?.secretStorage;
  const optional: OptionalCapabilities = {
    adapterRename: hasFunction(adapter, 'rename'),
    // 读写分开探测：只探测 getSecret 会把「只能读、不能写」误报成完整能力。
    secretStorageRead: hasFunction(secretStorage, 'getSecret'),
    secretStorageWrite: hasFunction(secretStorage, 'setSecret'),
    appReload: hasFunction(commands, 'executeCommandById'),
  };

  const missingRequired: string[] = [];
  if (!required.vaultProcess) missingRequired.push('Vault.process（1.1.0+）');

  const missingOptional: string[] = [];
  if (!optional.adapterRename) missingOptional.push('DataAdapter.rename（外部请求认领）');
  if (!optional.secretStorageRead && !optional.secretStorageWrite) {
    missingOptional.push('SecretStorage（1.11.4+，密钥持久化）');
  } else if (!optional.secretStorageWrite) {
    missingOptional.push('SecretStorage.setSecret（密钥只能保留在本次运行内）');
  } else if (!optional.secretStorageRead) {
    missingOptional.push('SecretStorage.getSecret（无法读回已持久化的密钥）');
  }
  if (!optional.appReload) missingOptional.push('命令 app:reload（改设置后自动重载）');

  return {
    required,
    optional,
    missingRequired,
    missingOptional,
    canCommitSafely: required.vaultProcess,
  };
}

/**
 * 生成给用户看的一行诊断。
 *
 * 没有缺失时返回 `null`，避免在界面上堆无意义的「一切正常」。
 */
export function describeCapabilities(report: CapabilityReport): string | null {
  if (report.missingRequired.length === 0 && report.missingOptional.length === 0) return null;
  const parts: string[] = [];
  if (report.missingRequired.length > 0) {
    parts.push(`缺少必要接口：${report.missingRequired.join('、')}；不会提交正文。`);
  }
  if (report.missingOptional.length > 0) {
    parts.push(`缺少可选接口：${report.missingOptional.join('、')}；只关闭对应功能。`);
  }
  return parts.join(' ');
}
