"""Run a command in a pseudo-terminal: our stdin goes to it, its screen output comes back on stdout.

usage: python3 -I ptyrun.py COLS ROWS -- command args...
Used by the end-to-end tests so vigent runs exactly as it does in a real terminal.
"""
import fcntl, os, pty, select, signal, struct, sys, termios

cols, rows = int(sys.argv[1]), int(sys.argv[2])
cmd = sys.argv[sys.argv.index("--") + 1 :]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
os.kill(pid, signal.SIGWINCH)
stdin = sys.stdin.fileno()
open_in = True
while True:
    fds = [fd] + ([stdin] if open_in else [])
    try:
        ready, _, _ = select.select(fds, [], [], 0.1)
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if open_in and stdin in ready:
        data = os.read(stdin, 65536)
        if not data:
            open_in = False
        else:
            os.write(fd, data)
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        # drain what's left
        try:
            while True:
                r, _, _ = select.select([fd], [], [], 0.05)
                if not r:
                    break
                data = os.read(fd, 65536)
                if not data:
                    break
                os.write(1, data)
        except OSError:
            pass
        sys.exit(os.waitstatus_to_exitcode(status))
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
