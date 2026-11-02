/**
 * 让出事件循环一次。
 *
 * 为什么需要它：主进程里所有重活都跑在**同一个线程**上——
 * 本地目录遍历、哈希、SQLite 写入、远端对账的比对循环。
 * 一个 for 循环里连续做几千次同步调用（stat / SQLite / 字符串处理），
 * 事件循环就被独占了：窗口的点击、滚动、IPC 全都排在后面，
 * 用户看到的就是「点按钮没反应」。
 *
 * `await tick()` 把控制权交回事件循环一轮（setImmediate 排在
 * 本轮 I/O 回调之后、定时器之前），GUI 与 IPC 的事件得以穿插执行。
 *
 * 为什么不用 `await sleep(0)`：setTimeout(0) 在 Windows 上有
 * ~1ms 的实际粒度，一万次让出就是一秒起步的额外开销；
 * setImmediate 走的是同一轮的事件循环，代价小得多。
 */
export function tick(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}
