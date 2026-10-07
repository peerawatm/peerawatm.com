# Serve ./public locally with live reload.
[no-exit-message]
dev:
    python3 dev.py

links:
    python3 tools/socials.py --write

[no-exit-message]
links-check:
    python3 tools/socials.py --check

check: links-check
    python3 -m py_compile dev.py tools/socials.py
