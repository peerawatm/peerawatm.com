set shell := ["bash", "-euo", "pipefail", "-c"]
wrangler := "npx --yes wrangler@4.151.1"
did := "did:plc:adrw3vdg5fk2i63lzsv5w6rl"

default:
	@just --list

[no-exit-message]
dev:
	python3 dev.py
socials-sync:
	python3 tools/socials.py --write
socials-check:
	python3 tools/socials.py --check
check: socials-check
	python3 -m py_compile dev.py tools/socials.py
	node --check src/index.js
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
clean:
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
