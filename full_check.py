#!/usr/bin/env python3
import paramiko, sys, io, os, fnmatch
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

# Same exclude patterns as deploy.py
EXTRA_EXCLUDE_PATTERNS = [
    '.vscode', '.writerHelper', 'RP-Hub', 'node_modules', '.git',
    '__pycache__', '*.pyc', '.DS_Store', 'Thumbs.db', 'database.sqlite',
    'database.sqlite.*', 'logs', 'backups', 'public/uploads', '.env',
    '.env.*', 'test_*.html', '*.tgz', '*.zip', 'cookies.txt',
    'login_result.html', '.setup_completed', 'npm-debug.log*',
    'scripts/.file_checksums.json', 'public/vendor/**/*.map',
    '*.key', '*.pem', 'config.json', 'deploy.py', 'diagnose.py', 'view-logs.py',
]

local_root = 'E:/桌面/mi'
remote_root = '/var/www/dalaowang233.top'

def should_skip(item):
    if item.startswith('.'):
        return True
    if item in ['node_modules', '.git', '__pycache__']:
        return True
    for pat in EXTRA_EXCLUDE_PATTERNS:
        if item == pat:
            return True
        if '*' in pat and fnmatch.fnmatch(item, pat):
            return True
    return False

def get_local_files(root, prefix=''):
    files = []
    for item in sorted(os.listdir(root)):
        if item.startswith('.'):
            continue
        full = os.path.join(root, item)
        rel = os.path.join(prefix, item) if prefix else item
        if os.path.isfile(full):
            if not should_skip(item):
                files.append(rel.replace('\\', '/'))
        elif os.path.isdir(full):
            if not should_skip(item):
                files.extend(get_local_files(full, rel))
    return files

def get_remote_files(ssh, prefix=''):
    stdin, stdout, stderr = ssh.exec_command(f'find {remote_root}/{prefix} -type f 2>/dev/null | head -500')
    lines = stdout.read().decode('utf-8', errors='replace').strip().split('\n')
    files = []
    for line in lines:
        if line.startswith(remote_root + '/'):
            rel = line[len(remote_root)+1:]
            # Skip files that should be excluded
            basename = os.path.basename(rel)
            if not should_skip(basename):
                files.append(rel)
    return files

# Get local files
print('Scanning local files...')
local_files = set(get_local_files(local_root))

# Get remote files via SSH
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('8.156.91.188', 22, 'root', '20030423Wang')
print('Connected to server')

# Check key directories
key_dirs = ['server', 'views', 'public']
missing_files = []

for d in key_dirs:
    stdin, stdout, stderr = ssh.exec_command(f'find {remote_root}/{d} -type f 2>/dev/null')
    remote_files_raw = stdout.read().decode('utf-8', errors='replace').strip().split('\n')
    
    for rf in remote_files_raw:
        if not rf.startswith(remote_root + '/'):
            continue
        rel = rf[len(remote_root)+1:]
        basename = os.path.basename(rel)
        if should_skip(basename):
            continue
        # Check if this file should exist locally
        local_path = os.path.join(local_root, rel.replace('/', os.sep))
        if not os.path.exists(local_path):
            missing_files.append(rel)

# Check local files that should be on server
for lf in sorted(local_files):
    # Skip files that should be excluded on server
    basename = os.path.basename(lf)
    if should_skip(basename):
        continue
    # Check if it's in a key directory or is a root-level config file
    if lf.startswith(('server/', 'views/', 'public/')) or lf in ('cdn-config.js', 'package.json', 'ecosystem.config.js'):
        remote_path = f'{remote_root}/{lf}'
        stdin, stdout, stderr = ssh.exec_command(f'ls {remote_path} 2>/dev/null')
        exists = 'No such file' not in stdout.read().decode('utf-8', errors='replace')
        if not exists:
            missing_files.append(lf)

ssh.close()

# Report
print(f'\nLocal files (key dirs): {len([f for f in local_files if f.startswith(("server/","views/","public/"))])}')
print(f'Files missing on server: {len(missing_files)}')
if missing_files:
    print('\nMissing files:')
    for f in sorted(missing_files):
        print(f'  - {f}')
else:
    print('\nAll files present!')
