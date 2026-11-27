#!/usr/bin/env bash
# 面向「已经有 TeslaMate 在跑」的用户：自动探测数据库与 MQTT 地址，
# 生成 .env，并把本服务接入 TeslaMate 所在的 Docker 网络。
#
# 用法：
#   ./scripts/install-existing.sh              # 交互式安装
#   ./scripts/install-existing.sh --dry-run    # 只打印探测结果，不写文件不启动
#
# 探测全部基于 docker inspect，不解析 compose 文件，所以路径怎么放都不影响。
set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "未知参数：$arg（可用 --dry-run）" >&2; exit 1 ;;
  esac
done

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少命令：$1" >&2; exit 1; }; }
need docker

say()  { printf '%s\n' "$*"; }
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }

# ---------- 1. 找到 TeslaMate 主容器 ----------
TM_CONTAINER=$(docker ps --filter "label=com.docker.compose.service=teslamate" --format '{{.Names}}' | head -n1 || true)
if [ -z "$TM_CONTAINER" ]; then
  # 有些部署不是 compose 起的，退化为按镜像名找
  TM_CONTAINER=$(docker ps --filter "ancestor=teslamate/teslamate" --format '{{.Names}}' | head -n1 || true)
fi
[ -n "$TM_CONTAINER" ] || fail "没找到正在运行的 TeslaMate 容器。请确认 TeslaMate 已启动（docker ps | grep teslamate）。"

PROJECT=$(docker inspect "$TM_CONTAINER" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)
NETWORK=$(docker inspect "$TM_CONTAINER" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' | head -n1)
[ -n "$NETWORK" ] || fail "无法识别 TeslaMate 所在网络。"

# ---------- 2. 找数据库容器并读取凭证 ----------
DB_CONTAINER=$(docker ps --filter "label=com.docker.compose.project=$PROJECT" \
  --filter "label=com.docker.compose.service=database" --format '{{.Names}}' | head -n1 || true)
if [ -z "$DB_CONTAINER" ]; then
  # 服务名不一定叫 database，按镜像找 postgres
  DB_CONTAINER=$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}} {{.Image}}' \
    | awk '/postgres/{print $1; exit}')
fi
[ -n "$DB_CONTAINER" ] || fail "没找到 TeslaMate 的 PostgreSQL 容器。"

DB_ENV=$(docker inspect "$DB_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}')
DB_USER=$(printf '%s\n' "$DB_ENV" | sed -n 's/^POSTGRES_USER=//p' | head -n1)
DB_PASS=$(printf '%s\n' "$DB_ENV" | sed -n 's/^POSTGRES_PASSWORD=//p' | head -n1)
DB_NAME=$(printf '%s\n' "$DB_ENV" | sed -n 's/^POSTGRES_DB=//p' | head -n1)
DB_HOST=$(docker inspect "$DB_CONTAINER" --format '{{index .Config.Labels "com.docker.compose.service"}}' 2>/dev/null || true)
[ -n "$DB_HOST" ] || DB_HOST="database"
DB_PORT=5432

[ -n "$DB_USER" ] || fail "读取不到 POSTGRES_USER，请手动在 .env 里填写 TESLAMATE_DATABASE_URL。"
[ -n "$DB_PASS" ] || say "警告：读取不到 POSTGRES_PASSWORD，生成的连接串里密码为空，需要手动补。"

# ---------- 3. 找 MQTT 地址 ----------
MQTT_HOST=$(docker inspect "$TM_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | sed -n 's/^MQTT_HOST=//p' | head -n1)
MQTT_HOST=${MQTT_HOST:-mosquitto}
MQTT_URL="mqtt://${MQTT_HOST}:1883"

DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME:-teslamate}"
# 打印时打码，避免密码进入终端历史或日志
MASKED_URL="postgresql://${DB_USER}:***@${DB_HOST}:${DB_PORT}/${DB_NAME:-teslamate}"

# 密码里带 @ : / ? # 会让 URL 解析错位，这里提前拦住而不是让人排查半天
case "$DB_PASS" in
  *@*|*:*|*/*|*\?*|*#*) say "警告：数据库密码含特殊字符（@ : / ? #），连接串可能解析失败，必要时改用只读账号。" ;;
esac

say "探测结果："
say "  TeslaMate 容器   ${TM_CONTAINER}"
say "  compose 项目     ${PROJECT:-（非 compose）}"
say "  Docker 网络      ${NETWORK}"
say "  数据库           ${DB_HOST}:${DB_PORT}/${DB_NAME:-teslamate}（用户 ${DB_USER}）"
say "  MQTT             ${MQTT_URL}"

# ---------- 4. 连通性验证 ----------
say ""
say "验证数据库连通性…"
if docker run --rm --network "$NETWORK" -e PGPASSWORD="$DB_PASS" postgres:18-alpine \
     psql -h "$DB_HOST" -U "$DB_USER" -d "${DB_NAME:-teslamate}" -tAc "select 1" >/dev/null 2>&1; then
  say "  连接成功"
else
  say "  连接失败。若数据库账号或端口不同，请手动检查后再继续。"
fi

# ---------- 5. 写入 .env ----------
if [ "$DRY_RUN" -eq 1 ]; then
  say ""
  say "（dry-run 模式，不写文件、不启动容器）"
  say ""
  say "将写入 .env 的内容："
  say "  TESLAMATE_DATABASE_URL=${MASKED_URL}"
  say "  MQTT_URL=${MQTT_URL}"
  say "  TESLAMATE_NETWORK=${NETWORK}"
  exit 0
fi

if [ -f .env ]; then
  printf '当前目录已存在 .env，覆盖吗？[y/N] '
  read -r answer
  case "$answer" in [yY]*) ;; *) fail "已取消，未修改任何文件。" ;; esac
fi

printf '请输入 Bark key（App 首页推送地址里的那串）：'
read -r BARK_KEY_INPUT
[ -n "$BARK_KEY_INPUT" ] || fail "Bark key 不能为空。"

cat > .env <<EOF
# 由 scripts/install-existing.sh 自动生成
BARK_KEY=${BARK_KEY_INPUT}
TESLAMATE_DATABASE_URL=${DATABASE_URL}
MQTT_URL=${MQTT_URL}
TESLAMATE_NETWORK=${NETWORK}
EOF
chmod 600 .env
say ""
say "已写入 .env"

# ---------- 6. 启动 ----------
say "启动服务…"
docker compose -f docker-compose.existing.yml up -d --build
say ""
say "完成。查看日志确认连接状态："
say "  docker compose -f docker-compose.existing.yml logs -f"
