"""Opt-in real Pi terminal smoke test; no prompts/model calls, no credential output.
Runs only this extension. Queries live usage when /usage opens.
"""
import fcntl
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")

def smoke(mode):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 48, 100, 0, 0))
    env = dict(os.environ, TERM="xterm-256color")
    process = subprocess.Popen([
        "pi", "--no-extensions", "--extension", str(ROOT / "src/index.ts"),
        "--no-skills", "--no-prompt-templates", "--no-themes", "--use-theme", "dark",
        "--no-context-files", "--no-session", "--no-approve", "--offline", "--tui-mode", mode,
    ], cwd=ROOT, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
    os.close(slave)
    output = bytearray()
    def receive(seconds):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            readable, _, _ = select.select([master], [], [], min(0.1, max(0, until - time.monotonic())))
            if readable:
                try:
                    chunk = os.read(master, 65536)
                    if not chunk:
                        break
                    output.extend(chunk)
                    # Answer Pi's cursor-position probe so startup doesn't wait on a real emulator.
                    if b"\x1b[6n" in chunk:
                        os.write(master, b"\x1b[1;1R")
                except OSError:
                    break
    def text():
        return ANSI.sub("", output.decode("utf-8", "replace"))
    try:
        receive(4)
        assert process.poll() is None, "Pi exited during startup"
        os.write(master, b"/usage\r")
        receive(15)
        screen = text()
        assert "PLAN USAGE" in screen, "Dashboard did not open"
        assert "Claude" not in screen, "Removed provider still appears"
        for label in ["GLM", "Grok", "Codex"]:
            assert label in screen, f"Provider missing: {label}"
        assert "% used" in screen, "No live usage bars rendered"
        # Narrow resize, keyboard navigation and dismissal must not crash Pi.
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 20, 44, 0, 0))
        os.kill(process.pid, signal.SIGWINCH)
        receive(0.3)
        os.write(master, b"jjjkk")
        receive(0.2)
        os.write(master, b"\x1b")
        receive(0.5)
        assert process.poll() is None, "Pi crashed during resize or dismissal"
        assert "Failed to load extension" not in text(), "Extension load error"
        print(f"PASS {mode}: live modal/bars, three providers, no removed-provider controls, resize, scroll, Escape")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        os.close(master)

for mode in ["regular", "fullscreen"]:
    smoke(mode)
