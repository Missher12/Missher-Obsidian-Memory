import { describe, expect, it } from 'vitest';
import {
  buildProfileView, MEMORY_CATEGORIES, MISSHER_CATEGORY_LABELS, MemoryStore,
  assertOrganizationPath, contentHashOf, defaultOrganization, isOrganizationPath,
  mergeSettings, normalizeOrganization, organizationFolders, parseMemoryFile, serializeMemoryFile,
  type MemoryCategory, type MemoryKind, type OrganizationSettings,
} from '@mom/core';
import { memoryStore, seededRand, T0 } from './helpers.js';

const missher = (placement: 'root' | 'vault' = 'vault'): OrganizationSettings => ({ preset: 'missher', placement, folders: {} });
function fixture(organization = missher(), seed?: Record<string, string>, root = '记忆库') {
  const fs = memoryStore(seed);
  const store = new MemoryStore({ store: fs, root, organization, now: () => T0, rand: seededRand(73) });
  return { fs, store };
}

describe('文件组织设置与明确目录边界', () => {
  it('旧设置缺省仍为 legacy/root，14 分类独立于 kind', () => {
    expect(defaultOrganization()).toEqual({ preset: 'legacy', placement: 'root', folders: {} });
    expect(mergeSettings({ root: '旧库' }).settings.organization).toEqual(defaultOrganization());
    expect(MEMORY_CATEGORIES).toHaveLength(14);
    expect(MEMORY_CATEGORIES.map(key => MISSHER_CATEGORY_LABELS[key])).toEqual([
      '记忆库', '用户画像', '场景', '知识库', '调研', '决策', '规划', '工作流', '教训', '日记', '周报', '月报', '系统', '模板',
    ]);
    expect(organizationFolders('旧库', defaultOrganization())).toEqual(['旧库']);
  });

  it('root/vault 布局计算物理目录、保留旧 root 并去重，不产生全库根', () => {
    const nested = organizationFolders('旧库', missher('root'));
    expect(nested).toHaveLength(15);
    expect(nested).toContain('旧库/知识库');
    expect(nested).not.toContain('知识库');
    const top = organizationFolders('记忆库', missher());
    expect(top).toHaveLength(14);
    expect(new Set(top).size).toBe(top.length);
    expect(top).not.toContain('');
    expect(top).not.toContain('.');
    const custom = normalizeOrganization({ ...missher(), folders: { knowledge: '资料/知识', research: '资料/知识' } });
    expect(organizationFolders('旧库', custom).filter(path => path === '资料/知识')).toHaveLength(1);
  });

  it.each(['../私人', '/绝对', 'C:相对', '~/.config', '.obsidian', '资料/.memory', '.', '', '.隐藏', 'a\u0000b'])(
    '分类目录拒绝不安全值 %j，设置合并明确警告回退', path => {
      const raw = { ...missher(), folders: { knowledge: path } };
      expect(() => normalizeOrganization(raw)).toThrow();
      const merged = mergeSettings({ organization: raw });
      expect(merged.settings.organization).toEqual(defaultOrganization());
      expect(merged.warnings).toHaveLength(1);
    },
  );

  it('拒绝错误配置类型、未知分类和非白名单路径，不把协议目录开放为正文目录', () => {
    for (const raw of [[], 'missher', { preset: 'other' }, { placement: 'all' }, { folders: { other: '资料' } }]) {
      expect(() => normalizeOrganization(raw)).toThrow();
    }
    expect(assertOrganizationPath('旧库', missher(), '知识库/主题.md')).toBe('知识库/主题.md');
    expect(isOrganizationPath('旧库', missher(), '旧库/旧分类/记忆.md')).toBe(true);
    for (const path of ['私人/秘密.md', '知识库外/主题.md', '知识库/../私人/秘密.md', '/知识库/主题.md', '旧库/.memory/账本.md', '知识库/.obsidian/config.md']) {
      expect(isOrganizationPath('旧库', missher(), path)).toBe(false);
      expect(() => assertOrganizationPath('旧库', missher(), path)).toThrow();
    }
  });
});

describe('新建分类、旧文件共存与不迁移', () => {
  it.each(MEMORY_CATEGORIES)('显式 %s 分类落入中文目录并往返元数据', async category => {
    const { store, fs } = fixture();
    const saved = await store.remember({ title: '简短标题', body: '合成事实', category, kind: 'fact', sourceKind: 'user_explicit' });
    expect(saved.ok).toBe(true);
    expect(saved.path).toBe(`${MISSHER_CATEGORY_LABELS[category]}/简短标题.md`);
    const parsed = parseMemoryFile(saved.path, fs.peek(saved.path)!);
    expect(parsed.record?.meta.category).toBe(category);
    expect(parsed.record?.meta.kind).toBe('fact');
    expect(parseMemoryFile(saved.path, serializeMemoryFile(parsed.record!)).record?.meta.category).toBe(category);
  });

  it.each<[MemoryKind, MemoryCategory]>([
    ['knowledge', 'knowledge'], ['decision', 'decision'], ['project', 'planning'], ['event', 'journal'],
    ['note', 'memory'], ['fact', 'memory'], ['preference', 'memory'], ['person', 'memory'],
  ])('缺省类别仅由 kind=%s 推导为 %s', async (kind, category) => {
    const { store } = fixture(missher('root'));
    const saved = await store.remember({ title: '标题', body: '分类合成内容', kind, sourceKind: 'user_explicit' });
    expect(saved.path).toBe(`记忆库/${MISSHER_CATEGORY_LABELS[category]}/标题.md`);
    expect(store.get(saved.id)?.meta.category).toBe(category);
  });

  it('自定义目录不改变状态和范围；pending 不进入默认检索', async () => {
    const organization = normalizeOrganization({ ...missher(), folders: { knowledge: '资料/文献' } });
    const { store } = fixture(organization);
    const saved = await store.propose({ title: '范围案例', body: '合成知识', kind: 'knowledge', scope: 'project', scopeRef: 'demo', sourceKind: 'ai_extraction' });
    expect(saved.path).toBe('资料/文献/范围案例.md');
    expect(store.get(saved.id)?.meta).toMatchObject({ scope: 'project', scope_ref: 'demo', status: 'pending' });
    expect((await store.search({ text: '合成知识' })).hits).toHaveLength(0);
  });

  it('legacy 沿用旧 kind 目录与 ID 前缀，旧元数据不凭空增加 category', async () => {
    const { store, fs } = fixture(defaultOrganization(), undefined, '旧库');
    const saved = await store.remember({ title: '偏好', body: '合成偏好', kind: 'preference', sourceKind: 'user_explicit' });
    expect(saved.path).toMatch(/^旧库\/10-关于我\/[a-f0-9]{8}-偏好\.md$/);
    expect(fs.peek(saved.path)).not.toMatch(/^category:/m);
    const parsed = parseMemoryFile(saved.path, fs.peek(saved.path)!);
    expect(parsed.record?.meta.category).toBeUndefined();
    expect(serializeMemoryFile(parsed.record!)).not.toMatch(/^category:/m);
    const modern = new MemoryStore({ store: fs, root: '旧库', organization: missher(), now: () => T0 });
    await modern.load();
    expect(modern.get(saved.id)?.path).toBe(saved.path);
    expect(fs.peek(saved.path)).not.toMatch(/^category:/m);
  });

  it('普通旧笔记与导航不算坏记忆，同名路径占用后使用序号且不改原文', async () => {
    const ordinary = '# 已有主题\n\n用户原文';
    const { store, fs } = fixture(missher(), {
      '知识库/主题.md': ordinary,
      '知识库/导航.md': '---\ntitle: 导航\ncategory: reading\ntags: [索引]\n---\n# 导航',
    });
    const report = await store.load();
    expect(report.valid).toBe(0);
    expect(report.invalid).toBe(0);
    expect(report.problems).toEqual([]);
    const first = await store.remember({ title: '主题', body: '新的合成记忆', kind: 'knowledge', sourceKind: 'user_explicit' });
    const second = await store.remember({ title: '主题', body: '另一条合成记忆', kind: 'knowledge', sourceKind: 'user_explicit' });
    expect(first.path).toBe('知识库/主题-2.md');
    expect(second.path).toBe('知识库/主题-3.md');
    expect(fs.peek('知识库/主题.md')).toBe(ordinary);
  });

  it('只枚举明确配置的根，恶意适配器夹带根外文件时不读取', async () => {
    const { store, fs } = fixture();
    const listed: string[] = [];
    const read: string[] = [];
    const listFiles = fs.listFiles.bind(fs);
    const readFile = fs.readFile.bind(fs);
    fs.listFiles = async (path, extensions) => {
      listed.push(path ?? '');
      return [...await listFiles(path, extensions), { path: '私人/不能读取.md', size: 4, mtime: T0 }];
    };
    fs.readFile = async path => { read.push(path); return readFile(path); };
    await store.load();
    expect(listed).toEqual(organizationFolders('记忆库', missher()));
    expect(read).not.toContain('私人/不能读取.md');
    expect(read.every(path => path.startsWith('记忆库/.memory/'))).toBe(true);
  });

  it('已知托管记录删坏元数据仍报告，重建也不能把它藏成普通笔记', async () => {
    const { store, fs } = fixture();
    const saved = await store.remember({ title: '待修复', body: '合成事实', sourceKind: 'user_explicit' });
    fs.simulateManualEdit(saved.path, '# 手改后丢失了所有属性');
    const report = await store.rebuild();
    expect(report.invalid).toBe(1);
    expect(report.problems.some(problem => problem.path === saved.path)).toBe(true);
    expect(store.get(saved.id)).toBeNull();
  });

  it('首次载入明显托管但无 id 的文件仍报告损坏，未知 category 也不可被隐去', async () => {
    const { store } = fixture(missher(), { '记忆库/坏记忆.md': '---\nsource_kind: user_explicit\nrevision: 1\n---\n# 损坏记忆' });
    expect((await store.load()).invalid).toBe(1);
    const good = fixture();
    const saved = await good.store.remember({ title: '分类案例', body: '合成事实', sourceKind: 'user_explicit' });
    const raw = good.fs.peek(saved.path)!.replace('category: memory', 'category: unknown');
    expect(parseMemoryFile(saved.path, raw).ok).toBe(false);
    expect(parseMemoryFile(saved.path, raw).issues.some(issue => issue.code === 'unknown_category')).toBe(true);
  });

  it('加载后冒出的同名文件由 expectedHash:null 拒绝，绝不覆盖普通笔记', async () => {
    const { store, fs } = fixture();
    await store.load();
    fs.simulateManualEdit('记忆库/迟到同名.md', '# 其他编辑器刚刚创建');
    const result = await store.remember({ title: '迟到同名', body: '合成事实', sourceKind: 'user_explicit' });
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(fs.peek('记忆库/迟到同名.md')).toBe('# 其他编辑器刚刚创建');
  });

  it('新布局保留人工修改 CAS；改标题不自动改路径或 ID', async () => {
    const { store, fs } = fixture();
    const saved = await store.remember({ title: '原始标题', body: '初始合成内容', category: 'lesson', sourceKind: 'user_explicit' });
    const original = fs.peek(saved.path)!;
    fs.simulateManualEdit(saved.path, `${original}\n人工补充\n`, { cacheStale: true });
    const result = await store.update(saved.id, { title: '新标题', actor: 'user', reason: '合成修改', expectedHash: contentHashOf(original) });
    expect(result.conflict).toBe(true);
    expect(fs.peek(saved.path)).toContain('人工补充');
    await store.load({ force: true });
    const renamedTitle = await store.update(saved.id, { title: '新标题', actor: 'user', reason: '用户修改标题', expectedHash: contentHashOf(fs.peek(saved.path)!) });
    expect(renamedTitle.ok).toBe(true);
    expect(renamedTitle.id).toBe(saved.id);
    expect(renamedTitle.path).toBe(saved.path);
    expect(store.get(saved.id)?.meta.category).toBe('lesson');
  });

  it('只加载不会写文件或创建十四个空目录', async () => {
    const { store, fs } = fixture();
    const directories: string[] = [];
    const ensureDir = fs.ensureDir.bind(fs);
    fs.ensureDir = async (path?: string) => { directories.push(path ?? ''); await ensureDir(); };
    const before = fs.revision();
    await store.load();
    expect(fs.revision()).toBe(before);
    expect(directories).toEqual([]);
  });
});


it('模板可以管理，但不作为已确认事实进入检索或画像', async () => {
  const { store } = fixture();
  const saved = await store.remember({ title: '复盘模板', body: '先记录问题，再补验证。', category: 'template', sourceKind: 'user_explicit' });
  expect(saved.ok).toBe(true);
  expect(store.get(saved.id)?.meta.status).toBe('confirmed');
  const found = await store.search({ text: '复盘', includeNonConfirmed: true });
  expect(found.hits).toHaveLength(0);
  expect(found.diagnosis.notes.some(note => note.code === 'template')).toBe(true);
  const profile = buildProfileView(store.all());
  expect(profile.sources).toHaveLength(0);
  expect(profile.excluded.template).toBe(1);
  expect(store.explain(saved.id).reasons).toContain('模板描述记录结构，不作为事实参与召回。');
  expect(store.explain(saved.id).reasons).not.toContain('当前条件下可被正常检索。');
});
