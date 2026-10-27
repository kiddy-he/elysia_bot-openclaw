#!/usr/bin/env python3
"""Own the shared Reach browser in a separate cgroup from request deadlines."""
import signal
import threading
from agent_reach.runtime import browser

stop = threading.Event()
for sig in (signal.SIGTERM, signal.SIGINT):
    signal.signal(sig, lambda *_: stop.set())
try:
    while not stop.is_set():
        try:
            browser.ensure_running()
            browser.touch()
        except Exception as error:
            # No upstream body, Cookie, source profile or environment in logs.
            print('reach_browser_state=' + str(getattr(error, 'code', 'unavailable')), flush=True)
        stop.wait(60)
finally:
    try:
        browser.stop()
    except Exception:
        pass
