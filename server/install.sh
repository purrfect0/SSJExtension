#!/usr/bin/env bash
# SSJ VPN - proxy installer for a fresh or shared VPS (Debian / Ubuntu, run as root).
#
# Installs GOST v3.3.3 (HTTP/2 + TLS 1.3 multiplexed HTTPS proxy) on :8443 with:
#   - Let's Encrypt certificate (<IP>.sslip.io, automatic fallback to <IP>.nip.io)
#   - Unprivileged service user (ssjproxy) and hidden config (/etc/ssj-proxy/config.yaml)
#   - Outbound private/loopback IP protection (GOST bypass + nftables DNS-rebinding guard)
#   - Automatic TCP BBR enablement when supported by the kernel
#
# Existing services (Docker, Xray, WireGuard/Amnezia, websites) are never modified.
set -euo pipefail

GOST_VERSION="3.3.3"
HTTPS_PORT="${SSJ_HTTPS_PORT:-8443}"
SSJ_IP="${SSJ_IP:-}"
SSJ_USER="${SSJ_USER:-}"
SSJ_PASS="${SSJ_PASS:-}"
SELFTEST_URL="${SSJ_SELFTEST_URL:-https://cp.cloudflare.com/generate_204}"
PORT80_SERVICE="${SSJ_PORT80_SERVICE:-}"
PORT80_CONTAINER="${SSJ_PORT80_CONTAINER:-}"
PORT80_ACTION="${SSJ_PORT80_ACTION:-}"
DPKG_FIX="${SSJ_DPKG_FIX:-}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[1;31m'; GRN=$'\033[1;32m'
  YEL=$'\033[1;33m'; CYN=$'\033[1;36m'; X=$'\033[0m'
else
  B=""; DIM=""; RED=""; GRN=""; YEL=""; CYN=""; X=""
fi

step() { printf '%s==>%s %s\n' "$CYN" "$X" "$1"; }
fail() { printf '\n%s✗ Ошибка:%s %s\n' "$RED" "$X" "$1" >&2; exit 1; }
row()  { printf '  %s%s%s  %-5s %s\n' "$2" "$1" "$X" "$3" "$4"; }
sub()  { printf '         %s└ %s%s\n' "$DIM" "$1" "$X"; }
rule() { printf '  %s────────────────────────────────────────────────────%s\n' "$DIM" "$X"; }
has_tty() { { : </dev/tty; } 2>/dev/null; }

[ "$(id -u)" -eq 0 ] || fail "запустите от root (sudo -i)"
command -v apt-get >/dev/null 2>&1 || fail "нужен Debian или Ubuntu (apt-get не найден)"
[[ "$SSJ_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || fail "не задан или неверен SSJ_IP"
[[ "$SSJ_USER" =~ ^[A-Za-z0-9]{1,32}$ ]] || fail "не задан или неверен SSJ_USER"
[[ "$SSJ_PASS" =~ ^[A-Za-z0-9]{8,64}$ ]] || fail "не задан или неверен SSJ_PASS"
[[ -z "$PORT80_SERVICE" || "$PORT80_SERVICE" =~ ^[A-Za-z0-9@._-]+$ ]] || fail "неверен SSJ_PORT80_SERVICE"
[[ -z "$PORT80_CONTAINER" || "$PORT80_CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.,-]*$ ]] || fail "неверен SSJ_PORT80_CONTAINER"
[[ -z "$PORT80_ACTION" || "$PORT80_ACTION" =~ ^(safe|stop)$ ]] || fail "SSJ_PORT80_ACTION должен быть safe или stop"
[[ -z "$DPKG_FIX" || "$DPKG_FIX" == "yes" ]] || fail "SSJ_DPKG_FIX может быть только yes"

DOMAIN_PRIMARY="${SSJ_DOMAIN:-${SSJ_IP}.sslip.io}"
DOMAIN_FALLBACK="${SSJ_IP}.nip.io"
DOMAIN="$DOMAIN_PRIMARY"
if [ ! -s "/etc/letsencrypt/live/${DOMAIN_PRIMARY}/fullchain.pem" ] && [ -s "/etc/letsencrypt/live/${DOMAIN_FALLBACK}/fullchain.pem" ]; then
  DOMAIN="$DOMAIN_FALLBACK"
fi
CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
UNIT="/etc/systemd/system/ssj-proxy.service"

case "$(uname -m)" in
  x86_64|amd64)  ARCH="amd64"; SHA256="f4c1255dc892a7014c0ad6e5f1c3573108f7bea4403f04f21873406ab58aa666" ;;
  aarch64|arm64) ARCH="arm64"; SHA256="4c704c92df6eeea8a3b08d0de4fd3c44343095a20136b3b6cf334f98d2f174ab" ;;
  armv7l)        ARCH="armv7"; SHA256="721343061accae0003c380eec61188dda75f5d324ce9ffdd733c4251cb9d2210" ;;
  *) fail "неподдерживаемая архитектура процессора: $(uname -m)" ;;
esac

RERUN=0
systemctl is-active --quiet ssj-proxy 2>/dev/null && RERUN=1

port_busy() { ss -ltnH 2>/dev/null | grep -Eq "[]:]$1[[:space:]]"; }

port_holder() {
  local line name pid
  line="$(ss -ltnpH 2>/dev/null | grep -E "[]:]$1[[:space:]]" | head -n1 || true)"
  name="$(printf '%s' "$line" | grep -o 'users:(("[^"]*"' | head -n1 | sed 's/users:(("//; s/"$//' || true)"
  pid="$(printf '%s' "$line" | grep -o 'pid=[0-9]*' | head -n1 | cut -d= -f2 || true)"
  printf '%s|%s' "$name" "$pid"
}

port_state() {
  local name
  port_busy "$1" || { echo free; return 0; }
  name="$(port_holder "$1" | cut -d'|' -f1)"
  if [ "$RERUN" -eq 1 ] && [ "$name" = "gost" ]; then echo ours; else echo other; fi
}

port_free_or_unit() {
  local port="$1" expected_unit="$2" pid unit
  port_busy "$port" || return 0
  pid="$(port_holder "$port" | cut -d'|' -f2)"
  [ -n "$pid" ] || return 1
  unit="$(systemctl status "$pid" --no-pager 2>/dev/null | head -n1 | grep -o '[A-Za-z0-9@._-]*\.service' | head -n1 || true)"
  [ "$unit" = "${expected_unit}.service" ]
}

docker_holders() {
  command -v docker >/dev/null 2>&1 || return 0
  docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}' 2>/dev/null | grep -F ":$1->" | cut -d'|' -f1,2 || true
}

service_of_pid() {
  local unit
  [ -n "$1" ] || return 0
  unit="$(systemctl status "$1" --no-pager 2>/dev/null | head -n1 | grep -o '[A-Za-z0-9@._-]*\.service' | head -n1 || true)"
  case "$unit" in
    ""|docker.service|containerd.service|ssh.service|sshd.service|cron.service|user@*|getty@*|systemd-*) return 0 ;;
  esac
  printf '%s' "${unit%.service}"
}

NEED_CERT=0
[ -s "${CERT_DIR}/fullchain.pem" ] || NEED_CERT=1

MISSING_PKGS=()
if ! command -v curl >/dev/null 2>&1; then MISSING_PKGS+=(curl ca-certificates); fi
if ! command -v certbot >/dev/null 2>&1; then MISSING_PKGS+=(certbot); fi
if ! command -v dnsmasq >/dev/null 2>&1; then MISSING_PKGS+=(dnsmasq-base); fi
if ! command -v python3 >/dev/null 2>&1; then MISSING_PKGS+=(python3); fi
if ! command -v ss >/dev/null 2>&1; then MISSING_PKGS+=(iproute2); fi

DPKG_BAD=0
DPKG_PKGS=""
if [ "${#MISSING_PKGS[@]}" -gt 0 ]; then
  AUDIT="$(dpkg --audit 2>/dev/null || true)"
  DPKG_PKGS="$(printf '%s\n' "$AUDIT" | grep -E '^ [a-z0-9]' | awk '{print $1}' | paste -sd, - || true)"
  if [ -n "$AUDIT" ] || [ -n "$(ls -A /var/lib/dpkg/updates 2>/dev/null || true)" ]; then DPKG_BAD=1; fi
fi

P80_KIND=""
P80_TARGETS=""
BLOCK_REQUIRED=0

printf '\n%sПроверка сервера %s%s\n' "$B" "$SSJ_IP" "$X"
rule

if [ "$NEED_CERT" -eq 0 ]; then
  row "✓" "$GRN" 80 "сертификат уже выпущен (${DOMAIN}), порт не нужен"
elif [ -n "$PORT80_SERVICE" ] || [ -n "$PORT80_CONTAINER" ]; then
  row "✓" "$GRN" 80 "выпуск сертификата — ${GRN}освободим автоматически${X}"
elif ! command -v ss >/dev/null 2>&1; then
  row "!" "$YEL" 80 "утилита ss не найдена, порт не проверен"
elif port_busy 80; then
  IFS='|' read -r H_NAME H_PID <<< "$(port_holder 80)"
  DOCKER_LINES=""
  if [ "$H_NAME" = "docker-proxy" ]; then DOCKER_LINES="$(docker_holders 80)"; fi
  row "✗" "$RED" 80 "${B}выпуск сертификата${X} — ${RED}занят${X}"
  if [ -n "$DOCKER_LINES" ]; then
    P80_KIND="docker"
    P80_TARGETS="$(printf '%s\n' "$DOCKER_LINES" | cut -d'|' -f1 | paste -sd, -)"
    while IFS='|' read -r c_name c_image; do sub "контейнер ${YEL}${c_name}${X}${DIM} (${c_image})"; done <<< "$DOCKER_LINES"
  else
    UNIT_NAME="$(service_of_pid "$H_PID")"
    if [ -n "$UNIT_NAME" ]; then
      P80_KIND="service"; P80_TARGETS="$UNIT_NAME"
      sub "служба ${YEL}${UNIT_NAME}${X}${DIM} (процесс ${H_NAME:-?}, PID ${H_PID:-?})"
    else
      P80_KIND="other"
      sub "процесс ${YEL}${H_NAME:-неизвестный}${X}${DIM} (PID ${H_PID:-?})"
    fi
  fi
else
  row "✓" "$GRN" 80 "выпуск сертификата — ${GRN}свободен${X}"
fi

if ! command -v ss >/dev/null 2>&1; then
  row "!" "$YEL" "$HTTPS_PORT" "HTTPS-прокси — порт не проверен (нет утилиты ss)"
else
  ST="$(port_state "$HTTPS_PORT")"
  if [ "$ST" = "ours" ]; then
    row "✓" "$GRN" "$HTTPS_PORT" "HTTPS-прокси — уже работает (обновление конфигурации)"
  elif [ "$ST" = "other" ]; then
    IFS='|' read -r H_NAME H_PID <<< "$(port_holder "$HTTPS_PORT")"
    row "✗" "$RED" "$HTTPS_PORT" "${B}HTTPS-прокси${X} — ${RED}занят${X}"
    sub "процесс ${YEL}${H_NAME:-неизвестный}${X}${DIM} (PID ${H_PID:-?})"
    BLOCK_REQUIRED=1
  else
    row "✓" "$GRN" "$HTTPS_PORT" "HTTPS-прокси — ${GRN}свободен${X}"
  fi
fi

if [ "${#MISSING_PKGS[@]}" -eq 0 ]; then
  row "✓" "$GRN" "apt" "curl и certbot уже установлены"
elif [ "$DPKG_BAD" -eq 1 ]; then
  row "✗" "$RED" "apt" "${B}пакетная система${X} — ${RED}прервана установка пакетов${X}"
  sub "${DPKG_PKGS:-незавершённые операции dpkg}"
else
  row "✓" "$GRN" "apt" "пакетная система исправна (будет установлено: ${MISSING_PKGS[*]})"
fi
rule

if [ "$BLOCK_REQUIRED" -eq 1 ]; then
  printf '\n%s✗ Порт %s обязателен%s: именно к нему подключается расширение.\n' "$RED" "$HTTPS_PORT" "$X" >&2
  printf '  Освободите его или выберите другой сервер.\n' >&2
  printf '  %sНа сервере ничего не изменено.%s\n\n' "$B" "$X" >&2
  exit 1
fi

if [ "$P80_KIND" = "other" ]; then
  printf '\n%s✗ Порт 80 занят процессом, который скрипт не умеет безопасно останавливать.%s\n' "$RED" "$X" >&2
  printf '  Остановите его сами на время установки или выберите другой сервер.\n' >&2
  printf '  %sНа сервере ничего не изменено.%s\n\n' "$B" "$X" >&2
  exit 1
fi

ASK80=0; ASKDPKG=0
[ -n "$P80_KIND" ] && [ -z "$PORT80_ACTION" ] && ASK80=1
[ "$DPKG_BAD" -eq 1 ] && [ -z "$DPKG_FIX" ] && ASKDPKG=1

if [ $((ASK80 + ASKDPKG)) -gt 0 ] && ! has_tty; then
  printf '\n%sНужно принять решение, а терминала нет.%s Запустите команду снова, добавив перед ней:\n' "$YEL" "$X" >&2
  [ "$ASK80" -eq 1 ] && printf '  %sSSJ_PORT80_ACTION=safe%s   порт 80: остановка только на время выпуска сертификата\n' "$GRN" "$X" >&2
  [ "$ASKDPKG" -eq 1 ] && printf '  %sSSJ_DPKG_FIX=yes%s         завершить прерванную установку пакетов (dpkg --configure -a)\n' "$GRN" "$X" >&2
  exit 1
fi

if [ "$ASK80" -eq 1 ]; then
  case "$P80_KIND" in
    docker)  NOUN_CAP="Контейнер"; NOUN_INS="контейнером" ;;
    *)       NOUN_CAP="Служба";    NOUN_INS="службой" ;;
  esac
  printf '\n%sПорт 80 нужен Let'"'"'s Encrypt на несколько секунд, чтобы выдать сертификат.%s\n' "$B" "$X"
  printf '%sЧто сделать с %s на порту 80?%s\n\n' "$B" "$NOUN_INS" "$X"
  printf '  %s1%s  %sБЕЗОПАСНО (рекомендуется)%s — остановить на несколько секунд и сразу вернуть\n' "$GRN" "$X" "$GRN" "$X"
  printf '  %s2%s  %sОТКЛЮЧИТЬ%s — остановить и выключить автозапуск\n' "$YEL" "$X" "$YEL" "$X"
  printf '  %s3%s  Отмена\n\n' "$CYN" "$X"
  ANSWER=""
  read -r -t 180 -p "  Ваш выбор [1/2/3]: " ANSWER </dev/tty || ANSWER=3
  printf '\n'
  case "$ANSWER" in
    1) PORT80_ACTION="safe" ;;
    2) PORT80_ACTION="stop" ;;
    *) printf '%sОтменено.%s На сервере ничего не изменено.\n\n' "$B" "$X"; exit 1 ;;
  esac
fi

if [ "$ASKDPKG" -eq 1 ]; then
  printf '\n%sПакетная система сервера требует завершения прошлой установки (%s).%s\n' "$B" "${DPKG_PKGS:-dpkg}" "$X"
  printf '  %s1%s  %sИСПРАВИТЬ И ПРОДОЛЖИТЬ%s\n  %s2%s  Отмена\n\n' "$GRN" "$X" "$GRN" "$X" "$CYN" "$X"
  ANSWER=""
  read -r -t 180 -p "  Ваш выбор [1/2]: " ANSWER </dev/tty || ANSWER=2
  printf '\n'
  [ "$ANSWER" = "1" ] && DPKG_FIX="yes" || { printf '%sОтменено.%s\n\n' "$B" "$X"; exit 1; }
fi

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_SUSPEND=1
APT_OPTS=(-o DPkg::Lock::Timeout=180 -o Dpkg::Options::=--force-confold)

if [ "$DPKG_BAD" -eq 1 ] && [ "$DPKG_FIX" = "yes" ]; then
  step "Завершаю прерванную установку пакетов (dpkg --configure -a)"
  : > /tmp/ssj-dpkg.log
  if ! dpkg --force-confold --configure -a >>/tmp/ssj-dpkg.log 2>&1; then
    apt-get "${APT_OPTS[@]}" install -f -y --no-install-recommends >>/tmp/ssj-dpkg.log 2>&1 || true
    dpkg --force-confold --configure -a >>/tmp/ssj-dpkg.log 2>&1 \
      || { tail -n 6 /tmp/ssj-dpkg.log >&2; fail "не удалось исправить dpkg (/tmp/ssj-dpkg.log)"; }
  fi
fi

if [ "$PORT80_ACTION" = "safe" ] && [ -n "$P80_KIND" ]; then
  if [ "$P80_KIND" = "docker" ]; then PORT80_CONTAINER="$P80_TARGETS"; else PORT80_SERVICE="$P80_TARGETS"; fi
elif [ "$PORT80_ACTION" = "stop" ] && [ -n "$P80_KIND" ]; then
  if [ "$P80_KIND" = "docker" ]; then
    for c in ${P80_TARGETS//,/ }; do docker stop "$c" >/dev/null; docker update --restart=no "$c" >/dev/null; done
  else
    systemctl disable --now "$P80_TARGETS" >/dev/null 2>&1 || fail "не удалось остановить службу ${P80_TARGETS}"
  fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do port_busy 80 || break; sleep 1; done
fi

printf '\n'
if [ "${#MISSING_PKGS[@]}" -gt 0 ]; then
  step "Устанавливаю пакеты: ${MISSING_PKGS[*]}"
  apt-get "${APT_OPTS[@]}" update -y -qq >/dev/null 2>&1 || true
  apt-get "${APT_OPTS[@]}" install -y -qq --no-install-recommends --no-upgrade "${MISSING_PKGS[@]}" >/tmp/ssj-apt.log 2>&1 \
    || { tail -n 6 /tmp/ssj-apt.log >&2 || true; fail "не удалось установить пакеты (${MISSING_PKGS[*]})"; }
fi

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  step "Открываю порты в ufw"
  for p in 80 "$HTTPS_PORT" 2053 2083; do ufw allow "${p}/tcp" >/dev/null; done
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  step "Открываю порты в firewalld"
  for p in 80 "$HTTPS_PORT" 2053 2083; do firewall-cmd --permanent --add-port="${p}/tcp" >/dev/null 2>&1 || true; done
  firewall-cmd --reload >/dev/null 2>&1 || true
fi

# Enable TCP BBR if available and not yet enabled
if sysctl net.ipv4.tcp_available_congestion_control 2>/dev/null | grep -qw bbr; then
  if [ "$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || true)" != "bbr" ]; then
    step "Включаю ускорение TCP BBR"
    cat > /etc/sysctl.d/99-ssj-bbr.conf <<'SYSCTL'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
SYSCTL
    sysctl --system >/dev/null 2>&1 || true
  fi
fi

issue_cert() {
  local target_domain="$1"
  PRE_CMD=""
  POST_CMD=""
  if [ -n "$PORT80_SERVICE" ]; then
    PRE_CMD="systemctl stop ${PORT80_SERVICE}"
    POST_CMD="systemctl start ${PORT80_SERVICE}"
  fi
  if [ -n "$PORT80_CONTAINER" ]; then
    PRE_CMD="${PRE_CMD:+${PRE_CMD}; }docker stop ${PORT80_CONTAINER//,/ }"
    POST_CMD="${POST_CMD:+${POST_CMD}; }docker start ${PORT80_CONTAINER//,/ }"
  fi
  CERTBOT_HOOKS=()
  [ -n "$PRE_CMD" ] && CERTBOT_HOOKS=(--pre-hook "$PRE_CMD" --post-hook "${POST_CMD} || true")
  certbot certonly --standalone -d "$target_domain" --preferred-challenges http \
    --non-interactive --agree-tos --register-unsafely-without-email \
    ${CERTBOT_HOOKS[@]+"${CERTBOT_HOOKS[@]}"} >/tmp/ssj-certbot.log 2>&1
}

if [ ! -s "${CERT_DIR}/fullchain.pem" ]; then
  step "Выпускаю сертификат Let's Encrypt для ${DOMAIN_PRIMARY}"
  if issue_cert "$DOMAIN_PRIMARY"; then
    DOMAIN="$DOMAIN_PRIMARY"
  else
    step "Пробую резервный домен ${DOMAIN_FALLBACK}"
    if issue_cert "$DOMAIN_FALLBACK"; then
      DOMAIN="$DOMAIN_FALLBACK"
    else
      tail -n 6 /tmp/ssj-certbot.log >&2 || true
      fail "сертификат не выпущен: порт 80 закрыт у провайдера или достигнут лимит Let's Encrypt (/tmp/ssj-certbot.log)"
    fi
  fi
  CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
fi
systemctl enable --now certbot.timer >/dev/null 2>&1 || true

if ! /usr/local/bin/gost -V 2>&1 | grep -q "gost ${GOST_VERSION}"; then
  step "Скачиваю GOST ${GOST_VERSION} (${ARCH})"
  TMP_DIR="$(mktemp -d)"
  curl -fsSL --retry 3 -o "${TMP_DIR}/gost.tar.gz" \
    "https://github.com/go-gost/gost/releases/download/v${GOST_VERSION}/gost_${GOST_VERSION}_linux_${ARCH}.tar.gz" \
    || { rm -rf "$TMP_DIR"; fail "не удалось скачать gost с GitHub"; }
  echo "${SHA256}  ${TMP_DIR}/gost.tar.gz" | sha256sum -c --quiet - \
    || { rm -rf "$TMP_DIR"; fail "контрольная сумма gost не совпала"; }
  tar -xzf "${TMP_DIR}/gost.tar.gz" -C "$TMP_DIR" gost
  install -m 755 "${TMP_DIR}/gost" /usr/local/bin/gost
  rm -rf "$TMP_DIR"
fi

step "Настраиваю изолированную службу ssj-proxy и DNS AdBlock"
id -u ssjproxy >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin ssjproxy
install -d -m 750 -o root -g ssjproxy /etc/ssj-proxy
mkdir -p /usr/local/lib/ssj
cp -fL "${CERT_DIR}/fullchain.pem" /etc/ssj-proxy/fullchain.pem
cp -fL "${CERT_DIR}/privkey.pem" /etc/ssj-proxy/privkey.pem
[ -f /etc/ssj-proxy/adblock-domains.conf ] || : > /etc/ssj-proxy/adblock-domains.conf

cat > /etc/ssj-proxy/dnsmasq.conf <<'DNSEOF'
port=5353
listen-address=127.0.0.1
bind-interfaces
no-resolv
no-poll
no-hosts
server=1.1.1.1
server=8.8.8.8
cache-size=10000
conf-file=/etc/ssj-proxy/adblock-domains.conf
DNSEOF

cat > /usr/local/lib/ssj/update-adblock.py <<'PYEOF'
#!/usr/bin/env python3
import os, re, subprocess, urllib.request
SOURCES = [
    "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=nohtml&mimetype=plaintext",
    "https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt",
]
SAFE = {
    "google.com","www.google.com","gstatic.com","googleapis.com","googleusercontent.com","googleadservices.com","www.googleadservices.com",
    "youtube.com","www.youtube.com","youtu.be","googlevideo.com","ytimg.com","ggpht.com","cloudflare.com","challenges.cloudflare.com",
    "cp.cloudflare.com","recaptcha.net","hcaptcha.com","yandex.ru","ya.ru","yandex.net","yastatic.net","kinopoisk.ru","dzen.ru",
    "vk.com","vk.ru","userapi.com","vkuser.net","ok.ru","mycdn.me","mail.ru","imgsmail.ru","gosuslugi.ru","sberbank.ru","tbank.ru",
    "tinkoff.ru","ozon.ru","ozone.ru","wildberries.ru","wb.ru","avito.ru","telegram.org","t.me","whatsapp.com","whatsapp.net","signal.org",
    "discord.com","discordapp.com","discordapp.net","discord.gg","openai.com","chatgpt.com","oaistatic.com","oaiusercontent.com","sora.com",
    "claude.ai","anthropic.com","gemini.google.com","aistudio.google.com","notebooklm.google.com","cursor.com","github.com","githubusercontent.com",
    "apple.com","icloud.com","microsoft.com","live.com","office.com","steampowered.com","steamstatic.com","roblox.com","rbxcdn.com",
    "spotify.com","scdn.co","netflix.com","instagram.com","cdninstagram.com","facebook.com","fbcdn.net","x.com","twitter.com","twimg.com",
    "tiktok.com","tiktokcdn.com","admitad.com","ad.admitad.com","letyshops.com","onelink.me","app.link","sslip.io","nip.io","ipify.org","ipwho.is","country.is","geojs.io",
}
DOM_RE = re.compile(r"^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$")
BLK_RE = re.compile(r"^\|\|([a-z0-9._-]+)\^(?:\$(?:important|third-party|all))?$", re.I)
EXC_RE = re.compile(r"^@@\|\|([a-z0-9._-]+)\^", re.I)
HOST_RE = re.compile(r"^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([a-z0-9._-]+)$", re.I)
def clean(d):
    d = d.strip().lower().strip(".")
    return d if d and len(d) <= 253 and "." in d and not d.rsplit(".", 1)[-1].isdigit() and DOM_RE.match(d) else ""
def has_parent(d, pool):
    i = d.find(".")
    while i != -1:
        if d[i + 1:] in pool: return True
        i = d.find(".", i + 1)
    return False
blocked, exceptions = set(), set()
for url in SOURCES:
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "SSJ-VPN/1.0"}), timeout=30) as r:
        for raw_bytes in r:
            line = raw_bytes.decode("utf-8", "ignore").strip()
            if not line or line[0] in ("!", "#") or "$badfilter" in line: continue
            m = EXC_RE.match(line)
            if m:
                c = clean(m.group(1))
                if c: exceptions.add(c)
                continue
            m = BLK_RE.match(line) or HOST_RE.match(line)
            if m:
                c = clean(m.group(1))
                if c and c not in SAFE: blocked.add(c)
            elif "pgl.yoyo.org" in url and " " not in line:
                c = clean(line)
                if c and c not in SAFE: blocked.add(c)
blocked -= exceptions | SAFE
pruned = sorted(d for d in blocked if not has_parent(d, blocked))
pset = set(pruned)
aexc = sorted(e for e in (exceptions | SAFE) if has_parent(e, pset))
out = "/etc/ssj-proxy/adblock-domains.conf"
with open(out + ".tmp", "w", encoding="ascii") as f:
    for d in pruned: f.write(f"address=/{d}/0.0.0.0\naddress=/{d}/::\n")
    for e in aexc: f.write(f"server=/{e}/#\n")
os.replace(out + ".tmp", out)
subprocess.run(["dnsmasq", "--test", "--conf-file=/etc/ssj-proxy/dnsmasq.conf"], check=True)
subprocess.run(["systemctl", "restart", "ssj-dns"], check=False)
PYEOF
chmod 755 /usr/local/lib/ssj/update-adblock.py

cat > /etc/systemd/system/ssj-dns.service <<'EOF'
[Unit]
Description=SSJ VPN AdBlock & Caching DNS (127.0.0.1:5353)
After=network-online.target

[Service]
User=ssjproxy
Group=ssjproxy
ExecStart=/usr/sbin/dnsmasq -k --conf-file=/etc/ssj-proxy/dnsmasq.conf
Restart=always
RestartSec=2
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/ssj-adblock.service <<'EOF'
[Unit]
Description=Update SSJ VPN AdBlock domain list
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/env python3 /usr/local/lib/ssj/update-adblock.py
ExecStartPost=/bin/chown root:ssjproxy /etc/ssj-proxy/adblock-domains.conf
ExecStartPost=/bin/chmod 640 /etc/ssj-proxy/adblock-domains.conf
EOF

cat > /etc/systemd/system/ssj-adblock.timer <<'EOF'
[Unit]
Description=Weekly SSJ VPN AdBlock list refresh

[Timer]
OnCalendar=weekly
RandomizedDelaySec=6h
Persistent=true

[Install]
WantedBy=timers.target
EOF

python3 /usr/local/lib/ssj/update-adblock.py >/dev/null 2>&1 || true

BACKUP_SVC=""
if [ "$HTTPS_PORT" != "2053" ] && port_free_or_unit 2053 ssj-proxy; then
  BACKUP_SVC="
  - name: ssj-https-backup
    addr: \":2053\"
    resolver: ssj-dns
    bypass: ssj-block-private
    handler:
      type: http2
      auth:
        username: \"${SSJ_USER}\"
        password: \"${SSJ_PASS}\"
    listener:
      type: http2
      metadata:
        keepAlive: true
        ttl: 30s
      tls:
        certFile: /etc/ssj-proxy/fullchain.pem
        keyFile: /etc/ssj-proxy/privkey.pem"
fi

cat > /etc/ssj-proxy/config.yaml <<CFGEOF
resolvers:
  - name: ssj-dns
    nameservers:
      - addr: "127.0.0.1:5353"
        prefer: ipv4
        ttl: 5m
      - addr: "1.1.1.1:53"
        prefer: ipv4
services:
  - name: ssj-https
    addr: ":${HTTPS_PORT}"
    resolver: ssj-dns
    bypass: ssj-block-private
    handler:
      type: http2
      auth:
        username: "${SSJ_USER}"
        password: "${SSJ_PASS}"
    listener:
      type: http2
      metadata:
        keepAlive: true
        ttl: 30s
      tls:
        certFile: /etc/ssj-proxy/fullchain.pem
        keyFile: /etc/ssj-proxy/privkey.pem${BACKUP_SVC}
bypasses:
  - name: ssj-block-private
    whitelist: false
    matchers:
      - "localhost"
      - "*.local"
      - "0.0.0.0/8"
      - "10.0.0.0/8"
      - "100.64.0.0/10"
      - "127.0.0.0/8"
      - "169.254.0.0/16"
      - "172.16.0.0/12"
      - "192.168.0.0/16"
      - "224.0.0.0/4"
      - "::1/128"
      - "fc00::/7"
      - "fe80::/10"
CFGEOF
chown root:ssjproxy /etc/ssj-proxy/fullchain.pem /etc/ssj-proxy/privkey.pem /etc/ssj-proxy/config.yaml /etc/ssj-proxy/dnsmasq.conf /etc/ssj-proxy/adblock-domains.conf
chmod 640 /etc/ssj-proxy/fullchain.pem /etc/ssj-proxy/privkey.pem /etc/ssj-proxy/config.yaml /etc/ssj-proxy/dnsmasq.conf /etc/ssj-proxy/adblock-domains.conf

mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/ssj-proxy.sh <<HOOKEOF
#!/usr/bin/env bash
if [ -d "${CERT_DIR}" ] && [ -d /etc/ssj-proxy ]; then
  cp -fL "${CERT_DIR}/fullchain.pem" /etc/ssj-proxy/fullchain.pem
  cp -fL "${CERT_DIR}/privkey.pem" /etc/ssj-proxy/privkey.pem
  chown root:ssjproxy /etc/ssj-proxy/fullchain.pem /etc/ssj-proxy/privkey.pem
  chmod 640 /etc/ssj-proxy/fullchain.pem /etc/ssj-proxy/privkey.pem
  systemctl restart ssj-proxy ssj-feed || true
fi
HOOKEOF
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/ssj-proxy.sh

if port_free_or_unit 2083 ssj-feed; then
  cat > /usr/local/lib/ssj/update-rkn-feed.py <<'FEEDPY'
#!/usr/bin/env python3
import datetime, gzip, json, os, re, urllib.request
SOURCES = {
    "community": "https://community.antifilter.download/list/domains.lst",
    "inside": "https://raw.githubusercontent.com/itdoginfo/allow-domains/refs/heads/main/Russia/inside-raw.lst",
    "geoblock": "https://raw.githubusercontent.com/itdoginfo/allow-domains/refs/heads/main/Categories/geoblock.lst",
    "norussia": "https://raw.githubusercontent.com/dartraiden/no-russia-hosts/master/hosts.txt",
    "google_ai": "https://raw.githubusercontent.com/itdoginfo/allow-domains/refs/heads/main/Services/google_ai.lst",
    "youtube": "https://raw.githubusercontent.com/itdoginfo/allow-domains/refs/heads/main/Services/youtube.lst",
    "discord": "https://raw.githubusercontent.com/itdoginfo/allow-domains/refs/heads/main/Services/discord.lst",
}
DOM_RE = re.compile(r"^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$")
def parse_domain(raw):
    s = raw.split("#", 1)[0].strip().lower()
    if not s: return ""
    p = s.split()
    if len(p) >= 2 and p[0] in ("0.0.0.0", "127.0.0.1"): s = p[1]
    s = re.sub(r"^(\*\.|\.+)", "", s).rstrip(".")
    if not s or "." not in s or len(s) > 253: return ""
    try: s = s.encode("idna").decode("ascii")
    except Exception: return ""
    return s if not s.rsplit(".", 1)[-1].isdigit() and DOM_RE.match(s) else ""
def has_parent(d, pool):
    i = d.find(".")
    while i != -1:
        if d[i + 1:] in pool: return True
        i = d.find(".", i + 1)
    return False
all_d, geo_d = set(), set()
for name, url in SOURCES.items():
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "SSJ-VPN/1.0"}), timeout=25) as r:
            for line in r.read().decode("utf-8", "ignore").splitlines():
                d = parse_domain(line)
                if d:
                    all_d.add(d)
                    if name in ("geoblock", "norussia", "google_ai"): geo_d.add(d)
    except Exception: pass
if len(all_d) >= 500:
    pa = sorted(d for d in all_d if not has_parent(d, all_d))
    pg = sorted(d for d in geo_d if not has_parent(d, geo_d))
    raw = json.dumps({"version": 1, "updatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "domainCount": len(pa), "domains": pa, "geoDomains": pg}, separators=(",", ":")).encode("ascii")
    gz = gzip.compress(raw, compresslevel=9)
    for fn, b in [("/etc/ssj-proxy/rkn-feed.json", raw), ("/etc/ssj-proxy/rkn-feed.json.gz", gz)]:
        with open(fn + ".tmp", "wb") as f: f.write(b)
        os.replace(fn + ".tmp", fn)
FEEDPY
  chmod 755 /usr/local/lib/ssj/update-rkn-feed.py
  python3 /usr/local/lib/ssj/update-rkn-feed.py >/dev/null 2>&1 || true
  chown root:ssjproxy /etc/ssj-proxy/rkn-feed.json* 2>/dev/null || true
  chmod 640 /etc/ssj-proxy/rkn-feed.json* 2>/dev/null || true

  cat > /usr/local/lib/ssj/feed-server.py <<'FEEDSRV'
#!/usr/bin/env python3
import os, ssl, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
JSON_P, GZ_P = "/etc/ssj-proxy/rkn-feed.json", "/etc/ssj-proxy/rkn-feed.json.gz"
SEM = threading.BoundedSemaphore(32)
CTX = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
CTX.minimum_version = ssl.TLSVersion.TLSv1_2
CTX.load_cert_chain("/etc/ssj-proxy/fullchain.pem", "/etc/ssj-proxy/privkey.pem")

class H(BaseHTTPRequestHandler):
    timeout = 5
    server_version = "nginx"; sys_version = ""
    def do_GET(self):
        if self.path.split("?", 1)[0] != "/v1/ssj-rules.json" or not os.path.isfile(JSON_P):
            self.send_error(404); return
        gz = "gzip" in self.headers.get("Accept-Encoding", "") and os.path.isfile(GZ_P)
        with open(GZ_P if gz else JSON_P, "rb") as f: body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if gz: self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass

class S(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64
    def process_request_thread(self, request, client_address):
        if not SEM.acquire(blocking=False):
            self.shutdown_request(request); return
        try:
            request.settimeout(5.0)
            tls_conn = CTX.wrap_socket(request, server_side=True)
            super().process_request_thread(tls_conn, client_address)
        except Exception:
            self.shutdown_request(request)
        finally:
            SEM.release()

S(("0.0.0.0", 2083), H).serve_forever()
FEEDSRV
  chmod 755 /usr/local/lib/ssj/feed-server.py

  cat > /etc/systemd/system/ssj-feed.service <<'EOF'
[Unit]
Description=SSJ VPN RKN Rules Feed HTTPS Server (:2083)
After=network-online.target

[Service]
User=ssjproxy
Group=ssjproxy
ExecStart=/usr/bin/env python3 /usr/local/lib/ssj/feed-server.py
Restart=always
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes

[Install]
WantedBy=multi-user.target
EOF

  cat > /etc/systemd/system/ssj-rkn-feed.service <<'EOF'
[Unit]
Description=Daily SSJ VPN RKN domain list rebuild
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/env python3 /usr/local/lib/ssj/update-rkn-feed.py
ExecStartPost=/bin/chown root:ssjproxy /etc/ssj-proxy/rkn-feed.json /etc/ssj-proxy/rkn-feed.json.gz
ExecStartPost=/bin/chmod 640 /etc/ssj-proxy/rkn-feed.json /etc/ssj-proxy/rkn-feed.json.gz
EOF

  cat > /etc/systemd/system/ssj-rkn-feed.timer <<'EOF'
[Unit]
Description=Daily SSJ VPN RKN domain list refresh

[Timer]
OnCalendar=daily
RandomizedDelaySec=2h
Persistent=true

[Install]
WantedBy=timers.target
EOF
fi

NFT_PRE=""
NFT_POST=""
if command -v nft >/dev/null 2>&1; then
  cat > /etc/ssj-proxy/guard.nft <<'NFTEOF'
table inet ssj_guard {
  chain output {
    type filter hook output priority 0; policy accept;
    meta skuid != "ssjproxy" accept
    ct state established,related accept
    ip daddr 127.0.0.1 udp dport 5353 accept
    ip daddr 127.0.0.1 tcp dport 5353 accept
    ip daddr 127.0.0.53 udp dport 53 accept
    ip daddr 127.0.0.53 tcp dport 53 accept
    ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4 } reject
    ip6 daddr { ::1/128, fc00::/7, fe80::/10, ff00::/8 } reject
  }
}
NFTEOF
  NFT_BIN="$(command -v nft)"
  NFT_PRE=$'ExecStartPre=-+'"${NFT_BIN}"$' delete table inet ssj_guard\nExecStartPre=+'"${NFT_BIN}"' -f /etc/ssj-proxy/guard.nft'
  NFT_POST="ExecStopPost=-+${NFT_BIN} delete table inet ssj_guard"
fi

cat > "$UNIT" <<UNITEOF
[Unit]
Description=SSJ VPN proxy (HTTPS ${HTTPS_PORT})
After=network-online.target
Wants=network-online.target

[Service]
User=ssjproxy
Group=ssjproxy
${NFT_PRE}
ExecStart=/usr/local/bin/gost -C /etc/ssj-proxy/config.yaml
${NFT_POST}
Restart=always
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
UNITEOF
chmod 644 "$UNIT"
systemctl daemon-reload
systemctl enable --now ssj-dns ssj-adblock.timer >/dev/null 2>&1 || true
[ -f /etc/systemd/system/ssj-feed.service ] && systemctl enable --now ssj-feed ssj-rkn-feed.timer >/dev/null 2>&1 || true
systemctl enable ssj-proxy >/dev/null 2>&1
systemctl restart ssj-dns ssj-proxy

step "Проверяю прокси"
UP=0
for _ in $(seq 1 20); do
  CODE="$(curl -sk -m 3 -o /dev/null -w '%{http_code}' --resolve "${DOMAIN}:${HTTPS_PORT}:127.0.0.1" "https://${DOMAIN}:${HTTPS_PORT}/" || true)"
  if [ "$CODE" = "407" ] || [ "$CODE" = "200" ]; then UP=1; break; fi
  sleep 1
done
[ "$UP" -eq 1 ] || fail "ssj-proxy не запустился (смотрите: journalctl -u ssj-proxy -n 30)"

OUT="$(curl -fsS -m 20 -o /dev/null -w '%{http_code}' --resolve "${DOMAIN}:${HTTPS_PORT}:127.0.0.1" \
        -x "https://${DOMAIN}:${HTTPS_PORT}" --proxy-user "${SSJ_USER}:${SSJ_PASS}" "$SELFTEST_URL" 2>&1)" \
  || fail "прокси запущен, но не пропускает трафик: ${OUT}"

printf '\n%s✓ Готово!%s Прокси запущен: %sHTTPS %s:%s%s\n' "$GRN" "$X" "$B" "$DOMAIN" "$HTTPS_PORT" "$X"
printf '  Расширение само подхватит этот сервер, окно можно не держать открытым.\n'
echo "SSJ_OK ${SSJ_IP} ${DOMAIN}"
