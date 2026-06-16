#!/usr/bin/env python3
"""
Pieces OS Babysitter
====================
- Launches Pieces OS if not running at boot
- Health checks every 10s to http://127.0.0.1:39301/.well-known/health
- Restarts if 3 consecutive health check failures
- Escalation per attempt: /os/restart -> SIGTERM+relaunch -> SIGKILL+relaunch
- Gives up after 5 restart attempts and sends macOS alert
- Resets restart counter after 10 min of clean uptime
- Kills all existing instances before launching to prevent duplicate menu bar icons
- Auth checks every 5 min via /user: detects logged-out state, sends notification,
  opens the Pieces Desktop App to prompt re-login
"""

import json, subprocess, time, signal, logging, os, sys
from datetime import datetime
from pathlib import Path
import urllib.request, urllib.error

# ── Config ────────────────────────────────────────────────────────────────────
APP_BINARY          = "/Applications/Pieces OS.app/Contents/MacOS/Pieces OS"
PIECES_APP          = "/Applications/Pieces OS.app"
# PiecesOS picks a dynamic port. We discover it via lsof each time we need it.
# These are the candidate ports in preference order.
CANDIDATE_PORTS     = [39300, 39301, 39302, 39303, 39304, 39305, 39306, 39307,
                       39308, 39309, 39310, 39311, 39312, 39313, 39314, 39315]
HEALTH_INTERVAL     = 10      # seconds between health checks
AUTH_CHECK_INTERVAL = 300     # seconds between auth checks (5 min)
HEALTH_FAIL_LIMIT   = 3       # consecutive failures before restart
RESTART_WAIT        = 30      # seconds to wait after /os/restart
MAX_RESTARTS        = 5       # give up threshold
CLEAN_UPTIME_RESET  = 600     # reset restart counter after 10 min clean
STARTUP_GRACE_SECS  = 90      # suppress health-check restarts during initial boot
# ──────────────────────────────────────────────────────────────────────────────

LOG_DIR  = Path.home() / "Library/Logs/PiecesOS"
LOG_FILE = LOG_DIR / "babysitter.log"
LOG_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(LOG_FILE), logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("babysitter")
# ──────────────────────────────────────────────────────────────────────────────

def http_get_raw(url: str, timeout: int = 8) -> tuple[int, str]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, str(e)
    except Exception as e:
        return -1, str(e)


_cached_port: int | None = None

def discover_port() -> int | None:
    """
    Find the port PiecesOS is currently listening on by probing candidates.
    Caches the last working port globally so we don't lsof on every call.
    """
    global _cached_port
    # Try cached port first (fast path)
    if _cached_port is not None:
        code, _ = http_get_raw(f"http://127.0.0.1:{_cached_port}/.well-known/health", timeout=2)
        if code == 200:
            return _cached_port
        _cached_port = None
    # Slow path: probe all candidates
    for port in CANDIDATE_PORTS:
        code, _ = http_get_raw(f"http://127.0.0.1:{port}/.well-known/health", timeout=2)
        if code == 200:
            log.info(f"PiecesOS found on port {port}")
            _cached_port = port
            return port
    # Last resort: parse lsof output for the Pieces process
    try:
        pid = get_pid()
        if pid:
            out = subprocess.check_output(
                ["lsof", "-p", str(pid), "-i", "-a"], text=True, timeout=5
            )
            import re
            m = re.search(r"localhost:(\d+) \(LISTEN\)", out)
            if m:
                port = int(m.group(1))
                log.info(f"PiecesOS found via lsof on port {port}")
                _cached_port = port
                return port
    except Exception:
        pass
    return None


def base_url() -> str | None:
    port = discover_port()
    return f"http://127.0.0.1:{port}" if port else None


def notify(title: str, message: str) -> None:
    script = f'display notification "{message}" with title "{title}" sound name "Basso"'
    try:
        subprocess.run(["osascript", "-e", script], check=False, timeout=5)
    except Exception as e:
        log.warning(f"Notification failed: {e}")


def open_pieces_app() -> None:
    """Open the Pieces Desktop App (triggers re-login UI if auth is expired)."""
    try:
        subprocess.run(["open", PIECES_APP], check=False, timeout=5)
    except Exception as e:
        log.warning(f"Could not open Pieces app: {e}")


def get_all_pids() -> list[int]:
    """Return all PIDs matching the Pieces OS binary."""
    try:
        out = subprocess.check_output(
            ["pgrep", "-f", "Pieces OS"], text=True, timeout=5
        ).strip()
        return [int(p) for p in out.splitlines() if p.strip().isdigit()]
    except subprocess.CalledProcessError:
        return []
    except Exception as e:
        log.warning(f"pgrep error: {e}")
        return []


def get_pid() -> int | None:
    pids = get_all_pids()
    return pids[0] if pids else None


def kill_all_instances(reason: str = "") -> None:
    """
    Kill every running Pieces OS process before launching a fresh one.
    Prevents duplicate menu bar icons from stale or slow-dying instances.
    Uses SIGTERM first, escalates to SIGKILL after 10s if needed.
    """
    pids = get_all_pids()
    if not pids:
        return
    log.info(f"Killing {len(pids)} existing Pieces OS instance(s) {pids}{' — ' + reason if reason else ''}")
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except Exception as e:
            log.warning(f"SIGTERM failed for PID {pid}: {e}")
    # Give them up to 10s to exit gracefully
    deadline = time.time() + 10
    while time.time() < deadline:
        if not get_all_pids():
            log.info("All instances exited cleanly.")
            return
        time.sleep(1)
    # Anything still alive gets SIGKILL
    stragglers = get_all_pids()
    if stragglers:
        log.warning(f"Force-killing {stragglers} with SIGKILL")
        for pid in stragglers:
            try:
                os.kill(pid, signal.SIGKILL)
            except Exception:
                pass
        time.sleep(2)


def http_get(path: str, timeout: int = 8) -> tuple[int, str]:
    """Make a GET to a PiecesOS path, auto-discovering the current port."""
    url_base = base_url()
    if url_base is None:
        return -1, "PiecesOS port not found"
    return http_get_raw(f"{url_base}{path}", timeout=timeout)


def check_auth() -> bool:
    """
    Return True if a user is logged in, False otherwise.

    PiecesOS exposes GET /user which returns a User object with an `id` field
    when authenticated, or a 401/empty response when not. We treat any response
    with a non-empty `id` as "logged in".
    """
    code, body = http_get("/user", timeout=6)
    if code != 200:
        log.warning(f"Auth check: /user returned HTTP {code}")
        return False
    try:
        data = json.loads(body)
        # The user object is nested: {"user": {"id": "...", "email": "..."}}
        # or flat {"id": "..."} depending on PiecesOS version
        user = data.get("user", data)
        logged_in = bool(user.get("id") or user.get("email"))
        if not logged_in:
            log.warning(f"Auth check: /user returned 200 but no user id/email. body={body[:200]}")
        return logged_in
    except Exception as e:
        log.warning(f"Auth check: could not parse /user response: {e}. body={body[:200]}")
        return False


def handle_auth_failure(was_logged_in: bool) -> None:
    """Fire a notification and open the app. Only fires once per logged-out episode."""
    if was_logged_in:
        log.warning("Auth lost — Pieces OS is logged out. LTM may not be collecting data.")
        notify(
            "Pieces OS — Auth Lost",
            "Pieces is logged out. LTM may have stopped collecting. Open the app to re-login.",
        )
        open_pieces_app()
    else:
        # Still logged out — log quietly, don't spam notifications
        log.info("Auth check: still logged out.")


def launch_process() -> None:
    existing = get_all_pids()
    if existing:
        log.warning(f"launch_process called but {len(existing)} instance(s) already running: {existing} — skipping")
        return
    log.info(f"Launching via: open -a '{PIECES_APP}'")
    subprocess.Popen(
        ["open", "-a", PIECES_APP],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    log.info("Launch requested via macOS Launch Services (LSMultipleInstancesProhibited enforced)")


def wait_for_startup(timeout: int = 60) -> bool:
    """Poll health endpoint until healthy or timeout expires."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        code, _ = http_get("/.well-known/health")
        if code == 200:
            return True
        time.sleep(2)
    return False


def try_api_restart() -> bool:
    log.info("Requesting API restart via /os/restart ...")
    http_get("/os/restart")
    time.sleep(RESTART_WAIT)
    code, _ = http_get("/.well-known/health")
    if code == 200:
        log.info("API restart succeeded — service healthy.")
        return True
    log.warning("API restart did not restore health.")
    return False


def kill_and_relaunch(pid: int | None, sig: int) -> bool:
    sig_name = {signal.SIGTERM: "SIGTERM", signal.SIGKILL: "SIGKILL"}.get(sig, str(sig))
    if pid:
        log.info(f"Sending {sig_name} to PID {pid}")
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            log.info("Process already gone before signal.")
    for _ in range(15):
        time.sleep(2)
        if get_pid() != pid:
            break
    # Ensure ALL instances are gone before spawning a fresh one
    kill_all_instances(reason=f"pre-relaunch cleanup after {sig_name}")
    launch_process()
    time.sleep(5)
    return wait_for_startup(timeout=60)


def escalated_restart(pid: int | None, attempt: int) -> bool:
    log.warning(f"=== Restart attempt {attempt}/{MAX_RESTARTS} ===")
    if try_api_restart():
        return True
    log.warning("Escalating to SIGTERM ...")
    if kill_and_relaunch(pid, signal.SIGTERM):
        log.info("SIGTERM + relaunch restored health.")
        return True
    log.warning("Escalating to SIGKILL ...")
    new_pid = get_pid()
    if kill_and_relaunch(new_pid, signal.SIGKILL):
        log.info("SIGKILL + relaunch restored health.")
        return True
    log.error("All escalation steps failed for this attempt.")
    return False


def main() -> None:
    log.info("Pieces OS Babysitter starting ...")

    # Kill any stale instances from a previous session before launching fresh
    kill_all_instances(reason="startup cleanup")

    launch_process()
    log.info(f"Waiting up to {STARTUP_GRACE_SECS}s for Pieces OS to become healthy ...")
    if not wait_for_startup(timeout=STARTUP_GRACE_SECS):
        log.error("Pieces OS failed to become healthy within startup grace period.")
    else:
        log.info("Pieces OS healthy at startup.")

    restart_count           = 0
    health_fail_streak      = 0
    last_clean_time         = datetime.now()
    last_health_check       = 0.0
    last_auth_check         = 0.0
    auth_logged_in          = True   # optimistic until first check
    startup_time            = time.time()

    while True:
        now = time.time()
        in_startup_grace = (now - startup_time) < STARTUP_GRACE_SECS

        # ── Health check ───────────────────────────────────────────────────────
        if now - last_health_check >= HEALTH_INTERVAL:
            last_health_check = now
            code, body = http_get("/.well-known/health")
            if code == 200:
                health_fail_streak = 0
                log.debug("Health OK")
            else:
                health_fail_streak += 1
                log.warning(
                    f"Health check failed ({health_fail_streak}/{HEALTH_FAIL_LIMIT}): "
                    f"HTTP {code} — {body[:120]}"
                )
                if health_fail_streak >= HEALTH_FAIL_LIMIT:
                    if in_startup_grace:
                        log.info(
                            f"Health failures during startup grace period "
                            f"({int(now - startup_time)}s / {STARTUP_GRACE_SECS}s) — holding off restart."
                        )
                        health_fail_streak = 0
                    else:
                        log.error("Health fail limit reached — initiating restart.")
                        health_fail_streak  = 0
                        pid = get_pid()
                        restart_count += 1
                        if restart_count > MAX_RESTARTS:
                            msg = f"Pieces OS unresponsive after {MAX_RESTARTS} restart attempts."
                            log.critical(msg)
                            notify("Pieces OS — CRITICAL", msg)
                            sys.exit(1)
                        if escalated_restart(pid, restart_count):
                            last_clean_time = datetime.now()

        # ── Auth check ────────────────────────────────────────────────────────
        if now - last_auth_check >= AUTH_CHECK_INTERVAL:
            last_auth_check = now
            currently_logged_in = check_auth()
            if not currently_logged_in:
                handle_auth_failure(was_logged_in=auth_logged_in)
            elif not auth_logged_in:
                log.info("Auth restored — Pieces OS is logged back in.")
                notify("Pieces OS — Auth Restored", "Pieces is logged back in. LTM is running.")
            auth_logged_in = currently_logged_in

        # ── Process alive check ────────────────────────────────────────────────
        all_pids = get_all_pids()
        if len(all_pids) > 1:
            log.error(f"Multiple Pieces OS instances detected: {all_pids} — killing all and relaunching one")
            kill_all_instances(reason="duplicate instance detected")
            launch_process()
            wait_for_startup(60)
        elif not all_pids and not in_startup_grace:
            log.warning("Pieces OS process not found — relaunching.")
            launch_process()
            wait_for_startup(60)

        # ── Reset restart counter after 10 min clean uptime ───────────────────
        if restart_count > 0:
            if (datetime.now() - last_clean_time).total_seconds() >= CLEAN_UPTIME_RESET:
                log.info("10 min clean uptime — resetting restart counter.")
                restart_count = 0

        time.sleep(HEALTH_INTERVAL)


if __name__ == "__main__":
    main()
