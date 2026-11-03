/**
 * 浏览器是否处于离线态。
 *
 * ⚠️ `navigator.onLine === false` 是**可靠**的（浏览器确定没有网络时一定为 false），
 * 但反过来不可靠：连着 WiFi 但没出口 / 需要认证的门户，它照样报 true。
 * 所以这个函数只用来做**"别再撞墙了"的短路**，绝不用它判断"一定能连上"——
 * 真正的连通性只能靠请求失败来说话。
 *
 * 单独一个模块（而不是塞进 cloud.ts）是为了**能被 mock 而不牵连云 SDK**：
 * cloudSync 的测试全都 `vi.mock('../cloud')`，往那个模块加导出让测试拿到
 * undefined 函数，会在运行期炸成 "is not a function"，与本次改动毫无关系。
 */
export function isBrowserOffline(): boolean {
  const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  // 没有 navigator（node 测试环境）→ 当在线：宁可多试一次，也不假装离线把同步卡住
  return nav?.onLine === false;
}
