#!/usr/bin/env python3
"""Build a self-contained extension ZIP and refresh data/package_files.json."""
import json
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
version = manifest.get('version_name', manifest['version'])
output = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root / 'releases' / f'SSJ_VPN_v{version}.zip'

EXCLUDED_DIRS = {'tests', '__pycache__', 'node_modules', 'dist', 'releases', 'scripts', 'docs', '_metadata'}
EXCLUDED_FILES = {'.gitignore', '.gitattributes', 'LICENSE'}
EXCLUDED_EXTS = {'.zip', '.lst'}

index = root / 'data/package_files.json'
index.write_text('[]\n', encoding='utf-8')
files = sorted(
    path.relative_to(root).as_posix()
    for path in root.rglob('*')
    if path.is_file()
    and path.resolve() != output
    and path.name not in EXCLUDED_FILES
    and path.suffix.lower() not in EXCLUDED_EXTS
    and not any(
        part.startswith('.') or part.startswith('_') or part in EXCLUDED_DIRS
        for part in path.relative_to(root).parts
    )
)
index.write_text(json.dumps(files, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

output.parent.mkdir(parents=True, exist_ok=True)
root_extras = [
    ('installer/install_windows.cmd', 'Установить_SSJ_VPN.cmd'),
    ('installer/guide.html', 'Инструкция.html'),
    ('START_HERE_RU.txt', 'ПРОЧИТАЙ_МЕНЯ.txt'),
]
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for src, dest in root_extras:
        if (root / src).is_file():
            archive.write(root / src, dest)
    for name in files:
        archive.write(root / name, f'SSJ_VPN/{name}')

print(f'{output}: {len(files)} extension files, {output.stat().st_size} bytes')
