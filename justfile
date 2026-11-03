set shell := ["bash", "-euo", "pipefail", "-c"]
wrangler := "npx --yes wrangler@4.151.1"
did := "did:plc:adrw3vdg5fk2i63lzsv5w6rl"

default:
	@just --list

[no-exit-message]
dev:
	#!/usr/bin/env bash
	set -euo pipefail
	(
		for _ in {1..40}; do
			curl -sf -o /dev/null http://localhost:8787/ && break
			sleep 0.25
		done
		open http://localhost:8787
	) &
	{{wrangler}} dev --port 8787 --test-scheduled --live-reload
check:
	node --check src/index.js
	node --check public/theme.js
	node --test src/
	sqlite3 :memory: < migrations/0001_hits.sql
db-migrate:
	{{wrangler}} d1 migrations apply peerawatm-hits --remote
deploy: check
	{{wrangler}} deploy
deploy-dry: check
	{{wrangler}} deploy --dry-run
dns:
	#!/usr/bin/env bash
	set -euo pipefail
	record='did={{did}}'
	body="{\"type\":\"TXT\",\"name\":\"_atproto\",\"content\":\"$record\",\"ttl\":1}"
	if cf dns records list -z peerawatm.com | grep -q '"_atproto.peerawatm.com"'; then
		echo "TXT _atproto already present"
	else
		cf dns records create -z peerawatm.com --body "$body"
	fi
rate-limit:
	#!/usr/bin/env bash
	set -euo pipefail
	zone='peerawatm.com'
	desc='Cap /hit beacons per IP'
	body='{"action":"block","description":"'"$desc"'","enabled":true,"expression":"(http.request.uri.path eq \"/hit\")","ratelimit":{"characteristics":["ip.src","cf.colo.id"],"mitigation_timeout":10,"period":10,"requests_per_period":5}}'
	current=$(cf rulesets entrypoint get http_ratelimit -z "$zone" 2>/dev/null || true)
	if [ -n "$current" ] && jq -e --arg d "$desc" 'any(.rules[]?; .description == $d)' <<<"$current" >/dev/null; then
		echo "rate limit already present"
		exit 0
	fi
	if [ -n "$current" ]; then
		cf rulesets rules create "$(jq -r '.id' <<<"$current")" -z "$zone" --body "$body"
	else
		cf rulesets create -z "$zone" --kind zone --phase http_ratelimit --name 'peerawatm rate limits' --rules "[$body]"
	fi
doctor:
	#!/usr/bin/env bash
	set -euo pipefail
	txt=$(dig +short TXT _atproto.peerawatm.com)
	code=$(curl -sSL -o /dev/null -w '%{http_code}' https://peerawatm.com)
	bsky=$(curl -fsS 'https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=peerawatm.com')
	printf 'TXT   %s\nsite  %s\nbsky  %s\n' "$txt" "$code" "$bsky"
	grep -q 'did={{did}}' <<<"$txt"
	test "$code" = 200
	grep -q '"did":"{{did}}"' <<<"$bsky"
dash:
	open "https://dash.cloudflare.com"
open:
	open "https://www.peerawatm.com"
gh:
	open "https://github.com/peerawatm/peerawatm.com"
