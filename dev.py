#!/usr/bin/env python3
"""Dependency-free live-reload preview server for ./public.

Hardened so no file change, malformed asset, mid-write read, dropped
connection, or injected template error can take the process down.
"""
import hashlib, os, signal, threading, time, urllib.parse
import http.server, socketserver, webbrowser

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
PORT = int(os.environ.get("PORT", "8787"))
IGNORED_SUFFIX = ("~", ".swp", ".swo", ".tmp")
RETRYABLE = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError)
state = {"version": 0}
_stop = threading.Event()


def ignored(name):
    return name.startswith(".") or name.endswith(IGNORED_SUFFIX)


def snapshot():
    """Hash path+mtime+size of every tracked file. Never raises."""
    h = hashlib.sha1()
    try:
        for dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = [d for d in dirnames if not ignored(d)]
            for f in sorted(filenames):
                if ignored(f):
                    continue
                p = os.path.join(dirpath, f)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                h.update(p.encode())
                h.update(str(st.st_mtime_ns).encode())
                h.update(str(st.st_size).encode())
    except Exception:
        pass
    return h.hexdigest()


def watcher():
    last = snapshot()
    while not _stop.is_set():
        try:
            time.sleep(0.3)
            cur = snapshot()
            if cur != last:
                last = cur
                state["version"] += 1
        except Exception:
            time.sleep(0.5)  # never let a transient FS error kill the thread


RELOAD = (
    b"<script>(function(){var v=null;setInterval(function(){"
    b'fetch("/__dev/version",{cache:"no-store"}).then(function(r){return r.text();})'
    b".then(function(x){if(v===null){v=x;}else if(x!==v){location.reload();}})"
    b".catch(function(){});},400);})();</script>"
)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass

    def log_error(self, *a):
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

    def _fail(self):
        try:
            self.send_error(500, "server error")
        except Exception:
            pass

    def _read(self, fpath):
        """Read a file that may be mid-write. Never raises."""
        for _ in range(4):
            try:
                with open(fpath, "rb") as f:
                    return f.read()
            except OSError:
                time.sleep(0.05)
        return None

    def _send(self, code, ctype, body):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/__dev/version":
            self._send(200, "text/plain", str(state["version"]).encode())
            return

        fpath = self.translate_path(path)
        try:
            isdir = os.path.isdir(fpath)
        except OSError:
            isdir = False
        if isdir:
            fpath = os.path.join(fpath, "index.html")

        if fpath.endswith(".html") and os.path.isfile(fpath):
            data = self._read(fpath)
            if data is None:
                self.send_error(404, "not found")
                return
            try:
                data = (
                    data.replace(b"</body>", RELOAD + b"</body>", 1)
                    if b"</body>" in data
                    else data + RELOAD
                )
            except Exception:
                pass
            self._send(200, "text/html; charset=utf-8", data)
            return

        super().do_GET()


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True
    block_on_close = False
    request_queue_size = 64


def bind(preferred, span=20):
    explicit = os.environ.get("PORT") is not None
    candidates = [preferred] if explicit else range(preferred, preferred + span)
    for p in candidates:
        try:
            return Server(("", p), Handler), p
        except OSError:
            continue
    raise SystemExit(f"no free port in {preferred}..{preferred + span - 1}")


def _on_signal(signum, frame):
    # Graceful exit on Ctrl-C / kill / terminal hangup instead of a hard kill.
    _stop.set()
    raise KeyboardInterrupt


def main():
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        try:
            signal.signal(sig, _on_signal)
        except (ValueError, OSError):
            pass

    threading.Thread(target=watcher, daemon=True).start()
    httpd, port = bind(PORT)
    url = f"http://localhost:{port}/"
    print(f"Serving {ROOT}\n  {url}  (live reload, Ctrl-C to stop)", flush=True)
    if not os.environ.get("NO_OPEN"):
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    except Exception:
        pass
    finally:
        _stop.set()
        try:
            httpd.server_close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
