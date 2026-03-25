#!/usr/bin/env bash
set -euo pipefail

echo "Fetching plugins.json..."
plugins_json=$(curl -sS https://arborium.bearcove.eu/plugins.json)

# Extract all cdn_wasm URLs
urls=$(echo "$plugins_json" | jq -r '.entries[] | .cdn_wasm')

total=$(echo "$urls" | wc -l | tr -d ' ')
current=0

echo "Warming jsDelivr cache for $total URLs..."
echo

for url in $urls; do
    current=$((current + 1))
    printf "[%3d/%d] %s " "$current" "$total" "$url"

    # HEAD request is enough to warm the cache
    status=$(curl -sS -o /dev/null -w "%{http_code}" --head "$url")

    if [ "$status" = "200" ]; then
        echo "OK"
    else
        echo "HTTP $status"
    fi
done

echo
echo "Done!"
