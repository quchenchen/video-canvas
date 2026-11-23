#!/usr/bin/env python3
"""在伪终端里跑一条命令，把输入喂进去，返回它的合并输出与退出码。

CLI 的节点级修改要求 stdin 是终端；Node 标准库造不出 pty，所以测试借这个脚本
包一层。找不到 python3 时测试会跳过，不影响其它用例。
"""

import os
import pty
import select
import subprocess
import sys

cmd = sys.argv[1:]
if not cmd:
    print("usage: pty_run.py <command> [args...]", file=sys.stderr)
    sys.exit(2)

master, slave = pty.openpty()
proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)

feed = os.environ.get("PTY_INPUT", "yes")
os.write(master, (feed + "\n").encode())

out = b""
while True:
    try:
        ready, _, _ = select.select([master], [], [], 60)
        if not ready:
            break
        chunk = os.read(master, 4096)
        if not chunk:
            break
        out += chunk
    except OSError:
        break

os.close(master)
code = proc.wait()
sys.stdout.buffer.write(out)
sys.exit(code)
