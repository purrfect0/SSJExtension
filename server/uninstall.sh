#!/usr/bin/env bash
# SSJ VPN - removes the proxy installed by install.sh (run as root).
# Docker, Xray, WireGuard and everything else on the server are left untouched.
set -uo pipefail

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  RED=$'\033[1;31m'; GRN=$'\033[1;32m'; CYN=$'\033[1;36m'; X=$'\033[0m'
else
  RED=""; GRN=""; CYN=""; X=""
fi

SSJ_IP="${SSJ_IP:-}"
[ "$(id -u)" -eq 0 ] || { printf '%s✗ Ошибка:%s запустите от root (sudo -i)\n' "$RED" "$X" >&2; exit 1; }
[[ "$SSJ_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { printf '%s✗ Ошибка:%s не задан или неверен SSJ_IP\n' "$RED" "$X" >&2; exit 1; }

printf '%s==>%s Останавливаю и удаляю службу ssj-proxy\n' "$CYN" "$X"
systemctl stop ssj-proxy ssj-dns ssj-feed ssj-adblock.timer ssj-rkn-feed.timer >/dev/null 2>&1 || true
systemctl disable ssj-proxy ssj-dns ssj-feed ssj-adblock.timer ssj-rkn-feed.timer >/dev/null 2>&1 || true
command -v nft >/dev/null 2>&1 && nft delete table inet ssj_guard >/dev/null 2>&1 || true
rm -rf /etc/systemd/system/ssj-proxy.service /etc/systemd/system/ssj-dns.service /etc/systemd/system/ssj-feed.service /etc/systemd/system/ssj-adblock.service /etc/systemd/system/ssj-adblock.timer /etc/systemd/system/ssj-rkn-feed.service /etc/systemd/system/ssj-rkn-feed.timer /usr/local/lib/ssj/update-adblock.py /usr/local/lib/ssj/update-rkn-feed.py /usr/local/lib/ssj/feed-server.py /etc/ssj-proxy /etc/letsencrypt/renewal-hooks/deploy/ssj-proxy.sh /etc/sysctl.d/99-ssj-bbr.conf /usr/local/bin/gost /usr/local/bin/gost.new
systemctl daemon-reload >/dev/null 2>&1 || true
id -u ssjproxy >/dev/null 2>&1 && userdel ssjproxy >/dev/null 2>&1 || true

if command -v certbot >/dev/null 2>&1; then
  for dom in "${SSJ_IP}.sslip.io" "${SSJ_IP}.nip.io"; do
    if [ -d "/etc/letsencrypt/live/${dom}" ]; then
      printf '%s==>%s Удаляю сертификат для %s\n' "$CYN" "$X" "$dom"
      certbot delete --cert-name "$dom" --non-interactive >/dev/null 2>&1 || true
    fi
  done
fi

printf '\n%s✓ Готово!%s Прокси и сертификат удалены, остальное на сервере не тронуто.\n' "$GRN" "$X"
echo "SSJ_REMOVED ${SSJ_IP}"
