[no-exit-message]
d:
	python3 dev.py
ln:
	python3 tools/socials.py --write
lnc:
	python3 tools/socials.py --check
c: lnc
	python3 -m py_compile dev.py tools/socials.py
cf:
	open "https://dash.cloudflare.com"
o:
	open "https://www.peerawatm.com"
clean:
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
	
