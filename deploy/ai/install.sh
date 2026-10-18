#!/usr/bin/env bash
# AI engine for «مصوبات مشابه» in the commission networks, on this server (no data leaves it):
# Ollama + the multilingual embedding model bge-m3 (~1.2 GB disk, ~1.5 GB RAM, CPU is enough).
#
#   bash deploy/ai/install.sh
#
# If this server cannot download the model (registry.ollama.ai blocked), download a bge-m3 GGUF file
# elsewhere, copy it to deploy/ai/models/bge-m3.gguf and run the script again.
set -euo pipefail
cd "$(dirname "$0")/../.."
MODEL="${AI_EMBEDDING_MODEL:-bge-m3}"

[ -f .env ] || { echo "No .env found: install the platform first (bash deploy/docker-install.sh)."; exit 1; }

set_env() { # set_env KEY VALUE — replace or append in .env
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}

echo "› Starting the AI engine container…"
docker compose --profile ai up -d ai
for i in $(seq 1 30); do
  docker compose --profile ai exec -T ai ollama list >/dev/null 2>&1 && break
  sleep 2
done

if docker compose --profile ai exec -T ai ollama list | awk '{print $1}' | grep -q "^${MODEL}\(:latest\)\?$"; then
  echo "› Model ${MODEL} is already installed."
elif [ -f "deploy/ai/models/${MODEL}.gguf" ]; then
  echo "› Importing deploy/ai/models/${MODEL}.gguf…"
  CID="$(docker compose --profile ai ps -q ai)"
  docker cp "deploy/ai/models/${MODEL}.gguf" "$CID:/tmp/${MODEL}.gguf"
  docker compose --profile ai exec -T ai sh -c "printf 'FROM /tmp/${MODEL}.gguf\n' > /tmp/Modelfile && ollama create ${MODEL} -f /tmp/Modelfile && rm /tmp/${MODEL}.gguf"
else
  echo "› Downloading the model ${MODEL} (about 1.2 GB)…"
  # A pull can time out in its last step («context deadline exceeded») after the download completed;
  # the downloaded parts are kept, so a retry finishes quickly.
  pulled=0
  for attempt in 1 2 3 4 5; do
    if docker compose --profile ai exec -T ai ollama pull "$MODEL"; then pulled=1; break; fi
    echo "  Retrying (${attempt}/5)…"
    sleep 5
  done
  if [ "$pulled" != 1 ]; then
    echo
    echo "The model could not be downloaded from this server."
    echo "Download a ${MODEL} GGUF file on another computer, copy it to deploy/ai/models/${MODEL}.gguf and run this script again."
    exit 1
  fi
fi

echo "› Testing the engine with a Persian sentence…"
DIM="$(docker compose exec -T api node -e "
    fetch('http://ai:11434/v1/embeddings', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: '${MODEL}', input: ['تمدید مهلت رفع تعهد ارزی صادرکنندگان'] }) })
      .then((r) => r.json()).then((j) => console.log(j.data[0].embedding.length)).catch((e) => { console.error(e.message); process.exit(1); });
  " 2>/dev/null || true)"
if [ -z "$DIM" ]; then
  echo "! The api container could not reach the engine yet; it is enabled anyway and will be retried."
else
  echo "  OK — vectors of ${DIM} dimensions."
fi

set_env COMPOSE_PROFILES ai
set_env AI_BASE_URL http://ai:11434/v1
set_env AI_EMBEDDING_MODEL "$MODEL"
echo "› Restarting the api with the AI engine enabled…"
docker compose up -d api
echo
echo "Done. «مصوبات مشابه» and «پیشنهاد هوشمند» now compare resolutions by meaning (${MODEL})."
echo "To turn it off: set AI_BASE_URL= in .env and run: docker compose up -d api"
