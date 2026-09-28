#!/usr/bin/env bash
#
# Wait until ConfirmX services answer their health endpoints with HTTP 200.
# Read-only (plain GETs); used by deploy.sh after restarting services.
#
#   bash wait-ready.sh [--timeout SECONDS] [--interval SECONDS] <name>=<url> [<name>=<url> ...]
#
#   --timeout   total time to wait for every target (default 120)
#   --interval  pause between polling rounds (default 2)
#
# Exit status: 0 = every target returned 200 before the deadline,
#              1 = at least one target never did (each is listed with its last status),
#              2 = usage error.

set -uo pipefail

TIMEOUT=120 INTERVAL=2
names=() urls=()

usage() { echo "usage: wait-ready.sh [--timeout S] [--interval S] name=url ..." >&2; exit 2; }
is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }

while [ $# -gt 0 ]; do
  case "$1" in
    --timeout) shift; is_uint "${1:-}" || usage; TIMEOUT="$1" ;;
    --interval) shift; is_uint "${1:-}" && [ "$1" -gt 0 ] || usage; INTERVAL="$1" ;;
    *=http://*|*=https://*) names+=("${1%%=*}"); urls+=("${1#*=}") ;;
    *) usage ;;
  esac
  shift
done
[ "${#names[@]}" -gt 0 ] || usage

declare -A last ready
for n in "${names[@]}"; do last[$n]="-"; ready[$n]=0; done

start=$SECONDS
deadline=$((start + TIMEOUT))
while :; do
  pending=0
  for i in "${!names[@]}"; do
    n="${names[$i]}"
    [ "${ready[$n]}" -eq 1 ] && continue
    code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "${urls[$i]}" 2>/dev/null)"
    code="${code:-000}"
    if [ "$code" = "200" ]; then
      ready[$n]=1
      printf 'ready    %-8s %s (after %ss)\n' "$n" "${urls[$i]}" "$((SECONDS - start))"
    else
      [ "$code" != "${last[$n]}" ] && printf 'waiting  %-8s %s → %s\n' "$n" "${urls[$i]}" "$code"
      last[$n]="$code"
      pending=$((pending + 1))
    fi
  done
  [ "$pending" -eq 0 ] && exit 0
  if [ "$SECONDS" -ge "$deadline" ]; then
    for i in "${!names[@]}"; do
      n="${names[$i]}"
      [ "${ready[$n]}" -eq 1 ] || printf 'NOT READY %-8s %s → last status %s after %ss\n' "$n" "${urls[$i]}" "${last[$n]}" "$TIMEOUT"
    done
    exit 1
  fi
  sleep "$INTERVAL"
done
