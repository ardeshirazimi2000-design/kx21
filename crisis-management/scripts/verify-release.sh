#!/usr/bin/env bash
# FPT_TUD_EXT.1.2/1.3 — secure update: the system administrator installs an update manually, only after
# verifying its integrity (SHA-256) and the publisher's signature over the checksum file.
#
#   scripts/verify-release.sh crisis-management-1.1.0.tgz SHA256SUMS SHA256SUMS.sig publisher-public.pem
#
# Publisher side (once per release):
#   sha256sum crisis-management-*.tgz > SHA256SUMS
#   openssl dgst -sha256 -sign publisher-private.pem -out SHA256SUMS.sig SHA256SUMS
set -euo pipefail
pkg="$1"; sums="$2"; sig="$3"; pub="$4"
openssl dgst -sha256 -verify "$pub" -signature "$sig" "$sums" >/dev/null \
  || { echo "✗ امضای فایل چکیده نامعتبر است — به‌روزرسانی نصب نشود" >&2; exit 1; }
grep -F " $(basename "$pkg")" "$sums" | (cd "$(dirname "$pkg")" && sha256sum -c --status -) \
  || { echo "✗ چکیده SHA-256 بسته با فایل امضاشده مطابقت ندارد — به‌روزرسانی نصب نشود" >&2; exit 1; }
echo "✓ امضا و چکیده بسته تأیید شد: $(basename "$pkg")"
