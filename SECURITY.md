# 安全说明

## 这个项目会接触到什么

它直连你的 TeslaMate 数据库和 MQTT，因此能看到**完整的位置轨迹、充电记录、车辆状态**。它不接触 Tesla 账号凭证（那是 TeslaMate 自己保存的）。

运行时会在 `DATA_DIR` 下写入状态文件，其中包含推送去重记录与行程信号队列。这些文件以 `0600` 权限写入。

## 请务必注意

**不要暴露 TeslaMate 的 Web 界面到公网。** TeslaMate 本身不带用户认证，任何能访问该地址的人都能看到你的实时位置与历史轨迹。如果确实需要远程访问，请放在带认证的反向代理后面。

**Bark key 等同于推送权限。** 泄露后他人可以向你推送任意内容。不要把 `.env` 提交进仓库——该文件已在 `.gitignore` 中排除。

**数据库连接串包含密码。** 建议为本服务单独建一个只读账号，而不是直接用 `teslamate` 超级用户：

```sql
CREATE USER teslamate_ro WITH PASSWORD 'your_password';
GRANT CONNECT ON DATABASE teslamate TO teslamate_ro;
GRANT USAGE ON SCHEMA public TO teslamate_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO teslamate_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO teslamate_ro;
```

## 报告漏洞

请通过 issue 私密报告，或发邮件给维护者，不要在公开 issue 中贴出可利用细节。收到后会尽快确认并修复。
