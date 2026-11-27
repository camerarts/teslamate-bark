// 统一日志格式：ISO 时间戳 + 内容，便于 docker logs 与 journalctl 检索。
export function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

export function logError(message) {
  process.stderr.write(`[${new Date().toISOString()}] ${message}\n`);
}
