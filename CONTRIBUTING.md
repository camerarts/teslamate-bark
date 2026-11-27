# 贡献指南

欢迎提 issue 和 pull request。以下是让改动顺利合入的几条约定。

## 环境

- Node.js 22 以上
- 不需要真实的 TeslaMate 或 Bark 账号即可运行测试

```bash
npm install
npm test
```

## 提交前必须做

```bash
npm test
```

所有测试必须通过。如果新增了行为，请补对应测试。这个项目的测试集中在纯逻辑上（文案渲染、去重、时间边界、状态机迁移），不需要数据库，新增测试也应保持这一特点。

## 代码约定

- 全部使用 ESM（`import` / `export`），不引入 CommonJS
- 只有 `mqtt` 和 `pg` 两个运行时依赖，新增依赖需要说明理由
- 数据库查询集中在 `src/teslamate.mjs`，不要在别处直接拼 SQL
- 消息文案集中在 `src/bark.mjs`，新增通知类型请一并更新 `docs/notifications.md`
- 注释解释「为什么」，不复述「做了什么」

## 关于时间

TeslaMate 的 `start_date` 等字段是**不带时区后缀的 UTC 时间**。直接 `new Date(str)` 会被当成本地时间，导致 8 小时偏移。取时间请沿用仓库里已有的做法。

## 提交通信息

```
feat: 新增 XXX 通知
fix: 修正胎压去重在跨天时未重置
docs: 补充 MQTT 连接排查
```

## 提交 PR

1. 从 `main` 切分支
2. 保持改动聚焦，一个 PR 只做一件事
3. 描述里说明「为什么这样改」，而不只是「改了什么」
4. 涉及用户可见行为变化时，同步更新 `CHANGELOG.md`
