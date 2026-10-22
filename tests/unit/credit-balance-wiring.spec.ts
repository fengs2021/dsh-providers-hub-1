import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { PROVIDER_REGISTRY } from '../../src/provider-registry.js'
import type { CreditBalance } from '../../src/credits.js'
import { clearProviderRuntimes } from '../../src/provider-runtime.js'

const probes = vi.hoisted(() => ({
  read: vi.fn(async () => ({ total: 42.5, packages: [], expiredTotal: 0 } as CreditBalance)),
  claim: vi.fn(),
}))

// 只替换供应商的取数原语，注册、账号池、凭据解析和既有余额分派全部走真实现。
// ⚠️ 桩的 provider 键必须与**当前 registry** 一致：`buddy` 已从 `PROVIDER_REGISTRY`
// 移除（基线演进），继续用它会得到 `unsupported-provider` —— 而那是**桩过期**，
// 不是被测代码的缺陷。这里改成 registry 里真实存在、且本用例会查询的几家。
vi.mock('../../src/provider-credits.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/provider-credits.js')>()
  const stub = { fetchBalance: probes.read, claim: probes.claim }
  return { ...actual, createProviderCredits: () => ({ codearts: stub, lobsterai: stub }) }
})

const disposers: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  clearProviderRuntimes()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

/**
 * @param options.preexistingService 预先在根 ctx 上注册一个 `creditBalance`，
 *   模拟「服务已存在」——本函数被重复调用时就是这种局面。
 * @param options.pluginRootCtx 替换传给 `registerJetHubRpc` 的第 5 参（插件根 ctx），
 *   用于构造「`get` 探测不到、但 `provide` 会抛错」的并发窗口。
 */
async function setup(options: {
  preexistingService?: unknown
  pluginRootCtx?: (inner: Context) => unknown
} = {}) {
  const ctx = new Context()
  if (options.preexistingService !== undefined) {
    ctx.provide('creditBalance', options.preexistingService as never)
  }
  const resolve = vi.fn(async (ref: string) => ({ value: JSON.stringify({ access_token: `${ref}-PRIVATE` }), source: 'fixture' }))
  ctx.provide('credentials', { resolve } as never)
  ctx.provide('commands', { register: () => () => {}, definitions: [] } as never)
  ctx.provide('llm', { listModels: async () => [] } as never)
  const state: { value: unknown } = { value: undefined }
  ctx.provide('settings', {
    register: () => ({ get: () => state.value, replace: (value: unknown) => { state.value = value } }),
    describe: () => [],
  } as never)
  const pool = new AccountPool(ctx)
  for (const provider of ['codearts', 'lobsterai']) {
    await pool.addAccount({ id: `${provider}-PRIVATE-ID`, provider, nickname: 'PRIVATE-EMAIL', credentialRef: `${provider.toUpperCase()}_KEY`, enabled: true, refreshable: false, createdAt: 1 })
  }
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('单测不得访问真实网络') }))
  const fork = ctx.plugin((inner) => {
    // ⚠️ 第 5 参传**插件根 ctx**：服务必须注册在这里才对他插件可见；
    // 若回退到 connectionCtx（第 2 个实参内部用的那个），下面「服务可见性」
    // 的断言会得到 undefined —— 这正是本 PR 要修的那个缺陷。
    const pluginRoot = options.pluginRootCtx === undefined ? inner : options.pluginRootCtx(inner)
    registerJetHubRpc(inner, pool, Object.fromEntries(PROVIDER_REGISTRY.map((p) => [p.id, {}])) as never, undefined, pluginRoot as never)
  })
  disposers.push(async () => fork.dispose())
  // ⚠️ 记录被注册的路由：`connection.fetch.register` 是 `/api/jet-hub` 的**唯一**
  // 注册点。余额服务若在它之前抛错，这段就执行不到 ⇒ 路由整体消失（线上表现为
  // `HTTP 404` + 供应商开关读不出）。不记录就无法断言这个后果。
  const registeredPaths: string[] = []
  const mountConnection = () => {
    const connection = ctx.plugin((inner) => {
      inner.provide('connection', {
        fetch: {
          register: (route: { path: string }) => {
            registeredPaths.push(route.path)
            return () => {}
          },
        },
      } as never)
    })
    disposers.push(async () => connection.dispose())
    return connection
  }
  return { ctx, pool, resolve, mountConnection, registeredPaths }
}

describe('宿主余额服务真实接线', () => {
  it('connection 延迟出现时注册，移除时撤销，重新挂载时创建新实例', async () => {
    const { ctx, mountConnection } = await setup()
    expect(ctx.creditBalance).toBeUndefined()
    const connection = mountConnection()
    await expect.poll(() => ctx.creditBalance).toBeDefined()
    const first = ctx.creditBalance
    expect(first.supportedProviders().map((p) => p.id)).toEqual(expect.arrayContaining(['zcode', 'minimax', 'minimaxintl']))
    expect(first.supportedProviders().some((p) => p.id === 'opencode')).toBe(false)
    await connection.dispose()
    await expect.poll(() => ctx.creditBalance).toBeUndefined()
    mountConnection()
    await expect.poll(() => ctx.creditBalance).toBeDefined()
    expect(ctx.creditBalance).not.toBe(first)
  })

  it('经现有余额编排读取且仅查询指定供应商，不签到、不选号，返回脱敏读数', async () => {
    const { ctx, pool, resolve, mountConnection } = await setup()
    mountConnection()
    await expect.poll(() => ctx.creditBalance).toBeDefined()
    const select = vi.spyOn(pool, 'getAvailableAccount')
    const result = await ctx.creditBalance.creditsBalances('codearts')
    expect(result).toEqual({ accounts: [{ accountId: 'account-1', nickname: '账号 1', balance: { total: 42.5, packages: [] } }] })
    expect(probes.read).toHaveBeenCalledOnce()
    expect(resolve.mock.calls.length).toBeGreaterThan(0)
    // 凭据 ref 必须是**被查询那家自己的**（`setup()` 按 `${PROVIDER}_KEY` 造条目），
    // 不是硬编码某一家 —— 否则换 provider 时这条断言会以「假红」的形式失效。
    expect(resolve.mock.calls.every(([ref]) => ref === 'CODEARTS_KEY')).toBe(true)
    expect(probes.claim).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('OpenCode 通道数和未知供应商不作为余额暴露，也不读取凭据', async () => {
    const { ctx, resolve, mountConnection } = await setup()
    mountConnection()
    await expect.poll(() => ctx.creditBalance).toBeDefined()
    for (const id of ['opencode', '__proto__', 'unknown']) {
      await expect(ctx.creditBalance.creditsBalances(id)).rejects.toMatchObject({ name: 'UnsupportedProviderError' })
    }
    expect(resolve).not.toHaveBeenCalled()
    expect(probes.read).not.toHaveBeenCalled()
  })

  /**
   * ## 为什么这两条用例必须存在
   *
   * 上面三条用例全部跑在**测试替身**上，而替身的 `provide` 从不抛错。真实 Cordis
   * 对同名服务只允许注册一次，重复注册直接 `throw`：
   *
   * ```
   * service "creditBalance" has been registered at <fiber>
   * ```
   *
   * 于是「31/31 全绿」并不能说明这段代码在真实宿主上安全。这两条用例专门复现
   * 真实宿主的行为，覆盖两种情况：
   *
   * 1. **服务已存在** → 走 `get` 预检跳过，不重复注册，已有实例保持不动；
   * 2. **预检没探到、`provide` 仍抛错**（并发窗口）→ 只 warn，绝不向上抛，
   *    保证紧随其后的 `/api/jet-hub` 路由注册照常完成。
   *
   * 第 2 条是重点：它断言的是**路由还在**。缺陷版代码在这里会让整条路由消失，
   * 用户看到的是「供应商开关读取失败：HTTP 404」，而余额只是其中一部分。
   */
  it('服务已存在时不重复注册，保留已有实例且路由照常注册', async () => {
    const preexisting = { supportedProviders: () => [], creditsBalances: async () => ({ accounts: [] }) }
    const { ctx, mountConnection, registeredPaths } = await setup({ preexistingService: preexisting })
    mountConnection()
    await expect.poll(() => registeredPaths).toContain(JET_HUB_API_PATH)
    // 已有实例必须原样保留 —— 不能被本次注册覆盖成新对象。
    expect(ctx.creditBalance).toBe(preexisting)
  })

  it('provide 抛错时只告警，不阻断 /api/jet-hub 路由注册', async () => {
    const warn = vi.fn()
    const { ctx, mountConnection, registeredPaths } = await setup({
      // 构造「get 探测不到、provide 会抛错」的并发窗口：用一个 get 返回 undefined、
      // 但 provide 模拟真实 Cordis 重复注册异常的 ctx 替身包住真实 ctx。
      pluginRootCtx: (inner) => ({
        get: () => undefined,
        provide: () => { throw new Error('service "creditBalance" has been registered at root') },
        logger: { warn },
        effect: inner.effect.bind(inner),
      }),
    })
    mountConnection()
    // 关键断言：路由仍然注册成功。缺陷版代码在此处会因异常向上传播而漏注册。
    await expect.poll(() => registeredPaths).toContain(JET_HUB_API_PATH)
    // 「已注册」属正常重复调用，不应刷告警。
    expect(warn).not.toHaveBeenCalled()
  })
})
