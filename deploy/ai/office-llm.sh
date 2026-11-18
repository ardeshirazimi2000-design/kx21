#!/usr/bin/env bash
# Local AI for the office automation (رسا): letter summaries («شرح نامه» of incoming letters) and smart search,
# answered by a model on this server through Ollama, so no letter text leaves it (docs/office/09-local-ai.md).
#
#   bash deploy/ai/office-llm.sh                      # qwen2.5:7b (~4.7 GB disk, ~6 GB free RAM) + bge-m3
#   CHAT_MODEL=qwen2.5:3b bash deploy/ai/office-llm.sh   # smaller server (~2.5 GB RAM), weaker Persian
#   EMBED_MODEL= bash deploy/ai/office-llm.sh            # chat model only, no meaning-based re-ranking
#
# The engine is the "ai" service of docker-compose.yml (the same one the meetings system uses). It has no host port:
# only the containers of this stack reach it, at http://ai:11434/v1.
#
# If this server cannot download models (registry.ollama.ai blocked), download the GGUF file on another computer and
# copy it to deploy/ai/models/<model name with ":" replaced by "-">.gguf (e.g. qwen2.5-7b.gguf), then run this again.
set -euo pipefail
cd "$(dirname "$0")/../.."
CHAT_MODEL="${CHAT_MODEL:-qwen2.5:7b}"
EMBED_MODEL="${EMBED_MODEL-bge-m3}"
NEED_MB="${NEED_MB:-6000}" # free memory the chat model needs (weights + an 8K context)

[ -f .env ] || { echo "No .env found: install the platform first (bash deploy/docker-install.sh)."; exit 1; }

set_env() { # set_env KEY VALUE — replace or append in .env
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}

echo "› Checking this server…"
AVAIL_MB=$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo)
TOTAL_MB=$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)
echo "  Memory: ${AVAIL_MB} MB free of ${TOTAL_MB} MB; CPU cores: $(nproc)"
grep -qw avx2 /proc/cpuinfo || echo "  ! This CPU (or VM) does not report AVX2: the model will run, but much slower. In Hyper-V, set the VM's processor compatibility mode off."
if [ "$AVAIL_MB" -lt "$NEED_MB" ] && [ "${FORCE:-0}" != 1 ]; then
  echo
  echo "Not enough free memory for ${CHAT_MODEL}: about ${NEED_MB} MB is needed, ${AVAIL_MB} MB is free."
  echo "The other systems on this server could run out of memory. Options:"
  echo "  • a smaller model:            CHAT_MODEL=qwen2.5:3b NEED_MB=3000 bash deploy/ai/office-llm.sh"
  echo "  • Ollama on another server:   see docs/office/09-local-ai.md"
  echo "  • run anyway (not advised):   FORCE=1 bash deploy/ai/office-llm.sh"
  exit 1
fi

echo "› Starting the AI engine container…"
docker compose --profile ai up -d ai
for i in $(seq 1 30); do
  docker compose --profile ai exec -T ai ollama list >/dev/null 2>&1 && break
  sleep 2
done

install_model() { # install_model NAME
  local m="$1" gguf="deploy/ai/models/${1//:/-}.gguf"
  if docker compose --profile ai exec -T ai ollama list | awk 'NR>1 {print $1}' | grep -qx -e "$m" -e "$m:latest"; then
    echo "› Model ${m} is already installed."
  elif [ -f "$gguf" ]; then
    echo "› Importing ${gguf}…"
    local cid
    cid="$(docker compose --profile ai ps -q ai)"
    docker cp "$gguf" "$cid:/tmp/model.gguf"
    docker compose --profile ai exec -T ai sh -c "printf 'FROM /tmp/model.gguf\n' > /tmp/Modelfile && ollama create '$m' -f /tmp/Modelfile && rm /tmp/model.gguf /tmp/Modelfile"
  else
    echo "› Downloading the model ${m} (this can take a while)…"
    # A pull can time out in its last step («context deadline exceeded») after the download completed; the downloaded
    # parts are kept, so a retry finishes quickly.
    local attempt
    for attempt in 1 2 3 4 5; do
      docker compose --profile ai exec -T ai ollama pull "$m" && return 0
      echo "  Retrying (${attempt}/5)…"
      sleep 5
    done
    echo
    echo "The model ${m} could not be downloaded from this server."
    echo "Download its GGUF file on another computer, copy it to ${gguf} and run this script again."
    exit 1
  fi
}

install_model "$CHAT_MODEL"
[ -n "$EMBED_MODEL" ] && install_model "$EMBED_MODEL"

# Keep the engine running across «docker compose up -d» and reboots.
PROFILES="$(grep -E '^COMPOSE_PROFILES=' .env | tail -1 | cut -d= -f2- || true)"
case ",${PROFILES}," in
  *,ai,*) ;;
  ,,) set_env COMPOSE_PROFILES ai ;;
  *) set_env COMPOSE_PROFILES "${PROFILES},ai" ;;
esac
grep -q '^OFFICE_AI_CHAT_TIMEOUT_SECONDS=' .env || set_env OFFICE_AI_CHAT_TIMEOUT_SECONDS 300
docker compose up -d office-api >/dev/null

echo "› Testing from the office-api container with a Persian request (the first answer is slow: the model loads)…"
START=$(date +%s)
REPLY="$(docker compose exec -T office-api node -e "
  fetch('http://ai:11434/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(600000),
    body: JSON.stringify({ model: '${CHAT_MODEL}', temperature: 0.2, max_tokens: 80, messages: [
      { role: 'system', content: 'تو دستیار دبیرخانه یک سازمان هستی. در یک جمله و به فارسی رسمی پاسخ بده.' },
      { role: 'user', content: 'خلاصه کن: اداره کل امور مالیاتی استان درخواست کرده است فهرست قراردادهای سال ۱۴۰۴ تا پایان آذرماه ارسال شود.' } ] }) })
    .then((r) => r.json()).then((j) => console.log(j.choices[0].message.content.trim())).catch((e) => { console.error(e.message); process.exit(1); });
" 2>&1)" || REPLY=""
if [ -z "$REPLY" ]; then
  echo "! office-api could not get an answer yet. Check: docker compose logs --tail 50 ai"
else
  echo "  OK in $(( $(date +%s) - START )) s: ${REPLY}"
fi

echo
echo "Done. In Rasa open «یکپارچه‌سازی» → «هوش مصنوعی» and enter:"
echo "  Address (Base URL):   http://ai:11434/v1"
echo "  API key:              (leave empty)"
echo "  Chat model:           ${CHAT_MODEL}"
[ -n "$EMBED_MODEL" ] && echo "  Embedding model:      ${EMBED_MODEL}"
echo "press «ذخیره» (or first «Ollama همین سرور» to fill these), then «آزمایش اتصال». Classified letters are still never sent to the model."
