#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================
  增强版一键部署脚本 - dalaowang233.top
  服务器: 8.156.91.188
  部署目录: /var/www/dalaowang233.top
  域名: dalaowang233.top
  特性:
    - 完整的错误处理和日志记录
    - 部署前检查和部署后验证
    - 详细的诊断功能
    - 日志查看和分析工具
    - 自动故障恢复
    - 回滚机制
============================================================

双击运行 → 交互菜单
命令行模式:
  完整部署:           python deploy.py
  仅上传文件:         python deploy.py --upload-only
  仅上传变更文件:     python deploy.py --upload-changed
  仅SSL配置:          python deploy.py --ssl-only
  仅修复:             python deploy.py --fix-only
  仅修复Nginx:        python deploy.py --fix-nginx
  健康检查:           python deploy.py --check
  查看日志:           python deploy.py --logs
  诊断模式:           python deploy.py --diagnose
  回滚:               python deploy.py --rollback
  交互模式:           python deploy.py --interactive

依赖:
  pip install paramiko
"""

import os
import sys
import time
import json
import base64
import getpass
import argparse
import subprocess
import traceback
from datetime import datetime
from pathlib import Path

# 修复 Windows GBK 终端下的 Unicode 编码问题
if sys.stdout.encoding and sys.stdout.encoding.upper() in ('GBK', 'GB2312', 'GB18030'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# ============ 配置（支持环境变量覆盖） ============
CONFIG = {
    "host": os.environ.get("DEPLOY_HOST", "8.156.91.188"),
    "port": int(os.environ.get("DEPLOY_PORT", "22")),
    "user": os.environ.get("DEPLOY_USER", "root"),
    "password": os.environ.get("DEPLOY_PASS", ""),
    "key_file": os.environ.get("DEPLOY_KEY_FILE", ""),
    "remote_dir": os.environ.get("DEPLOY_DIR", "/var/www/dalaowang233.top"),
    "domain": os.environ.get("DEPLOY_DOMAIN", "dalaowang233.top"),
    "app_port": int(os.environ.get("DEPLOY_APP_PORT", "3000")),
    "node_version": os.environ.get("DEPLOY_NODE_VERSION", "20"),
}

# 额外排除模式（不上传的文件/目录）
EXTRA_EXCLUDE_PATTERNS = [
    '.vscode',
    '.writerHelper',
    'RP-Hub',
    'node_modules',
    '.git',
    '__pycache__',
    '*.pyc',
    '.DS_Store',
    'Thumbs.db',
    'database.sqlite',
    'database.sqlite.*',
    'logs',
    'backups',
    'public/uploads',
    '.env',
    '.env.*',
    'test_*.html',
    '*.tgz',
    '*.zip',
    'cookies.txt',
    'login_result.html',
    '.setup_completed',
    'npm-debug.log*',
    'scripts/.file_checksums.json',
    'public/vendor/**/*.map',
    '*.key',
    '*.pem',
    'config.json',
    'deploy.py',
    'diagnose.py',
    'view-logs.py',
]

# ============ 颜色输出 ============
class Colors:
    GREEN = '\033[0;32m'
    YELLOW = '\033[1;33m'
    RED = '\033[0;31m'
    BLUE = '\033[0;34m'
    CYAN = '\033[0;36m'
    MAGENTA = '\033[0;35m'
    NC = '\033[0m'

def info(msg):   print(f"{Colors.GREEN}[INFO]{Colors.NC} {msg}")
def warn(msg):   print(f"{Colors.YELLOW}[WARN]{Colors.NC} {msg}")
def error(msg):  print(f"{Colors.RED}[ERROR]{Colors.NC} {msg}")
def debug(msg):  print(f"{Colors.CYAN}[DEBUG]{Colors.NC} {msg}")
def success(msg):print(f"{Colors.GREEN}[SUCCESS]{Colors.NC} {msg}")
def step(num, total, msg):
    print(f"\n{Colors.BLUE}={'>'*58}{Colors.NC}")
    print(f"{Colors.BLUE}[{num}/{total}]{Colors.NC} {msg}")
    print(f"{Colors.BLUE}={'>'*58}{Colors.NC}")

# ============ 日志记录系统 ============
class DeployLogger:
    def __init__(self, log_dir='deploy_logs'):
        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(exist_ok=True)
        self.timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        self.log_file = self.log_dir / f'deploy_{self.timestamp}.log'
        self.fd = open(self.log_file, 'w', encoding='utf-8')
    
    def log(self, level, message):
        ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        line = f"[{ts}] [{level}] {message}\n"
        self.fd.write(line)
        self.fd.flush()
    
    def info(self, msg): self.log('INFO', msg)
    def warn(self, msg): self.log('WARN', msg)
    def error(self, msg): self.log('ERROR', msg)
    def debug(self, msg): self.log('DEBUG', msg)
    
    def close(self):
        if self.fd:
            self.fd.close()
    
    def __enter__(self):
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

logger = None

def init_logger():
    global logger
    logger = DeployLogger()
    logger.info("部署脚本启动")

# ============ 交互输入密码 ============
def ensure_password():
    """如果未设置环境变量密码，交互式输入"""
    if CONFIG.get("key_file") and os.path.exists(CONFIG["key_file"]):
        info(f"使用 SSH 密钥认证: {CONFIG['key_file']}")
        return
    
    if not CONFIG["password"]:
        print(f"\n{'=' * 50}")
        print(f"  请输入服务器密码")
        print(f"  提示: 也可先设置环境变量 DEPLOY_PASS")
        print(f"  或设置 DEPLOY_KEY_FILE 指定SSH密钥文件")
        print(f"{'=' * 50}")
        CONFIG["password"] = getpass.getpass("密码: ")
        if not CONFIG["password"]:
            print(f"\n{Colors.RED}[错误]{Colors.NC} 密码不能为空！")
            sys.exit(1)

# ============ SSH 连接 ============
def get_ssh_client():
    """创建 SSH 连接"""
    try:
        import paramiko
    except ImportError:
        return None, "paramiko 未安装"

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        info(f"正在连接 {CONFIG['host']}:{CONFIG['port']} ...")
        info(f"用户名: {CONFIG['user']}")
        
        key_file = CONFIG.get("key_file", "")
        if key_file and os.path.exists(key_file):
            info(f"使用SSH密钥认证: {key_file}")
            try:
                key = paramiko.RSAKey.from_private_key_file(key_file)
            except paramiko.ssh_exception.SSHException:
                try:
                    key = paramiko.Ed25519Key.from_private_key_file(key_file)
                except paramiko.ssh_exception.SSHException:
                    try:
                        key = paramiko.ECDSAKey.from_private_key_file(key_file)
                    except:
                        key = None
            
            if key:
                client.connect(
                    hostname=CONFIG["host"],
                    port=CONFIG["port"],
                    username=CONFIG["user"],
                    pkey=key,
                    timeout=30
                )
            else:
                client.connect(
                    hostname=CONFIG["host"],
                    port=CONFIG["port"],
                    username=CONFIG["user"],
                    timeout=30
                )
        else:
            if not CONFIG["password"]:
                error("未设置密码或SSH密钥文件")
                sys.exit(1)
            info(f"使用密码认证")
            try:
                client.connect(
                    hostname=CONFIG["host"],
                    port=CONFIG["port"],
                    username=CONFIG["user"],
                    password=CONFIG["password"],
                    timeout=30,
                    allow_agent=False,
                    look_for_keys=False
                )
                info("SSH 连接成功 [OK]")
                return client, None
            except paramiko.AuthenticationException:
                warn("paramiko认证失败，尝试使用sshpass回退...")
                return None, "paramiko认证失败"
        info("SSH 连接成功 [OK]")
        return client, None
    except paramiko.AuthenticationException:
        error(f"SSH 认证失败: 用户名或密码错误")
        error(f"请检查: 1) 用户名是否正确 2) 密码是否正确 3) 服务器是否允许密码认证")
        sys.exit(1)
    except paramiko.SSHException as e:
        error(f"SSH 连接错误: {e}")
        error(f"请检查: 1) 服务器IP是否正确 2) SSH端口是否正确 3) 服务器是否允许SSH连接")
        sys.exit(1)
    except Exception as e:
        error(f"SSH 连接失败: {e}")
        if logger:
            logger.error(f"SSH 连接失败: {e}\n{traceback.format_exc()}")
        sys.exit(1)

def exec_cmd(client, command, timeout=120):
    """在远程服务器执行命令并返回输出"""
    channel = None
    try:
        transport = client.get_transport()
        if not transport or not transport.is_active():
            return "SSH 传输通道已关闭", -1
        channel = transport.open_session()
        channel.settimeout(timeout)
        channel.exec_command(command)

        exit_code = -1
        out = ""
        err = ""
        deadline = time.time() + timeout
        last_output_time = time.time()
        while time.time() < deadline:
            if channel.recv_ready():
                data = channel.recv(65536).decode('utf-8', errors='ignore')
                if data:
                    out += data
                    last_output_time = time.time()
            if channel.recv_stderr_ready():
                data = channel.recv_stderr(65536).decode('utf-8', errors='ignore')
                if data:
                    err += data
                    last_output_time = time.time()
            if channel.exit_status_ready():
                exit_code = channel.recv_exit_status()
                while channel.recv_ready():
                    out += channel.recv(65536).decode('utf-8', errors='ignore')
                while channel.recv_stderr_ready():
                    err += channel.recv_stderr(65536).decode('utf-8', errors='ignore')
                break
            if time.time() - last_output_time > 30:
                print(".", end="", flush=True)
                last_output_time = time.time()
            time.sleep(0.1)

        if not channel.exit_status_ready():
            channel.close()
            return "命令执行超时", -1

        out = out.strip()
        err = err.strip()
        return out + ("\n" + err if err else ""), exit_code
    except Exception as e:
        return str(e), -1
    finally:
        if channel:
            try:
                channel.close()
            except:
                pass

def upload_file(client, local_path, remote_path):
    """上传文件或目录到服务器，含完整性校验"""
    sftp = None
    try:
        sftp = client.open_sftp()
        local_path = os.path.abspath(local_path)

        if os.path.isfile(local_path):
            _upload_single_with_verify(sftp, local_path, remote_path)
            if logger:
                logger.info(f"上传文件: {local_path} -> {remote_path}")
        elif os.path.isdir(local_path):
            result = _upload_dir(sftp, local_path, remote_path)
            if result['failed'] > 0:
                warn(f"  目录上传完成，但有 {result['failed']} 个文件上传失败")
        else:
            warn(f"  文件不存在: {local_path}")
    except Exception as e:
        error(f"SFTP 上传失败 [{local_path} -> {remote_path}]: {e}")
        if logger:
            logger.error(f"上传失败: {local_path} -> {remote_path}: {e}")
    finally:
        if sftp:
            try:
                sftp.close()
            except:
                pass

def _upload_single_with_verify(sftp, local_path, remote_path, max_retries=3):
    """上传单个文件并验证完整性（文件大小校验），支持自动重试"""
    local_size = os.path.getsize(local_path)
    basename = os.path.basename(local_path)

    for attempt in range(1, max_retries + 1):
        try:
            sftp.put(local_path, remote_path)
        except Exception as e:
            if attempt < max_retries:
                warn(f"  [重试 {attempt}/{max_retries}] {basename}: {e}")
                time.sleep(1)
                continue
            else:
                warn(f"  [失败] {basename}: 上传失败 ({max_retries}次重试后): {e}")
                if logger:
                    logger.error(f"上传失败(重试{max_retries}次): {basename}: {e}")
                return False

        # 验证远程文件大小
        try:
            remote_stat = sftp.stat(remote_path)
            remote_size = remote_stat.st_size
            if remote_size != local_size:
                if attempt < max_retries:
                    warn(f"  [校验失败 {attempt}/{max_retries}] {basename}: 本地={local_size}B, 远程={remote_size}B, 重新上传...")
                    if logger:
                        logger.warn(f"文件大小校验失败: {basename}: 本地={local_size}, 远程={remote_size}")
                    time.sleep(1)
                    continue
                else:
                    warn(f"  [校验失败] {basename}: 本地={local_size}B, 远程={remote_size}B ({max_retries}次重试后仍不一致)")
                    if logger:
                        logger.error(f"文件大小校验最终失败: {basename}: 本地={local_size}, 远程={remote_size}")
                    return False
            else:
                info(f"  [OK] {basename} ({_format_size(local_size)})")
                if logger:
                    logger.info(f"上传并校验成功: {basename} ({local_size}B)")
                return True
        except Exception as e:
            warn(f"  [校验异常] {basename}: {e}")
            if logger:
                logger.error(f"远程文件stat失败: {basename}: {e}")
            if attempt < max_retries:
                time.sleep(1)
                continue
            return False

    return False

def _format_size(size_bytes):
    """格式化文件大小为人类可读格式"""
    if size_bytes < 1024:
        return f"{size_bytes}B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f}KB"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f}MB"
    else:
        return f"{size_bytes / (1024 * 1024 * 1024):.1f}GB"

def _upload_dir(sftp, local_dir, remote_dir):
    """递归上传目录，返回 { success: int, failed: int, skipped: int }"""
    result = {'success': 0, 'failed': 0, 'skipped': 0}
    try:
        sftp.stat(remote_dir)
    except:
        _mkdir_p(sftp, remote_dir)

    for item in sorted(os.listdir(local_dir)):
        local_item = os.path.join(local_dir, item)
        remote_item = f"{remote_dir}/{item}"

        # Skip hidden files/directories
        if item.startswith('.'):
            result['skipped'] += 1
            continue

        # Skip directories that should never be uploaded
        if item in ['node_modules', '.git', '__pycache__']:
            result['skipped'] += 1
            continue

        # Check exclude patterns - use exact match or glob match, NOT substring
        should_skip = False
        for pat in EXTRA_EXCLUDE_PATTERNS:
            # Exact filename match
            if item == pat:
                should_skip = True
                break
            # Glob pattern match (e.g., *.pyc, test_*.html)
            if '*' in pat:
                import fnmatch
                if fnmatch.fnmatch(item, pat):
                    should_skip = True
                    break
            # For directory patterns, only match exact directory names
            # Don't use substring matching to avoid false positives like 'logs' matching 'activity-logs'

        if should_skip:
            result['skipped'] += 1
            continue

        if os.path.isfile(local_item):
            ok = _upload_single_with_verify(sftp, local_item, remote_item)
            if ok:
                result['success'] += 1
            else:
                result['failed'] += 1
        elif os.path.isdir(local_item):
            sub_result = _upload_dir(sftp, local_item, remote_item)
            result['success'] += sub_result['success']
            result['failed'] += sub_result['failed']
            result['skipped'] += sub_result['skipped']

    return result

def _mkdir_p(sftp, remote_dir):
    """递归创建目录"""
    dirs = []
    while True:
        try:
            sftp.stat(remote_dir)
            break
        except:
            dirs.append(remote_dir)
            remote_dir = os.path.dirname(remote_dir)
    for d in reversed(dirs):
        try:
            sftp.mkdir(d)
        except:
            pass

# ============ Git 变更检测 ============
def get_project_root():
    return os.path.dirname(os.path.abspath(__file__))

def should_exclude(filepath):
    import fnmatch
    filepath = filepath.replace('\\', '/')
    basename = os.path.basename(filepath)
    for pattern in EXTRA_EXCLUDE_PATTERNS:
        if fnmatch.fnmatch(basename, pattern):
            return True
        if fnmatch.fnmatch(filepath, pattern):
            return True
        if filepath == pattern or filepath.startswith(pattern + '/'):
            return True
        if '/' + pattern + '/' in filepath:
            return True
    return False

def get_git_changes():
    project_root = get_project_root()
    try:
        result = subprocess.run(
            ['git', 'status', '--porcelain'],
            cwd=project_root,
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            timeout=30
        )
        if result.returncode != 0:
            warn(f"git status 执行失败: {result.stderr}")
            return [], [], []

        modified = []
        new_files = []
        deleted = []
        for line in result.stdout.strip().split('\n'):
            line = line.strip()
            if not line:
                continue
            status = line[:2].strip()
            filename = line[2:].strip()
            if ' -> ' in filename:
                filename = filename.split(' -> ')[-1].strip()
            filename = filename.replace('\\', '/')
            if should_exclude(filename):
                continue
            if status in ['M', 'MM']:
                modified.append(filename)
            elif status in ['A', 'AM']:
                new_files.append(filename)
            elif status in ['D', 'DM']:
                deleted.append(filename)
            elif status == '??':
                new_files.append(filename)
            elif status == 'R':
                modified.append(filename)
            elif status == 'C':
                new_files.append(filename)
            else:
                full_path = os.path.join(project_root, filename)
                if os.path.exists(full_path):
                    modified.append(filename)
                else:
                    deleted.append(filename)
        return modified, new_files, deleted
    except FileNotFoundError:
        warn("git 未安装或不是 git 仓库，无法检测变更文件")
        return [], [], []
    except Exception as e:
        warn(f"git 检测失败: {e}")
        return [], [], []

def upload_changed_files(client, do_restart=True, do_delete=True):
    project_root = get_project_root()
    remote = CONFIG["remote_dir"]
    info("检测文件变更...")
    modified, new_files, deleted = get_git_changes()
    if not modified and not new_files and not deleted:
        info("未检测到任何文件变更")
        return
    info(f"变更摘要: 修改 {len(modified)} 个, 新增 {len(new_files)} 个, 删除 {len(deleted)} 个")
    
    sftp = None
    try:
        sftp = client.open_sftp()
        upload_count = 0
        fail_count = 0
        if modified:
            info("上传修改的文件...")
            for rel_path in modified:
                local_path = os.path.join(project_root, rel_path)
                # 修复：远程路径始终使用正斜杠（Linux服务器）
                remote_path = f"{remote}/{rel_path.replace(os.sep, '/')}"
                if not os.path.exists(local_path):
                    warn(f"  本地文件不存在，跳过: {rel_path}")
                    continue
                _mkdir_p(sftp, os.path.dirname(remote_path).replace(os.sep, '/'))
                ok = _upload_single_with_verify(sftp, local_path, remote_path)
                if ok:
                    upload_count += 1
                else:
                    fail_count += 1
        if new_files:
            info("上传新增的文件...")
            for rel_path in new_files:
                local_path = os.path.join(project_root, rel_path)
                # 修复：远程路径始终使用正斜杠（Linux服务器）
                remote_path = f"{remote}/{rel_path.replace(os.sep, '/')}"
                if not os.path.exists(local_path):
                    warn(f"  本地文件不存在，跳过: {rel_path}")
                    continue
                _mkdir_p(sftp, os.path.dirname(remote_path).replace(os.sep, '/'))
                ok = _upload_single_with_verify(sftp, local_path, remote_path)
                if ok:
                    upload_count += 1
                else:
                    fail_count += 1
        if do_delete and deleted:
            info("删除远程已删除的文件...")
            for rel_path in deleted:
                remote_path = f"{remote}/{rel_path.replace(os.sep, '/')}"
                try:
                    sftp.remove(remote_path)
                    info(f"  [OK] {rel_path}")
                except FileNotFoundError:
                    pass
                except Exception as e:
                    warn(f"  [失败] {rel_path}: {e}")
        if upload_count == 0 and fail_count == 0:
            info("没有文件需要上传")
        else:
            info(f"共上传 {upload_count} 个文件 [OK]")
            if fail_count > 0:
                warn(f"有 {fail_count} 个文件上传失败或校验不通过")
        if do_restart and upload_count > 0:
            info("重启 PM2...")
            exec_cmd(client, f"cd {remote} && pm2 restart ecosystem.config.js 2>&1", timeout=30)
            time.sleep(3)
            out, _ = exec_cmd(client, "pm2 status 2>&1")
            info(f"PM2 状态:\n{out}")
    finally:
        if sftp:
            try:
                sftp.close()
            except:
                pass

# ============ 核心功能模块 ============
def test_ssh(client):
    out, code = exec_cmd(client, "echo 'SSH 连接正常'")
    info(f"服务器 {CONFIG['host']} 连接正常")

def check_remote_env(client):
    step(2, 16, "检查服务器环境")
    out, _ = exec_cmd(client, "cat /etc/os-release 2>/dev/null | head -2 || cat /etc/issue 2>/dev/null | head -1")
    info(f"系统: {out.split(chr(10))[0] if out else 'unknown'}")
    checks = {
        "Node.js": "node --version 2>/dev/null || echo '未安装'",
        "npm": "npm --version 2>/dev/null || echo '未安装'",
        "PM2": "pm2 --version 2>/dev/null || echo '未安装'",
        "Nginx": "nginx -v 2>&1 || echo '未安装'",
        "Certbot": "certbot --version 2>/dev/null || echo '未安装'",
    }
    for name, cmd in checks.items():
        out, _ = exec_cmd(client, cmd)
        version = out.split('\n')[0].strip()[:50]
        info(f"  {name}: {version}")
    out, _ = exec_cmd(client, "echo \"CPU: $(nproc)核 | 内存: $(free -h | grep Mem | awk '{print $2}') | 磁盘: $(df -h / | tail -1 | awk '{print $4}')\"")
    info(f"资源: {out}")

def install_software(client):
    step(3, 16, "安装/更新服务器软件")
    info("更新包列表...")
    exec_cmd(client, "apt-get update -qq 2>/dev/null || true")
    info("安装 Node.js...")
    exec_cmd(client, f"which node || (curl -fsSL https://deb.nodesource.com/setup_{CONFIG['node_version']}.x | bash - && apt-get install -y nodejs)")
    info("安装构建工具...")
    exec_cmd(client, "apt-get install -y build-essential python3 git curl wget unzip 2>/dev/null || true")
    info("安装 PM2...")
    exec_cmd(client, "which pm2 || npm install -g pm2")
    info("安装 Nginx...")
    exec_cmd(client, "which nginx || apt-get install -y nginx")
    exec_cmd(client, "systemctl enable nginx 2>/dev/null || true")
    info("安装 Certbot (SSL)...")
    exec_cmd(client, "which certbot || (apt-get install -y certbot python3-certbot-nginx 2>/dev/null || true)")
    info("软件安装完成 [OK]")

def create_backup(client):
    step(4, 16, "创建部署前备份")
    remote = CONFIG["remote_dir"]
    backup_name = f"backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.tar.gz"
    backup_path = f"{remote}/{backup_name}"
    info(f"正在创建备份: {backup_name}")
    exec_cmd(client, f"mkdir -p {remote}/backups")
    out, code = exec_cmd(client, f"cd {remote} && tar -czf {backup_path} --exclude='{backup_name}' --exclude='backups' --exclude='logs' --exclude='node_modules' --exclude='public/uploads' . 2>&1", timeout=300)
    if code == 0:
        info(f"备份创建成功 [OK]")
    else:
        warn(f"备份创建可能有问题: {out}")
    out, _ = exec_cmd(client, f"ls -lh {remote}/backups/ 2>/dev/null || echo '无'")
    info(f"备份列表:\n{out}")

def clear_remote_dir(client):
    step(5, 16, "清理远程服务器旧文件")
    remote = CONFIG['remote_dir']
    info("正在清理远程旧文件（保留 uploads/ logs/ backup/ 和配置文件）...")
    exec_cmd(client, "pm2 stop ecosystem.config.js 2>/dev/null || true")
    exec_cmd(client, "pm2 delete ecosystem.config.js 2>/dev/null || true")
    cleanup_cmd = f"""
cd {remote} && rm -rf server views public/css public/js public/assets && \
rm -f package.json package-lock.json ecosystem.config.js .session_secret && \
rm -rf scripts deploy && mkdir -p logs backups public/uploads/images public/uploads/novels
"""
    exec_cmd(client, cleanup_cmd, timeout=60)
    info("旧文件清理完成 [OK]")

def create_directories(client):
    step(6, 16, "创建远程目录")
    dirs = f"{CONFIG['remote_dir']}/{{logs,backups,public/uploads/images,public/uploads/novels,scripts}}"
    exec_cmd(client, f"mkdir -p {dirs}")
    info(f"目录创建完成: {CONFIG['remote_dir']}")

def upload_files(client):
    step(7, 16, "上传项目文件到服务器")
    project_dir = os.path.dirname(os.path.abspath(__file__))
    remote = CONFIG["remote_dir"]
    info("上传核心文件...")
    core_files = [
        "package.json",
        "package-lock.json",
        "ecosystem.config.js",
        "cdn-config.js",
        ".eslintrc.json",
        ".eslintignore",
        ".gitignore",
        "LICENSE",
        "README.md",
    ]
    for f in core_files:
        local = os.path.join(project_dir, f)
        if os.path.exists(local):
            upload_file(client, local, f"{remote}/{f}")
    info("上传 server/...")
    upload_file(client, os.path.join(project_dir, "server"), f"{remote}/server")
    info("上传 views/...")
    upload_file(client, os.path.join(project_dir, "views"), f"{remote}/views")
    if os.path.exists(os.path.join(project_dir, "assets")):
        info("上传 assets/...")
        upload_file(client, os.path.join(project_dir, "assets"), f"{remote}/assets")
    if os.path.exists(os.path.join(project_dir, "character")):
        info("上传 character/...")
        upload_file(client, os.path.join(project_dir, "character"), f"{remote}/character")
    info("上传 public/...")
    upload_file(client, os.path.join(project_dir, "public"), f"{remote}/public")
    info("设置权限...")
    exec_cmd(client, f"chmod -R 755 {remote}/public/uploads")
    info("文件上传完成 [OK]")

def setup_pm2(client):
    step(8, 16, "配置 PM2 进程管理")
    remote = CONFIG["remote_dir"]
    info("停止旧进程...")
    exec_cmd(client, "pm2 stop ecosystem.config.js 2>/dev/null || true")
    exec_cmd(client, "pm2 delete ecosystem.config.js 2>/dev/null || true")
    info("安装 npm 依赖...")
    out, code = exec_cmd(client, f"cd {remote} && npm install --production --prefer-offline --no-audit --no-fund 2>&1", timeout=600)
    if code != 0:
        warn(f"npm install 可能有警告: {out[-300:]}")
    else:
        info("npm 依赖安装完成")
    info("启动应用...")
    exec_cmd(client, f"cd {remote} && pm2 start ecosystem.config.js")
    time.sleep(5)
    out, _ = exec_cmd(client, "pm2 status 2>&1")
    info(f"PM2 状态:\n{out}")
    exec_cmd(client, "pm2 save")
    exec_cmd(client, "pm2 startup systemd -u root --hp /root 2>/dev/null || true")
    info("验证应用启动...")
    out, _ = exec_cmd(client, f"curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1:{CONFIG['app_port']}/health 2>/dev/null || echo '000'")
    if out == "200":
        info(f"应用健康检查通过 (HTTP {out})")
    else:
        warn(f"应用健康检查异常 (HTTP {out})，查看日志...")
        out, _ = exec_cmd(client, f"cd {remote} && pm2 logs --lines 50 --nostream 2>&1 || echo '无日志'")
        warn(f"最近日志:\n{out}")

def setup_nginx(client):
    step(9, 16, "配置 Nginx 反向代理")
    domain = CONFIG["domain"]
    remote_dir = CONFIG["remote_dir"]
    app_port = CONFIG["app_port"]
    conf_path = f"/etc/nginx/sites-available/{domain}"
    nginx_config = f"""server {{
    listen 80;
    listen [::]:80;
    server_name {domain} www.{domain};
    access_log /var/log/nginx/{domain}_access.log;
    error_log /var/log/nginx/{domain}_error.log;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-XSS-Protection "1; mode=block" always;
    location ~* \\.(jpg|jpeg|png|gif|ico|css|js|woff|woff2|ttf|svg|eot)$ {{
        root {remote_dir}/public;
        expires 30d;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
        access_log off;
    }}
    location /uploads/ {{
        alias {remote_dir}/public/uploads/;
        expires 7d;
        add_header Cache-Control "public";
    }}
    location = /favicon.ico {{
        root {remote_dir}/public;
        log_not_found off;
        access_log off;
    }}
    location /health {{
        proxy_pass http://127.0.0.1:{app_port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        access_log off;
        allow all;
    }}
    location / {{
        proxy_pass http://127.0.0.1:{app_port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }}
    client_max_body_size 50M;
}}
"""
    info("生成 Nginx 配置...")
    encoded = base64.b64encode(nginx_config.encode()).decode()
    exec_cmd(client, f"echo '{encoded}' | base64 -d > {conf_path}")
    info("启用站点...")
    exec_cmd(client, "mkdir -p /etc/nginx/sites-enabled")
    exec_cmd(client, f"ln -sf {conf_path} /etc/nginx/sites-enabled/{domain}")
    exec_cmd(client, "rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true")
    info("测试 Nginx 配置...")
    out, code = exec_cmd(client, "nginx -t 2>&1")
    if code == 0:
        exec_cmd(client, "systemctl reload nginx")
        info("Nginx 配置成功 [OK]")
    else:
        error(f"Nginx 配置失败:\n{out}")
        sys.exit(1)

def setup_ssl(client):
    step(10, 16, "配置 SSL 证书 (Let's Encrypt)")
    domain = CONFIG["domain"]
    info("检查 Certbot...")
    exec_cmd(client, "which certbot 2>/dev/null || apt-get install -y certbot python3-certbot-nginx 2>/dev/null || true")
    info(f"获取 SSL 证书 [{domain}]...")
    out, code = exec_cmd(client, f"certbot --nginx -d {domain} -d www.{domain} --non-interactive --agree-tos --email admin@{domain} --redirect 2>&1", timeout=120)
    if code != 0:
        warn("www 子域名验证失败，尝试仅申请主域名证书...")
        out, code = exec_cmd(client, f"certbot --nginx -d {domain} --non-interactive --agree-tos --email admin@{domain} --redirect 2>&1", timeout=120)
    if code == 0:
        info("SSL 证书配置成功 [OK]")
        info("已启用 HTTPS 并自动重定向 HTTP → HTTPS")
        exec_cmd(client, '(crontab -l 2>/dev/null | grep -v "certbot renew"; echo "0 3 * * * /usr/bin/certbot renew --quiet && systemctl reload nginx") | crontab -')
    else:
        warn("SSL 证书获取失败，可能原因:")
        warn("  1) 域名尚未解析到本服务器")
        warn("  2) 80端口未开放")
        warn("  3) Certbot 速率限制")
        warn("跳过 SSL 配置，继续使用 HTTP")

def setup_system(client):
    step(11, 16, "系统优化")
    info("优化内核参数...")
    sysctl_cfg = """
net.core.somaxconn = 1024
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_max_syn_backlog = 2048
vm.swappiness = 10
"""
    exec_cmd(client, f"echo '{sysctl_cfg}' >> /etc/sysctl.conf")
    exec_cmd(client, "sysctl -p 2>/dev/null || true")
    info("配置文件句柄限制...")
    limits_cfg = """
root soft nofile 65536
root hard nofile 65536
* soft nofile 65536
* hard nofile 65536
"""
    exec_cmd(client, f"echo '{limits_cfg}' >> /etc/security/limits.conf")
    info("配置防火墙...")
    exec_cmd(client, "ufw allow 22/tcp 2>/dev/null || true")
    exec_cmd(client, "ufw allow 80/tcp 2>/dev/null || true")
    exec_cmd(client, "ufw allow 443/tcp 2>/dev/null || true")
    exec_cmd(client, "ufw --force enable 2>/dev/null || true")
    info("系统优化完成 [OK]")

def setup_logrotate(client):
    step(12, 16, "配置日志轮转")
    domain = CONFIG["domain"]
    logrotate_cfg = f"""/var/log/nginx/{domain}_*.log {{
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 640 www-data adm
    sharedscripts
    postrotate
        [ -f /var/run/nginx.pid ] && kill -USR1 `cat /var/run/nginx.pid`
    endscript
}}
{CONFIG['remote_dir']}/logs/*.log {{
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
}}
"""
    exec_cmd(client, f"cat > /etc/logrotate.d/nginx-{domain} << 'EOFLOG'\n{logrotate_cfg}\nEOFLOG")
    info("Nginx 日志轮转配置完成")
    info("配置 PM2 日志轮转...")
    exec_cmd(client, "pm2 install pm2-logrotate 2>/dev/null || true")
    exec_cmd(client, "pm2 set pm2-logrotate:max_size 10M 2>/dev/null || true")
    exec_cmd(client, "pm2 set pm2-logrotate:retain 7 2>/dev/null || true")
    info("日志轮转配置完成 [OK]")

def setup_health_scripts(client):
    step(13, 16, "部署健康监控脚本")
    remote_dir = CONFIG["remote_dir"]
    domain = CONFIG["domain"]
    app_port = CONFIG["app_port"]
    check_script = f"""#!/bin/bash
REMOTE_DIR="{remote_dir}"
DOMAIN="{domain}"
APP_PORT={app_port}
LOG_FILE="${{REMOTE_DIR}}/logs/check-server.log"
mkdir -p $(dirname $LOG_FILE)
log() {{
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> ${{LOG_FILE}}
    echo "$1"
}}
log "========== 服务器状态检查 =========="
echo "--- 系统资源 ---"
free -h | head -2
df -h / | tail -1
uptime
if systemctl is-active --quiet nginx; then
    log "[OK] Nginx"
else
    log "[FAIL] Nginx 重启..."
    systemctl restart nginx
    sleep 2
    systemctl is-active --quiet nginx && log "[OK] 已重启" || log "[FAIL] 重启失败"
fi
HTTP_CODE=$(curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1:${{APP_PORT}}/health 2>/dev/null || echo "000")
if [ "${{HTTP_CODE}}" = "200" ]; then
    log "[OK] 应用正常"
else
    log "[FAIL] 应用无响应 (HTTP: ${{HTTP_CODE}})"
    cd ${{REMOTE_DIR}} && pm2 restart ecosystem.config.js 2>/dev/null
    sleep 5
fi
DISK=$(df / | tail -1 | awk '{{print $5}}' | sed 's/%//')
[ ${{DISK}} -gt 90 ] && log "[WARN] 磁盘 ${{DISK}}%" || log "[OK] 磁盘 ${{DISK}}%"
[ -f "/etc/letsencrypt/live/${{DOMAIN}}/fullchain.pem" ] && {{
    EXPIRY=$(openssl x509 -enddate -noout -in /etc/letsencrypt/live/${{DOMAIN}}/fullchain.pem | cut -d= -f2)
    log "[OK] SSL 至 ${{EXPIRY}}"
}}
log "========== 检查完成 =========="
"""
    heal_script = f"""#!/bin/bash
REMOTE_DIR="{remote_dir}"
DOMAIN="{domain}"
APP_PORT={app_port}
LOG_FILE="${{REMOTE_DIR}}/logs/auto-heal.log"
mkdir -p $(dirname $LOG_FILE)
log() {{ echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> ${{LOG_FILE}}; }}
log "========== 自动修复 =========="
if ! systemctl is-active --quiet nginx; then
    log "重启 Nginx..."
    systemctl restart nginx
    sleep 2
    systemctl is-active --quiet nginx && log "OK" || log "失败"
fi
HEALTH=$(curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1:${{APP_PORT}}/health 2>/dev/null || echo "000")
if [ "${{HEALTH}}" != "200" ]; then
    log "重启 PM2..."
    cd ${{REMOTE_DIR}} && pm2 restart ecosystem.config.js 2>/dev/null
    sleep 5
fi
pm2 list 2>/dev/null | grep -q "online" || {{
    cd ${{REMOTE_DIR}} && pm2 start ecosystem.config.js 2>/dev/null && pm2 save
}}
DISK=$(df / | tail -1 | awk '{{print $5}}' | sed 's/%//')
if [ ${{DISK}} -gt 85 ]; then
    pm2 flush 2>/dev/null
    > /var/log/nginx/${{DOMAIN}}_access.log 2>/dev/null
    > /var/log/nginx/${{DOMAIN}}_error.log 2>/dev/null
    apt-get clean 2>/dev/null
fi
command -v certbot &>/dev/null && [ -f "/etc/letsencrypt/live/${{DOMAIN}}/fullchain.pem" ] && {{
    openssl x509 -checkend 864000 -noout -in "/etc/letsencrypt/live/${{DOMAIN}}/fullchain.pem" 2>/dev/null || {{
        certbot renew --quiet 2>/dev/null && systemctl reload nginx
    }}
}}
pm2 save 2>/dev/null
log "========== 修复完成 =========="
"""
    info("创建检查脚本...")
    sftp = None
    try:
        sftp = client.open_sftp()
        with sftp.open(f"{remote_dir}/scripts/check-server.sh", 'w') as f:
            f.write(check_script)
        with sftp.open(f"{remote_dir}/scripts/auto-heal.sh", 'w') as f:
            f.write(heal_script)
    except Exception as e:
        error(f"创建健康脚本失败: {e}")
    finally:
        if sftp:
            try:
                sftp.close()
            except:
                pass
    exec_cmd(client, f"chmod +x {remote_dir}/scripts/*.sh")
    info("配置定时监控...")
    cron_cmd = f'(crontab -l 2>/dev/null | grep -v "check-server.sh\\|auto-heal.sh"; echo "*/5 * * * * cd {remote_dir} && bash scripts/check-server.sh >/dev/null 2>&1"; echo "*/30 * * * * cd {remote_dir} && bash scripts/auto-heal.sh >/dev/null 2>&1") | crontab -'
    exec_cmd(client, cron_cmd)
    info("健康监控已部署 [OK]")

def final_verify(client):
    step(14, 16, "验证部署结果")
    print("\n" + "="*50)
    print("  验证清单")
    print("="*50)
    info("1. PM2 进程:")
    out, _ = exec_cmd(client, "pm2 status 2>&1")
    print(f"{out}\n")
    info("2. 应用健康检查:")
    out, _ = exec_cmd(client, f"curl -s http://127.0.0.1:{CONFIG['app_port']}/health 2>/dev/null")
    print(f"{out}\n")
    info("3. Nginx:")
    out, _ = exec_cmd(client, "systemctl status nginx --no-pager | head -5")
    print(f"{out}\n")
    info("4. SSL:")
    out, _ = exec_cmd(client, "certbot certificates 2>/dev/null || echo '未配置'")
    print(f"{out}")
    ssl_expiry, _ = exec_cmd(client, f'openssl x509 -enddate -noout -in /etc/letsencrypt/live/{CONFIG["domain"]}/fullchain.pem 2>/dev/null | cut -d= -f2 || echo "无证书"')
    if ssl_expiry:
        print(f"证书到期: {ssl_expiry}\n")
    info("5. 监听端口:")
    out, _ = exec_cmd(client, "ss -tlnp | grep -E ':(80|443|3000) ' || true")
    print(f"{out}\n")
    info("6. 定时任务:")
    out, _ = exec_cmd(client, "crontab -l 2>/dev/null || echo '无'")
    print(f"{out}")

def deploy_complete():
    step(15, 16, "部署完成！")
    domain = CONFIG["domain"]
    host = CONFIG["host"]
    remote_dir = CONFIG["remote_dir"]
    print(f"""
{Colors.GREEN}============================================================{Colors.NC}
{Colors.GREEN}  部署完成！{Colors.NC}
{Colors.GREEN}============================================================{Colors.NC}
  域名:     {Colors.BLUE}http://{domain}{Colors.NC}
  HTTPS:    {Colors.BLUE}https://{domain}{Colors.NC} (如果SSL成功)
  后台:     {Colors.BLUE}http://{domain}/admin{Colors.NC}
  健康:     {Colors.BLUE}http://{domain}/health{Colors.NC}
  目录:     {Colors.YELLOW}{remote_dir}{Colors.NC}
  进程:     {Colors.YELLOW}pm2 status{Colors.NC}
  日志:     {Colors.YELLOW}pm2 logs{Colors.NC}
{Colors.YELLOW}  首次使用请访问 /setup 完成初始化安装{Colors.NC}
{Colors.YELLOW}  每5分钟检查, 每30分钟自动修复{Colors.NC}
{Colors.GREEN}============================================================{Colors.NC}
""")

def rollback(client):
    step(16, 16, "执行回滚")
    remote = CONFIG["remote_dir"]
    info("查找最新备份...")
    out, _ = exec_cmd(client, f"ls -1t {remote}/backups/backup_*.tar.gz 2>/dev/null | head -1")
    backup_file = out.strip()
    if not backup_file:
        error("没有找到备份文件！")
        return False
    info(f"找到备份: {backup_file}")
    confirm = input(f"{Colors.YELLOW}确认要回滚到这个备份吗？(yes/no): {Colors.NC}").strip()
    if confirm.lower() != "yes":
        info("回滚已取消")
        return False
    info("停止当前服务...")
    exec_cmd(client, "pm2 stop ecosystem.config.js 2>/dev/null || true")
    exec_cmd(client, "pm2 delete ecosystem.config.js 2>/dev/null || true")
    info("恢复备份...")
    out, code = exec_cmd(client, f"cd {remote} && tar -xzf {backup_file} 2>&1", timeout=300)
    if code != 0:
        error(f"恢复备份失败: {out}")
        return False
    info("重启服务...")
    exec_cmd(client, f"cd {remote} && pm2 start ecosystem.config.js")
    time.sleep(3)
    info("验证回滚...")
    out, _ = exec_cmd(client, "pm2 status 2>&1")
    print(out)
    success("回滚完成！")
    return True

# ============ 诊断和日志查看 ============
def view_logs(client):
    remote = CONFIG["remote_dir"]
    while True:
        print(f"\n{Colors.BLUE}{'='*50}{Colors.NC}")
        print(f"  日志查看工具")
        print(f"{Colors.BLUE}{'='*50}{Colors.NC}")
        print("  [1] PM2 错误日志")
        print("  [2] PM2 输出日志")
        print("  [3] Nginx 访问日志")
        print("  [4] Nginx 错误日志")
        print("  [5] 健康检查日志")
        print("  [6] 自动修复日志")
        print("  [7] 查看所有日志文件")
        print("  [R] 运行诊断")
        print("  [B] 返回")
        choice = input("\n请选择: ").strip().lower()
        if choice == '1':
            lines = input("显示行数 [50]: ").strip() or "50"
            out, _ = exec_cmd(client, f"cd {remote} && tail -n {lines} logs/pm2-error.log 2>&1 || echo '日志不存在'")
            print(f"\n--- PM2 错误日志 ---\n{out}")
        elif choice == '2':
            lines = input("显示行数 [50]: ").strip() or "50"
            out, _ = exec_cmd(client, f"cd {remote} && tail -n {lines} logs/pm2-out.log 2>&1 || echo '日志不存在'")
            print(f"\n--- PM2 输出日志 ---\n{out}")
        elif choice == '3':
            lines = input("显示行数 [50]: ").strip() or "50"
            out, _ = exec_cmd(client, f"tail -n {lines} /var/log/nginx/{CONFIG['domain']}_access.log 2>&1 || echo '日志不存在'")
            print(f"\n--- Nginx 访问日志 ---\n{out}")
        elif choice == '4':
            lines = input("显示行数 [50]: ").strip() or "50"
            out, _ = exec_cmd(client, f"tail -n {lines} /var/log/nginx/{CONFIG['domain']}_error.log 2>&1 || echo '日志不存在'")
            print(f"\n--- Nginx 错误日志 ---\n{out}")
        elif choice == '5':
            lines = input("显示行数 [50]: ").strip() or "50"
            out, _ = exec_cmd(client, f"cd {remote} && tail -n {lines} logs/check-server.log 2>&1 || echo '日志不存在'")
            print(f"\n--- 健康检查日志 ---\n{out}")
        elif choice == '6':
            lines = input("显示行数 [50]: ").strip() or "50"
            out, _ = exec_cmd(client, f"cd {remote} && tail -n {lines} logs/auto-heal.log 2>&1 || echo '日志不存在'")
            print(f"\n--- 自动修复日志 ---\n{out}")
        elif choice == '7':
            out, _ = exec_cmd(client, f"cd {remote} && ls -lh logs/ 2>&1; echo; ls -lh /var/log/nginx/ 2>&1")
            print(f"\n--- 日志文件列表 ---\n{out}")
        elif choice == 'r':
            run_diagnose(client)
        elif choice == 'b':
            break
        input("\n按回车键继续...")

def run_diagnose(client):
    print(f"\n{Colors.MAGENTA}{'='*50}{Colors.NC}")
    print("  系统诊断")
    print(f"{Colors.MAGENTA}{'='*50}{Colors.NC}")
    print("\n--- 系统资源 ---")
    out, _ = exec_cmd(client, "free -h")
    print(out)
    out, _ = exec_cmd(client, "df -h /")
    print(out)
    out, _ = exec_cmd(client, "uptime")
    print(out)
    print("\n--- PM2 状态 ---")
    out, _ = exec_cmd(client, "pm2 status 2>&1")
    print(out)
    print("\n--- PM2 监控 ---")
    out, _ = exec_cmd(client, "pm2 jlist 2>&1 | head -100")
    print(out)
    print("\n--- 应用健康检查 ---")
    out, _ = exec_cmd(client, f"curl -s http://127.0.0.1:{CONFIG['app_port']}/health 2>&1 || echo '无法连接'")
    print(out)
    print("\n--- Nginx 状态 ---")
    out, _ = exec_cmd(client, "nginx -t 2>&1")
    print(out)
    out, _ = exec_cmd(client, "systemctl status nginx --no-pager | head -10")
    print(out)
    print("\n--- 监听端口 ---")
    out, _ = exec_cmd(client, "ss -tlnp")
    print(out)
    print("\n--- SSL 状态 ---")
    out, _ = exec_cmd(client, "certbot certificates 2>&1")
    print(out)
    print("\n--- 防火墙状态 ---")
    out, _ = exec_cmd(client, "ufw status 2>&1 || iptables -L -n 2>&1 | head -20")
    print(out)
    print("\n--- 定时任务 ---")
    out, _ = exec_cmd(client, "crontab -l 2>&1")
    print(out)
    print("\n--- 最近错误日志 (最后50行) ---")
    out, _ = exec_cmd(client, f"cd {CONFIG['remote_dir']} && tail -50 logs/pm2-error.log 2>&1 || echo '无日志'")
    print(out)
    print("\n--- 文件权限检查 ---")
    out, _ = exec_cmd(client, f"ls -la {CONFIG['remote_dir']}/ | head -20")
    print(out)

# ============ 模式函数 ============
def full_deploy():
    init_logger()
    ensure_password()
    client, err = get_ssh_client()
    if err:
        error(f"SSH 连接失败: {err}")
        return
    try:
        test_ssh(client)
        check_remote_env(client)
        install_software(client)
        create_backup(client)
        clear_remote_dir(client)
        create_directories(client)
        upload_files(client)
        setup_pm2(client)
        setup_nginx(client)
        setup_ssl(client)
        setup_system(client)
        setup_logrotate(client)
        setup_health_scripts(client)
        final_verify(client)
        deploy_complete()
        success("部署成功完成！")
        if logger:
            logger.info("部署成功完成")
    except Exception as e:
        error(f"部署过程出错: {e}")
        if logger:
            logger.error(f"部署失败: {e}\n{traceback.format_exc()}")
        print("\n是否尝试回滚？")
        choice = input("(yes/no): ").strip().lower()
        if choice == "yes":
            rollback(client)
    finally:
        client.close()
        if logger:
            logger.close()

def upload_only():
    ensure_password()
    client, err = get_ssh_client()
    if err:
        error(f"SSH 连接失败: {err}")
        return
    try:
        create_directories(client)
        upload_files(client)
        info("文件上传完成！")
    finally:
        client.close()

def upload_changed_only():
    ensure_password()
    client, err = get_ssh_client()
    if err:
        error(f"SSH 连接失败: {err}")
        return
    try:
        create_directories(client)
        upload_changed_files(client, do_restart=True)
        info("变更文件上传完成！")
    finally:
        client.close()

def ssl_only():
    ensure_password()
    client, err = get_ssh_client()
    if err:
        error(f"SSH 连接失败: {err}")
        return
    try:
        check_remote_env(client)
        install_software(client)
        setup_nginx(client)
        setup_ssl(client)
        deploy_complete()
    finally:
        client.close()

def fix_only():
    ensure_password()
    client, err = get_ssh_client()
    if err:
        error(f"SSH 连接失败: {err}")
        return
    try:
        info("执行修复...")
        exec_cmd(client, "nginx -t && systemctl reload nginx && echo 'Nginx OK' || systemctl restart nginx")
        exec_cmd(client, f"curl -s http://127.0.0.1:{CONFIG['app_port']}/health >/dev/null 2>&1 && echo '应用 OK' || (cd {CONFIG['remote_dir']} && pm2 restart ecosystem.config.js && echo '已重启')")
        exec_cmd(client, "certbot renew --quiet 2>/dev/null && systemctl reload nginx && echo 'SSL 已续期' || echo 'SSL 未配置或续期失败'")
        exec_cmd(client, "pm2 flush 2>/dev/null; apt-get clean 2>/dev/null")
        info("修复完成 [OK]")
    finally:
        client.close()

def fix_nginx_only():
    ensure_password()
    client, err = get_ssh_client()
    if err:
        error(f"SSH 连接失败: {err}")
        return
    try:
        domain = CONFIG["domain"]
        remote_dir = CONFIG["remote_dir"]
        app_port = CONFIG["app_port"]
        conf_path = f"/etc/nginx/sites-available/{domain}"
        info("检查 Nginx 状态...")
        out, code = exec_cmd(client, "which nginx")
        if code != 0:
            warn("Nginx 未安装，正在安装...")
            exec_cmd(client, "apt-get update -qq")
            exec_cmd(client, "apt-get install -y nginx")
            exec_cmd(client, "systemctl enable nginx")
            info("Nginx 安装完成")
        out, code = exec_cmd(client, "systemctl is-active nginx")
        if code == 0:
            info("Nginx 服务运行正常")
        else:
            warn("Nginx 服务未运行，正在启动...")
            exec_cmd(client, "systemctl start nginx")
        info("备份现有配置...")
        backup_dir = f"/etc/nginx/backup-{int(time.time())}"
        exec_cmd(client, f"mkdir -p {backup_dir}")
        exec_cmd(client, f"test -f {conf_path} && cp {conf_path} {backup_dir}/ || true")
        exec_cmd(client, "cp /etc/nginx/nginx.conf {backup_dir}/ 2>/dev/null || true")
        info("生成站点配置...")
        nginx_config = f"""server {{
    listen 80;
    listen [::]:80;
    server_name {domain} www.{domain};
    access_log /var/log/nginx/{domain}_access.log;
    error_log /var/log/nginx/{domain}_error.log;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-XSS-Protection "1; mode=block" always;
    location ~* \\.(jpg|jpeg|png|gif|ico|css|js|woff|woff2|ttf|svg|eot)$ {{
        root {remote_dir}/public;
        expires 30d;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
        access_log off;
    }}
    location /uploads/ {{
        alias {remote_dir}/public/uploads/;
        expires 7d;
        add_header Cache-Control "public";
    }}
    location = /favicon.ico {{
        root {remote_dir}/public;
        log_not_found off;
        access_log off;
    }}
    location /health {{
        proxy_pass http://127.0.0.1:{app_port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        access_log off;
        allow all;
    }}
    location / {{
        proxy_pass http://127.0.0.1:{app_port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }}
    client_max_body_size 50M;
}}
"""
        encoded = base64.b64encode(nginx_config.encode()).decode()
        exec_cmd(client, f"echo '{encoded}' | base64 -d > {conf_path}")
        info("启用站点...")
        exec_cmd(client, "mkdir -p /etc/nginx/sites-enabled")
        exec_cmd(client, f"ln -sf {conf_path} /etc/nginx/sites-enabled/{domain}")
        exec_cmd(client, "rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true")
        info("测试 Nginx 配置...")
        out, code = exec_cmd(client, "nginx -t 2>&1")
        if code == 0:
            info("Nginx 配置测试通过")
            exec_cmd(client, "systemctl reload nginx")
            info("Nginx 已成功重载")
        else:
            error(f"Nginx 配置测试失败:\n{out}")
            return
        info("Nginx 修复完成 [OK]")
    finally:
        client.close()

def check_health():
    ensure_password()
    client, err = get_ssh_client()
    if err:
        error(f"SSH 连接失败: {err}")
        return
    try:
        run_diagnose(client)
    finally:
        client.close()

def delete_remote_dir():
    ensure_password()
    client, err = get_ssh_client()
    if err:
        error(f"SSH 连接失败: {err}")
        return
    try:
        remote_dir = CONFIG['remote_dir']
        info(f"准备删除服务器部署目录: {remote_dir}")
        confirm = input(f"{Colors.RED}警告: 此操作将删除服务器上的整个部署目录！{Colors.NC}\n确认删除 {remote_dir} 吗？(输入 'yes' 确认): ").strip()
        if confirm.lower() != 'yes':
            info("操作已取消")
            return
        info("停止 PM2 进程...")
        exec_cmd(client, "pm2 stop ecosystem.config.js 2>/dev/null || true")
        exec_cmd(client, "pm2 delete ecosystem.config.js 2>/dev/null || true")
        info(f"删除目录 {remote_dir}...")
        out, code = exec_cmd(client, f"rm -rf {remote_dir}", timeout=60)
        if code == 0:
            info(f"目录 {remote_dir} 已成功删除 [OK]")
        else:
            error(f"删除目录失败: {out}")
    finally:
        client.close()

def interactive_mode():
    while True:
        print(f"""
{Colors.BLUE}============================================================{Colors.NC}
{Colors.BLUE}  增强版部署脚本 - {CONFIG['domain']}{Colors.NC}
{Colors.BLUE}  服务器: {CONFIG['host']}:{CONFIG['port']}{Colors.NC}
{Colors.BLUE}  部署目录: {CONFIG['remote_dir']}{Colors.NC}
{Colors.BLUE}============================================================{Colors.NC}
  部署操作:
    [1] 完整部署（一键全流程，含备份）
    [2] 仅上传所有文件
    [3] 仅上传变更文件（增量上传）
    [4] 仅配置 SSL
    [5] 仅修复
    [6] 仅修复 Nginx
  诊断和维护:
    [7] 健康检查/系统诊断
    [8] 查看日志
    [9] 回滚到最近备份
  配置和管理:
    [C] 修改服务器配置
    [D] 删除服务器部署目录
    [Q] 退出
{Colors.BLUE}============================================================{Colors.NC}
""")
        choice = input("请选择: ").strip().lower()
        if choice == '1':
            full_deploy()
        elif choice == '2':
            upload_only()
        elif choice == '3':
            upload_changed_only()
        elif choice == '4':
            ssl_only()
        elif choice == '5':
            fix_only()
        elif choice == '6':
            fix_nginx_only()
        elif choice == '7':
            check_health()
        elif choice == '8':
            ensure_password()
            client, _ = get_ssh_client()
            if client:
                view_logs(client)
                client.close()
        elif choice == '9':
            ensure_password()
            client, _ = get_ssh_client()
            if client:
                rollback(client)
                client.close()
        elif choice == 'c':
            config_menu()
        elif choice == 'd':
            delete_remote_dir()
        elif choice == 'q':
            info("已退出")
            sys.exit(0)
        else:
            error("无效选择")
        if choice not in ['c', 'q']:
            input("\n按回车键继续...")

def config_menu():
    global CONFIG
    while True:
        print(f"\n{'=' * 50}")
        print(f"  修改服务器配置")
        print(f"{'=' * 50}")
        print(f"  当前配置:")
        print(f"    服务器IP:     {CONFIG['host']}")
        print(f"    SSH端口:      {CONFIG['port']}")
        print(f"    用户名:       {CONFIG['user']}")
        print(f"    部署目录:     {CONFIG['remote_dir']}")
        print(f"    域名:         {CONFIG['domain']}")
        print(f"    应用端口:     {CONFIG['app_port']}")
        print(f"    Node版本:     {CONFIG['node_version']}")
        print()
        print(f"  [1] 修改服务器IP")
        print(f"  [2] 修改SSH端口")
        print(f"  [3] 修改用户名")
        print(f"  [4] 修改部署目录")
        print(f"  [5] 修改域名")
        print(f"  [6] 修改应用端口")
        print(f"  [B] 返回主菜单")
        print()
        choice = input("请选择: ").strip()
        if choice == '1':
            val = input(f"服务器IP [{CONFIG['host']}]: ").strip()
            if val:
                CONFIG['host'] = val
        elif choice == '2':
            val = input(f"SSH端口 [{CONFIG['port']}]: ").strip()
            if val:
                CONFIG['port'] = int(val)
        elif choice == '3':
            val = input(f"用户名 [{CONFIG['user']}]: ").strip()
            if val:
                CONFIG['user'] = val
        elif choice == '4':
            val = input(f"部署目录 [{CONFIG['remote_dir']}]: ").strip()
            if val:
                CONFIG['remote_dir'] = val
        elif choice == '5':
            val = input(f"域名 [{CONFIG['domain']}]: ").strip()
            if val:
                CONFIG['domain'] = val
        elif choice == '6':
            val = input(f"应用端口 [{CONFIG['app_port']}]: ").strip()
            if val:
                CONFIG['app_port'] = int(val)
        elif choice.lower() == 'b':
            break
        else:
            print("无效选择")
            continue
        print(f"{Colors.GREEN}[OK]{Colors.NC} 配置已更新")

def main():
    parser = argparse.ArgumentParser(description='增强版部署脚本')
    parser.add_argument('--upload-only', action='store_true', help='仅上传文件')
    parser.add_argument('--upload-changed', action='store_true', help='仅上传变更文件')
    parser.add_argument('--ssl-only', action='store_true', help='仅配置SSL')
    parser.add_argument('--fix-only', action='store_true', help='仅修复')
    parser.add_argument('--fix-nginx', action='store_true', help='仅修复Nginx')
    parser.add_argument('--check', action='store_true', help='健康检查')
    parser.add_argument('--logs', action='store_true', help='查看日志')
    parser.add_argument('--diagnose', action='store_true', help='诊断')
    parser.add_argument('--rollback', action='store_true', help='回滚')
    parser.add_argument('--interactive', action='store_true', help='交互模式')
    
    args = parser.parse_args()
    
    if args.upload_only:
        upload_only()
    elif args.upload_changed:
        upload_changed_only()
    elif args.ssl_only:
        ssl_only()
    elif args.fix_only:
        fix_only()
    elif args.fix_nginx:
        fix_nginx_only()
    elif args.check:
        check_health()
    elif args.logs:
        ensure_password()
        client, _ = get_ssh_client()
        if client:
            view_logs(client)
            client.close()
    elif args.diagnose:
        check_health()
    elif args.rollback:
        ensure_password()
        client, _ = get_ssh_client()
        if client:
            rollback(client)
            client.close()
    elif args.interactive:
        interactive_mode()
    elif len(sys.argv) == 1:
        interactive_mode()
    else:
        full_deploy()

if __name__ == "__main__":
    main()