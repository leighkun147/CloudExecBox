"""
Run (single-file check as UID 65534:65534 under hardened container flags):
  docker run --rm --cpus="0.5" --network none --pids-limit 32 --memory="128m" --memory-swap="128m" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m -v "$(pwd)/test codes:/work:ro" runner-python:latest python3 /work/test_07_python_probe.py basic
"""
import os
import socket
import sys

mode = sys.argv[1] if len(sys.argv) > 1 else "basic"

if mode == "basic":
    print("PYTHON_OK uid=", os.getuid(), flush=True)
elif mode == "tmpfs":
    try:
        with open("/tmp/py_probe.txt", "w") as f:
            f.write("ok\n")
        print("TMPFS_WRITE_OK", flush=True)
    except OSError as e:
        print("TMPFS_BLOCKED:", e, flush=True)
elif mode == "net":
    try:
        s = socket.create_connection(("1.1.1.1", 80), timeout=2)
        s.close()
        print("NET_OPEN_OK", flush=True)
    except OSError as e:
        print("NET_BLOCKED:", e.errno, e.strerror, flush=True)
else:
    print("UNKNOWN_MODE:", mode, flush=True)
