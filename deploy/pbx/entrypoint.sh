#!/bin/sh
# Rasa PBX container start: writes the settings that come from the environment, then runs Asterisk in the foreground.
# Nothing secret is baked into the image; the AMI secret and the trunk password come from .env (docs/communications/telephony.md).
set -eu

: "${AMI_SECRET:?AMI_SECRET is required (at least 24 characters)}"
[ "${#AMI_SECRET}" -ge 24 ] || { echo "AMI_SECRET must be at least 24 characters" >&2; exit 1; }
AMI_USER="${AMI_USER:-rasa}"
AMI_PERMIT="${PBX_AMI_PERMIT:-172.16.0.0/255.240.0.0}"
RTP_START="${PBX_RTP_START:-10000}"
RTP_END="${PBX_RTP_END:-10099}"
MAX_OUTBOUND="${PBX_MAX_OUTBOUND:-2}"
case "$AMI_USER$AMI_SECRET" in *[!A-Za-z0-9_.-]*) echo "AMI_USER/AMI_SECRET: letters, digits, _ . - only" >&2; exit 1 ;; esac
case "$RTP_START$RTP_END$MAX_OUTBOUND" in *[!0-9]*) echo "PBX_RTP_START/END, PBX_MAX_OUTBOUND must be numbers" >&2; exit 1 ;; esac

ETC=/etc/asterisk
LOCAL=$ETC/rasa-local
mkdir -p "$LOCAL"
umask 027

sed -e "s|@AMI_USER@|$AMI_USER|" -e "s|@AMI_SECRET@|$AMI_SECRET|" -e "s|@AMI_PERMIT@|$AMI_PERMIT|" $ETC/manager.conf.tpl > $ETC/manager.conf
sed -e "s|@RTP_START@|$RTP_START|" -e "s|@RTP_END@|$RTP_END|" $ETC/rtp.conf.tpl > $ETC/rtp.conf
printf 'MAX_OUTBOUND=%s\n' "$MAX_OUTBOUND" > "$LOCAL/globals.conf"

# SIP transport. PBX_EXTERNAL_ADDRESS: the server's address as phones on the LAN see it (Docker NAT in between).
{
  echo '[transport-udp]'
  echo 'type=transport'
  echo 'protocol=udp'
  echo 'bind=0.0.0.0:5060'
  if [ -n "${PBX_EXTERNAL_ADDRESS:-}" ]; then
    echo "external_media_address=$PBX_EXTERNAL_ADDRESS"
    echo "external_signaling_address=$PBX_EXTERNAL_ADDRESS"
  fi
  # Networks that are "inside" (no address rewriting): the LAN of the phones.
  for net in $(echo "${PBX_LOCAL_NETS:-}" | tr ',' ' '); do echo "local_net=$net"; done
} > "$LOCAL/transport.conf"

# City-line gateway (FXO): registers to Rasa PBX as user rasa-trunk, and is also matched by its IP address.
if [ -n "${PBX_TRUNK_PASSWORD:-}" ]; then
  case "$PBX_TRUNK_PASSWORD" in *[!A-Za-z0-9]*) echo "PBX_TRUNK_PASSWORD: letters and digits only" >&2; exit 1 ;; esac
  [ "${#PBX_TRUNK_PASSWORD}" -ge 16 ] || { echo "PBX_TRUNK_PASSWORD must be at least 16 characters" >&2; exit 1; }
  {
    echo '[rasa-trunk](rasa-endpoint)'
    echo 'type=endpoint'
    echo 'context=rasa-from-trunk'
    echo 'auth=rasa-trunk-auth'
    echo 'aors=rasa-trunk'
    echo 'trust_id_inbound=no'
    echo
    echo '[rasa-trunk-auth]'
    echo 'type=auth'
    echo 'auth_type=userpass'
    echo 'username=rasa-trunk'
    echo "password=$PBX_TRUNK_PASSWORD"
    echo
    echo '[rasa-trunk](rasa-aor)'
    echo 'type=aor'
    echo 'max_contacts=1'
    if [ -n "${PBX_TRUNK_IP:-}" ]; then
      echo
      echo '[rasa-trunk-identify]'
      echo 'type=identify'
      echo 'endpoint=rasa-trunk'
      echo "match=$PBX_TRUNK_IP"
    fi
  } > "$LOCAL/pjsip_trunk.conf"
else
  : > "$LOCAL/pjsip_trunk.conf"
fi
chown -R root:asterisk "$LOCAL" $ETC/manager.conf $ETC/rtp.conf
chmod 0640 $ETC/manager.conf "$LOCAL"/*

# Rasa writes rasa/*.conf; until its first sync the includes are simply empty.
# No -G: with -G Asterisk drops its supplementary groups, and it reads Rasa's files (owner uid/gid 1000, mode 0640)
# through its membership of group 1000. With -U alone it keeps the asterisk group and all supplementary ones.
exec /usr/sbin/asterisk -f -U asterisk -vvv
