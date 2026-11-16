# Rasa PBX: Asterisk 20 (Ubuntu 24.04 package), configured from deploy/pbx/conf + files Rasa generates.
# Built with docker-compose.pbx.yml; never published to the internet (docs/communications/telephony.md).
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive TZ=Asia/Tehran
RUN apt-get update \
 && apt-get install -y --no-install-recommends asterisk=1:20.6.0~dfsg+~cs6.13.40431414-2build5 asterisk-core-sounds-en-gsm tzdata \
 && rm -rf /var/lib/apt/lists/* \
 # Package defaults stay for files Rasa does not set (indications, features, ...); interfaces Rasa does not use
 # (ARI, HTTP, chan_sip, IAX, AEL/Lua dial plans) are switched off by conf/ files and modules.conf.
 && rm -f /etc/asterisk/extensions.ael /etc/asterisk/extensions.lua /etc/asterisk/users.conf \
 # Rasa's API container runs as uid/gid 1000 (node) and writes the generated files with mode 0640.
 && usermod -a -G "$(getent group 1000 | cut -d: -f1)" asterisk \
 && mkdir -p /etc/asterisk/rasa /etc/asterisk/rasa-local
COPY deploy/pbx/conf/ /etc/asterisk/
COPY deploy/pbx/entrypoint.sh /usr/local/bin/rasa-pbx
EXPOSE 5060/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD asterisk -rx 'core show uptime' | grep -q 'System uptime' || exit 1
ENTRYPOINT ["/usr/local/bin/rasa-pbx"]
