#!/usr/bin/env python3
"""Dependency-free live-reload preview server for ./public.

Priorities, in order:

* Never break midway - retry mid-write reads, swallow dropped connections and
  transient filesystem errors, and stop cleanly on Ctrl-C / TERM / HUP.
* Fast opening - listen and open the browser immediately, and keep HTTP/1.1
  connections alive so assets share a warm socket.
* Least resources - fingerprint changes with a cheap ``os.scandir`` pass (no
  hashing) and reload the browser with a long-poll instead of fixed-interval
  polling, so an idle preview costs almost nothing.

Stdlib only. Configure with ``HOST``, ``PORT``, ``NO_OPEN``.
"""
from __future__ import annotations

import os
import signal
import threading
import urllib.parse
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "public"
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8787"))
NO_OPEN = os.environ.get("NO_OPEN", "") != ""
IGNORED_SUFFIX = ("~", ".swp", ".swo", ".tmp")
RETRYABLE = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError)
POLL = 0.4        # seconds between cheap change-detection scans
LONGPOLL = 25.0   # seconds a reload request waits before replying "unchanged"

_stop = threading.Event()
_cond = threading.Condition()
_version = 0

RELOAD = (
    b'<script>(function(){var v=null;function tick(){var q=v===null?"":"?since="+v;'
    b'var ctl=new AbortController();var to=setTimeout(function(){ctl.abort();},30000);'
    b'fetch("/__dev/version"+q,{cache:"no-store",signal:ctl.signal})'
    b'.then(function(r){return r.text();})'
    b'.then(function(x){clearTimeout(to);if(v!==null&&x!==v){location.reload();return;}v=x;tick();})'
    b'.catch(function(){clearTimeout(to);setTimeout(tick,1000);});}tick();})();</script>'
)


def fingerprint() -> tuple[tuple[str, int, int], ...]:
    """Cheap, allocation-light signature of every tracked file. Never raises."""
    out: list[tuple[str, int, int]] = []
    stack = [ROOT]
    while stack:
        try:
            entries = os.scandir(stack.pop())
        except OSError:
            continue
        with entries:
            for entry in entries:
                name = entry.name
                if name.startswith(".") or name.endswith(IGNORED_SUFFIX):
                    continue
                try:
                    if entry.is_dir(follow_symlinks=False):
                        stack.append(Path(entry.path))
                    elif entry.is_file(follow_symlinks=False):
                        st = entry.stat(follow_symlinks=False)
                        out.append((entry.path, st.st_mtime_ns, st.st_size))
                except OSError:
                    continue
    return tuple(out)


def watcher() -> None:
    global _version
    last = fingerprint()
    while not _stop.wait(POLL):
        try:
            current = fingerprint()
        except Exception:
            continue  # never let a transient FS error kill the watcher
        if current != last:
            last = current
            with _cond:
                _version += 1
                _cond.notify_all()


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep-alive: warm sockets for assets + long-poll
    timeout = 65                   # reap idle kept-alive connections

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *args):  # keep the preview quiet
        pass

    def log_error(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def do_GET(self):
        try:
            self._serve()
        except RETRYABLE:
            pass
        except Exception:
            self._fail()

    def do_HEAD(self):
        try:
            super().do_HEAD()
        except RETRYABLE:
            pass
        except Exception:
            self._fail()

    def _fail(self):
        try:
            self.send_error(500, "server error")
        except Exception:
            pass

    def _read(self, path: Path) -> bytes | None:
        """Read a file that may be mid-write. Never raises."""
        for _ in range(4):
            try:
                return path.read_bytes()
            except OSError:
                _stop.wait(0.05)
        return None

    def _send(self, code: int, ctype: str, body: bytes) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve(self) -> None:
        path = urllib.parse.urlparse(self.path).path
        if path == "/__dev/version":
            self._serve_version(self._parse_since())
            return

        fpath = self.translate_path(path)
        try:
            is_dir = os.path.isdir(fpath)
        except OSError:
            is_dir = False
        if is_dir:
            fpath = os.path.join(fpath, "index.html")

        if fpath.endswith(".html") and os.path.isfile(fpath):
            data = self._read(Path(fpath))
            if data is None:
                self.send_error(404, "not found")
                return
            try:
                if b"</body>" in data:
                    data = data.replace(b"</body>", RELOAD + b"</body>", 1)
                else:
                    data += RELOAD
            except Exception:
                pass
            self._send(200, "text/html; charset=utf-8", data)
            return

        super().do_GET()

    def _parse_since(self) -> int | None:
        raw = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("since", [None])[0]
        try:
            return int(raw) if raw is not None else None
        except (TypeError, ValueError):
            return None

    def _serve_version(self, since: int | None) -> None:
        if since is None:
            current = _version
        else:
            with _cond:
                if _version == since:
                    _cond.wait(LONGPOLL)
                current = _version
        self._send(200, "text/plain; charset=utf-8", str(current).encode())


class Server(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    allow_reuse_address = True
    request_queue_size = 64


def bind(preferred: int) -> tuple[Server, int]:
    explicit = os.environ.get("PORT") is not None
    candidates = [preferred] if explicit else range(preferred, preferred + 20)
    for port in candidates:
        try:
            return Server((HOST, port), Handler), port
        except OSError:
            continue
    raise SystemExit(f"no free port in {preferred}..{preferred + 19}")


def _on_signal(signum, frame):
    _stop.set()
    raise KeyboardInterrupt


def main() -> None:
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        try:
            signal.signal(sig, _on_signal)
        except (ValueError, OSError):
            pass

    if not ROOT.is_dir():
        print(f"warning: {ROOT} does not exist; serving 404s until it does", flush=True)

    threading.Thread(target=watcher, daemon=True).start()
    httpd, port = bind(PORT)
    url = f"http://{HOST}:{port}/"
    print(f"Serving {ROOT}\n  {url}  (live reload, Ctrl-C to stop)", flush=True)
    if not NO_OPEN:
        threading.Timer(0.2, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    except Exception:
        pass
    finally:
        _stop.set()
        with _cond:
            _cond.notify_all()  # release any parked long-poll handlers
        try:
            httpd.server_close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
