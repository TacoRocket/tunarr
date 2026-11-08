"""Run a synchronous QuickJS action in a fresh process with one mediated read capability."""

import ctypes
import errno
import json
from pathlib import Path
import resource
import signal
import subprocess
import sys
from threading import Timer
import time


ACTION_SECONDS = 30
MAX_READS = 50
MAX_RESULT = 64 * 1024
MAX_QUERY = 4096
MAX_READ_REPLY = 8 * 1024 * 1024


class GuestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def send(stream, value):
    message = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
    stream.write(message + b"\n")
    stream.flush()


def receive(stream, limit):
    line = stream.readline(limit + 1)
    if not line or len(line) > limit or not line.endswith(b"\n"):
        raise GuestError(502, "Extension stopped or exceeded its execution limits.")
    try:
        return json.loads(line)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise GuestError(502, "Invalid response from the extension runner.") from exc


def run_guest(code, inputs, read):
    deadline = time.monotonic() + ACTION_SECONDS
    with subprocess.Popen(
        [sys.executable, "-I", str(Path(__file__).resolve())], cwd="/", env={}, close_fds=True,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    ) as worker:
        timeout = Timer(ACTION_SECONDS, worker.kill)
        timeout.daemon = True
        timeout.start()
        try:
            send(worker.stdin, {"code": code, "input": inputs})
            read_count = 0
            while True:
                message = receive(worker.stdout, MAX_RESULT + MAX_QUERY)
                if not isinstance(message, dict):
                    raise GuestError(502, "Invalid response from the extension runner.")
                if message.get("type") == "result" and isinstance(message.get("value"), dict):
                    return message["value"]
                if (message.get("type") != "read" or not isinstance(message.get("id"), str)
                    or not isinstance(message.get("params"), dict)):
                    raise GuestError(502, "Extension failed to return a JSON object.")
                read_count += 1
                if read_count > MAX_READS:
                    raise GuestError(422, "Extension exceeded its service read limit.")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise GuestError(504, "Extension request timed out.")
                reply = read(message["id"], message["params"], remaining)
                send(worker.stdin, reply)
        except (BrokenPipeError, OSError) as exc:
            raise GuestError(502, "Extension runner exited before completing the action.") from exc
        finally:
            timeout.cancel()
            worker.kill()


def confine_process():
    """Allow memory management, clocks, termination and the two protocol pipes."""
    lib = ctypes.CDLL("libseccomp.so.2")
    pointer, integer, unsigned = ctypes.c_void_p, ctypes.c_int, ctypes.c_uint

    class Comparison(ctypes.Structure):
        _fields_ = [("arg", unsigned), ("op", integer), ("a", ctypes.c_uint64), ("b", ctypes.c_uint64)]

    lib.seccomp_init.argtypes = [unsigned]
    lib.seccomp_init.restype = pointer
    lib.seccomp_release.argtypes = [pointer]
    lib.seccomp_release.restype = None
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_rule_add_array.argtypes = [pointer, unsigned, integer, unsigned, ctypes.POINTER(Comparison)]
    lib.seccomp_load.argtypes = [pointer]

    allow, deny, equal = 0x7fff0000, 0x00050000 | errno.EPERM, 4  # libseccomp's public ABI
    context = lib.seccomp_init(deny)
    if not context:
        raise RuntimeError("Could not create the worker syscall filter.")
    try:
        def permit(name, descriptor=None):
            call = lib.seccomp_syscall_resolve_name(name.encode())
            condition = None if descriptor is None else Comparison(0, equal, descriptor, 0)
            if call < 0 or lib.seccomp_rule_add_array(
                context, allow, call, int(condition is not None),
                ctypes.byref(condition) if condition is not None else None,
            ) != 0:
                raise RuntimeError("Could not create the worker syscall rule.")

        permit("read", 0)
        permit("write", 1)
        for name in ("brk", "mmap", "mremap", "munmap", "mprotect", "madvise", "futex",
                     "clock_gettime", "gettimeofday", "rt_sigreturn", "exit", "exit_group"):
            permit(name)
        if lib.seccomp_load(context) != 0:
            raise RuntimeError("Could not install the worker syscall filter.")
    finally:
        lib.seccomp_release(context)


def execute():
    import quickjs

    context = quickjs.Context()
    context.set_memory_limit(16 * 1024 * 1024)
    context.set_max_stack_size(256 * 1024)
    request = receive(sys.stdin.buffer, 2 * 1024 * 1024)
    confine_process()

    def service_read(operation, query):
        if (not isinstance(operation, str) or len(operation) > 64
            or not isinstance(query, str) or len(query.encode()) > MAX_QUERY):
            raise ValueError("Invalid read arguments.")
        params = json.loads(query)
        if not isinstance(params, dict):
            raise ValueError("Read parameters must be an object.")
        send(sys.stdout.buffer, {"type": "read", "id": operation, "params": params})
        return json.dumps(receive(sys.stdin.buffer, MAX_READ_REPLY), ensure_ascii=False,
                          allow_nan=False, separators=(",", ":"))

    context.add_callable("_read", service_read)
    context.eval("""
        ((bridge, stringify, parse) => {
            delete globalThis._read;
            Object.defineProperty(globalThis, "readJson", {
                value: (id, params = {}) => parse(bridge(id, stringify(params)))
            });
        })(_read, JSON.stringify, JSON.parse)
    """)
    context.set("_input", context.parse_json(json.dumps(request["input"])))
    context.eval('"use strict";\n' + request["code"])
    result = context.eval("run(_input)")
    if not isinstance(result, quickjs.Object):
        raise ValueError("Expected a JSON object.")
    serialized = result.json()
    if not isinstance(serialized, str) or len(serialized.encode()) > MAX_RESULT:
        raise ValueError("Extension result exceeded limit.")
    value = json.loads(serialized)
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object.")
    send(sys.stdout.buffer, {"type": "result", "value": value})


if __name__ == "__main__":
    signal.alarm(ACTION_SECONDS)
    resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
    if sys.platform == "linux":
        resource.setrlimit(resource.RLIMIT_AS, (192 << 20, 192 << 20))
    try:
        execute()
    except Exception:
        # The guest chooses exception messages. Keep them out of host logs and UI responses.
        send(sys.stdout.buffer, {"type": "error"})
